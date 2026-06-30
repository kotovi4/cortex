/**
 * #4 TTL-кэш результатов экстракции по URL — экономит и fetch, и LLM на повторах
 * (в сборке КП один товар добавляют многократно). In-memory; на нескольких инстансах
 * заменить на Redis. TTL и размер — через env.
 */
import type { Product } from "./extractProduct";

const TTL_MS = Number(process.env.EXTRACT_CACHE_TTL_MS ?? String(60 * 60 * 1000)); // 1 час
const MAX_ENTRIES = Number(process.env.EXTRACT_CACHE_MAX ?? "500");

const store = new Map<string, { product: Product; expiresAt: number }>();

export function extractCacheGet(url: string): Product | null {
  const hit = store.get(url);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    store.delete(url);
    return null;
  }
  return hit.product;
}

export function extractCacheSet(url: string, product: Product): void {
  if (TTL_MS <= 0) return; // кэш отключён
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(url, { product, expiresAt: Date.now() + TTL_MS });
}
