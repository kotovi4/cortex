import { createMiddleware } from "hono/factory";
import { resolveApiKey, type Scope } from "../lib/engine";
import type { AppEnv } from "../types";

/**
 * Требует валидный API-ключ в заголовке X-API-Key с нужным scope.
 * Тенант кладётся в контекст (c.get("tenant")). orgId/projectId — из ключа, не из тела.
 *
 * Двойная авторизация (раздел 10.1): внутренний трафик по JWT — отдельный middleware,
 * добавляется позже; здесь — внешние/виджет-ключи движка.
 */
export function requireApiKey(scope: Scope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header("X-API-Key") ?? "";
    const tenant = await resolveApiKey(key);
    if (!tenant) {
      return c.json({ error: "Невалидный или отсутствующий API-ключ" }, 401);
    }
    if (!tenant.scopes.includes(scope)) {
      return c.json({ error: `У ключа нет доступа к scope: ${scope}` }, 403);
    }
    c.set("tenant", tenant);
    await next();
  });
}
