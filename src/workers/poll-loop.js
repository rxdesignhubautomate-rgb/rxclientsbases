const DEFAULT_QUOTA_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 5 * 60 * 1000;

export class PollLoop {
  constructor({ run, intervalMs, logger, errorMessage, quotaBackoffMs = DEFAULT_QUOTA_BACKOFF_MS }) {
    this.run = run;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.errorMessage = errorMessage;
    this.quotaBackoffMs = quotaBackoffMs;
    this.timer = null;
    this.started = false;
    this.failureCount = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs) {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.execute();
    }, delayMs);
    this.timer.unref?.();
  }

  async execute() {
    let retryInMs = this.intervalMs;
    try {
      await this.run();
      this.failureCount = 0;
    } catch (error) {
      this.failureCount += 1;
      retryInMs = isQuotaExceeded(error)
        ? this.quotaBackoffMs
        : Math.min(this.intervalMs * 2 ** this.failureCount, DEFAULT_MAX_ERROR_BACKOFF_MS);
      this.logger.error({ error: error.message, retryInMs }, this.errorMessage);
    } finally {
      this.schedule(retryInMs);
    }
  }
}

export function isQuotaExceeded(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "").toUpperCase();
  return code === "8" || code.includes("RESOURCE_EXHAUSTED") || message.includes("RESOURCE_EXHAUSTED") || message.includes("QUOTA EXCEEDED");
}
