import { pgTable, text, timestamp, uuid, integer, jsonb, real, boolean } from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";

// pgvector колонка (256/768-мерный вектор; размерность фиксируется миграцией pgvector).
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(768)",
  fromDriver: (v: string) => JSON.parse(v) as number[],
  toDriver: (v: number[]) => `[${v.join(",")}]`,
});

// ── Движковые таблицы (владелец — движок) ──
// ВАЖНО: projectId здесь — это просто scope-значение тенанта (резолвится из API-ключа),
// а НЕ внешний ключ на хостовую таблицу projects. Хостовые таблицы (organizations,
// projects, users, conversations, ...) живут в монолите/у компании и движку не принадлежат.

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id"), // scope тенанта; без FK — projects не принадлежит движку
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  content: text("content").notNull(),
  chunkCount: integer("chunk_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }).notNull(),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  embedding: vector("embedding").notNull().$type<number[] | null>(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const queryLogs = pgTable("query_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  question: text("question").notNull(),
  conversationId: uuid("conversation_id"),
  projectId: uuid("project_id"),
  projectName: text("project_name"),
  topSimilarity: real("top_similarity"),
  resultsCount: integer("results_count").default(0),
  answered: boolean("answered").default(true),
  searchMethod: text("search_method"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── API-ключи (Фаза 1) ──
// Хранится только sha256-хэш ключа (как сессии). Тенант (orgId/projectId) берётся
// из ключа, а не из тела запроса. Ключ показывается один раз при создании.
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  projectId: uuid("project_id"), // nullable — ключ может быть на уровне организации
  name: text("name"),
  keyHash: text("key_hash").notNull().unique(),
  type: text("type").notNull(), // 'secret' | 'public'
  scopes: jsonb("scopes").$type<string[]>().notNull().default(["chat"]),
  domainAllowlist: jsonb("domain_allowlist").$type<string[]>(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
