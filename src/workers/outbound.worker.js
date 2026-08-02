import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now, toDate } from "../utils/dates.js";
import { PollLoop } from "./poll-loop.js";

const MEDIA_MESSAGE_TYPES = ["IMAGE", "DOCUMENT", "VIDEO", "AUDIO"];

export class OutboundWorker {
  constructor({ store, channelManager, channelAccounts, media, notifications, intervalMs, batchSize, maxAttempts, retryDelays, campaignDelayMs = 0, workerId, logger }) {
    this.store = store;
    this.channelManager = channelManager;
    this.channelAccounts = channelAccounts;
    this.media = media;
    this.notifications = notifications;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.retryDelays = retryDelays;
    this.campaignDelayMs = campaignDelayMs;
    this.workerId = workerId;
    this.logger = logger;
    this.loop = new PollLoop({
      run: () => this.tick(),
      intervalMs,
      logger,
      errorMessage: "outbox_worker_tick_failed"
    });
    this.running = false;
  }

  start() {
    this.loop.start();
  }

  stop() {
    this.loop.stop();
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
      const templateHeader = message.type === "TEMPLATE" ? message.metadata?.templateHeader : null;
      if (MEDIA_MESSAGE_TYPES.includes(message.type) || templateHeader?.type) {
        for (const attachment of attachments) {
          try {
            attachment.providerMediaId = await this.media.ensureProviderMediaId({
              orgId: claimed.orgId,
              account,
              attachment
            });
          } catch (uploadError) {
            safeWarn(this.logger, {
              attachmentId: attachment.attachmentId,
              code: uploadError.code,
              message: uploadError.message
            }, "media_upload_to_meta_failed_falling_back_to_link");
          }
        }
      }
      if (templateHeader?.type) attachTemplateHeader(message, attachments[0], templateHeader);
      const result = await this.channelManager.send({ account, message, attachments });
      const decisionAudits = await this.store.find(COLLECTIONS.messageAuditLogs, {
        filters: [["messageId", "==", message.messageId]],
        limit: 5
      });
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
        if (message.metadata?.messageDecisionKey) {
          tx.update(COLLECTIONS.messageDecisionKeys, message.metadata.messageDecisionKey, {
            status: "SENT",
            metaMessageId: result.providerMessageId,
            sentAt: now(),
            updatedAt: now()
          });
        }
        for (const audit of decisionAudits.items.filter((item) => item.orgId === claimed.orgId)) {
          tx.update(COLLECTIONS.messageAuditLogs, audit.messageAuditLogId || audit.id, {
            sent: true,
            queued: false,
            metaMessageId: result.providerMessageId,
            sentAt: now()
          });
        }
      });
      if (message.metadata?.campaignId && this.campaignDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.campaignDelayMs));
      }
    } catch (error) {
      await this.failOrRetry(claimed, error);
    }
  }

  async failOrRetry(record, error) {
    const permanent = error.retryable === false;
    const final = permanent || record.attemptCount >= this.maxAttempts;
    const details = sanitize(error);
    safeWarn(this.logger, {
      code: details.code,
      message: details.message,
      messageId: record.messageId,
      attemptCount: record.attemptCount,
      final
    }, "outbound_send_failed");
    const message = await this.store.get(COLLECTIONS.messages, record.messageId);
    const decisionAudits = await this.store.find(COLLECTIONS.messageAuditLogs, {
      filters: [["messageId", "==", record.messageId]],
      limit: 5
    });
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
        if (message?.metadata?.messageDecisionKey) {
          tx.update(COLLECTIONS.messageDecisionKeys, message.metadata.messageDecisionKey, {
            status: "RETRY",
            lastError: details,
            updatedAt: now()
          });
        }
        for (const audit of decisionAudits.items.filter((item) => item.orgId === record.orgId)) {
          tx.update(COLLECTIONS.messageAuditLogs, audit.messageAuditLogId || audit.id, {
            queued: true,
            errorCode: details.code,
            errorMessage: details.message,
            updatedAt: now()
          });
        }
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
      if (message?.metadata?.messageDecisionKey) {
        tx.update(COLLECTIONS.messageDecisionKeys, message.metadata.messageDecisionKey, {
          status: "FAILED",
          lastError: details,
          updatedAt: now()
        });
      }
      for (const audit of decisionAudits.items.filter((item) => item.orgId === record.orgId)) {
        tx.update(COLLECTIONS.messageAuditLogs, audit.messageAuditLogId || audit.id, {
          sent: false,
          queued: false,
          errorCode: details.code,
          errorMessage: details.message,
          updatedAt: now()
        });
      }
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

function safeWarn(logger, fields, message) {
  try {
    logger?.warn(fields, message);
  } catch {
    // Logging must never change delivery or retry behaviour.
  }
}

function attachTemplateHeader(message, attachment, header) {
  if (!attachment) {
    throw permanentError(`The approved ${String(header.type).toLowerCase()} template needs an uploaded header file`, "TEMPLATE_HEADER_MEDIA_REQUIRED");
  }
  const type = String(header.type || "").toLowerCase();
  if (!["image", "video", "document"].includes(type)) {
    throw permanentError("Unsupported Meta template header media type", "TEMPLATE_HEADER_MEDIA_UNSUPPORTED");
  }
  const media = attachment.providerMediaId
    ? { id: attachment.providerMediaId }
    : attachment.signedUrl
      ? { link: attachment.signedUrl }
      : null;
  if (!media) throw permanentError("Template header media is unavailable", "TEMPLATE_HEADER_MEDIA_UNAVAILABLE");
  const template = message.metadata?.template;
  if (!template) throw permanentError("Template message metadata is unavailable", "TEMPLATE_METADATA_REQUIRED");
  const components = Array.isArray(template.components)
    ? template.components.filter((component) => String(component?.type || "").toLowerCase() !== "header")
    : [];
  message.metadata = {
    ...(message.metadata || {}),
    template: {
      ...template,
      components: [{ type: "header", parameters: [{ type, [type]: media }] }, ...components]
    }
  };
}
