/**
 * In-memory rate limiter по IP.
 * Хранит скользящее окно запросов в Map — без внешних зависимостей.
 * При перезапуске сервера счётчики сбрасываются (достаточно для MVP).
 */

interface RateLimitEntry {
  count: number;
  resetAt: number; // timestamp в мс
}

const store = new Map<string, RateLimitEntry>();

// Чистка просроченных записей раз в 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

export interface RateLimitConfig {
  /** Максимум запросов за windowMs */
  limit: number;
  /** Размер окна в миллисекундах */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Проверяет и инкрементирует счётчик для данного ключа (IP или др.).
 */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    // Новое окно
    store.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.limit - 1, resetAt: now + config.windowMs };
  }

  if (entry.count >= config.limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: config.limit - entry.count, resetAt: entry.resetAt };
}

/**
 * Извлекает IP из заголовков запроса (поддерживает прокси).
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ─── Конфиги для разных эндпоинтов ───

export const CHAT_RATE_LIMIT: RateLimitConfig = {
  limit: 30,       // 30 запросов
  windowMs: 60_000, // за 1 минуту
};

export const UPLOAD_RATE_LIMIT: RateLimitConfig = {
  limit: 10,        // 10 загрузок
  windowMs: 60_000, // за 1 минуту
};
