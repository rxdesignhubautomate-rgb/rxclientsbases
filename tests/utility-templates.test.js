import { describe, expect, it } from "vitest";
import { MarketingTemplateService } from "../src/services/marketing-template.service.js";
import { UtilityTemplateService } from "../src/services/utility-template.service.js";
import { validateTemplateHeaderMedia } from "../src/services/template-header-media.js";
import { makeCore, seedConversation } from "./helpers/core.js";

describe("WhatsApp utility templates", () => {
  it("exposes the four operational Utility templates", () => {
    const ids = new UtilityTemplateService().list().map((template) => template.id);
    expect(ids).toEqual([
      "order_confirmation",
      "design_approved",
      "ready_to_dispatch",
      "experience_feedback"
    ]);
  });

  it("prepares only a whitelisted utility template for Meta", () => {
    const service = new UtilityTemplateService();
    const result = service.prepare("ready_to_dispatch", {
      customer_name: "Rahul",
      order_reference: "ORD-17"
    });
    expect(result.type).toBe("TEMPLATE");
    expect(result.metadata.templateCategory).toBe("UTILITY");
    expect(result.metadata.template.name).toBe("rx_ready_to_dispatch");
    expect(result.metadata.template.components[0].parameters).toHaveLength(2);
  });

  it("rejects unknown templates and missing values", () => {
    const service = new UtilityTemplateService();
    expect(() => service.prepare("marketing_offer", {})).toThrow(/supported WhatsApp utility template/);
    expect(() => service.prepare("payment_reminder", {})).toThrow(/supported WhatsApp utility template/);
    expect(() => service.prepare("order_confirmation", { customer_name: "Rahul" })).toThrow(/Order reference is required/);
  });

  it("prepares the approved order-confirmation video header", () => {
    const service = new UtilityTemplateService();
    const template = service.list().find((item) => item.id === "order_confirmation");
    const result = service.prepare("order_confirmation", {
      customer_name: "Rahul",
      order_reference: "ORD-17",
      order_value: "INR 25,000"
    });

    expect(template.header).toEqual({ type: "VIDEO", required: true });
    expect(result.metadata.templateHeader).toEqual({ type: "VIDEO", required: true });
    expect(result.metadata.template.name).toBe("rx_order_confirmation");
  });

  it("accepts only the selected client's video for a video-header Utility template", async () => {
    const template = { header: { type: "VIDEO", required: true } };
    const media = {
      get: async (_orgId, attachmentId) => ({
        attachmentId,
        contactId: "CON_1",
        conversationId: "CV_1",
        mimeType: "video/mp4"
      })
    };

    await expect(validateTemplateHeaderMedia({
      media,
      orgId: "RXDH",
      contactId: "CON_1",
      conversationId: "CV_1",
      template,
      attachmentIds: ["ATT_1"]
    })).resolves.toEqual(["ATT_1"]);
    await expect(validateTemplateHeaderMedia({
      media,
      orgId: "RXDH",
      contactId: "CON_2",
      conversationId: "CV_1",
      template,
      attachmentIds: ["ATT_1"]
    })).rejects.toThrow(/does not belong to the selected client/);
    await expect(validateTemplateHeaderMedia({
      media,
      orgId: "RXDH",
      contactId: "CON_1",
      conversationId: "CV_1",
      template,
      attachmentIds: []
    })).rejects.toThrow(/Upload exactly one video/);
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

describe("WhatsApp marketing templates", () => {
  it("maps the approved 1_marketing video template with only the customer-name body variable", () => {
    const service = new MarketingTemplateService();
    const template = service.list().find((item) => item.id === "interest_followup");
    const result = service.prepare("interest_followup", { customer_name: "Rahul" });

    expect(template).toMatchObject({
      name: "1_marketing",
      header: { type: "VIDEO", required: true }
    });
    expect(result.metadata.template.components[0].parameters).toEqual([
      { type: "text", text: "Rahul" }
    ]);
    expect(result.metadata.templateHeader).toEqual({ type: "VIDEO", required: true });
  });
});
