import { GoogleGenerativeAI } from "@google/generative-ai";
import { aiConfig } from "./ai-provider";
import { getQueryEmbedding } from "./embeddings";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";

const SYSTEM_PROMPT = `Ты — AI-ассистент технической поддержки. Ты ОБЯЗАН отвечать на вопросы пользователей, опираясь ТОЛЬКО на предоставленную документацию в блоке "Контекст из документации".

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Внимательно прочитай ВСЕ предоставленные источники из контекста
2. Если ответ есть в контексте — дай чёткий развёрнутый ответ, цитируя источник
3. Если в контексте нет прямого ответа — скажи: "В загруженной документации нет информации по этому вопросу"
4. НИКОГДА не отвечай "не удалось получить ответ" — всегда либо отвечай по контексту, либо честно скажи что информации нет
5. Не выдумывай информацию, которой нет в контексте
6. Отвечай на том языке, на котором задан вопрос
7. Используй markdown для форматирования`;

interface SearchResult {
  content: string;
  documentTitle: string;
  similarity: number;       // vector: косинусная близость (0..1); keyword: ts_rank/0.1 (другая шкала!)
  chunkIndex: number;
  searchMethod?: "vector" | "keyword";
}

interface RawChunkRow {
  content: string;
  chunk_index: number;
  document_title: string;
  rank?: string | number;
  similarity?: string | number;
}

interface GeminiApiError extends Error {
  status?: number;
  headers?: Record<string, string> & { get?: (key: string) => string | null };
}

// db.execute() в postgres-js возвращает массив-RowList; в node-postgres — объект с .rows.
// Нормализуем к массиву строк, не завязываясь на драйвер.
function toRows(result: unknown): RawChunkRow[] {
  const r = result as RawChunkRow[] | { rows?: RawChunkRow[] };
  return Array.isArray(r) ? r : (r.rows ?? []);
}

// ─── Поиск по ключевым словам (FTS fallback) ───
// Использует PostgreSQL tsvector/tsquery — O(log n) вместо O(n)

async function keywordSearchAsync(
  query: string,
  topK: number = 5,
  projectId?: string | null
): Promise<SearchResult[]> {
  try {
    const results = projectId
      ? await db.execute(sql`
          SELECT c.content, c.chunk_index, d.title AS document_title,
                 ts_rank(c.fts, plainto_tsquery('russian', ${query})) AS rank
          FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.fts @@ plainto_tsquery('russian', ${query}) AND d.project_id = ${projectId}::uuid
          ORDER BY rank DESC LIMIT ${topK}
        `)
      : await db.execute(sql`
          SELECT c.content, c.chunk_index, d.title AS document_title,
                 ts_rank(c.fts, plainto_tsquery('russian', ${query})) AS rank
          FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.fts @@ plainto_tsquery('russian', ${query})
          ORDER BY rank DESC LIMIT ${topK}
        `);

    const rows = toRows(results);

    if (rows.length > 0) {
      logger.debug(`FTS search returned ${rows.length} results`);
      return rows.map((row) => ({
        content: row.content,
        documentTitle: row.document_title,
        similarity: parseFloat(String(row.rank ?? 0)) || 0.1,
        chunkIndex: row.chunk_index,
        searchMethod: "keyword" as const,
      }));
    }
  } catch (err) {
    logger.warn("FTS search failed, falling back to LIKE:", err);
  }

  // Последний резерв — LIKE поиск (если fts колонки нет)
  const likeQuery = `%${query.slice(0, 100)}%`;
  const fallback = await db.execute(sql`
    SELECT c.content, c.chunk_index, d.title AS document_title, 0.1 AS rank
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.content ILIKE ${likeQuery}
    LIMIT ${topK}
  `);
  const fallbackRows = toRows(fallback);
  logger.debug(`LIKE fallback returned ${fallbackRows.length} results`);
  return fallbackRows.map((row) => ({
    content: row.content,
    documentTitle: row.document_title,
    similarity: 0.1,
    chunkIndex: row.chunk_index,
    searchMethod: "keyword" as const,
  }));
}

// ─── Основной поиск ───

export async function searchKnowledgeBase(
  query: string,
  topK: number = 5,
  threshold: number = 0.3,
  projectId?: string | null
): Promise<SearchResult[]> {
  let queryEmbedding: number[] | null = null;

  try {
    queryEmbedding = await getQueryEmbedding(query);
  } catch {
    logger.warn("Could not get query embedding, using keyword search");
  }

  if (queryEmbedding) {
    try {
      const embeddingStr = `[${queryEmbedding.join(",")}]`;
      const results = projectId
        ? await db.execute(sql`
            SELECT c.content, c.chunk_index, d.title as document_title,
                   1 - (c.embedding <=> ${embeddingStr}::vector) as similarity
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.embedding IS NOT NULL AND d.project_id = ${projectId}::uuid
            ORDER BY c.embedding <=> ${embeddingStr}::vector LIMIT ${topK}
          `)
        : await db.execute(sql`
            SELECT c.content, c.chunk_index, d.title as document_title,
                   1 - (c.embedding <=> ${embeddingStr}::vector) as similarity
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.embedding IS NOT NULL
            ORDER BY c.embedding <=> ${embeddingStr}::vector LIMIT ${topK}
          `);

      const rows = toRows(results);
      const filtered = rows
        .filter((row) => parseFloat(String(row.similarity ?? 0)) >= threshold)
        .map((row) => ({
          content: row.content,
          documentTitle: row.document_title,
          similarity: parseFloat(String(row.similarity ?? 0)),
          chunkIndex: row.chunk_index,
          searchMethod: "vector" as const,
        }));

      if (filtered.length > 0) {
        logger.debug(`pgvector search returned ${filtered.length} results`);
        return filtered;
      }
    } catch (err) {
      logger.warn("pgvector search failed, using keyword fallback:", err);
    }
  }

  return keywordSearchAsync(query, topK, projectId);
}

// ─── YandexGPT Generation ───

async function generateWithYandex(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): Promise<string> {
  const { yandexApiKey, yandexFolderId, yandexChatModel } = aiConfig;

  // YandexGPT требует IAM-токен или API-ключ
  const messages = [];

  // Системная инструкция — через отдельное поле
  const response = await fetch(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${yandexApiKey}`,
        "x-folder-id": yandexFolderId,
      },
      body: JSON.stringify({
        modelUri: `gpt://${yandexFolderId}/${yandexChatModel}/latest`,
        completionOptions: {
          stream: false,
          temperature: 0.6,
          maxTokens: 2000,
        },
        messages: [
          {
            role: "system",
            text: systemPrompt,
          },
          ...conversationHistory.map((msg) => ({
            role: msg.role === "user" ? "user" : "assistant",
            text: msg.content,
          })),
          {
            role: "user",
            text: userMessage,
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`YandexGPT error: ${response.status} - ${err}`);
  }

  const data = (await response.json()) as {
    result?: { alternatives?: Array<{ message?: { text?: string } }> };
  };
  return data.result?.alternatives?.[0]?.message?.text || "";
}

// ─── Gemini Generation ───

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryGeminiModel(
  modelName: string,
  systemInstruction: string,
  history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
  message: string,
  retries: number = 2
): Promise<string> {
  const genAI = new GoogleGenerativeAI(aiConfig.geminiApiKey);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const chat = model.startChat({
        systemInstruction: { role: "user", parts: [{ text: systemInstruction }] },
        history,
      });
      const result = await chat.sendMessage(message);
      logger.debug(`Using Gemini model: ${modelName}${attempt > 0 ? ` (retry ${attempt})` : ""}`);
      return result.response.text();
    } catch (err: unknown) {
      const geminiErr = err as GeminiApiError;
      const status = geminiErr?.status ?? 0;
      if (status === 400) throw err;
      if (attempt < retries) {
        let delay: number;
        // Gemini возвращает Retry-After в секундах — уважаем его
        const retryAfterRaw = geminiErr?.headers?.get?.("retry-after") ?? geminiErr?.headers?.["retry-after"];
        const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
        if (!isNaN(retryAfterSec)) {
          delay = retryAfterSec * 1000;
          logger.warn(`Gemini ${modelName} rate-limited (${status}), Retry-After: ${retryAfterSec}s, ждём...`);
        } else {
          delay = 3000 * (attempt + 1);
          logger.warn(`Gemini ${modelName} failed (${status}), retrying in ${delay}ms...`);
        }
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function generateWithGemini(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): Promise<string> {
  const historyParts = conversationHistory.map((msg) => ({
    role: msg.role === "user" ? "user" as const : "model" as const,
    parts: [{ text: msg.content }],
  }));

  for (const modelName of aiConfig.geminiChatModels) {
    try {
      return await tryGeminiModel(modelName, systemPrompt, historyParts, userMessage);
    } catch {
      continue;
    }
  }
  throw new Error("Все Gemini модели заняты. Попробуйте через минуту.");
}

// ─── Общий хелпер: собрать userMessage ───

function buildUserMessage(query: string, context: SearchResult[]): string {
  const contextText = context
    .map((c, i) => `[Источник ${i + 1}: ${c.documentTitle}]${c.content}`)
    .join("");
  return `Контекст из документации: ${contextText} Вопрос пользователя: ${query} Ответь на вопрос, ИСПОЛЬЗУЯ информацию из контекста выше. Если информация есть — обязательно ответь.`;
}

// ─── Унифицированная генерация (не-стриминг) ───

export async function generateAnswer(
  query: string,
  context: SearchResult[],
  conversationHistory: { role: string; content: string }[] = []
): Promise<{ answer: string; sources: SearchResult[] }> {
  const userMessage = buildUserMessage(query, context);
  logger.debug(`Using AI provider: ${aiConfig.provider}`);

  let answer: string;
  try {
    if (aiConfig.isYandex) {
      answer = await generateWithYandex(SYSTEM_PROMPT, conversationHistory, userMessage);
    } else {
      answer = await generateWithGemini(SYSTEM_PROMPT, conversationHistory, userMessage);
    }
  } catch (err) {
    logger.error(`Generation failed with ${aiConfig.provider}:`, err);
    answer = "Не удалось получить ответ от AI. Попробуйте через минуту.";
  }

  return { answer, sources: context };
}

// ─── Стриминг: Yandex ───

async function* streamWithYandex(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): AsyncGenerator<string> {
  const { yandexApiKey, yandexFolderId, yandexChatModel } = aiConfig;

  const response = await fetch(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${yandexApiKey}`,
        "x-folder-id": yandexFolderId,
      },
      body: JSON.stringify({
        modelUri: `gpt://${yandexFolderId}/${yandexChatModel}/latest`,
        completionOptions: { stream: true, temperature: 0.6, maxTokens: 2000 },
        messages: [
          { role: "system", text: systemPrompt },
          ...conversationHistory.map((msg) => ({
            role: msg.role === "user" ? "user" : "assistant",
            text: msg.content,
          })),
          { role: "user", text: userMessage },
        ],
      }),
    }
  );

  if (!response.ok || !response.body) {
    const err = await response.text();
    throw new Error(`YandexGPT stream error: ${response.status} - ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        const text: string = json?.result?.alternatives?.[0]?.message?.text ?? "";
        // Яндекс отдаёт накопленный текст — вычисляем дельту
        if (text.length > lastText.length) {
          yield text.slice(lastText.length);
          lastText = text;
        }
      } catch {
        // неполный JSON — ждём следующего чанка
      }
    }
  }
}

// ─── Стриминг: Gemini ───

async function* streamWithGemini(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): AsyncGenerator<string> {
  const historyParts = conversationHistory.map((msg) => ({
    role: msg.role === "user" ? ("user" as const) : ("model" as const),
    parts: [{ text: msg.content }],
  }));

  const genAI = new GoogleGenerativeAI(aiConfig.geminiApiKey);

  for (const modelName of aiConfig.geminiChatModels) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const chat = model.startChat({
        systemInstruction: { role: "user", parts: [{ text: systemPrompt }] },
        history: historyParts,
      });
      const result = await chat.sendMessageStream(userMessage);
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
      }
      return;
    } catch (err: unknown) {
      if ((err as GeminiApiError)?.status === 400) throw err;
      logger.warn(`Gemini stream failed for ${modelName}, trying next...`);
      continue;
    }
  }
  throw new Error("Все Gemini модели недоступны.");
}

// ─── Публичный стриминг-интерфейс ───

export async function* generateAnswerStream(
  query: string,
  context: SearchResult[],
  conversationHistory: { role: string; content: string }[] = []
): AsyncGenerator<string> {
  const userMessage = buildUserMessage(query, context);
  logger.debug(`Streaming with AI provider: ${aiConfig.provider}`);

  try {
    if (aiConfig.isYandex) {
      yield* streamWithYandex(SYSTEM_PROMPT, conversationHistory, userMessage);
    } else {
      yield* streamWithGemini(SYSTEM_PROMPT, conversationHistory, userMessage);
    }
  } catch (err) {
    logger.error(`Stream generation failed:`, err);
    yield "Не удалось получить ответ от AI. Попробуйте через минуту.";
  }
}
