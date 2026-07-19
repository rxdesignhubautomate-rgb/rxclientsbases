import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now, toDate } from "../utils/dates.js";

export class OutboundWorker {
  constructor({ store, channelManager, channelAccounts, media, notifications, intervalMs, batchSize, maxAttempts, retryDelays, workerId, logger }) {
    this.store = store;
    this.channelManager = channelManager;
    this.channelAccounts = channelAccounts;
    this.media = media;
    this.notifications = notifications;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.retryDelays = retryDelays;
    this.workerId = workerId;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error({ error: error.message }, "outbox_worker_tick_failed")), this.intervalMs);
    this.timer.unref?.();
    setImmediate(() => this.tick().catch((error) => this.logger.error({ error: error.message }, "outbox_worker_start_failed")));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.store.find(COLLECTIONS.outbox, {
        filters: [["status", "in", ["PENDING", "RETRY"]], ["nextAttemptAt", "<=", now()]],
        orderBy: ["nextAttemptAt", "asc"],
        limit: this.batchSize
      });
      for (const record of result.items) await this.processOne(record);
    } finally {
      this.running = false;
    }
  }

  async processOne(candidate) {
    const id = candidate.outboxId || candidate.id;
    const claimed = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.outbox, id);
      const due = !toDate(current?.nextAttemptAt) || toDate(current.nextAttemptAt).getTime() <= Date.now();
      const lockedAt = toDate(current?.lockedAt);
      const stale = !lockedAt || Date.now() - lockedAt.getTime() > 5 * 60 * 1000;
      if (!current || !due || !["PENDING", "RETRY", "PROCESSING"].includes(current.status) || (current.status === "PROCESSING" && !stale)) return null;
      const attemptCount = Number(current.attemptCount || 0) + 1;
      tx.update(COLLECTIONS.outbox, id, { status: "PROCESSING", attemptCount, lockedAt: now(), lockedBy: this.workerId, updatedAt: now() });
      tx.update(COLLECTIONS.messages, current.messageId, { status: "SENDING", updatedAt: now() });
      return { ...current, attemptCount };
    });
    if (!claimed) return;
    try {
      const [message, account] = await Promise.all([
        this.store.get(COLLECTIONS.messages, claimed.messageId),
        this.channelAccounts.get(claimed.orgId, claimed.channelAccountId)
      ]);
      if (!message) throw permanentError("Outbound message no longer exists", "MESSAGE_NOT_FOUND");
      if (account.status !== "ACTIVE" || account.sendEnabled !== true) throw permanentError("Channel account is disabled", "ACCOUNT_DISABLED");
      const attachments = await this.media.prepareForSend(claimed.orgId, message.attachmentIds || []);
      const result = await this.channelManager.send({ account, message, attachments });
      await this.store.runTransaction(async (tx) => {
        tx.update(COLLECTIONS.messages, message.messageId, {
          status: "SENT",
          providerMessageId: result.providerMessageId,
          errorCode: null,
          errorMessage: null,
          updatedAt: now()
        });
        tx.update(COLLECTIONS.outbox, id, {
          status: "SENT",
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          sentAt: now(),
          updatedAt: now()
        });
      });
    } catch (error) {
      await this.failOrRetry(claimed, error);
    }
  }

  async failOrRetry(record, error) {
    const permanent = error.retryable === false;
    const final = permanent || record.attemptCount >= this.maxAttempts;
    const details = sanitize(error);
    if (!final) {
      const delay = this.retryDelays[Math.min(record.attemptCount, this.retryDelays.length - 1)] || 60_000;
      await this.store.runTransaction(async (tx) => {
        tx.update(COLLECTIONS.outbox, record.outboxId, {
          status: "RETRY",
          nextAttemptAt: new Date(Date.now() + delay),
          lockedAt: null,
          lockedBy: null,
          lastError: details,
          updatedAt: now()
        });
        tx.update(COLLECTIONS.messages, record.messageId, {
          status: "QUEUED",
          errorCode: details.code,
          errorMessage: details.message,
          updatedAt: now()
        });
      });
      return;
    }
    const deadLetterId = createId("deadLetter");
    await this.store.runTransaction(async (tx) => {
      tx.update(COLLECTIONS.outbox, record.outboxId, { status: "FAILED", lockedAt: null, lockedBy: null, lastError: details, updatedAt: now() });
      tx.update(COLLECTIONS.messages, record.messageId, { status: "FAILED", errorCode: details.code, errorMessage: details.message, updatedAt: now() });
      tx.create(COLLECTIONS.deadLetters, deadLetterId, {
        deadLetterId,
        orgId: record.orgId,
        sourceCollection: COLLECTIONS.outbox,
        sourceId: record.outboxId,
        originalRecord: record,
        failureReason: details.message,
        attemptCount: record.attemptCount,
        sanitizedError: details,
        lastAttemptedAt: now(),
        manualRetryStatus: "AVAILABLE",
        createdAt: now()
      });
    });
    await this.notifications.create(record.orgId, {
      type: "OUTBOX_DEAD_LETTER",
      severity: "ERROR",
      title: "Outgoing message permanently failed",
      entityType: "MESSAGE",
      entityId: record.messageId,
      metadata: { deadLetterId, outboxId: record.outboxId }
    });
  }
}

function permanentError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function sanitize(error) {
  return { name: error.name || "Error", code: String(error.code || "CHANNEL_ERROR"), message: String(error.message || "Unknown error").slice(0, 500), retryable: error.retryable !== false };
}
