import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

export class MediaService {
  constructor({ store, bucket, channelManager, channelAccounts = null }) {
    this.store = store;
    this.bucket = bucket;
    this.channelManager = channelManager;
    this.channelAccounts = channelAccounts;
  }

  async downloadAndStore({ orgId, account, contactId, conversationId, messageId, media }) {
    if (messageId) {
      const existingMessage = await this.store.get(COLLECTIONS.messages, messageId);
      if (existingMessage?.orgId === orgId && existingMessage.attachmentIds?.length) {
        return this.get(orgId, existingMessage.attachmentIds[0]);
      }
    }
    const downloaded = await this.channelManager.downloadMedia({ account, media });
    return this.storeBuffer({
      orgId,
      contactId,
      conversationId,
      messageId,
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      originalFilename: downloaded.filename,
      providerMediaId: downloaded.providerMediaId,
      expectedSha256: media.sha256
    });
  }

  async storeBuffer(input) {
    const attachmentId = createId("attachment");
    const actualHash = sha256(input.buffer);
    const extension = safeExtension(input.originalFilename);
    const storagePath = `organizations/${input.orgId}/contacts/${input.contactId}/${attachmentId}${extension}`;
    const file = this.bucket.file(storagePath);
    await file.save(input.buffer, {
      resumable: false,
      contentType: input.mimeType || "application/octet-stream",
      metadata: { metadata: { attachmentId, sha256: actualHash } }
    });
    const attachment = {
      attachmentId,
      orgId: input.orgId,
      contactId: input.contactId,
      conversationId: input.conversationId || null,
      messageId: input.messageId || null,
      storagePath,
      originalFilename: input.originalFilename || attachmentId,
      mimeType: input.mimeType || "application/octet-stream",
      sizeBytes: input.buffer.length,
      sha256: actualHash,
      providerMediaId: input.providerMediaId || null,
      providerHashMatched: input.expectedSha256 ? input.expectedSha256 === actualHash : null,
      scanStatus: "PENDING",
      createdAt: now()
    };
    await this.store.create(COLLECTIONS.attachments, attachmentId, attachment);
    if (input.messageId) {
      const message = await this.store.get(COLLECTIONS.messages, input.messageId);
      const timestamp = now();
      await this.store.update(COLLECTIONS.messages, input.messageId, {
        attachmentIds: [...new Set([...(message?.attachmentIds || []), attachmentId])],
        metadata: {
          ...(message?.metadata || {}),
          mediaArchiveStatus: "READY",
          mediaArchiveError: null
        },
        updatedAt: timestamp
      });
      const conversationId = input.conversationId || message?.conversationId;
      if (conversationId) {
        await this.store.update(COLLECTIONS.conversations, conversationId, {
          mediaUpdatedAt: timestamp,
          updatedAt: timestamp
        });
      }
    }
    return attachment;
  }

  async markMessageMediaState(orgId, messageId, status, error = null) {
    const message = await this.store.get(COLLECTIONS.messages, messageId);
    if (!message || message.orgId !== orgId) throw new NotFoundError("Message");
    const timestamp = now();
    await this.store.update(COLLECTIONS.messages, messageId, {
      metadata: {
        ...(message.metadata || {}),
        mediaArchiveStatus: status,
        mediaArchiveError: error ? String(error).slice(0, 300) : null
      },
      updatedAt: timestamp
    });
    if (message.conversationId) {
      await this.store.update(COLLECTIONS.conversations, message.conversationId, {
        mediaUpdatedAt: timestamp,
        updatedAt: timestamp
      });
    }
  }

  async retryInboundMedia(orgId, messageId) {
    const message = await this.store.get(COLLECTIONS.messages, messageId);
    if (!message || message.orgId !== orgId) throw new NotFoundError("Message");
    if (message.attachmentIds?.length) {
      return this.get(orgId, message.attachmentIds[0], { withSignedUrl: true });
    }
    if (message.direction !== "INBOUND" || !["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"].includes(message.type)) {
      throw new ConflictError("This message does not contain recoverable inbound media");
    }

    let media = message.metadata?.providerMedia || null;
    if (!media) {
      const jobs = await this.store.find(COLLECTIONS.automationJobs, {
        filters: [["orgId", "==", orgId], ["type", "==", "MEDIA_DOWNLOAD"]],
        limit: 250
      });
      media = jobs.items.find((job) => job.payload?.messageId === messageId)?.payload?.media || null;
    }
    if (!media?.providerMediaId) {
      throw new ConflictError("The original WhatsApp media reference is unavailable");
    }
    if (!this.channelAccounts) throw new ConflictError("Media recovery is not configured");

    const account = await this.channelAccounts.get(orgId, message.channelAccountId);
    await this.markMessageMediaState(orgId, messageId, "DOWNLOADING");
    try {
      const attachment = await this.downloadAndStore({
        orgId,
        account,
        contactId: message.contactId,
        conversationId: message.conversationId,
        messageId,
        media
      });
      return this.get(orgId, attachment.attachmentId, { withSignedUrl: true });
    } catch (error) {
      await this.markMessageMediaState(orgId, messageId, "FAILED", error.message);
      throw error;
    }
  }

  async get(orgId, attachmentId, { withSignedUrl = false } = {}) {
    const attachment = await this.store.get(COLLECTIONS.attachments, attachmentId);
    if (!attachment || attachment.orgId !== orgId) throw new NotFoundError("Attachment");
    if (!withSignedUrl) return attachment;
    const [signedUrl] = await this.bucket.file(attachment.storagePath).getSignedUrl({
      action: "read",
      expires: Date.now() + 15 * 60 * 1000
    });
    return { ...attachment, signedUrl };
  }

  async getContent(orgId, attachmentId) {
    const attachment = await this.get(orgId, attachmentId);
    const [buffer] = await this.bucket.file(attachment.storagePath).download();
    return { attachment, buffer };
  }

  async ensureProviderMediaId({ orgId, account, attachment }) {
    if (attachment.orgId !== orgId) throw new NotFoundError("Attachment");
    if (attachment.providerMediaId) return attachment.providerMediaId;
    const [buffer] = await this.bucket.file(attachment.storagePath).download();
    const mediaId = await this.channelManager.uploadMedia({
      account,
      buffer,
      mimeType: attachment.mimeType,
      filename: attachment.originalFilename
    });
    await this.store.update(COLLECTIONS.attachments, attachment.attachmentId, {
      providerMediaId: mediaId,
      updatedAt: now()
    });
    return mediaId;
  }

  async prepareForSend(orgId, attachmentIds = []) {
    return Promise.all(attachmentIds.map(async (id) => {
      const attachment = await this.get(orgId, id);
      if (attachment.providerMediaId) return attachment;
      try {
        return await this.get(orgId, id, { withSignedUrl: true });
      } catch {
        // Meta byte upload is primary. A signed URL is only a best-effort fallback.
        return attachment;
      }
    }));
  }
}

function safeExtension(filename = "") {
  const match = String(filename).toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match ? match[0] : "";
}
