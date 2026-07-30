import { describe, expect, it, vi } from "vitest";
import { COLLECTIONS } from "../src/config/constants.js";
import { OutboundWorker } from "../src/workers/outbound.worker.js";
import { makeCore, seedConversation } from "./helpers/core.js";

function worker(core, send, options = {}) {
  return new OutboundWorker({
    store: core.store,
    channelManager: { send },
    channelAccounts: core.channelAccounts,
    media: options.media || { prepareForSend: vi.fn().mockResolvedValue([]) },
    notifications: core.notifications,
    intervalMs: 5000,
    batchSize: 20,
    maxAttempts: 5,
    retryDelays: [0, 60_000, 300_000],
    workerId: "test-worker",
    logger: options.logger || { error: vi.fn(), warn: vi.fn() }
  });
}

describe("outbox processing", () => {
  it("creates an outbox record with every outgoing message and sends it once", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "Hello", senderId: "USR_1" });
    expect(queued.outbox.status).toBe("PENDING");
    const send = vi.fn().mockResolvedValue({ providerMessageId: "wamid.sent" });
    await worker(core, send).processOne(queued.outbox);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await core.messages.get("RXDH", queued.message.messageId)).status).toBe("SENT");
    expect((await core.store.get(COLLECTIONS.outbox, queued.outbox.outboxId)).status).toBe("SENT");
    await worker(core, send).processOne(queued.outbox);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries temporary failures", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "Retry me" });
    const error = Object.assign(new Error("temporary"), { code: "TIMEOUT", retryable: true });
    const logger = { error: vi.fn(), warn: vi.fn() };
    await worker(core, vi.fn().mockRejectedValue(error), { logger }).processOne(queued.outbox);
    expect((await core.store.get(COLLECTIONS.outbox, queued.outbox.outboxId)).status).toBe("RETRY");
    expect((await core.messages.get("RXDH", queued.message.messageId)).status).toBe("QUEUED");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      code: "TIMEOUT",
      message: "temporary",
      messageId: queued.message.messageId,
      attemptCount: 1,
      final: false
    }), "outbound_send_failed");
  });

  it("uploads outbound media to Meta and sends the cached media id", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const attachment = {
      attachmentId: "ATT_OUTBOUND",
      orgId: "RXDH",
      storagePath: "files/ATT_OUTBOUND.jpg",
      mimeType: "image/jpeg",
      originalFilename: "sample.jpg",
      signedUrl: "https://storage.test/sample.jpg",
      providerMediaId: null
    };
    const queued = await core.messages.queueOutbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      text: "Sample",
      type: "IMAGE",
      attachmentIds: [attachment.attachmentId]
    });
    const media = {
      prepareForSend: vi.fn().mockResolvedValue([attachment]),
      ensureProviderMediaId: vi.fn().mockResolvedValue("meta-media-3")
    };
    const send = vi.fn().mockResolvedValue({ providerMessageId: "wamid.image" });

    await worker(core, send, { media }).processOne(queued.outbox);

    expect(media.ensureProviderMediaId).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "RXDH",
      attachment
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ providerMediaId: "meta-media-3" })]
    }));
  });

  it("injects uploaded video into a Meta template header", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const attachment = {
      attachmentId: "ATT_TEMPLATE_VIDEO",
      orgId: "RXDH",
      storagePath: "files/ATT_TEMPLATE_VIDEO.mp4",
      mimeType: "video/mp4",
      originalFilename: "campaign.mp4",
      signedUrl: "https://storage.test/campaign.mp4",
      providerMediaId: null
    };
    const queued = await core.messages.queueOutbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      text: "Hello Rahul",
      type: "TEMPLATE",
      attachmentIds: [attachment.attachmentId],
      metadata: {
        templateHeader: { type: "VIDEO", required: true },
        template: {
          name: "1_marketing",
          language: { code: "en" },
          components: [{ type: "body", parameters: [{ type: "text", text: "Rahul" }] }]
        }
      }
    });
    const media = {
      prepareForSend: vi.fn().mockResolvedValue([attachment]),
      ensureProviderMediaId: vi.fn().mockResolvedValue("meta-template-video")
    };
    const send = vi.fn().mockResolvedValue({ providerMessageId: "wamid.template-video" });

    await worker(core, send, { media }).processOne(queued.outbox);

    const sent = send.mock.calls[0][0].message;
    expect(sent.metadata.template.components).toEqual([
      {
        type: "header",
        parameters: [{ type: "video", video: { id: "meta-template-video" } }]
      },
      { type: "body", parameters: [{ type: "text", text: "Rahul" }] }
    ]);
  });

  it("falls back to a signed link when Meta media upload fails", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const attachment = {
      attachmentId: "ATT_FALLBACK",
      orgId: "RXDH",
      signedUrl: "https://storage.test/fallback.pdf",
      mimeType: "application/pdf",
      originalFilename: "fallback.pdf"
    };
    const queued = await core.messages.queueOutbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      type: "DOCUMENT",
      attachmentIds: [attachment.attachmentId]
    });
    const uploadError = Object.assign(new Error("Meta rejected upload"), { code: "131053" });
    const media = {
      prepareForSend: vi.fn().mockResolvedValue([attachment]),
      ensureProviderMediaId: vi.fn().mockRejectedValue(uploadError)
    };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const send = vi.fn().mockResolvedValue({ providerMessageId: "wamid.document" });

    await worker(core, send, { media, logger }).processOne(queued.outbox);

    expect(send).toHaveBeenCalledTimes(1);
    const sentAttachment = send.mock.calls[0][0].attachments[0];
    expect(sentAttachment.signedUrl).toBe("https://storage.test/fallback.pdf");
    expect(sentAttachment.providerMediaId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({
      attachmentId: "ATT_FALLBACK",
      code: "131053",
      message: "Meta rejected upload"
    }, "media_upload_to_meta_failed_falling_back_to_link");
  });

  it("clears an invalid cached Meta media id before a manual retry", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const attachmentId = "ATT_INVALID_META_IMAGE";
    await core.store.create(COLLECTIONS.attachments, attachmentId, {
      attachmentId,
      orgId: "RXDH",
      storagePath: "files/invalid.jpg",
      mimeType: "image/jpeg",
      originalFilename: "invalid.jpg",
      providerMediaId: "invalid-meta-media-id"
    });
    const queued = await core.messages.queueOutbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      type: "IMAGE",
      attachmentIds: [attachmentId]
    });
    await core.store.update(COLLECTIONS.outbox, queued.outbox.outboxId, {
      status: "SENT"
    });
    await core.store.update(COLLECTIONS.messages, queued.message.messageId, {
      status: "FAILED",
      errorCode: 131053,
      errorTitle: "Media upload error",
      errorDetails: "Image is invalid",
      errorMessage: "Media upload error"
    });

    const retry = await core.messages.retry("RXDH", queued.message.messageId, {
      userId: "USR_ADMIN"
    });
    const attachment = await core.store.get(COLLECTIONS.attachments, attachmentId);
    const message = await core.messages.get("RXDH", queued.message.messageId);

    expect(retry.status).toBe("PENDING");
    expect(attachment.providerMediaId).toBeNull();
    expect(message.status).toBe("QUEUED");
    expect(message.errorCode).toBeNull();
    expect(message.errorTitle).toBeNull();
    expect(message.errorDetails).toBeNull();
    expect(message.errorMessage).toBeNull();
  });

  it("moves permanent failures to dead letters and notifies admins", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "Fail" });
    const error = Object.assign(new Error("invalid recipient"), { code: "INVALID_RECIPIENT", retryable: false });
    await worker(core, vi.fn().mockRejectedValue(error)).processOne(queued.outbox);
    expect((await core.store.get(COLLECTIONS.outbox, queued.outbox.outboxId)).status).toBe("FAILED");
    expect((await core.store.find(COLLECTIONS.deadLetters, { limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find(COLLECTIONS.notifications, { limit: 10 })).items).toHaveLength(1);
  });

  it("does not send through an account disabled after queueing", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "Blocked" });
    await core.channelAccounts.disable("RXDH", "WA_RX_01");
    const send = vi.fn();
    await worker(core, send).processOne(queued.outbox);
    expect(send).not.toHaveBeenCalled();
    expect((await core.store.get(COLLECTIONS.outbox, queued.outbox.outboxId)).status).toBe("FAILED");
  });

  it("routes new messages through a replacement default without rewriting history", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const historical = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "Old account" });
    await core.channelAccounts.create("RXDH", {
      channelAccountId: "WA_RX_02",
      channel: "WHATSAPP",
      provider: "META_CLOUD_API",
      displayName: "Replacement",
      phoneNumberId: "phone-id-2",
      status: "ACTIVE",
      sendEnabled: true,
      receiveEnabled: true,
      isDefault: false
    });
    await core.channelAccounts.makeDefault("RXDH", "WA_RX_02");
    await core.channelAccounts.disable("RXDH", "WA_RX_01");
    const replacement = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "New account" });
    expect(historical.message.channelAccountId).toBe("WA_RX_01");
    expect((await core.messages.get("RXDH", historical.message.messageId)).channelAccountId).toBe("WA_RX_01");
    expect(replacement.message.channelAccountId).toBe("WA_RX_02");
  });

  it("applies delivered and read provider statuses", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: "RXDH", conversationId: conversation.conversationId, text: "Status" });
    await core.store.update(COLLECTIONS.messages, queued.message.messageId, { providerMessageId: "wamid.status", status: "SENT" });
    await core.messages.updateProviderStatus("RXDH", "wamid.status", "DELIVERED");
    expect((await core.messages.get("RXDH", queued.message.messageId)).status).toBe("DELIVERED");
    await core.messages.updateProviderStatus("RXDH", "wamid.status", "READ");
    expect((await core.messages.get("RXDH", queued.message.messageId)).status).toBe("READ");
  });
});
