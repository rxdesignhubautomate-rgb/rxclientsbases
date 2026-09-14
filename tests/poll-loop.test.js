import { afterEach, describe, expect, it, vi } from "vitest";
import { isQuotaExceeded, PollLoop } from "../src/workers/poll-loop.js";

describe("worker poll loop", () => {
  afterEach(() => vi.useRealTimers());
  it("drains a full batch after 250ms instead of waiting another polling interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const loop = new PollLoop({ run, intervalMs: 15000, logger: { error: vi.fn() } });
    loop.start(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(run).toHaveBeenCalledTimes(2);
    loop.wake(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(3);
    loop.stop(); loop.wake(); await vi.advanceTimersByTimeAsync(15000); expect(run).toHaveBeenCalledTimes(3);
  });

  it("coalesces wake-ups while a worker is busy without overlapping executions", async () => {
    vi.useFakeTimers(); let finish;
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(false);
    const loop = new PollLoop({ run, intervalMs: 15000, logger: { error: vi.fn() } });
    loop.start(); await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) loop.wake();
    await vi.advanceTimersByTimeAsync(15000); expect(run).toHaveBeenCalledTimes(1);
    finish(false); await vi.advanceTimersByTimeAsync(250); expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("does not let new traffic bypass quota backoff", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED')).mockResolvedValue(false);
    const loop = new PollLoop({ run, intervalMs: 15000, logger: { error: vi.fn() } });
    loop.start(); await vi.advanceTimersByTimeAsync(0);
    loop.wake(); await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(840000); expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });
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
