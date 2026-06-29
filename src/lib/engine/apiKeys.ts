import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys } from "../db/schema";

export type ApiKeyType = "secret" | "public";
export type Scope = "chat" | "documents" | "analytics";

/**
 * Генерирует новый API-ключ. Префикс кодирует тип:
 *   sk_  — секретный (server-to-server, полный доступ в рамках орг)
 *   pub_ — публичный (встраиваемый виджет, ограниченный scope)
 * Возвращает ОТКРЫТЫЙ ключ — показать пользователю один раз, в БД хранится только хэш.
 */
export function generateApiKey(type: ApiKeyType): string {
  const prefix = type === "public" ? "pub_" : "sk_";
  return prefix + randomBytes(24).toString("base64url");
}

/** sha256-хэш ключа (в БД храним только его, как сессии). */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface ResolvedKey {
  id: string;
  orgId: string;
  projectId: string | null;
  type: ApiKeyType;
  scopes: Scope[];
  domainAllowlist: string[] | null;
}

/**
 * Эффективный projectId запроса.
 *
 * Секретный ключ (`sk_`) — доверенный server-to-server host (монолит/бэкенд Quotcat),
 * он сам провёл мультитенантную авторизацию, поэтому может адресовать любой проект
 * своей организации, передав projectId в запросе.
 *
 * Публичный ключ (`pub_`) — встраиваемый виджет, его нельзя перенацелить: projectId
 * жёстко берётся из ключа (закрывает возможность жечь чужую квоту).
 */
export function effectiveProjectId(tenant: ResolvedKey, requested?: string | null): string | null {
  if (tenant.type === "secret" && requested) return requested;
  return tenant.projectId;
}

/**
 * Резолвит сырой ключ из заголовка в тенанта. Возвращает null, если ключ не найден
 * или отозван. Обновляет last_used_at (fire-and-forget).
 *
 * Тенант (orgId/projectId) берётся ИЗ КЛЮЧА, а не из тела запроса — это закрывает
 * возможность дёргать чужие проекты (раздел 5 «Безопасность»).
 */
export async function resolveApiKey(rawKey: string): Promise<ResolvedKey | null> {
  if (!rawKey) return null;
  const keyHash = hashApiKey(rawKey);

  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  if (!row || row.revokedAt) return null;

  // Обновляем время последнего использования, не блокируя ответ.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});

  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId ?? null,
    type: row.type as ApiKeyType,
    scopes: (row.scopes as Scope[]) ?? [],
    domainAllowlist: (row.domainAllowlist as string[] | null) ?? null,
  };
}
