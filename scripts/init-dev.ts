/**
 * Dev-инициализация для запуска на ОБЩЕЙ с монолитом БД.
 *
 * На общей dev-БД таблицы documents/chunks/query_logs уже существуют (их создал
 * монолит). Нужна только api_keys — создаём её идемпотентно (IF NOT EXISTS) и
 * сидируем один секретный ключ со всеми scope. Ключ печатается ОДИН раз.
 *
 * На ЧИСТОЙ БД (компании, Фаза 5C) используйте вместо этого `npm run db:migrate`,
 * который создаст все 4 таблицы из миграций.
 *
 * Запуск: npm run init-dev
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { client, db } from "../src/lib/db";
import { apiKeys } from "../src/lib/db/schema";
import { generateApiKey, hashApiKey } from "../src/lib/engine";

// Фиктивный dev-orgId (на проде orgId приходит из хостовой системы).
const DEV_ORG_ID = "00000000-0000-0000-0000-000000000001";

async function main() {
  // api_keys создаётся идемпотентно — не трогает существующие documents/chunks/query_logs.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "api_keys" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "org_id" uuid NOT NULL,
      "project_id" uuid,
      "name" text,
      "key_hash" text NOT NULL UNIQUE,
      "type" text NOT NULL,
      "scopes" jsonb NOT NULL DEFAULT '["chat"]'::jsonb,
      "domain_allowlist" jsonb,
      "last_used_at" timestamp,
      "revoked_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  const rawKey = generateApiKey("secret");
  await db.insert(apiKeys).values({
    orgId: DEV_ORG_ID,
    projectId: null, // null = поиск по всем документам (удобно для смоук-теста на чужих данных)
    name: "dev-seed",
    keyHash: hashApiKey(rawKey),
    type: "secret",
    scopes: ["chat", "documents", "analytics", "extract"],
  });

  console.log("\n✅ api_keys готова. Сид-ключ (секрет, все scope, projectId=null):\n");
  console.log("   " + rawKey + "\n");
  console.log("   Сохраните его — он показывается один раз. Использование:");
  console.log('   curl -H "X-API-Key: ' + rawKey + '" ...\n');

  await client.end({ timeout: 5 });
  process.exit(0);
}

main().catch(async (err) => {
  console.error("init-dev failed:", err);
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
