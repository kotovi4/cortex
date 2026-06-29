import { aiConfig } from "./ai-provider";
import { logger } from "../logger";

// ─── Yandex Embeddings ───
// Яндекс требует разные модели для документов и запросов — это повышает качество поиска

async function getYandexEmbedding(text: string, modelType: "doc" | "query"): Promise<number[]> {
  const { yandexApiKey, yandexFolderId, yandexDocEmbeddingModel, yandexQueryEmbeddingModel } = aiConfig;
  const model = modelType === "doc" ? yandexDocEmbeddingModel : yandexQueryEmbeddingModel;

  const response = await fetch(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${yandexApiKey}`,
        "x-folder-id": yandexFolderId,
      },
      body: JSON.stringify({
        modelUri: `emb://${yandexFolderId}/${model}`,
        text,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Yandex Embedding error: ${response.status} - ${err}`);
  }

  const data = (await response.json()) as { embedding?: number[] };
  if (!Array.isArray(data?.embedding)) {
    throw new Error(`Unexpected Yandex embedding response shape`);
  }
  return data.embedding as number[];
}

// ─── Gemini Embeddings ───

async function getGeminiEmbedding(text: string): Promise<number[]> {
  const { geminiApiKey, geminiEmbeddingModel } = aiConfig;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiEmbeddingModel}:embedContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${geminiEmbeddingModel}`,
        content: { parts: [{ text }] },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini Embedding error: ${response.status} - ${err}`);
  }

  const data = (await response.json()) as { embedding?: { values?: number[] } };
  if (!Array.isArray(data?.embedding?.values)) {
    throw new Error(`Unexpected Gemini embedding response shape`);
  }
  return data.embedding.values as number[];
}

// ─── Унифицированный интерфейс ───

// Для индексации документов
export async function getEmbedding(text: string): Promise<number[]> {
  try {
    if (aiConfig.isYandex) {
      return await getYandexEmbedding(text, "doc");
    }
    return await getGeminiEmbedding(text);
  } catch (err) {
    logger.warn(
      `${aiConfig.provider} embedding unavailable, using hash fallback:`,
      err
    );
    return hashBasedEmbedding(text);
  }
}

// Для поиска по запросу пользователя
export async function getQueryEmbedding(query: string): Promise<number[]> {
  try {
    if (aiConfig.isYandex) {
      return await getYandexEmbedding(query, "query");
    }
    return await getGeminiEmbedding(query);
  } catch (err) {
    logger.warn(
      `${aiConfig.provider} query embedding unavailable, using hash fallback:`,
      err
    );
    return hashBasedEmbedding(query);
  }
}

// ─── Fallback: хеш-эмбеддинг для разработки без API ───

function hashBasedEmbedding(text: string): number[] {
  // Размерность должна совпадать с колонкой chunks.embedding: Yandex — 256, Gemini — 768.
  const DIMENSIONS = aiConfig.isYandex ? 256 : 768;
  const embedding = new Array(DIMENSIONS).fill(0);

  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    embedding[i % DIMENSIONS] += charCode;
  }

  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  );
  return embedding.map((val) => val / (magnitude || 1));
}

