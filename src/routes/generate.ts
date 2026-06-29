import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { generateAnswer, generateAnswerStream } from "../lib/engine";
import { requireApiKey } from "../middleware/auth";
import { logger } from "../lib/logger";
import type { AppEnv } from "../types";

const route = new Hono<AppEnv>();

type Ctx = Parameters<typeof generateAnswer>[1];
type Msg = { role: string; content: string };

// POST /api/v1/generate — низкоуровневый примитив генерации ответа поверх переданного
// контекста (для доверенных серверных поверхностей). Только секретный ключ.
// Тело: { query, context: SearchResult[], history?, stream? }.
//   stream:true  → SSE токены (как generateAnswerStream)
//   иначе        → { answer, sources }
route.post("/", requireApiKey("chat"), async (c) => {
  const tenant = c.get("tenant");
  if (tenant.type !== "secret") {
    return c.json({ error: "Примитив доступен только секретному ключу" }, 403);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const query = String(body.query ?? "").trim();
  if (!query) return c.json({ error: "Поле query обязательно" }, 400);

  const context = (Array.isArray(body.context) ? body.context : []) as Ctx;
  const history = (Array.isArray(body.history) ? body.history : []) as Msg[];
  const stream = body.stream === true;

  if (!stream) {
    const { answer, sources } = await generateAnswer(query, context, history);
    return c.json({ answer, sources });
  }

  return streamSSE(c, async (s) => {
    try {
      for await (const token of generateAnswerStream(query, context, history)) {
        await s.writeSSE({ data: JSON.stringify({ token }) });
      }
      await s.writeSSE({ data: JSON.stringify({ done: true }) });
    } catch (err) {
      logger.error("generate stream error", err);
      await s.writeSSE({ data: JSON.stringify({ error: "Ошибка при генерации" }) });
    }
  });
});

export default route;
