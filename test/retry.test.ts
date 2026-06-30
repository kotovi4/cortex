import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/lib/retry";

describe("withRetry", () => {
  it("возвращает результат с первой попытки (без повторов)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("повторяет и в итоге успешен", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 1, onRetry })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("бросает после исчерпания попыток", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
