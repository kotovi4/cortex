import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "drizzle-orm";
import {
  searchKnowledgeBase,
  generateAnswer,
  generateAnswerStream,
  shouldEscalate,
  isOperatorAvailable,
  effectiveProjectId,
} from "../lib/engine";
import { db } from "../lib/db";
import { queryLogs } from "../lib/db/schema";
import { requireApiKey } from "../middleware/auth";
import { logger } from "../lib/logger";
import type { AppEnv } from "../types";

const chat = new Hono<AppEnv>();

// Бот дал содержательный ответ (не «нет информации»).
function isAnswered(text: string): boolean {
  const noInfoPhrases = [
    "нет информации",
    "не найдено",
    "не содержит информации",
    "не удалось найти",
    "в загруженной документации нет",
    "документации нет информации",
  ];
  const lower = text.toLowerCase();
  return !noInfoPhrases.some((p) => lower.includes(p));
}

type SearchResults = Awaited<ReturnType<typeof searchKnowledgeBase>>;

function mapSources(results: SearchResults) {
  return results.map((s) => ({
    document: s.documentTitle,
    chunk: s.chunkIndex,
    similarity: s.similarity,
    excerpt: s.content.slice(0, 200) + "...",
  }));
}

async function logQuery(
  question: string,
  projectId: string | null,
  results: SearchResults,
  answered: boolean,
) {
  const topSimilarity = results.length ? results[0].similarity : null;
  try {
    await db.insert(queryLogs).values({
      question,
      projectId: projectId ?? undefined,
      topSimilarity,
      resultsCount: results.length,
      answered,
      searchMethod: topSimilarity !== null ? "vector" : "keyword",
    });
  } catch (err) {
    logger.error("logQuery failed", err);
  }
}

// POST /api/v1/chat — ответ на вопрос (JSON или SSE).
// Тенант (projectId) — из ключа. Тело: { message, stream?, history? }.
chat.post("/", requireApiKey("chat"), async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  const message = String(body.message ?? "").trim();
  if (!message) return c.json({ error: "Поле message обязательно" }, 400);

  const stream = body.stream === true;
  const history = Array.isArray(body.history)
    ? (body.history as { role: string; content: string }[])
    : [];
  // projectId: для секретного ключа — из запроса (доверенный host), для публичного — из ключа.
  const projectId = effectiveProjectId(
    tenant,
    typeof body.projectId === "string" ? body.projectId : null,
  );

  const results = await searchKnowledgeBase(message, 5, 0.3, projectId);

  if (!stream) {
    const { answer, sources } = await generateAnswer(message, results, history);
    const answered = isAnswered(answer);
    const escalated = shouldEscalate({
      isAnswered: answered,
      topSimilarity: results.length ? results[0].similarity : null,
      userMessage: message,
    });
    await logQuery(message, projectId, results, answered);
    return c.json({
      answer,
      escalated,
      operatorAvailable: escalated ? isOperatorAvailable() : undefined,
      sources: mapSources(sources),
    });
  }

  // ── SSE стриминг ──
  return streamSSE(c, async (s) => {
    let full = "";
    try {
      for await (const token of generateAnswerStream(message, results, history)) {
        full += token;
        await s.writeSSE({ data: JSON.stringify({ token }) });
      }
      const answered = isAnswered(full);
      const escalated = shouldEscalate({
        isAnswered: answered,
        topSimilarity: results.length ? results[0].similarity : null,
        userMessage: message,
      });
      await logQuery(message, projectId, results, answered);
      await s.writeSSE({
        data: JSON.stringify({
          done: true,
          escalated,
          operatorAvailable: escalated ? isOperatorAvailable() : undefined,
          sources: mapSources(results),
        }),
      });
    } catch (err) {
      logger.error("Stream error", err);
      await s.writeSSE({ data: JSON.stringify({ error: "Ошибка при генерации ответа" }) });
    }
  });
});

export default chat;
