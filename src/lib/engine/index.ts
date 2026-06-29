/**
 * Точка входа движка (barrel-export) — публичная поверхность лицензируемого ядра.
 * Контракт /api/v1 (src/routes) и middleware импортируют только отсюда.
 */
export * from "./ai-provider";
export * from "./embeddings";
export * from "./chunker";
export * from "./pdfExtractor";
export * from "./rag";
export * from "./rateLimit";
export * from "./escalation";
export * from "./apiKeys";
