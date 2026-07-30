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

  it("separates replied customers, assigns AI temperature, and preserves manual priority controls", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const marketing = makeMarketing(core);
    await core.store.set("users", "USR_ANKIT", {
      userId: "USR_ANKIT",
      orgId: "RXDH",
      name: "Ankit",
      role: "SALES",
      active: true
    });
    await marketing.recordConsent("RXDH", seeded.contact.contactId, { status: "OPTED_IN", source: "PHONE", note: "Asked for updates" });
    const audience = await marketing.createAudience("RXDH", { name: "Reply prospects", contactIds: [seeded.contact.contactId] });
    const campaign = await marketing.createCampaign("RXDH", {
      name: "Reply qualification",
      audienceId: audience.audienceId,
      interestLabel: "catalogue printing",
      templateId: "interest_followup",
      steps: [{ delayDays: 0, messageLine: "Would you like a quotation?" }]
    });
    await marketing.launchCampaign("RXDH", campaign.campaignId);
    await marketing.processDue(10);
    const message = { messageId: "MSG_HOT_REPLY", conversationId: seeded.conversation.conversationId, text: "Yes, please send price and quotation" };
    const campaignContext = await marketing.handleInbound({ orgId: "RXDH", contactId: seeded.contact.contactId, message });
    expect(campaignContext).toMatchObject({ campaignReply: true, campaignId: campaign.campaignId });
    const prospect = await marketing.recordRepliedProspect({
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      message,
      campaignContext,
      aiResult: {
        skipped: false,
        result: {
          intent: "QUOTATION_REQUEST",
          leadUpdates: { interestLevel: "HIGH" },
          confidence: 0.91,
          reason: "Customer asked for pricing and a quotation"
        }
      }
    });
    expect(prospect).toMatchObject({ aiTemperature: "HOT", classificationSource: "AI", replyCount: 1, important: false });

    const updated = await marketing.updateRepliedProspect("RXDH", seeded.contact.contactId, {
      important: true,
      assignedTo: "USR_ANKIT",
      repeatMarketing: true
    }, { userId: "USR_ADMIN" });
    expect(updated).toMatchObject({ important: true, assignedTo: "USR_ANKIT", repeatMarketing: true });
    const important = await marketing.listRepliedProspects("RXDH", { important: true, temperature: "HOT", limit: 100 });
    expect(important.items).toHaveLength(1);
    expect(important.items[0].contactId).toBe(seeded.contact.contactId);

    await marketing.recordConsent("RXDH", seeded.contact.contactId, { status: "OPTED_OUT", source: "WHATSAPP_REPLY", note: "STOP" });
    const suppressed = await core.store.get("marketingProspects", seeded.contact.contactId);
    expect(suppressed).toMatchObject({ suppressed: true, repeatMarketing: false });
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

  it("recognizes Hindi opt-out and requires an explicit opt-in phrase", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const marketing = makeMarketing(core);
    await marketing.handleInbound({
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      message: { messageId: "MSG_STOP_HI", conversationId: seeded.conversation.conversationId, text: "message mat karo" }
    });
    expect((await core.contacts.get("RXDH", seeded.contact.contactId)).marketingOptOut).toBe(true);
    await marketing.handleInbound({
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      message: { messageId: "MSG_START", conversationId: seeded.conversation.conversationId, text: "START" }
    });
    expect((await core.contacts.get("RXDH", seeded.contact.contactId)).marketingConsent.status).toBe("OPTED_IN");
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

  it("requires internal approval on the strict campaign start route", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    const marketing = makeMarketing(core);
    await marketing.recordConsent("RXDH", seeded.contact.contactId, { status: "OPTED_IN", source: "PHONE", note: "Requested updates" });
    const audience = await marketing.createAudience("RXDH", { name: "Approved buyers", contactIds: [seeded.contact.contactId] });
    const campaign = await marketing.createCampaign("RXDH", {
      name: "Approval campaign",
      audienceId: audience.audienceId,
      interestLabel: "catalogue printing",
      templateId: "interest_followup",
      steps: [{ delayDays: 0, messageLine: "Would you like more details?" }]
    }, { userId: "USR_CREATOR" });
    await expect(marketing.startCampaign("RXDH", campaign.campaignId, {}, { userId: "USR_ADMIN" })).rejects.toThrow(/internally approved/);
    await marketing.submitCampaign("RXDH", campaign.campaignId, { userId: "USR_CREATOR" });
    const approved = await marketing.approveCampaign("RXDH", campaign.campaignId, { userId: "USR_ADMIN" });
    expect(approved).toMatchObject({ status: "APPROVED", approvedBy: "USR_ADMIN" });
    const started = await marketing.startCampaign("RXDH", campaign.campaignId, {}, { userId: "USR_ADMIN" });
    expect(started).toMatchObject({ status: "ACTIVE", lifecycleStatus: "RUNNING" });
  });

  it("splits a scoped customer segment into deterministic batches of at most 500", async () => {
    const core = makeCore();
    const timestamp = new Date("2026-07-31T08:00:00.000Z");
    await Promise.all(Array.from({ length: 1001 }, async (_, index) => {
      const contactId = `CNT_PROSPECT_${String(index + 1).padStart(4, "0")}`;
      await core.store.set("contacts", contactId, {
        contactId,
        orgId: "RXDH",
        contactPerson: `Prospect ${index + 1}`,
        relationshipType: "PROSPECT",
        status: "ACTIVE",
        marketingConsent: { status: "OPTED_IN" },
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }));
    await core.store.set("contacts", "CNT_EXISTING", {
      contactId: "CNT_EXISTING",
      orgId: "RXDH",
      contactPerson: "Existing client",
      relationshipType: "EXISTING_CLIENT",
      status: "ACTIVE",
      marketingConsent: { status: "OPTED_IN" },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const marketing = makeMarketing(core);
    const result = await marketing.createSegmentBatches("RXDH", {
      name: "Prospect rollout",
      relationshipType: "PROSPECT",
      batchSize: 500,
      onlyOptedIn: true
    }, {
      userId: "USR_RESHU",
      role: "SALES",
      email: "reshu@rxdesignhub.com"
    });

    expect(result).toMatchObject({ relationshipType: "PROSPECT", totalContacts: 1001, batchCount: 3 });
    expect(result.audiences.map((item) => item.contactCount)).toEqual([500, 500, 1]);
    await expect(marketing.createSegmentBatches("RXDH", {
      name: "Wrong segment",
      relationshipType: "EXISTING_CLIENT",
      batchSize: 500
    }, {
      userId: "USR_RESHU",
      role: "SALES",
      email: "reshu@rxdesignhub.com"
    })).rejects.toThrow(/another team member/);
  });

  it("waits for a new customer reply before sending an open-window video drip", async () => {
    const core = makeCore();
    const seeded = await seedConversation(core);
    await core.store.update("conversations", seeded.conversation.conversationId, {
      lastInboundAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
    });
    await core.store.set("attachments", "ATT_CAMPAIGN_VIDEO", {
      attachmentId: "ATT_CAMPAIGN_VIDEO",
      orgId: "RXDH",
      purpose: "MARKETING_ASSET",
      filename: "products.mp4",
      mimeType: "video/mp4"
    });
    const marketing = makeMarketing(core);
    await marketing.recordConsent("RXDH", seeded.contact.contactId, {
      status: "OPTED_IN",
      source: "WHATSAPP_REPLY",
      note: "Asked to receive product updates"
    });
    const audience = await marketing.createAudience("RXDH", {
      name: "Video prospects",
      relationshipType: "PROSPECT",
      contactIds: [seeded.contact.contactId]
    });
    const campaign = await marketing.createCampaign("RXDH", {
      name: "Open-window video",
      audienceId: audience.audienceId,
      interestLabel: "new product range",
      templateId: "interest_followup",
      deliveryMode: "OPEN_WINDOW_ONLY",
      trigger: "CUSTOMER_REPLY",
      steps: [{
        delayDays: 0,
        delayMinutes: 0,
        messageLine: "Here is the product video you requested.",
        messageType: "VIDEO",
        attachmentIds: ["ATT_CAMPAIGN_VIDEO"]
      }]
    });
    const launched = await marketing.launchCampaign("RXDH", campaign.campaignId);
    expect(launched.stats).toMatchObject({ active: 0, waiting: 1 });
    expect(await marketing.processDue(10)).toHaveLength(0);

    await core.store.update("conversations", seeded.conversation.conversationId, {
      lastInboundAt: new Date()
    });
    await marketing.handleInbound({
      orgId: "RXDH",
      contactId: seeded.contact.contactId,
      message: {
        messageId: "MSG_WINDOW_OPEN",
        conversationId: seeded.conversation.conversationId,
        text: "Yes, please share the video"
      }
    });
    await marketing.processDue(10);
    const outbound = await core.store.find("messages", {
      filters: [["direction", "==", "OUTBOUND"]],
      limit: 10
    });
    expect(outbound.items).toHaveLength(1);
    expect(outbound.items[0]).toMatchObject({
      type: "VIDEO",
      attachmentIds: ["ATT_CAMPAIGN_VIDEO"]
    });
  });
});
