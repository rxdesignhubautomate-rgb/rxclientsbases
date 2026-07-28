import { describe, expect, it } from "vitest";
import {
  buildAudiencePlan,
  buildExistingContactPatch,
  buildNewContact,
  validateBroadcastPayload,
} from "../src/scripts/lib/broadcast-audience-sync.js";

const timestamp = new Date("2026-07-28T12:00:00.000Z");

function payload() {
  return {
    version: 1,
    sourceName: "RX_WhatsApp_Broadcast_List.xlsx",
    sourceSha256: "a".repeat(64),
    extractedAt: timestamp.toISOString(),
    segments: [
      {
        key: "EXISTING_CUSTOMERS",
        sheetName: "1. Existing Customers",
        rows: [{ phone: "9876543210", name: "Acme", city: "Delhi" }],
      },
      {
        key: "INTERESTED",
        sheetName: "2. Interested",
        rows: [{ phone: "919876543211", name: "", city: "" }],
      },
      {
        key: "POSSIBLY_INTERESTED",
        sheetName: "3. Possibly Interested",
        rows: [{ phone: "09876543212", name: "Beta", city: "Noida" }],
      },
    ],
  };
}

describe("broadcast audience sync", () => {
  it("validates all three disjoint Indian-phone segments", () => {
    const result = validateBroadcastPayload(payload());
    expect(result.totalContacts).toBe(3);
    expect(result.segments.map((segment) => segment.name)).toEqual([
      "Existing Customers",
      "Interested",
      "Possibly Interested",
    ]);
    expect(result.segments[0].rows[0].phone).toBe("919876543210");
  });

  it("never adds or changes a marketing consent field", () => {
    const result = validateBroadcastPayload(payload());
    const newContact = buildNewContact({
      orgId: "RXDH",
      contactId: "CNT_TEST",
      row: result.segments[0].rows[0],
      segment: result.segments[0],
      payload: result,
      timestamp,
    });
    const patch = buildExistingContactPatch({
      contact: {
        companyName: "Existing name",
        city: "Existing city",
        tags: ["VIP"],
        marketingConsent: { status: "OPTED_IN" },
      },
      row: result.segments[0].rows[0],
      segment: result.segments[0],
      payload: result,
      timestamp,
    });
    expect(newContact).not.toHaveProperty("marketingConsent");
    expect(patch).not.toHaveProperty("marketingConsent");
    expect(patch).not.toHaveProperty("companyName");
    expect(patch).not.toHaveProperty("city");
  });

  it("preserves manual audience members across managed re-syncs", () => {
    const result = validateBroadcastPayload(payload());
    const segment = result.segments[1];
    const plan = buildAudiencePlan({
      existing: {
        audienceId: "AUDIENCE_EXISTING",
        orgId: "RXDH",
        sourceKey: segment.sourceKey,
        contactIds: ["CNT_OLD_MANAGED", "CNT_MANUAL"],
        managedContactIds: ["CNT_OLD_MANAGED"],
      },
      importedContactIds: ["CNT_NEW_MANAGED"],
      segment,
      payload: result,
      timestamp,
    });
    expect(plan.contactIds).toEqual(["CNT_MANUAL", "CNT_NEW_MANAGED"]);
    expect(plan.managedContactIds).toEqual(["CNT_NEW_MANAGED"]);
    expect(plan.manualContactsPreserved).toBe(1);
  });

  it("rejects a phone repeated across segments", () => {
    const input = payload();
    input.segments[1].rows[0].phone = input.segments[0].rows[0].phone;
    expect(() => validateBroadcastPayload(input)).toThrow(/more than one segment/);
  });
});
