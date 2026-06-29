// Реиндексация: пересчитывает эмбеддинги для всех чанков через провайдера из AI_PROVIDER.
// Движок владеет таблицами documents/chunks, поэтому реиндекс живёт здесь.
//
// Запуск: npm run reindex
import "dotenv/config";
import { sql, eq, inArray } from "drizzle-orm";
import { client, db } from "../src/lib/db";
import { chunks, documents } from "../src/lib/db/schema";
import { getEmbedding, aiConfig } from "../src/lib/engine";

const BATCH_SIZE = 5;
// Яндекс: до 20 rps — 500ms между батчами; Gemini: 15 rpm — 1000ms.
const DELAY_MS = aiConfig.isYandex ? 500 : 1000;

async function reindex() {
  console.log(`Provider: ${aiConfig.provider}`);
  if (aiConfig.isYandex) {
    console.log(`  doc model:   ${aiConfig.yandexDocEmbeddingModel} (256-dim)`);
    console.log(`  query model: ${aiConfig.yandexQueryEmbeddingModel} (256-dim)`);
  }
  console.log("");

  const allChunks = await db
    .select({ id: chunks.id, content: chunks.content, documentId: chunks.documentId })
    .from(chunks);

  console.log(`Найдено чанков: ${allChunks.length}`);
  if (allChunks.length === 0) {
    console.log("Нечего индексировать — загрузите документы через /api/v1/documents.");
    await client.end({ timeout: 5 });
    process.exit(0);
  }

  const docIds = [...new Set(allChunks.map((c) => c.documentId))];
  const docs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(inArray(documents.id, docIds));
  const docMap = new Map(docs.map((d) => [d.id, d.title]));

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);

    for (const chunk of batch) {
      try {
        const embedding = await getEmbedding(chunk.content);
        const embeddingStr = `[${embedding.join(",")}]`;

        await db
          .update(chunks)
          .set({ embedding: sql`${embeddingStr}::vector` })
          .where(eq(chunks.id, chunk.id));

        updated++;
        const docTitle = docMap.get(chunk.documentId) || "Unknown";
        console.log(`✓ [${updated}/${allChunks.length}] "${docTitle}" — чанк ${chunk.id.slice(0, 8)}`);
      } catch (err) {
        failed++;
        console.error(`✗ Ошибка на чанке ${chunk.id}:`, err);
      }
    }

    if (i + BATCH_SIZE < allChunks.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nГотово! Обновлено: ${updated}, ошибок: ${failed}`);
  await client.end({ timeout: 5 });
  process.exit(failed > 0 ? 1 : 0);
}

reindex().catch(async (err) => {
  console.error("Reindex failed:", err);
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
