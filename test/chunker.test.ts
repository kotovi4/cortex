import { describe, it, expect } from "vitest";
import { chunkText } from "../src/lib/engine/chunker";

describe("chunkText", () => {
  it("короткий текст → один чанк, индекс 0", () => {
    const chunks = chunkText("Небольшой текст про товар.");
    expect(chunks.length).toBe(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toContain("товар");
  });

  it("пустой текст → нет чанков", () => {
    expect(chunkText("   ")).toHaveLength(0);
  });

  it("длинный текст → несколько чанков с последовательными индексами", () => {
    const para = "Параграф ".repeat(80); // ~720 символов
    const text = Array.from({ length: 6 }, (_, i) => `${para} (${i})`).join("\n\n");
    const chunks = chunkText(text, { chunkSize: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.content.length).toBeGreaterThan(0);
    });
  });
});
