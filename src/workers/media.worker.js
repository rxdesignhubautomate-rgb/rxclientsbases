import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now, toDate } from "../utils/dates.js";

export class MediaWorker {
  constructor({ store, channelAccounts, media, notifications, intervalMs, batchSize, workerId, logger, maxAttempts = 5 }) {
    Object.assign(this, { store, channelAccounts, media, notifications, intervalMs, batchSize, workerId, logger, maxAttempts });
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error({ error: error.message }, "media_worker_tick_failed")), this.intervalMs);
    this.timer.unref?.();
    setImmediate(() => this.tick().catch((error) => this.logger.error({ error: error.message }, "media_worker_start_failed")));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.store.find(COLLECTIONS.automationJobs, {
        filters: [["type", "==", "MEDIA_DOWNLOAD"], ["status", "in", ["PENDING", "RETRY"]], ["nextAttemptAt", "<=", now()]],
        orderBy: ["nextAttemptAt", "asc"],
        limit: this.batchSize
      });
      for (const job of result.items) await this.processOne(job);
    } finally {
      this.running = false;
    }
  }

  async processOne(candidate) {
    const id = candidate.automationJobId || candidate.id;
    const claimed = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.automationJobs, id);
      const due = !toDate(current?.nextAttemptAt) || toDate(current.nextAttemptAt).getTime() <= Date.now();
      if (!current || !due || !["PENDING", "RETRY"].includes(current.status)) return null;
      const attemptCount = Number(current.attemptCount || 0) + 1;
      tx.update(COLLECTIONS.automationJobs, id, { status: "PROCESSING", attemptCount, lockedBy: this.workerId, lockedAt: now(), updatedAt: now() });
      return { ...current, attemptCount };
    });
    if (!claimed) return;
    try {
      const account = await this.channelAccounts.get(claimed.orgId, claimed.payload.channelAccountId);
      await this.media.downloadAndStore({ orgId: claimed.orgId, account, ...claimed.payload });
      await this.store.update(COLLECTIONS.automationJobs, id, { status: "COMPLETED", completedAt: now(), lockedAt: null, lockedBy: null, updatedAt: now() });
    } catch (error) {
      const final = claimed.attemptCount >= this.maxAttempts;
      const details = { name: error.name || "Error", message: String(error.message || error).slice(0, 500) };
      await this.store.update(COLLECTIONS.automationJobs, id, {
        status: final ? "FAILED" : "RETRY",
        nextAttemptAt: new Date(Date.now() + Math.min(60_000 * 5 ** (claimed.attemptCount - 1), 7_200_000)),
        lastError: details,
        lockedAt: null,
        lockedBy: null,
        updatedAt: now()
      });
      if (final) {
        const deadLetterId = createId("deadLetter");
        await this.store.create(COLLECTIONS.deadLetters, deadLetterId, {
          deadLetterId,
          orgId: claimed.orgId,
          sourceCollection: COLLECTIONS.automationJobs,
          sourceId: id,
          originalRecord: claimed,
          failureReason: details.message,
          attemptCount: claimed.attemptCount,
          sanitizedError: details,
          lastAttemptedAt: now(),
          manualRetryStatus: "AVAILABLE",
          createdAt: now()
        });
        await this.notifications.create(claimed.orgId, {
          type: "MEDIA_DEAD_LETTER",
          severity: "ERROR",
          title: "Media archive permanently failed",
          entityType: "MESSAGE",
          entityId: claimed.payload.messageId,
          metadata: { deadLetterId, automationJobId: id }
        });
      }
    }
  }
}
