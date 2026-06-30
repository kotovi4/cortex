import { Hono } from "hono";
import {
  fetchPage,
  fetchPageRendered,
  HEADLESS_ENABLED,
  PageError,
  extractProduct,
  extractCacheGet,
  extractCacheSet,
  estimateCostRub,
  UPLOAD_RATE_LIMIT,
  checkRateLimit,
} from "../lib/engine";
import { requireApiKey } from "../middleware/auth";
import { logger } from "../lib/logger";
import type { AppEnv } from "../types";

const route = new Hono<AppEnv>();

// POST /api/v1/extract-product { url } — структурированный товар со страницы.
// BUILD-слой для Quotcat: доверенный server-to-server вызов (секретный ключ).
// Конверт: успех { data: Product }, ошибка { error: { code, message } }.
route.post("/", requireApiKey("extract"), async (c) => {
  const tenant = c.get("tenant");
  if (tenant.type !== "secret") {
    return c.json({ error: { code: "EAI_FORBIDDEN", message: "Доступно только секретному ключу" } }, 403);
  }

  const rl = checkRateLimit(`extract:${tenant.id}`, UPLOAD_RATE_LIMIT);
  if (!rl.allowed) {
    return c.json({ error: { code: "EAI_RATE_LIMITED", message: "Слишком много запросов" } }, 429);
  }

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return c.json({ error: { code: "EAI_BAD_REQUEST", message: "Поле url обязательно" } }, 400);
  }

  // #4 кэш: тот же URL уже парсили — отдаём без fetch и без LLM.
  const cached = extractCacheGet(url);
  if (cached) {
    return c.json({ data: cached, meta: { source: "cache", models: [], usageTokens: 0, costRub: 0 } });
  }

  try {
    let page = await fetchPage(url);
    const isThin = (p: typeof page) => p.text.length < 200 && p.ldjson.length === 0;

    // Фаза 2: пустой каркас (JS/SPA) + headless включён → рендерим браузером и повторяем.
    if (isThin(page) && HEADLESS_ENABLED) {
      try {
        page = await fetchPageRendered(url);
        logger.info(`extract-product: headless-фоллбэк для ${url}`);
      } catch (e) {
        logger.warn("extract-product: headless-фоллбэк не удался", e);
      }
    }

    if (isThin(page)) {
      return c.json(
        {
          error: {
            code: "EAI_EMPTY_PAGE",
            message: HEADLESS_ENABLED
              ? "Не удалось получить контент страницы даже headless-рендером."
              : "Страница почти без контента — вероятно, JS-рендеринг. Включите ENABLE_HEADLESS (Фаза 2).",
          },
        },
        422,
      );
    }

    const result = await extractProduct(page);
    extractCacheSet(url, result.product);

    const usageTokens = result.calls.reduce((s, call) => s + (call.usage?.total ?? 0), 0);
    const costRub = result.calls.reduce(
      (s, call) => s + estimateCostRub(call.model, call.usage?.total ?? 0),
      0,
    );

    return c.json({
      data: result.product,
      meta: {
        source: result.source,
        models: result.calls.map((call) => call.model),
        usageTokens,
        costRub: Number(costRub.toFixed(4)),
      },
    });
  } catch (err) {
    if (err instanceof PageError) {
      const status = err.code === "TOO_LARGE" ? 413 : 400;
      return c.json({ error: { code: "EAI_" + err.code, message: err.message } }, status);
    }
    logger.error("extract-product error", err);
    return c.json(
      { error: { code: "EAI_EXTRACTION_FAILED", message: "Не удалось распарсить товар со страницы" } },
      502,
    );
  }
});

export default route;
