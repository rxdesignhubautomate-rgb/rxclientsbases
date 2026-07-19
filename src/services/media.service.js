import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { NotFoundError } from "../utils/errors.js";

export class MediaService {
  constructor({ store, bucket, channelManager }) {
    this.store = store;
    this.bucket = bucket;
    this.channelManager = channelManager;
  }

  async downloadAndStore({ orgId, account, contactId, conversationId, messageId, media }) {
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
      await this.store.update(COLLECTIONS.messages, input.messageId, {
        attachmentIds: [...new Set([...(message?.attachmentIds || []), attachmentId])],
        updatedAt: now()
      });
    }
    return attachment;
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

  async prepareForSend(orgId, attachmentIds = []) {
    return Promise.all(attachmentIds.map((id) => this.get(orgId, id, { withSignedUrl: true })));
  }
}

function safeExtension(filename = "") {
  const match = String(filename).toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match ? match[0] : "";
}
