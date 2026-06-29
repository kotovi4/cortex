import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { db } from "./lib/db";
import { logger } from "./lib/logger";
import chat from "./routes/chat";
import documents from "./routes/documents";
import analytics from "./routes/analytics";
import search from "./routes/search";
import generate from "./routes/generate";

const app = new Hono();

// CORS: allowlist origin'ов поверхностей (виджет/Quotcat); "*" — только dev.
const corsOrigins = (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim());
app.use(
  "*",
  cors({
    origin: corsOrigins.length === 1 && corsOrigins[0] === "*" ? "*" : corsOrigins,
    allowHeaders: ["Content-Type", "X-API-Key"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

// Readiness: проверка БД.
app.get("/health", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ status: "ok", provider: process.env.AI_PROVIDER ?? "yandex" });
  } catch {
    return c.json({ status: "degraded", error: "db unreachable" }, 503);
  }
});

// Контракт движка.
app.route("/api/v1/chat", chat);
app.route("/api/v1/documents", documents);
app.route("/api/v1/analytics", analytics);
// Низкоуровневые примитивы для доверенных серверных поверхностей (секретный ключ):
app.route("/api/v1/search", search);
app.route("/api/v1/generate", generate);

const addr = process.env.SERVER_ADDRESS ?? "0.0.0.0:8080";
const lastColon = addr.lastIndexOf(":");
const hostname = lastColon > 0 ? addr.slice(0, lastColon) : "0.0.0.0";
const port = Number(lastColon > 0 ? addr.slice(lastColon + 1) : addr) || 8080;

serve({ fetch: app.fetch, hostname, port }, (info) => {
  logger.info(`cortex engine listening on http://${hostname}:${info.port} (provider=${process.env.AI_PROVIDER ?? "yandex"})`);
});
