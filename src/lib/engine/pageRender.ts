/**
 * Headless-рендеринг страницы (Фаза 2) — для товарных страниц, которые рендерятся
 * на клиенте (JS/SPA), где статический fetch вернёт пустой каркас.
 *
 * Опционально: playwright — необязательная зависимость, импортируется ЛЕНИВО и только
 * при включённом флаге `ENABLE_HEADLESS`. Без него движок работает на статике (Фаза 1).
 *
 * ⚠️ SSRF: главный URL проверяется isSafeUrl; плюс перехват ВСЕХ запросов браузера
 * (включая subresources) с блокировкой приватных IP.
 */
import dns from "dns/promises";
import { logger } from "../logger";
import { isPrivateIp, isSafeUrl, buildPageFromHtml, PageError, type FetchedPage } from "./pageFetch";

export const HEADLESS_ENABLED =
  process.env.ENABLE_HEADLESS === "1" || process.env.ENABLE_HEADLESS === "true";

const RENDER_TIMEOUT_MS = 20_000;

export async function fetchPageRendered(rawUrl: string): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PageError("INVALID_URL", "Некорректный URL");
  }
  if (parsed.protocol !== "https:") {
    throw new PageError("HTTPS_ONLY", "Разрешены только HTTPS-ссылки");
  }
  const { safe, reason } = await isSafeUrl(parsed);
  if (!safe) throw new PageError("UNSAFE_URL", `Недопустимый адрес: ${reason}`);

  // Ленивый импорт — playwright опционален.
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new PageError("HEADLESS_UNAVAILABLE", "Headless недоступен (playwright не установлен)");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: "CortexBot/1.0" });

    // SSRF-guard на каждый запрос браузера (документ + subresources).
    await context.route("**/*", async (route) => {
      try {
        const host = new URL(route.request().url()).hostname;
        const isIpLiteral = /^[\d.]+$/.test(host) || host.includes(":");
        const ip = isIpLiteral ? host : (await dns.lookup(host)).address;
        if (isPrivateIp(ip)) return route.abort();
      } catch {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    await page.goto(parsed.toString(), { waitUntil: "networkidle", timeout: RENDER_TIMEOUT_MS });
    const html = await page.content();
    const result = buildPageFromHtml(html, page.url(), rawUrl);
    logger.debug(`fetchPageRendered ok: ${result.url} (${result.text.length} chars)`);
    return result;
  } finally {
    await browser.close();
  }
}
