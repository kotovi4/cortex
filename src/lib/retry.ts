/** Повтор с экспоненциальной задержкой — для транзиентных сбоев (LLM/сеть). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      opts.onRetry?.(err, i);
      await new Promise((r) => setTimeout(r, base * 2 ** (i - 1)));
    }
  }
  throw lastErr;
}
