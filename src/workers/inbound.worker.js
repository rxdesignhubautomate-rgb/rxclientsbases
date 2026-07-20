import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now, toDate } from "../utils/dates.js";

export class InboundWorker {
  constructor({ store, webhookService, notifications, intervalMs, batchSize, workerId, maxAttempts = 5, logger }) {
    this.store = store;
    this.webhookService = webhookService;
    this.notifications = notifications;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.workerId = workerId;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error({ error: error.message }, "inbound_worker_tick_failed")), this.intervalMs);
    this.timer.unref?.();
    setImmediate(() => this.tick().catch((error) => this.logger.error({ error: error.message }, "inbound_worker_start_failed")));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.store.find(COLLECTIONS.webhookEvents, {
        filters: [["orgId", "==", this.webhookService.orgId], ["processingStatus", "in", ["PENDING", "RETRY"]]],
        orderBy: ["receivedAt", "asc"],
        limit: this.batchSize
      });
      for (const event of pending.items) await this.processOne(event);
    } finally {
      this.running = false;
    }
  }

  async processOne(candidate) {
    const id = candidate.webhookEventId || candidate.id;
    const claimed = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.webhookEvents, id);
      const lockedAt = toDate(current?.lockedAt);
      const stale = !lockedAt || Date.now() - lockedAt.getTime() > 5 * 60 * 1000;
      if (!current || !["PENDING", "RETRY", "PROCESSING"].includes(current.processingStatus) || (current.processingStatus === "PROCESSING" && !stale)) return false;
      tx.update(COLLECTIONS.webhookEvents, id, {
        processingStatus: "PROCESSING",
        lockedAt: now(),
        lockedBy: this.workerId,
        attemptCount: Number(current.attemptCount || 0) + 1
      });
      return true;
    });
    if (!claimed) return;
    try {
      await this.webhookService.processEvent(id);
    } catch (error) {
      const current = await this.store.get(COLLECTIONS.webhookEvents, id);
      const attempts = Number(current?.attemptCount || 1);
      const final = attempts >= this.maxAttempts;
      await this.store.update(COLLECTIONS.webhookEvents, id, {
        processingStatus: final ? "FAILED" : "RETRY",
        lastError: sanitize(error),
        lockedAt: null,
        lockedBy: null
      });
      if (final) {
        const deadLetterId = createId("deadLetter");
        await this.store.create(COLLECTIONS.deadLetters, deadLetterId, {
          deadLetterId,
          orgId: current.orgId,
          sourceCollection: COLLECTIONS.webhookEvents,
          sourceId: id,
          originalRecord: current,
          failureReason: error.message.slice(0, 500),
          attemptCount: attempts,
          sanitizedError: sanitize(error),
          lastAttemptedAt: now(),
          manualRetryStatus: "AVAILABLE",
          createdAt: now()
        });
        await this.notifications.create(current.orgId, {
          type: "WEBHOOK_DEAD_LETTER",
          severity: "ERROR",
          title: "Webhook processing permanently failed",
          entityType: "WEBHOOK_EVENT",
          entityId: id,
          metadata: { deadLetterId }
        });
      }
    }
  }
}

function sanitize(error) {
  return { name: error.name || "Error", code: error.code || null, message: String(error.message || "Unknown error").slice(0, 500) };
}
