import { describe, expect, it } from "vitest";
import { makeCore, seedConversation } from "./helpers/core.js";
import { SmartMessageService } from "../src/services/smart-message.service.js";
import { UtilityTemplateService } from "../src/services/utility-template.service.js";
import { MarketingTemplateService } from "../src/services/marketing-template.service.js";

function makeSmart(core, templateRegistry = { assertApproved: async () => ({ status: "APPROVED" }) }) {
  return new SmartMessageService({
    ...core,
    utilityTemplates: new UtilityTemplateService(),
    marketingTemplates: new MarketingTemplateService(),
    templateRegistry,
    config: { marketingMax24h: 1, marketingMax7d: 3, marketingMax30d: 8, marketingCooldownHours: 24 }
  });
}

describe("audited smart send", () => {
  it("blocks a duplicate deterministic send before creating a second message", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const smart = makeSmart(core);
    const input = {
      contactId: seeded.contact.contactId,
      conversationId: seeded.conversation.conversationId,
      eventType: "CUSTOMER_REQUEST",
      requestedByCustomer: true,
      textMessage: "Hello",
      idempotencyKey: "CUSTOMER_REPLY_1"
    };
    const first = await smart.smartSend("RXDH", input, { userId: "USR_ADMIN" });
    const second = await smart.smartSend("RXDH", input, { userId: "USR_ADMIN" });
    expect(first).toMatchObject({ queued: true, mode: "SERVICE_MESSAGE" });
    expect(second).toMatchObject({ queued: false, mode: "DO_NOT_SEND", reason: "DUPLICATE_SEND_BLOCKED" });
    expect((await core.store.find("messages", { filters: [["direction", "==", "OUTBOUND"]], limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find("messageAuditLogs", { limit: 10 })).items).toHaveLength(2);
  });

  it("blocks a paused Meta template and does not queue Meta traffic", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    await core.store.update("conversations", seeded.conversation.conversationId, { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await core.store.set("orders", "ORD_REAL", { orderId: "ORD_REAL", orgId: "RXDH", contactId: seeded.contact.contactId, status: "CONFIRMED" });
    const smart = makeSmart(core, { assertApproved: async () => { throw new Error("Meta template rx_order_confirmation is PAUSED"); } });
    const result = await smart.smartSend("RXDH", {
      contactId: seeded.contact.contactId,
      conversationId: seeded.conversation.conversationId,
      eventType: "ORDER_CONFIRMATION",
      orderId: "ORD_REAL",
      templateKey: "order_confirmation",
      templateData: { customer_name: "Rahul", order_reference: "ORD_REAL", order_value: "INR 1000" }
    });
    expect(result.mode).toBe("DO_NOT_SEND");
    expect(result.reason).toContain("TEMPLATE_NOT_APPROVED");
    expect((await core.store.find("outbox", { limit: 10 })).items).toHaveLength(0);
  });

  it("sends with the exact approved Meta regional language code", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    await core.store.update("conversations", seeded.conversation.conversationId, {
      lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
    });
    await core.store.set("orders", "ORD_LANGUAGE", {
      orderId: "ORD_LANGUAGE",
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      status: "CONFIRMED"
    });
    const smart = makeSmart(core, {
      assertApproved: async () => ({ status: "APPROVED", language: "en_US" })
    });

    const result = await smart.smartSend("RXDH", {
      contactId: seeded.contact.contactId,
      conversationId: seeded.conversation.conversationId,
      eventType: "ORDER_CONFIRMATION",
      orderId: "ORD_LANGUAGE",
      templateKey: "order_confirmation",
      templateData: {
        customer_name: "Rahul",
        order_reference: "ORD_LANGUAGE",
        order_value: "INR 1000"
      }
    });

    expect(result).toMatchObject({ queued: true, mode: "UTILITY_TEMPLATE" });
    const messages = await core.store.find("messages", {
      filters: [["direction", "==", "OUTBOUND"]],
      limit: 10
    });
    expect(messages.items[0].metadata.template.language.code).toBe("en_US");
  });

  it("preserves structured WhatsApp payloads through the policy layer", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const smart = makeSmart(core);
    const location = { latitude: 28.6139, longitude: 77.209, name: "RX Design Hub" };
    const result = await smart.smartSend("RXDH", {
      contactId: seeded.contact.contactId,
      conversationId: seeded.conversation.conversationId,
      eventType: "CUSTOMER_REQUEST",
      requestedByCustomer: true,
      messageType: "LOCATION",
      metadata: { location },
      idempotencyKey: "CUSTOMER_LOCATION_1"
    }, { userId: "USR_ADMIN" });
    expect(result).toMatchObject({ queued: true, mode: "SERVICE_MESSAGE" });
    const messages = await core.store.find("messages", {
      filters: [["direction", "==", "OUTBOUND"]],
      limit: 10
    });
    expect(messages.items[0]).toMatchObject({
      type: "LOCATION",
      metadata: { location }
    });
  });

  it("enforces the marketing frequency limit across different campaign jobs", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    await core.store.update("conversations", seeded.conversation.conversationId, { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await core.store.update("contacts", seeded.contact.contactId, {
      marketingOptIn: true,
      marketingOptOut: false,
      marketingConsent: { status: "OPTED_IN" }
    });
    const smart = makeSmart(core);
    const base = {
      contactId: seeded.contact.contactId,
      conversationId: seeded.conversation.conversationId,
      eventType: "CAMPAIGN_MESSAGE",
      isPromotional: true,
      templateKey: "interest_followup",
      templateData: { customer_name: "Rahul", interest: "printing", message_line: "New options are available." }
    };
    expect(await smart.smartSend("RXDH", { ...base, idempotencyKey: "CAMPAIGN_JOB_1" })).toMatchObject({ queued: true });
    expect(await smart.smartSend("RXDH", { ...base, idempotencyKey: "CAMPAIGN_JOB_2" })).toMatchObject({ queued: false, reason: "MARKETING_FREQUENCY_LIMIT" });
  });
});
