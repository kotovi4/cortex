/**
 * Разбивает текст на чанки с перекрытием для RAG
 */

export interface Chunk {
  content: string;
  index: number;
  metadata?: Record<string, unknown>;
}

export function chunkText(
  text: string,
  options: {
    chunkSize?: number;
    overlap?: number;
    separator?: string;
  } = {}
): Chunk[] {
  const {
    chunkSize = 800,
    overlap = 200,
    separator = "\n\n",
  } = options;

  // Сначала бьём по параграфам
  const paragraphs = text.split(separator).filter((p) => p.trim().length > 0);

  const chunks: Chunk[] = [];
  let currentChunk = "";
  let chunkIndex = 0;

  for (const para of paragraphs) {
    // Если один параграф слишком длинный — бьём по предложениям
    if (para.length > chunkSize) {
      if (currentChunk.trim()) {
        chunks.push({ content: currentChunk.trim(), index: chunkIndex++ });
        // Перекрытие: берём конец предыдущего чанка
        const overlapText = currentChunk.slice(-overlap);
        currentChunk = overlapText;
      }
      // Бьём длинный параграф по предложениям
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      for (const sentence of sentences) {
        if ((currentChunk + " " + sentence).length > chunkSize) {
          if (currentChunk.trim()) {
            chunks.push({ content: currentChunk.trim(), index: chunkIndex++ });
            const overlapText = currentChunk.slice(-overlap);
            currentChunk = overlapText;
          }
        }
        currentChunk += " " + sentence;
      }
    } else if ((currentChunk + separator + para).length > chunkSize) {
      // Текущий чанк полон — сохраняем
      chunks.push({ content: currentChunk.trim(), index: chunkIndex++ });
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + separator + para;
    } else {
      currentChunk = currentChunk ? currentChunk + separator + para : para;
    }
  }

  // Последний чанк
  if (currentChunk.trim()) {
    chunks.push({ content: currentChunk.trim(), index: chunkIndex++ });
  }

  return chunks;
}
