import { Hono } from "hono";
import { sql, eq, desc } from "drizzle-orm";
import { db } from "../lib/db";
import { queryLogs } from "../lib/db/schema";
import { requireApiKey } from "../middleware/auth";
import { effectiveProjectId } from "../lib/engine";
import type { AppEnv } from "../types";

const route = new Hono<AppEnv>();

// GET /api/v1/analytics — метрики покрытия по логам запросов тенанта.
// «Закрытые обращения» = язык, на котором платят (раздел 4, Quotcat).
route.get("/", requireApiKey("analytics"), async (c) => {
  const tenant = c.get("tenant");
  const projectId = effectiveProjectId(tenant, c.req.query("projectId"));
  const scope = projectId ? eq(queryLogs.projectId, projectId) : sql`true`;

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${queryLogs.answered} = true)::int`,
      unanswered: sql<number>`count(*) filter (where ${queryLogs.answered} = false)::int`,
      avgTopSimilarity: sql<number | null>`avg(${queryLogs.topSimilarity})`,
    })
    .from(queryLogs)
    .where(scope);

  const total = agg?.total ?? 0;
  const answered = agg?.answered ?? 0;

  const recent = await db
    .select({
      question: queryLogs.question,
      answered: queryLogs.answered,
      topSimilarity: queryLogs.topSimilarity,
      searchMethod: queryLogs.searchMethod,
      createdAt: queryLogs.createdAt,
    })
    .from(queryLogs)
    .where(scope)
    .orderBy(desc(queryLogs.createdAt))
    .limit(20);

  return c.json({
    total,
    answered,
    unanswered: agg?.unanswered ?? 0,
    coverageRate: total > 0 ? Number((answered / total).toFixed(4)) : null,
    avgTopSimilarity: agg?.avgTopSimilarity ?? null,
    recent,
  });
});

export default route;
