import { Hono } from "hono";
import { sql, eq, desc } from "drizzle-orm";
import { chunkText, getEmbedding, extractTextFromPdf, effectiveProjectId } from "../lib/engine";
import { db } from "../lib/db";
import { documents, chunks } from "../lib/db/schema";
import { requireApiKey } from "../middleware/auth";
import { logger } from "../lib/logger";
import mammoth from "mammoth";
import type { AppEnv } from "../types";

const route = new Hono<AppEnv>();

const ABSOLUTE_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB hard cap

// Извлекает текст из файла по типу.
async function extractContent(file: File): Promise<string> {
  const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
  const mime = file.type || "text/plain";
  if (ext === ".pdf" || mime === "application/pdf") {
    return extractTextFromPdf(await file.arrayBuffer());
  }
  if (
    ext === ".docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(await file.arrayBuffer()) });
    return result.value;
  }
  return file.text();
}

// Разбивает текст на чанки, считает эмбеддинги и сохраняет документ + чанки атомарно.
async function ingest(opts: {
  projectId: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  content: string;
}) {
  const textChunks = chunkText(opts.content, { chunkSize: 800, overlap: 200 });

  // Последовательно с лёгким троттлингом — параллельный залп упирается в rps Yandex
  // (тогда срабатывает hash-fallback и качество поиска падает).
  let embeddingFailures = 0;
  const embeddings: (number[] | null)[] = [];
  for (const ch of textChunks) {
    try {
      embeddings.push(await getEmbedding(ch.content));
    } catch {
      embeddingFailures++;
      embeddings.push(null);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  let docId = "";
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(documents)
      .values({
        title: opts.title,
        fileName: opts.fileName,
        mimeType: opts.mimeType,
        content: opts.content,
        chunkCount: textChunks.length,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      })
      .returning({ id: documents.id });
    docId = inserted.id;

    for (let i = 0; i < textChunks.length; i++) {
      const ch = textChunks[i];
      const emb = embeddings[i];
      const meta = JSON.stringify({ charCount: ch.content.length });
      if (emb) {
        const embStr = `[${emb.join(",")}]`;
        await tx.execute(sql`
          INSERT INTO chunks (id, document_id, content, chunk_index, embedding, metadata, created_at)
          VALUES (gen_random_uuid(), ${docId}, ${ch.content}, ${ch.index}, ${embStr}::vector, ${meta}::jsonb, now())
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO chunks (id, document_id, content, chunk_index, metadata, created_at)
          VALUES (gen_random_uuid(), ${docId}, ${ch.content}, ${ch.index}, ${meta}::jsonb, now())
        `);
      }
    }
  });

  return { id: docId, chunkCount: textChunks.length, embeddingFailures };
}

// POST /api/v1/documents — загрузка документа.
//   multipart/form-data: поле file (+ опц. title)
//   application/json:    { text, title }
// projectId берётся из ключа.
route.post("/", requireApiKey("documents"), async (c) => {
  const tenant = c.get("tenant");
  const contentType = c.req.header("content-type") ?? "";

  try {
    let content: string;
    let title: string;
    let fileName: string;
    let mimeType: string;
    let requestedProjectId: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) {
        return c.json({ error: "Файл не предоставлен (поле file)" }, 400);
      }
      if (file.size > ABSOLUTE_MAX_FILE_SIZE) {
        return c.json({ error: "Файл слишком большой (максимум 25 МБ)" }, 400);
      }
      content = await extractContent(file);
      title = (body["title"] as string) || file.name;
      fileName = file.name;
      mimeType = file.type || "text/plain";
      requestedProjectId = typeof body["projectId"] === "string" ? body["projectId"] : null;
    } else {
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
      if (body.url) {
        return c.json({ error: "Загрузка по URL пока не реализована в этом сервисе" }, 501);
      }
      content = String(body.text ?? "");
      title = String(body.title ?? "Untitled");
      fileName = typeof body.fileName === "string" ? body.fileName : `${title}.txt`;
      mimeType = typeof body.mimeType === "string" ? body.mimeType : "text/plain";
      requestedProjectId = typeof body.projectId === "string" ? body.projectId : null;
    }

    if (!content.trim()) {
      return c.json({ error: "Не удалось извлечь текст из документа" }, 400);
    }

    const result = await ingest({
      projectId: effectiveProjectId(tenant, requestedProjectId),
      title,
      fileName,
      mimeType,
      content,
    });

    return c.json(
      {
        id: result.id,
        title,
        chunkCount: result.chunkCount,
        embeddingFailures: result.embeddingFailures,
        message: `Документ загружен и разбит на ${result.chunkCount} чанков`,
      },
      201,
    );
  } catch (err) {
    logger.error("Document upload error", err);
    return c.json({ error: "Ошибка при загрузке документа" }, 500);
  }
});

// GET /api/v1/documents — список документов тенанта.
route.get("/", requireApiKey("documents"), async (c) => {
  const tenant = c.get("tenant");
  const projectId = effectiveProjectId(tenant, c.req.query("projectId"));
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      chunkCount: documents.chunkCount,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(projectId ? eq(documents.projectId, projectId) : sql`true`)
    .orderBy(desc(documents.createdAt))
    .limit(200);
  return c.json({ documents: rows });
});

// GET /api/v1/documents/:id — содержимое документа.
route.get("/:id", requireApiKey("documents"), async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("id");
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "Документ не найден" }, 404);
  const projectId = effectiveProjectId(tenant, c.req.query("projectId"));
  if (projectId && doc.projectId !== projectId) {
    return c.json({ error: "Нет доступа к документу" }, 403);
  }
  return c.json({ document: doc });
});

export default route;
