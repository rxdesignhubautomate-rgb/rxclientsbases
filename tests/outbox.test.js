import { describe, expect, it, vi } from "vitest";
import { COLLECTIONS } from "../src/config/constants.js";
import { OutboundWorker } from "../src/workers/outbound.worker.js";
import { makeCore, seedConversation } from "./helpers/core.js";

function worker(core, send) {
  return new OutboundWorker({
    store: core.store,
    channelManager: { send },
    channelAccounts: core.channelAccounts,
    media: { prepareForSend: vi.fn().mockResolvedValue([]) },
    notifications: core.notifications,
    intervalMs: 5000,
    batchSize: 20,
    maxAttempts: 5,
    retryDelays: [0, 60_000, 300_000],
    workerId: "test-worker",
    logger: { error: vi.fn() }
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
    await worker(core, vi.fn().mockRejectedValue(error)).processOne(queued.outbox);
    expect((await core.store.get(COLLECTIONS.outbox, queued.outbox.outboxId)).status).toBe("RETRY");
    expect((await core.messages.get("RXDH", queued.message.messageId)).status).toBe("QUEUED");
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
