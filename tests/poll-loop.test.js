import { describe, expect, it, vi } from "vitest";
import { isQuotaExceeded, PollLoop } from "../src/workers/poll-loop.js";

describe("worker poll loop", () => {
  it("detects Firestore quota exhaustion", () => {
    expect(isQuotaExceeded(Object.assign(new Error("Quota exceeded."), { code: 8 }))).toBe(true);
    expect(isQuotaExceeded(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."))).toBe(true);
    expect(isQuotaExceeded(new Error("temporary network error"))).toBe(false);
  });

  it("uses a long retry delay after quota errors", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn() };
    const loop = new PollLoop({
      run: vi.fn().mockRejectedValue(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")),
      intervalMs: 15_000,
      quotaBackoffMs: 900_000,
      logger,
      errorMessage: "worker_failed"
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ retryInMs: 900_000 }),
      "worker_failed"
    );
    loop.stop();
    vi.useRealTimers();
  });
});
