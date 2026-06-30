import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Фиктивные значения, чтобы импорт модулей (db-клиент, ai-provider) не падал.
    // Реальная сеть/БД в юнит-тестах не используется — внешние вызовы мокаются.
    env: {
      DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      AI_PROVIDER: "yandex",
      YANDEX_API_KEY: "test-key",
      YANDEX_FOLDER_ID: "test-folder",
    },
    include: ["test/**/*.test.ts"],
  },
});
