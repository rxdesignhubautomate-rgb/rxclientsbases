import { describe, expect, it, vi } from "vitest";
import { MediaWorker } from "../src/workers/media.worker.js";
import { makeCore, seedConversation } from "./helpers/core.js";

describe("inbound media worker observability", () => {
  it("logs the exact inbound media download failure without changing retry behaviour", async () => {
    const core = makeCore();
    const { contact, conversation } = await seedConversation(core);
    const saved = await core.messages.createInbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      contactId: contact.contactId,
      channel: "WHATSAPP",
      channelAccountId: "WA_RX_01",
      type: "IMAGE",
      providerMessageId: "wamid.inbound-media",
      senderId: "919876543210"
    });
    const automationJob = {
      automationJobId: "JOB_MEDIA_1",
      orgId: "RXDH",
      type: "MEDIA_DOWNLOAD",
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: new Date(),
      payload: {
        channelAccountId: "WA_RX_01",
        contactId: contact.contactId,
        conversationId: conversation.conversationId,
        messageId: saved.message.messageId,
        media: { providerMediaId: "provider-media-1", mimeType: "image/jpeg" }
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await core.store.create("automationJobs", automationJob.automationJobId, automationJob);
    const error = Object.assign(new Error("Meta token cannot download media"), { code: "190" });
    const media = {
      markMessageMediaState: vi.fn().mockResolvedValue(undefined),
      downloadAndStore: vi.fn().mockRejectedValue(error)
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const worker = new MediaWorker({
      store: core.store,
      channelAccounts: core.channelAccounts,
      media,
      notifications: core.notifications,
      intervalMs: 5000,
      batchSize: 20,
      workerId: "media-test-worker",
      logger,
      maxAttempts: 5
    });

    await worker.processOne(automationJob);

    expect(logger.warn).toHaveBeenCalledWith({
      automationJobId: "JOB_MEDIA_1",
      messageId: saved.message.messageId,
      providerMediaId: "provider-media-1",
      attemptCount: 1,
      message: "Meta token cannot download media",
      final: false
    }, "inbound_media_download_failed");
    expect((await core.store.get("automationJobs", automationJob.automationJobId)).status).toBe("RETRY");
  });
});
