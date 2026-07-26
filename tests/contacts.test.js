import { describe, expect, it } from "vitest";
import { COLLECTIONS } from "../src/config/constants.js";
import { makeCore } from "./helpers/core.js";

describe("contact service", () => {
  it("creates a permanent contact and normalizes its phone", async () => {
    const core = makeCore();
    const contact = await core.contacts.create("RXDH", { companyName: "ABC Pharma", primaryPhone: "98765 43210" });
    expect(contact.contactId).toMatch(/^CNT_/);
    expect(contact.primaryPhone).toBe("919876543210");
    expect(contact.orgId).toBe("RXDH");
  });

  it("prevents obvious duplicate phones", async () => {
    const core = makeCore();
    await core.contacts.create("RXDH", { primaryPhone: "9876543210" });
    await expect(core.contacts.create("RXDH", { primaryPhone: "+91 9876543210" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reuses an existing contact for an inbound identity", async () => {
    const core = makeCore();
    const contact = await core.contacts.create("RXDH", { primaryPhone: "9876543210" });
    const resolved = await core.contacts.resolveInboundIdentity({
      orgId: "RXDH",
      channel: "WHATSAPP",
      externalUserId: "919876543210",
      channelAccountId: "WA_RX_01"
    });
    expect(resolved.contact.contactId).toBe(contact.contactId);
    expect(resolved.identity.contactId).toBe(contact.contactId);
  });

  it("merges contacts without losing linked messages", async () => {
    const core = makeCore();
    const primary = await core.contacts.create("RXDH", { primaryPhone: "9876543210" });
    const duplicate = await core.contacts.create("RXDH", { primaryPhone: "9123456789", emails: ["x@example.com"] });
    await core.store.create(COLLECTIONS.messages, "MSG_TEST", {
      messageId: "MSG_TEST",
      orgId: "RXDH",
      contactId: duplicate.contactId,
      createdAt: new Date()
    });
    const result = await core.contacts.merge("RXDH", primary.contactId, duplicate.contactId, { userId: "USR_ADMIN" });
    expect((await core.store.get(COLLECTIONS.messages, "MSG_TEST")).contactId).toBe(primary.contactId);
    expect((await core.contacts.get("RXDH", duplicate.contactId)).status).toBe("MERGED");
    expect(result.primary.emails).toContain("x@example.com");
  });
});
