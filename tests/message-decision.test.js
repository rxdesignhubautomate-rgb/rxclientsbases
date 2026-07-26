import { describe, expect, it } from "vitest";
import { decideMessageType } from "../src/services/message-decision.service.js";

const current = new Date("2026-07-23T12:00:00.000Z");
const phone = "919876543210";

function decision(input = {}) {
  return decideMessageType({ phone, now: current, lead: {}, ...input });
}

describe("WhatsApp message decision policy", () => {
  it("selects a service message for an inbound message two hours ago", () => {
    expect(decision({ lead: { lastUserMessageAt: new Date(current.getTime() - 2 * 60 * 60 * 1000) } }).mode).toBe("SERVICE_MESSAGE");
  });

  it("selects Utility for a verified quotation outside 24 hours", () => {
    expect(decision({
      lead: { lastUserMessageAt: new Date(current.getTime() - 25 * 60 * 60 * 1000) },
      eventType: "QUOTATION_READY",
      quotationId: "QUO_REAL",
      transactionVerified: true
    })).toMatchObject({ mode: "UTILITY_TEMPLATE", templateKey: "QUOTATION_READY" });
  });

  it("selects Marketing for an opted-in discount outside 24 hours", () => {
    expect(decision({
      lead: { lastUserMessageAt: new Date(current.getTime() - 25 * 60 * 60 * 1000), marketingOptIn: true },
      eventType: "LEAD_REENGAGEMENT",
      messageIntent: "discount offer",
      isPromotional: true
    }).mode).toBe("MARKETING_TEMPLATE");
  });

  it("blocks Marketing when opt-in is missing", () => {
    expect(decision({ eventType: "LEAD_REENGAGEMENT", isPromotional: true }).reason).toBe("MARKETING_OPT_IN_REQUIRED");
  });

  it("blocks an opted-out customer", () => {
    expect(decision({ lead: { marketingOptOut: true }, eventType: "CUSTOMER_REQUEST" }).reason).toBe("CUSTOMER_OPTED_OUT");
  });

  it("never treats promotional Utility-labelled content as Utility", () => {
    expect(decision({
      lead: { marketingOptIn: true },
      eventType: "QUOTATION_READY",
      quotationId: "QUO_REAL",
      transactionVerified: true,
      messageIntent: "special discount offer",
      isPromotional: true,
      templateKey: "LEAD_REENGAGEMENT"
    }).mode).toBe("MARKETING_TEMPLATE");
  });

  it("blocks a quotation event without quotationId", () => {
    expect(decision({ eventType: "QUOTATION_READY", transactionVerified: true }).reason).toContain("MISSING_TRANSACTION_DATA");
  });

  it("blocks an invalid Indian phone number", () => {
    expect(decideMessageType({ phone: "12345", now: current, lead: {}, eventType: "CUSTOMER_REQUEST" }).reason).toBe("INVALID_PHONE");
  });

  it("uses a recorded free-entry window as Service", () => {
    expect(decision({ lead: { freeEntryWindowExpiresAt: new Date(current.getTime() + 60 * 60 * 1000) } }).mode).toBe("SERVICE_MESSAGE");
  });

  it("uses an approved Utility event outside the service window", () => {
    expect(decision({ eventType: "ORDER_DISPATCHED", orderId: "ORD_REAL", transactionVerified: true }).mode).toBe("UTILITY_TEMPLATE");
  });

  it("blocks Marketing when frequency limits or cooldown apply", () => {
    expect(decision({ lead: { marketingOptIn: true }, eventType: "LEAD_REENGAGEMENT", isPromotional: true, frequencyLimitReached: true }).reason).toBe("MARKETING_FREQUENCY_LIMIT");
    expect(decision({ lead: { marketingOptIn: true }, eventType: "LEAD_REENGAGEMENT", isPromotional: true, templateCooldownActive: true }).reason).toBe("MARKETING_TEMPLATE_COOLDOWN");
  });
});
