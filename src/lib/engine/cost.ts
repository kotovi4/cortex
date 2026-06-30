/**
 * Оценка стоимости LLM-операции в рублях по числу токенов.
 * Яндекс тарифицирует промпт+ответ СУММАРНО. Тарифы — через env (уточнить в
 * биллинге Yandex Cloud); дефолты — ориентир, а не гарантированная цена.
 */
function ratePer1k(model: string): number {
  const lite = Number(process.env.YANDEX_LITE_RUB_PER_1K ?? "0.20");
  const pro = Number(process.env.YANDEX_PRO_RUB_PER_1K ?? "1.20");
  return model.includes("lite") ? lite : pro;
}

/** Стоимость в ₽ за вызов модели `model` с `totalTokens` суммарных токенов. */
export function estimateCostRub(model: string | null, totalTokens: number): number {
  if (!model || !totalTokens) return 0;
  return (totalTokens / 1000) * ratePer1k(model);
}
