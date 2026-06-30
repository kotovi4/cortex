import { describe, it, expect, vi, afterEach } from "vitest";
import { extractProduct } from "../src/lib/engine/extractProduct";
import type { FetchedPage } from "../src/lib/engine/pageFetch";

const page: FetchedPage = {
  url: "https://shop.example/p1",
  title: "Сканер",
  text: "Описание сканера",
  ldjson: [],
  openGraph: {},
};

// Мокаем ответ YandexGPT (AI_PROVIDER=yandex в vitest.config) формой { result: { alternatives: [...] } }.
function mockYandex(text: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ result: { alternatives: [{ message: { text } }] } }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("extractProduct", () => {
  it("парсит JSON в ```json-ограждении и приводит типы", async () => {
    const llm =
      "```json\n" +
      JSON.stringify({
        name: "Сканер X",
        price: "154 900 ₽",
        currency: "RUB",
        sku: "A1",
        specs: { вес: "2кг", портов: 4 },
        images: ["https://x/i.jpg", 123],
        description: "desc",
      }) +
      "\n```";
    vi.stubGlobal("fetch", mockYandex(llm));

    const { product: p } = await extractProduct(page);
    expect(p.name).toBe("Сканер X");
    expect(p.price).toBe(154900); // строка с пробелами/валютой → число
    expect(p.currency).toBe("RUB");
    expect(p.sku).toBe("A1");
    expect(p.specs).toEqual({ вес: "2кг", портов: "4" }); // значения → строки
    expect(p.images).toEqual(["https://x/i.jpg"]); // не-строки отфильтрованы
    expect(p.description).toBe("desc");
    expect(p.sourceUrl).toBe("https://shop.example/p1"); // всегда из страницы, не из модели
  });

  it("отсутствующие поля → null / [] / {}", async () => {
    vi.stubGlobal("fetch", mockYandex(JSON.stringify({ name: null, images: null, specs: null })));
    const { product: p } = await extractProduct(page);
    expect(p.name).toBeNull();
    expect(p.price).toBeNull();
    expect(p.images).toEqual([]);
    expect(p.specs).toEqual({});
  });

  it("невалидный JSON от модели → ошибка", async () => {
    vi.stubGlobal("fetch", mockYandex("извините, не смог распарсить"));
    await expect(extractProduct(page)).rejects.toThrow();
  });
});
