/**
 * Структурированная экстракция товара со страницы (BUILD-слой для Quotcat).
 * Движок отдаёт НЕЙТРАЛЬНЫЙ товар (ЧТО); как он ляжет в offer и по какой цене —
 * решает Quotcat. Цена со страницы — лишь одно из извлечённых полей.
 *
 * Оптимизации стоимости (без потери качества):
 *  1. structured-first — поля из ld+json (schema.org/Product) и OpenGraph берём
 *     детерминированно; они ТОЧНЕЕ LLM и перетирают её значения при мердже.
 *     Опц. полный пропуск LLM, если структура «полная» (env EXTRACT_SKIP_LLM_WHEN_COMPLETE=1).
 *  2. умная подсказка — в LLM уходит только узел Product из ld+json, а не все блоки.
 *  3. каскад lite→pro — Pro только если lite не вытащил даже название на непустой странице.
 *  4. usage — фактические токены из ответа провайдера (для расчёта стоимости).
 */
import { aiConfig } from "./ai-provider";
import { logger } from "../logger";
import { withRetry } from "../retry";
import type { FetchedPage } from "./pageFetch";

export interface Product {
  name: string | null;
  price: number | null;
  currency: string | null;
  sku: string | null;
  specs: Record<string, string>;
  images: string[];
  description: string | null;
  sourceUrl: string;
}

export interface Usage {
  input: number;
  output: number;
  total: number;
}

export interface LlmCall {
  model: string;
  usage: Usage | null;
}

export interface ExtractResult {
  product: Product;
  /** "structured" — без LLM; "llm" — с одним или несколькими вызовами модели. */
  source: "structured" | "llm";
  calls: LlmCall[];
}

const TEXT_CHARS = Number(process.env.EXTRACT_TEXT_CHARS ?? "6000");
const SKIP_LLM_WHEN_COMPLETE = process.env.EXTRACT_SKIP_LLM_WHEN_COMPLETE === "1";
const PRO_MODEL = "yandexgpt";

const SYSTEM_PROMPT = `Ты извлекаешь данные о ТОВАРЕ со страницы интернет-магазина.
Верни СТРОГО валидный JSON по схеме (и ничего, кроме JSON — без markdown, без пояснений):
{
  "name": string|null,          // название товара
  "price": number|null,         // только число, без валюты/пробелов; null если не указана
  "currency": string|null,      // код валюты, напр. "RUB", "USD"
  "sku": string|null,           // артикул/код товара
  "specs": object,              // характеристики "атрибут": "значение" (строки); {} если нет
  "images": string[],           // абсолютные URL изображений; [] если нет
  "description": string|null    // краткое описание
}
Правила: не выдумывай значения — чего нет на странице, ставь null/[]/{}. price — число (например 154900), не строка.`;

// ── Универсальный LLM-вызов с usage. temperature 0 — детерминированная экстракция. ──
async function complete(
  system: string,
  user: string,
  model: string,
): Promise<{ text: string; usage: Usage | null }> {
  if (aiConfig.isYandex) {
    const { yandexApiKey, yandexFolderId } = aiConfig;
    const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${yandexApiKey}`,
        "x-folder-id": yandexFolderId,
      },
      body: JSON.stringify({
        modelUri: `gpt://${yandexFolderId}/${model}/latest`,
        completionOptions: { stream: false, temperature: 0, maxTokens: 2000 },
        messages: [
          { role: "system", text: system },
          { role: "user", text: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Yandex completion ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      result?: {
        alternatives?: Array<{ message?: { text?: string } }>;
        usage?: { inputTextTokens?: string; completionTokens?: string; totalTokens?: string };
      };
    };
    const u = data.result?.usage;
    const usage: Usage | null = u
      ? {
          input: Number(u.inputTextTokens) || 0,
          output: Number(u.completionTokens) || 0,
          total: Number(u.totalTokens) || 0,
        }
      : null;
    return { text: data.result?.alternatives?.[0]?.message?.text ?? "", usage };
  }

  // Gemini
  const { geminiApiKey, geminiChatModels } = aiConfig;
  const gModel = geminiChatModels[0];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2000 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini completion ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const um = data.usageMetadata;
  const usage: Usage | null = um
    ? {
        input: um.promptTokenCount ?? 0,
        output: um.candidatesTokenCount ?? 0,
        total: um.totalTokenCount ?? 0,
      }
    : null;
  return { text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "", usage };
}

// Достаёт JSON-объект из ответа модели (срезает markdown-ограждения и текст вокруг).
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.,-]/g, "").replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function specsFrom(v: unknown): Record<string, string> {
  const specs: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val != null) specs[k] = String(val);
    }
  }
  return specs;
}

function imagesFrom(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(imagesFrom);
  if (v && typeof v === "object") {
    const u = (v as Record<string, unknown>).url;
    if (typeof u === "string") return [u];
  }
  return [];
}

function llmToProduct(obj: Record<string, unknown>): Partial<Product> {
  return {
    name: toStr(obj.name) ?? undefined,
    price: toNumber(obj.price) ?? undefined,
    currency: toStr(obj.currency) ?? undefined,
    sku: toStr(obj.sku) ?? undefined,
    specs: specsFrom(obj.specs),
    images: Array.isArray(obj.images)
      ? (obj.images as unknown[]).filter((u): u is string => typeof u === "string")
      : [],
    description: toStr(obj.description) ?? undefined,
  };
}

// ── #1 structured-first: ld+json (schema.org/Product) + OpenGraph ──

function collectLdNodes(ldjson: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["@graph"]) visit(o["@graph"]);
      out.push(o);
    }
  };
  ldjson.forEach(visit);
  return out;
}

function isProductNode(o: Record<string, unknown>): boolean {
  const t = o["@type"];
  return t === "Product" || (Array.isArray(t) && t.includes("Product"));
}

function offerPrice(offers: unknown): { price: number | null; currency: string | null } {
  const arr = Array.isArray(offers) ? offers : [offers];
  for (const o of arr) {
    if (o && typeof o === "object") {
      const obj = o as Record<string, unknown>;
      const spec = (obj.priceSpecification ?? {}) as Record<string, unknown>;
      const price = toNumber(obj.price ?? spec.price);
      const currency = toStr(obj.priceCurrency ?? spec.priceCurrency);
      if (price != null) return { price, currency };
    }
  }
  return { price: null, currency: null };
}

/** Детерминированный товар из микроразметки + узел Product для подсказки LLM. */
function structuredProduct(page: FetchedPage): {
  product: Partial<Product>;
  productNode: Record<string, unknown> | null;
} {
  const p: Partial<Product> = {};
  const node = collectLdNodes(page.ldjson).find(isProductNode) ?? null;

  if (node) {
    const name = toStr(node.name);
    if (name) p.name = name;
    const sku = toStr(node.sku) ?? toStr(node.mpn);
    if (sku) p.sku = sku;
    const description = toStr(node.description);
    if (description) p.description = description;
    const imgs = imagesFrom(node.image);
    if (imgs.length) p.images = imgs;
    const { price, currency } = offerPrice(node.offers);
    if (price != null) p.price = price;
    if (currency) p.currency = currency;
  }

  const og = page.openGraph ?? {};
  if (p.name == null && toStr(og["og:title"])) p.name = og["og:title"];
  if (p.description == null && toStr(og["og:description"])) p.description = og["og:description"];
  if (!p.images?.length && toStr(og["og:image"])) p.images = [og["og:image"]];
  if (p.price == null) {
    const ogPrice = toNumber(og["product:price:amount"]);
    if (ogPrice != null) p.price = ogPrice;
  }
  if (p.currency == null && toStr(og["product:price:currency"])) p.currency = og["product:price:currency"];

  return { product: p, productNode: node };
}

/** Объединяет структуру (приоритет) и результат LLM в финальный товар. */
function finalize(structured: Partial<Product>, llm: Partial<Product> | null, url: string): Product {
  const scalar = <K extends "name" | "price" | "currency" | "sku" | "description">(k: K): Product[K] =>
    ((structured[k] ?? llm?.[k]) ?? null) as Product[K];
  return {
    name: scalar("name"),
    price: scalar("price"),
    currency: scalar("currency"),
    sku: scalar("sku"),
    specs: { ...(llm?.specs ?? {}), ...(structured.specs ?? {}) },
    images: (structured.images?.length ? structured.images : llm?.images) ?? [],
    description: scalar("description"),
    sourceUrl: url,
  };
}

function buildUserMessage(page: FetchedPage, productNode: Record<string, unknown> | null): string {
  // #2 умная подсказка: только узел Product (а не все ld+json блоки) — меньше токенов, больше сигнала.
  const ldHint = productNode
    ? `\n\nМикроразметка товара (ld+json, приоритетный источник):\n${JSON.stringify(productNode).slice(0, 3000)}`
    : "";
  const ogHint = Object.keys(page.openGraph ?? {}).length
    ? `\n\nOpenGraph:\n${JSON.stringify(page.openGraph)}`
    : "";
  return (
    `URL: ${page.url}\nЗаголовок: ${page.title}${ldHint}${ogHint}` +
    `\n\nТекст страницы:\n${page.text.slice(0, TEXT_CHARS)}`
  );
}

async function runLLM(
  page: FetchedPage,
  productNode: Record<string, unknown> | null,
  model: string,
): Promise<{ product: Partial<Product>; usage: Usage | null }> {
  const user = buildUserMessage(page, productNode);
  const { text, usage } = await withRetry(() => complete(SYSTEM_PROMPT, user, model), {
    attempts: 3,
    onRetry: (err, attempt) => logger.warn(`extractProduct: LLM retry ${attempt}`, err),
  });
  const obj = parseJsonObject(text);
  if (!obj) {
    logger.warn("extractProduct: модель не вернула валидный JSON", { raw: text.slice(0, 200) });
    throw new Error("EXTRACTION_FAILED");
  }
  return { product: llmToProduct(obj), usage };
}

/** Извлекает структурированный товар из загруженной страницы (с оптимизациями стоимости). */
export async function extractProduct(page: FetchedPage): Promise<ExtractResult> {
  const { product: structured, productNode } = structuredProduct(page);

  // #1 (опц.): структура «полная» → пропускаем LLM целиком. По умолчанию выключено,
  // чтобы не терять specs/description, которые LLM достаёт из текста.
  const complete4 = !!(
    structured.name &&
    structured.price != null &&
    structured.description &&
    structured.images?.length
  );
  if (SKIP_LLM_WHEN_COMPLETE && complete4) {
    logger.info(`extractProduct: structured-only (без LLM) для ${page.url}`);
    return { product: finalize(structured, null, page.url), source: "structured", calls: [] };
  }

  const baseModel = aiConfig.isYandex ? aiConfig.yandexChatModel : aiConfig.geminiChatModels[0];
  const calls: LlmCall[] = [];

  const first = await runLLM(page, productNode, baseModel);
  calls.push({ model: baseModel, usage: first.usage });
  let llm = first.product;

  // #3 каскад: lite не вытащил название на непустой странице → повтор на Pro.
  const stillNoName = finalize(structured, llm, page.url).name == null;
  if (aiConfig.isYandex && baseModel.includes("lite") && stillNoName && page.text.length > 200) {
    logger.info(`extractProduct: каскад lite→pro для ${page.url}`);
    const pro = await runLLM(page, productNode, PRO_MODEL);
    calls.push({ model: PRO_MODEL, usage: pro.usage });
    llm = pro.product;
  }

  return { product: finalize(structured, llm, page.url), source: "llm", calls };
}
