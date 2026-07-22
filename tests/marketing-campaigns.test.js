import { describe, expect, it } from "vitest";
import { makeCore, seedConversation } from "./helpers/core.js";
import { MarketingService } from "../src/services/marketing.service.js";
import { MarketingTemplateService } from "../src/services/marketing-template.service.js";

function makeMarketing(core) {
  return new MarketingService({
    ...core,
    templates: new MarketingTemplateService()
  });
}

describe("WhatsApp marketing campaigns", () => {
  it("enrolls only contacts with recorded opt-in and queues a Marketing template", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const unconsented = await core.contacts.create("RXDH", { contactPerson: "No Consent", primaryPhone: "9999999999" });
    const marketing = makeMarketing(core);
    await marketing.recordConsent("RXDH", seeded.contact.contactId, {
      status: "OPTED_IN",
      source: "IN_PERSON",
      note: "Requested product updates at the store"
    }, { userId: "USR_ADMIN" });
    const audience = await marketing.createAudience("RXDH", {
      name: "Interested buyers",
      contactIds: [seeded.contact.contactId, unconsented.contactId]
    });
    const campaign = await marketing.createCampaign("RXDH", {
      name: "Interest follow-up",
      audienceId: audience.audienceId,
      interestLabel: "premium catalogue",
      templateId: "interest_followup",
      steps: [{ delayDays: 0, messageLine: "Our team can share the latest options and pricing." }]
    });

    const launched = await marketing.launchCampaign("RXDH", campaign.campaignId);
    expect(launched.stats).toMatchObject({ total: 2, eligible: 1, suppressed: 1, active: 1 });

    await marketing.processDue(10);
    const messages = await core.store.find("messages", { filters: [["direction", "==", "OUTBOUND"]], limit: 10 });
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0].type).toBe("TEMPLATE");
    expect(messages.items[0].metadata.templateCategory).toBe("MARKETING");
    expect(messages.items[0].metadata.campaignId).toBe(campaign.campaignId);
    const completed = await marketing.getCampaign("RXDH", campaign.campaignId);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.stats).toMatchObject({ sent: 1, active: 0, completed: 1 });
  });

  it("pauses the remaining drip after a customer reply", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const marketing = makeMarketing(core);
    await marketing.recordConsent("RXDH", seeded.contact.contactId, { status: "OPTED_IN", source: "PHONE", note: "Asked for follow-ups" });
    const audience = await marketing.createAudience("RXDH", { name: "Hot prospects", contactIds: [seeded.contact.contactId] });
    const campaign = await marketing.createCampaign("RXDH", {
      name: "Two touch follow-up",
      audienceId: audience.audienceId,
      interestLabel: "catalogue printing",
      templateId: "interest_followup",
      steps: [
        { delayDays: 0, messageLine: "Would you like the latest catalogue options?" },
        { delayDays: 3, messageLine: "We can help prepare a quotation when you are ready." }
      ]
    });
    await marketing.launchCampaign("RXDH", campaign.campaignId);
    await marketing.processDue(10);
    await marketing.handleInbound({
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      message: { messageId: "MSG_REPLY", conversationId: seeded.conversation.conversationId, text: "Yes, share details" }
    });
    const details = await marketing.getCampaign("RXDH", campaign.campaignId, { includeEnrollments: true });
    expect(details.enrollments[0].status).toBe("PAUSED_REPLIED");
    expect(details.enrollments[0].nextRunAt).toBeNull();
    expect(details.stats).toMatchObject({ sent: 1, replied: 1, active: 0 });
  });

  it("honours STOP and records an opt-out", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const marketing = makeMarketing(core);
    await marketing.recordConsent("RXDH", seeded.contact.contactId, { status: "OPTED_IN", source: "ORDER_FORM", note: "Checked marketing updates" });
    await marketing.handleInbound({
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      message: { messageId: "MSG_STOP", conversationId: seeded.conversation.conversationId, text: "STOP" }
    });
    const contact = await core.contacts.get("RXDH", seeded.contact.contactId);
    expect(contact.marketingConsent.status).toBe("OPTED_OUT");
    expect(contact.marketingConsent.source).toBe("WHATSAPP_REPLY");
  });

  it("loads Marketing data and due work without composite Firestore indexes", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const marketing = makeMarketing(core);
    await marketing.recordConsent("RXDH", seeded.contact.contactId, { status: "OPTED_IN", source: "IN_PERSON", note: "Requested updates" });
    const audience = await marketing.createAudience("RXDH", { name: "Index-safe audience", contactIds: [seeded.contact.contactId] });
    const campaign = await marketing.createCampaign("RXDH", {
      name: "Index-safe campaign",
      audienceId: audience.audienceId,
      interestLabel: "catalogue printing",
      templateId: "interest_followup",
      steps: [{ delayDays: 0, messageLine: "We can share the available options." }]
    });
    await marketing.launchCampaign("RXDH", campaign.campaignId);

    const originalFind = core.store.find.bind(core.store);
    core.store.find = async (collection, options = {}) => {
      if (["marketingAudiences", "marketingCampaigns"].includes(collection) && options.orderBy) {
        throw new Error("COMPOSITE_INDEX_REQUIRED");
      }
      if (collection === "campaignEnrollments") {
        if ((options.filters || []).length > 1) throw new Error("COMPOSITE_INDEX_REQUIRED");
        if (options.orderBy && options.filters?.[0]?.[0] !== options.orderBy[0]) throw new Error("COMPOSITE_INDEX_REQUIRED");
      }
      return originalFind(collection, options);
    };

    await expect(marketing.listAudiences("RXDH", { limit: 100 })).resolves.toMatchObject({ items: [{ audienceId: audience.audienceId }] });
    await expect(marketing.listCampaigns("RXDH", { limit: 100 })).resolves.toMatchObject({ items: [{ campaignId: campaign.campaignId }] });
    await expect(marketing.getCampaign("RXDH", campaign.campaignId, { includeEnrollments: true })).resolves.toMatchObject({ campaignId: campaign.campaignId });
    await expect(marketing.processDue(10)).resolves.toHaveLength(1);
  });
});
