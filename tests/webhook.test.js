import { describe, expect, it, vi } from "vitest";
import { WebhookService } from "../src/services/webhook.service.js";
import { normalizeWhatsAppWebhook } from "../src/channels/whatsapp/whatsapp.normalizer.js";
import { COLLECTIONS } from "../src/config/constants.js";
import { makeCore } from "./helpers/core.js";

async function setup() {
  const core = makeCore();
  await core.channelAccounts.create("RXDH", {
    channelAccountId: "WA_RX_01",
    channel: "WHATSAPP",
    provider: "META_CLOUD_API",
    displayName: "RX",
    phoneNumberId: "phone-id",
    status: "ACTIVE",
    sendEnabled: true,
    receiveEnabled: true,
    isDefault: true
  });
  const media = { downloadAndStore: vi.fn().mockResolvedValue({ attachmentId: "ATT_TEST" }) };
  const ai = { processInbound: vi.fn().mockResolvedValue({ skipped: false }) };
  const legacy = { saveInbound: vi.fn().mockResolvedValue({}) };
  const adapter = { verifyWebhook: vi.fn().mockResolvedValue(true) };
  const channelManager = { normalizeWebhook: vi.fn(async (_account, payload) => normalizeWhatsAppWebhook(payload)) };
  const service = new WebhookService({
    store: core.store,
    orgId: "RXDH",
    whatsappAdapter: adapter,
    channelManager,
    channelAccounts: core.channelAccounts,
    contacts: core.contacts,
    conversations: core.conversations,
    messages: core.messages,
    domain: core.domain,
    media,
    ai,
    notifications: core.notifications,
    legacyDualWrite: legacy,
    allowUnsigned: true
  });
  return { core, service, media, ai };
}

function payload(id = "wamid.1", type = "text") {
  const message = { id, from: "919876543210", timestamp: "1710000000", type };
  if (type === "text") message.text = { body: "35 page visual aid chahiye" };
  if (type === "image") message.image = { id: "media-1", mime_type: "image/jpeg", caption: "sample" };
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "phone-id" }, contacts: [{ wa_id: "919876543210", profile: { name: "Rahul" } }], messages: [message] } }] }]
  };
}

describe("durable WhatsApp webhook", () => {
  it("persists once and treats provider retries as duplicates", async () => {
    const { core, service } = await setup();
    const body = payload();
    const raw = Buffer.from(JSON.stringify(body));
    const first = await service.receiveWhatsApp({ rawBody: raw, payload: body, signature: "test" });
    const second = await service.receiveWhatsApp({ rawBody: raw, payload: body, signature: "test" });
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ duplicate: true, webhookEventId: first.webhookEventId });
    expect((await core.store.find(COLLECTIONS.webhookEvents, { limit: 10 })).items).toHaveLength(1);
  });

  it("creates contact, lead, conversation, and message before invoking AI", async () => {
    const { core, service, ai } = await setup();
    const body = payload();
    const received = await service.receiveWhatsApp({ rawBody: Buffer.from(JSON.stringify(body)), payload: body, signature: "test" });
    await service.processEvent(received.webhookEventId);
    expect((await core.store.find(COLLECTIONS.contacts, { limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find(COLLECTIONS.leads, { filters: [["orgId", "==", "RXDH"]], limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find(COLLECTIONS.conversations, { limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find(COLLECTIONS.messages, { filters: [["orgId", "==", "RXDH"]], limit: 10 })).items).toHaveLength(1);
    expect(ai.processInbound).toHaveBeenCalledTimes(1);
  });

  it("reuses the customer and open conversation on later messages", async () => {
    const { core, service } = await setup();
    for (const id of ["wamid.1", "wamid.2"]) {
      const body = payload(id);
      const event = await service.receiveWhatsApp({ rawBody: Buffer.from(JSON.stringify(body)), payload: body, signature: "test" });
      await service.processEvent(event.webhookEventId);
    }
    expect((await core.store.find(COLLECTIONS.contacts, { limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find(COLLECTIONS.conversations, { limit: 10 })).items).toHaveLength(1);
    expect((await core.store.find(COLLECTIONS.messages, { filters: [["orgId", "==", "RXDH"]], limit: 10 })).items).toHaveLength(2);
  });

  it("archives media without delaying initial receipt persistence", async () => {
    const { service, media } = await setup();
    const body = payload("wamid.media", "image");
    const event = await service.receiveWhatsApp({ rawBody: Buffer.from(JSON.stringify(body)), payload: body, signature: "test" });
    await service.processEvent(event.webhookEventId);
    expect(media.downloadAndStore).toHaveBeenCalledWith(expect.objectContaining({ media: expect.objectContaining({ providerMediaId: "media-1" }) }));
  });
});
