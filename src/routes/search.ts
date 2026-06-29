import { Hono } from "hono";
import { searchKnowledgeBase, effectiveProjectId } from "../lib/engine";
import { requireApiKey } from "../middleware/auth";
import type { AppEnv } from "../types";

const route = new Hono<AppEnv>();

// POST /api/v1/search — низкоуровневый примитив поиска (для доверенных серверных
// поверхностей: монолит/бэкенд Quotcat сами оркестрируют ответ). Только секретный ключ.
// Тело: { query, topK?, threshold?, projectId? }. Возвращает { results: SearchResult[] }.
route.post("/", requireApiKey("chat"), async (c) => {
  const tenant = c.get("tenant");
  if (tenant.type !== "secret") {
    return c.json({ error: "Примитив доступен только секретному ключу" }, 403);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const query = String(body.query ?? "").trim();
  if (!query) return c.json({ error: "Поле query обязательно" }, 400);

  const topK = typeof body.topK === "number" ? body.topK : 5;
  const threshold = typeof body.threshold === "number" ? body.threshold : 0.3;
  const projectId = effectiveProjectId(
    tenant,
    typeof body.projectId === "string" ? body.projectId : null,
  );

  const results = await searchKnowledgeBase(query, topK, threshold, projectId);
  return c.json({ results });
});

export default route;
