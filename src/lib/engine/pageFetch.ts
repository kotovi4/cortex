/**
 * Безопасная загрузка внешней страницы по пользовательскому URL.
 * Портировано из ai-support `upload-url/route.ts` (SSRF-защита + лимит размера + html→text)
 * и расширено извлечением микроразметки (ld+json / OpenGraph) как подсказок для экстракции.
 *
 * ⚠️ Любой пользовательский URL ОБЯЗАН проходить isSafeUrl перед fetch.
 */
import dns from "dns/promises";
import { logger } from "../logger";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 МБ
const FETCH_TIMEOUT_MS = 10_000;

/** Ошибка загрузки/валидации страницы с машиночитаемым кодом. */
export class PageError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "PageError";
  }
}

export function isPrivateIp(ip: string): boolean {
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^127\./,
    /^169\.254\./, // link-local (AWS metadata 169.254.169.254)
    /^0\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  ];
  if (privateRanges.some((r) => r.test(ip))) return true;

  const v6 = ip.toLowerCase();
  if (v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique local
  const fe = parseInt(v6.slice(0, 4), 16);
  if (!isNaN(fe) && fe >= 0xfe80 && fe <= 0xfebf) return true; // link-local
  if (v6.startsWith("::ffff:")) {
    const mapped = v6.slice(7);
    if (isPrivateIp(mapped)) return true;
  }
  return false;
}

export async function isSafeUrl(parsedUrl: URL): Promise<{ safe: boolean; reason?: string }> {
  const hostname = parsedUrl.hostname;
  const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];
  if (blocked.includes(hostname.toLowerCase())) {
    return { safe: false, reason: "Локальные адреса запрещены" };
  }
  let addresses: string[];
  try {
    const result = await dns.lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    return { safe: false, reason: "Не удалось разрешить домен" };
  }
  for (const ip of addresses) {
    if (isPrivateIp(ip)) return { safe: false, reason: "Адрес указывает на внутреннюю сеть" };
  }
  return { safe: true };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractTitle(html: string, fallbackUrl: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (m) return m[1].trim();
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return fallbackUrl;
  }
}

// Микроразметка как подсказка для LLM: товар часто описан в ld+json (schema.org/Product)
// или OpenGraph (og:title/og:price...). Это сильно повышает точность экстракции.
function extractMicrodata(html: string): { ldjson: unknown[]; openGraph: Record<string, string> } {
  const ldjson: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(html)) !== null) {
    try {
      ldjson.push(JSON.parse(mm[1].trim()));
    } catch {
      // битый ld+json — пропускаем
    }
  }
  const openGraph: Record<string, string> = {};
  const ogRe = /<meta[^>]+(?:property|name)=["'](og:[^"']+|product:[^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  let og: RegExpExecArray | null;
  while ((og = ogRe.exec(html)) !== null) {
    openGraph[og[1]] = og[2];
  }
  return { ldjson, openGraph };
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  ldjson: unknown[];
  openGraph: Record<string, string>;
}

/** Собирает FetchedPage из HTML — общий шаг для статического fetch и headless-рендера. */
export function buildPageFromHtml(html: string, finalUrl: string, fallbackUrl: string): FetchedPage {
  const { ldjson, openGraph } = extractMicrodata(html);
  return {
    url: finalUrl,
    title: extractTitle(html, fallbackUrl),
    text: htmlToText(html),
    ldjson,
    openGraph,
  };
}

/** Загружает страницу с SSRF-защитой и лимитом размера. Бросает PageError при проблеме. */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
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

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      headers: { "User-Agent": "CortexBot/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "timeout";
    throw new PageError("FETCH_FAILED", `Не удалось загрузить страницу: ${msg}`);
  }

  if (!res.ok) throw new PageError("FETCH_FAILED", `Страница вернула ошибку ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new PageError("NOT_HTML", "URL должен указывать на HTML-страницу");
  }

  const reader = res.body?.getReader();
  if (!reader) throw new PageError("NO_BODY", "Нет тела ответа");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PageError("TOO_LARGE", "Страница слишком большая (макс. 5 МБ)");
    }
    chunks.push(value);
  }

  const html = new TextDecoder().decode(Buffer.concat(chunks));
  const page = buildPageFromHtml(html, parsed.toString(), rawUrl);
  logger.debug(`fetchPage ok: ${page.url} (${page.text.length} chars, ld+json: ${page.ldjson.length})`);
  return page;
}
