import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/services/ai.service.js";
import { COLLECTIONS } from "../src/config/constants.js";
import { makeCore, seedConversation } from "./helpers/core.js";

function response(overrides = {}) {
  return {
    choices: [{ message: { content: JSON.stringify({
      intent: "QUOTATION_REQUEST",
      reply: "Bilkul Sir, quantity kitni chahiye?",
      leadUpdates: { productRequired: ["VISUAL_AID"], interestLevel: "HIGH", paymentStatus: "PAID" },
      nextAction: "ASK_QUANTITY",
      needsHuman: false,
      confidence: 0.95,
      reason: "Product and pages are known",
      ...overrides
    }) } }]
  };
}

function service(core, create, autoSendEnabled = false) {
  return new AiService({
    model: "test",
    summaryModel: "test",
    autoSendEnabled,
    summaryInterval: 100,
    store: core.store,
    contacts: core.contacts,
    conversations: core.conversations,
    messages: core.messages,
    domain: core.domain,
    notifications: core.notifications,
    client: { chat: { completions: { create } } }
  });
}

describe("AI modes and safety", () => {
  it("OFF mode does nothing", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core, { aiMode: "OFF" });
    const create = vi.fn();
    expect(await service(core, create).processInbound({ orgId: "RXDH", conversationId: conversation.conversationId, message: { messageId: "MSG_1", text: "hello" } })).toEqual({ skipped: true, reason: "AI_OFF" });
    expect(create).not.toHaveBeenCalled();
  });

  it("human takeover blocks AI", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    await core.conversations.transition("RXDH", conversation.conversationId, "HUMAN_TAKEOVER", { enabled: true });
    const create = vi.fn();
    const result = await service(core, create).processInbound({ orgId: "RXDH", conversationId: conversation.conversationId, message: { messageId: "MSG_1", text: "hello" } });
    expect(result.reason).toBe("HUMAN_TAKEOVER");
    expect(create).not.toHaveBeenCalled();
  });

  it("ASSIST creates a draft and cannot apply disallowed fields", async () => {
    const core = makeCore();
    const { conversation, lead } = await seedConversation(core, { aiMode: "ASSIST" });
    const result = await service(core, vi.fn().mockResolvedValue(response())).processInbound({ orgId: "RXDH", conversationId: conversation.conversationId, message: { messageId: "MSG_1", text: "quotation" } });
    expect(result.mode).toBe("DRAFTED");
    const drafts = await core.store.find(COLLECTIONS.messages, { filters: [["direction", "==", "INTERNAL"]], limit: 10 });
    expect(drafts.items[0].metadata.draft).toBe(true);
    const updatedLead = await core.domain.get("leads", "RXDH", lead.leadId);
    expect(updatedLead.interestLevel).toBe("HIGH");
    expect(updatedLead.paymentStatus).toBe("PENDING");
  });

  it("AUTO queues only a safe high-confidence reply", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core, { aiMode: "AUTO" });
    const result = await service(core, vi.fn().mockResolvedValue(response()), true).processInbound({ orgId: "RXDH", conversationId: conversation.conversationId, message: { messageId: "MSG_1", text: "quotation" } });
    expect(result.mode).toBe("AUTO_SENT");
    expect((await core.store.find(COLLECTIONS.outbox, { limit: 10 })).items).toHaveLength(1);
  });

  it("handles invalid AI JSON safely by rejecting before writes", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    await expect(service(core, vi.fn().mockResolvedValue({ choices: [{ message: { content: "not json" } }] })).processInbound({ orgId: "RXDH", conversationId: conversation.conversationId, message: { messageId: "MSG_1", text: "hello" } })).rejects.toBeInstanceOf(SyntaxError);
    expect((await core.store.find(COLLECTIONS.outbox, { limit: 10 })).items).toHaveLength(0);
  });
});
