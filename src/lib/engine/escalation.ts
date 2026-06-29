// Логика эскалации диалога на оператора (handoff §4).
// Чистые функции — без БД, тестируются изолированно.

// Порог похожести для эскалации (применяется ТОЛЬКО к векторному поиску).
// У Yandex-эмбеддингов (256-dim) косинусная шкала сжата: релевантные ответы ≈ 0.39–0.48,
// а поиск отсекает результаты < 0.3. Поэтому дефолт = 0.3 (на уровне порога поиска):
// триггер по похожести фактически выключен, эскалация опирается на isAnswered /
// «зовут человека» / кнопку. Чтобы включить «низкая уверенность → оператор», поднимите
// значение через env (например, 0.5 для Gemini, у которого шкала выше). См. docs/13.
export const ESCALATION_SIMILARITY_THRESHOLD = Number(
  process.env.ESCALATION_SIMILARITY_THRESHOLD ?? 0.3,
);

// Визитёр явно просит живого человека.
// Подстроки основ (без \b — в JS \b не работает с кириллицей).
const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  /операт/i,      // оператор, оператора, оператору
  /менеджер/i,
  /человек/i,     // человек, человека, человеку (живой человек)
  /сотрудник/i,
];

export function wantsHuman(text: string): boolean {
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(text));
}

export interface EscalationInput {
  isAnswered: boolean;            // бот дал содержательный ответ (не «нет информации»)
  topSimilarity: number | null;  // лучший score поиска (null = keyword fallback / нет результатов)
  userMessage: string;           // последнее сообщение визитёра
  explicitEscalate?: boolean;    // визитёр нажал «позвать оператора»
}

/** Нужно ли передать диалог оператору после ответа бота. */
export function shouldEscalate({
  isAnswered,
  topSimilarity,
  userMessage,
  explicitEscalate = false,
}: EscalationInput): boolean {
  if (explicitEscalate) return true;
  if (!isAnswered) return true;
  if (wantsHuman(userMessage)) return true;
  if (topSimilarity !== null && topSimilarity < ESCALATION_SIMILARITY_THRESHOLD) return true;
  return false;
}

// Доступен ли оператор прямо сейчас (§7).
// MVP: бизнес-часы из env (по локальному времени сервера). Presence по lastSeenAt — позже.
//   OPERATOR_BUSINESS_HOURS = "9-21"  → доступен с 9:00 до 21:00 (end не включается)
//   OPERATOR_BUSINESS_DAYS  = "1-5"   → пн–пт (0=вс … 6=сб), опционально
// Если OPERATOR_BUSINESS_HOURS не задан → всегда доступен (как раньше).
export function isOperatorAvailable(now: Date = new Date()): boolean {
  const hours = process.env.OPERATOR_BUSINESS_HOURS;
  if (!hours) return true;

  const [hStart, hEnd] = hours.split("-").map((x) => parseInt(x.trim(), 10));
  if (Number.isNaN(hStart) || Number.isNaN(hEnd)) return true; // некорректный конфиг — не блокируем

  const hour = now.getHours();
  if (hour < hStart || hour >= hEnd) return false;

  const days = process.env.OPERATOR_BUSINESS_DAYS;
  if (days) {
    const [dStart, dEnd] = days.split("-").map((x) => parseInt(x.trim(), 10));
    if (!Number.isNaN(dStart) && !Number.isNaN(dEnd)) {
      const day = now.getDay();
      if (day < dStart || day > dEnd) return false;
    }
  }
  return true;
}
