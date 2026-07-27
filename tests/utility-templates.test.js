import { describe, expect, it } from "vitest";
import { UtilityTemplateService } from "../src/services/utility-template.service.js";
import { makeCore, seedConversation } from "./helpers/core.js";

describe("WhatsApp utility templates", () => {
  it("prepares only a whitelisted utility template for Meta", () => {
    const service = new UtilityTemplateService();
    const result = service.prepare("payment_reminder", {
      customer_name: "Rahul",
      amount_due: "INR 2,000",
      order_reference: "ORD-17"
    });
    expect(result.type).toBe("TEMPLATE");
    expect(result.metadata.templateCategory).toBe("UTILITY");
    expect(result.metadata.template.name).toBe("rx_payment_reminder");
    expect(result.metadata.template.components[0].parameters).toHaveLength(3);
  });

  it("rejects unknown templates and missing values", () => {
    const service = new UtilityTemplateService();
    expect(() => service.prepare("marketing_offer", {})).toThrow(/supported WhatsApp utility template/);
    expect(() => service.prepare("order_confirmation", { customer_name: "Rahul" })).toThrow(/Order reference is required/);
  });

  it("blocks free-form WhatsApp messages outside the 24-hour service window", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    await core.store.update("conversations", conversation.conversationId, {
      lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
    });
    await expect(core.messages.queueOutbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      text: "Hello"
    })).rejects.toThrow(/Utility template/);
  });

  it("allows utility templates even when the service window is closed", async () => {
    const core = makeCore();
    const { conversation } = await seedConversation(core);
    await core.store.update("conversations", conversation.conversationId, {
      lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
    });
    const queued = await core.messages.queueOutbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      type: "TEMPLATE",
      text: "Order update",
      metadata: { templateCategory: "UTILITY", template: { name: "rx_order_confirmation" } }
    });
    expect(queued.message.type).toBe("TEMPLATE");
  });
});
