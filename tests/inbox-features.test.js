import { describe, expect, it, vi } from "vitest";
import { QuickReplyService } from "../src/services/quick-reply.service.js";
import { WhatsAppMetaAdapter } from "../src/channels/whatsapp/whatsapp.adapter.js";
import { makeCore, seedConversation } from "./helpers/core.js";

describe("WhatsApp-style inbox features", () => {
  it("provides safe built-in quick replies and stores custom replies", async () => {
    const core = makeCore();
    const service = new QuickReplyService({ store: core.store, audit: core.audit });
    const initial = await service.list("RXDH");
    expect(initial.items.some((item) => item.shortcut === "/price" && item.builtin)).toBe(true);

    const custom = await service.create("RXDH", {
      shortcut: "/dispatch-help",
      title: "Dispatch help",
      text: "Please share your order reference.",
      category: "ORDER"
    }, { userId: "USR_ADMIN" });
    expect(custom.quickReplyId).toMatch(/^QRP_/);

    const listed = await service.list("RXDH", { search: "dispatch" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].shortcut).toBe("/dispatch-help");

    await expect(service.create("RXDH", {
      shortcut: "/price",
      title: "Duplicate",
      text: "Duplicate",
      category: "SALES"
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cascades inbox assignment to the permanent contact and active lead", async () => {
    const core = makeCore();
    const { contact, lead, conversation } = await seedConversation(core);
    await core.conversations.transition(
      "RXDH",
      conversation.conversationId,
      "ASSIGN",
      { assignedTo: "USR_SALES" },
      { userId: "USR_ADMIN" }
    );
    expect((await core.contacts.get("RXDH", contact.contactId)).assignedTo).toBe("USR_SALES");
    expect((await core.store.get("leads", lead.leadId)).assignedTo).toBe("USR_SALES");
  });

  it("sends quoted replies, locations, and reactions using Meta payloads", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.${requests.length}` }] }) };
    });
    const adapter = new WhatsAppMetaAdapter({
      accessToken: "token",
      appSecret: "secret",
      fetchImpl
    });
    const account = { phoneNumberId: "phone-id", status: "ACTIVE", sendEnabled: true };

    await adapter.sendMessage({
      account,
      message: {
        recipientId: "919876543210",
        type: "TEXT",
        text: "Reply",
        metadata: { replyToProviderMessageId: "wamid.original" }
      }
    });
    await adapter.sendMessage({
      account,
      message: {
        recipientId: "919876543210",
        type: "LOCATION",
        text: "",
        metadata: { location: { latitude: 28.6139, longitude: 77.209, name: "RX Design Hub" } }
      }
    });
    await adapter.sendMessage({
      account,
      message: {
        recipientId: "919876543210",
        type: "REACTION",
        text: "👍",
        metadata: { replyToProviderMessageId: "wamid.original" }
      }
    });

    expect(requests[0]).toMatchObject({
      type: "text",
      context: { message_id: "wamid.original" }
    });
    expect(requests[1]).toMatchObject({
      type: "location",
      location: { latitude: 28.6139, longitude: 77.209 }
    });
    expect(requests[2]).toMatchObject({
      type: "reaction",
      reaction: { message_id: "wamid.original", emoji: "👍" }
    });
  });
});
