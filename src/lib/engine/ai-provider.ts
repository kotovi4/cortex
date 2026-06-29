/**
 * Провайдер AI: Yandex (RU) или Gemini (EN/Global)
 *
 * Переменная окружения: AI_PROVIDER=yandex | gemini
 * По умолчанию: yandex (для российского сегмента)
 *
 * .env пример:
 *   AI_PROVIDER=yandex
 *   # Yandex
 *   YANDEX_API_KEY=...
 *   YANDEX_FOLDER_ID=...
 *   # Gemini
 *   GEMINI_API_KEY=...
 */

export type AIProvider = "yandex" | "gemini";

export function getAIProvider(): AIProvider {
  const raw = process.env.AI_PROVIDER?.toLowerCase().trim();
  if (raw === "gemini") return "gemini";
  return "yandex"; // default — безопасно для РФ
}

export const aiConfig = {
  get provider() {
    return getAIProvider();
  },

  get isYandex() {
    return this.provider === "yandex";
  },

  get isGemini() {
    return this.provider === "gemini";
  },

  // Yandex
  get yandexApiKey() {
    return process.env.YANDEX_API_KEY || "";
  },
  get yandexFolderId() {
    return process.env.YANDEX_FOLDER_ID || "";
  },
  get yandexChatModel() {
    return process.env.YANDEX_CHAT_MODEL || "yandexgpt-lite";
    // Опции: yandexgpt-lite | yandexgpt | yandexgpt-32k
  },
  // Яндекс использует разные модели для индексации и поиска:
  // text-search-doc  — при загрузке документов (256-мерный вектор)
  // text-search-query — при поиске по запросу пользователя (256-мерный вектор)
  get yandexDocEmbeddingModel() {
    return process.env.YANDEX_DOC_EMBEDDING_MODEL || "text-search-doc";
  },
  get yandexQueryEmbeddingModel() {
    return process.env.YANDEX_QUERY_EMBEDDING_MODEL || "text-search-query";
  },

  // Gemini
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY || "";
  },
  get geminiChatModels() {
    return ["gemini-2.0-flash", "gemini-2.0-flash-lite-001"];
  },
  get geminiEmbeddingModel() {
    return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
  },
} as const;
