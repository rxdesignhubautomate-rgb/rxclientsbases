import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now, toDate } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const ACTIVE_ENROLLMENT_STATUSES = new Set(["ACTIVE", "PROCESSING", "PAUSED", "PAUSED_REPLIED"]);
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const MAX_AUDIENCE_SIZE = 500;

export class MarketingService {
  constructor({ store, contacts, conversations, channelAccounts, messages, templates, audit }) {
    this.store = store;
    this.contacts = contacts;
    this.conversations = conversations;
    this.channelAccounts = channelAccounts;
    this.messages = messages;
    this.templates = templates;
    this.audit = audit;
  }

  listTemplates() {
    return this.templates.list();
  }

  async recordConsent(orgId, contactId, input, actor = {}) {
    const contact = await this.contacts.get(orgId, contactId);
    const timestamp = now();
    const consent = {
      channel: "WHATSAPP",
      status: input.status,
      source: input.source,
      note: input.note || "",
      recordedAt: timestamp,
      recordedBy: actor.userId || "SYSTEM",
      optedOutAt: input.status === "OPTED_OUT" ? timestamp : null
    };
    await this.store.update(COLLECTIONS.contacts, contactId, { marketingConsent: consent, updatedAt: timestamp });
    if (input.status === "OPTED_OUT") await this.stopContactEnrollments(orgId, contactId, "OPTED_OUT");
    await this.audit.write({
      orgId,
      actorType: actor.userId ? "USER" : "SYSTEM",
      actorId: actor.userId || "SYSTEM",
      action: `WHATSAPP_MARKETING_${input.status}`,
      entityType: "CONTACT",
      entityId: contactId,
      before: { marketingConsent: contact.marketingConsent || null },
      after: { marketingConsent: consent }
    });
    return { ...contact, marketingConsent: consent };
  }

  async createAudience(orgId, input, actor = {}) {
    const contactIds = unique(input.contactIds);
    if (!contactIds.length) throw new ConflictError("Select at least one interested customer");
    if (contactIds.length > MAX_AUDIENCE_SIZE) throw new ConflictError(`An audience can contain up to ${MAX_AUDIENCE_SIZE} customers`);
    await this.assertContacts(orgId, contactIds);
    const audienceId = createId("marketingAudience");
    const timestamp = now();
    const audience = {
      audienceId,
      orgId,
      name: input.name,
      description: input.description || "",
      contactIds,
      contactCount: contactIds.length,
      createdBy: actor.userId || "SYSTEM",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.create(COLLECTIONS.marketingAudiences, audienceId, audience);
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_AUDIENCE_CREATED", entityType: "MARKETING_AUDIENCE", entityId: audienceId, after: { name: audience.name, contactCount: audience.contactCount } });
    return audience;
  }

  async updateAudience(orgId, audienceId, input, actor = {}) {
    const before = await this.getAudience(orgId, audienceId, { includeContacts: false });
    const contactIds = input.contactIds ? unique(input.contactIds) : before.contactIds;
    if (!contactIds.length) throw new ConflictError("Select at least one interested customer");
    if (contactIds.length > MAX_AUDIENCE_SIZE) throw new ConflictError(`An audience can contain up to ${MAX_AUDIENCE_SIZE} customers`);
    await this.assertContacts(orgId, contactIds);
    const patch = {
      name: input.name ?? before.name,
      description: input.description ?? before.description,
      contactIds,
      contactCount: contactIds.length,
      updatedAt: now()
    };
    await this.store.update(COLLECTIONS.marketingAudiences, audienceId, patch);
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_AUDIENCE_UPDATED", entityType: "MARKETING_AUDIENCE", entityId: audienceId, before: { contactCount: before.contactCount }, after: { contactCount: patch.contactCount } });
    return this.getAudience(orgId, audienceId);
  }

  listAudiences(orgId, options = {}) {
    return this.store.find(COLLECTIONS.marketingAudiences, {
      filters: [["orgId", "==", orgId]],
      orderBy: ["updatedAt", "desc"],
      limit: options.limit || 100,
      cursor: options.cursor
    });
  }

  async getAudience(orgId, audienceId, { includeContacts = true } = {}) {
    const audience = await this.store.get(COLLECTIONS.marketingAudiences, audienceId);
    if (!audience || audience.orgId !== orgId) throw new NotFoundError("Marketing audience");
    if (!includeContacts) return audience;
    const contacts = await this.store.getMany(COLLECTIONS.contacts, audience.contactIds || []);
    const items = contacts.filter((contact) => contact.orgId === orgId).map(contactSummary);
    return {
      ...audience,
      contacts: items,
      eligibility: eligibilitySummary(items)
    };
  }

  async createCampaign(orgId, input, actor = {}) {
    const audience = await this.getAudience(orgId, input.audienceId, { includeContacts: false });
    const campaignId = createId("marketingCampaign");
    const timestamp = now();
    const campaign = {
      campaignId,
      orgId,
      audienceId: audience.audienceId,
      audienceName: audience.name,
      name: input.name,
      interestLabel: input.interestLabel,
      templateId: input.templateId,
      steps: input.steps.map((step, index) => ({
        stepId: `STEP_${index + 1}`,
        position: index + 1,
        delayDays: step.delayDays,
        messageLine: step.messageLine
      })),
      status: "DRAFT",
      startAt: null,
      createdBy: actor.userId || "SYSTEM",
      stats: emptyStats(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.templates.prepare(campaign.templateId, { customer_name: "Customer", interest: campaign.interestLabel, message_line: campaign.steps[0].messageLine });
    await this.store.create(COLLECTIONS.marketingCampaigns, campaignId, campaign);
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_CREATED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId, after: { name: campaign.name, audienceId: campaign.audienceId, steps: campaign.steps.length } });
    return campaign;
  }

  listCampaigns(orgId, options = {}) {
    const filters = [["orgId", "==", orgId]];
    if (options.status) filters.push(["status", "==", options.status]);
    return this.store.find(COLLECTIONS.marketingCampaigns, {
      filters,
      orderBy: ["updatedAt", "desc"],
      limit: options.limit || 100,
      cursor: options.cursor
    });
  }

  async getCampaign(orgId, campaignId, { includeEnrollments = false } = {}) {
    const campaign = await this.store.get(COLLECTIONS.marketingCampaigns, campaignId);
    if (!campaign || campaign.orgId !== orgId) throw new NotFoundError("Marketing campaign");
    if (!includeEnrollments) return campaign;
    const enrollments = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["orgId", "==", orgId], ["campaignId", "==", campaignId]],
      orderBy: ["createdAt", "desc"],
      limit: MAX_AUDIENCE_SIZE
    });
    return { ...campaign, enrollments: enrollments.items };
  }

  async launchCampaign(orgId, campaignId, input = {}, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId);
    if (campaign.status !== "DRAFT") throw new ConflictError("Only a draft campaign can be launched");
    const audience = await this.getAudience(orgId, campaign.audienceId);
    const startAt = toDate(input.startAt) || now();
    if (startAt.getTime() < Date.now() - 60_000) throw new ConflictError("Campaign start time cannot be in the past");
    const firstStep = campaign.steps[0];
    const enrollmentItems = [];
    let eligible = 0;
    let suppressed = 0;
    for (const contact of audience.contacts) {
      const isEligible = marketingEligible(contact);
      const enrollmentId = createId("campaignEnrollment");
      const status = isEligible ? "ACTIVE" : "SUPPRESSED";
      if (isEligible) eligible += 1;
      else suppressed += 1;
      enrollmentItems.push({
        id: enrollmentId,
        data: {
          campaignEnrollmentId: enrollmentId,
          orgId,
          campaignId,
          audienceId: audience.audienceId,
          contactId: contact.contactId,
          conversationId: null,
          status,
          suppressionReason: isEligible ? null : eligibilityReason(contact),
          currentStepIndex: 0,
          nextRunAt: isEligible ? addDays(startAt, firstStep.delayDays) : null,
          sentCount: 0,
          lastMessageId: null,
          replyMessageId: null,
          orderId: null,
          createdAt: now(),
          updatedAt: now()
        }
      });
    }
    if (!eligible) throw new ConflictError("No selected customer has recorded WhatsApp marketing opt-in");
    await this.store.batchUpdate(COLLECTIONS.campaignEnrollments, enrollmentItems);
    const stats = { total: audience.contacts.length, eligible, active: eligible, suppressed, sent: 0, replied: 0, converted: 0, completed: 0, optedOut: 0 };
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, { status: "ACTIVE", startAt, launchedAt: now(), launchedBy: actor.userId || "SYSTEM", stats, updatedAt: now() });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_LAUNCHED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId, after: { startAt, stats } });
    return this.getCampaign(orgId, campaignId);
  }

  async pauseCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId);
    if (campaign.status !== "ACTIVE") throw new ConflictError("Only an active campaign can be paused");
    await this.moveCampaignEnrollments(orgId, campaignId, "ACTIVE", "PAUSED");
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, { status: "PAUSED", pausedAt: now(), updatedAt: now() });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_PAUSED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async resumeCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId);
    if (campaign.status !== "PAUSED") throw new ConflictError("Only a paused campaign can be resumed");
    await this.moveCampaignEnrollments(orgId, campaignId, "PAUSED", "ACTIVE", { nextRunAt: now() });
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, { status: "ACTIVE", resumedAt: now(), updatedAt: now() });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_RESUMED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async processDue(limit = 20) {
    const due = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["status", "in", ["ACTIVE", "PROCESSING"]], ["nextRunAt", "<=", now()]],
      orderBy: ["nextRunAt", "asc"],
      limit
    });
    const results = [];
    for (const enrollment of due.items) {
      try {
        results.push(await this.processEnrollment(enrollment));
      } catch (error) {
        results.push({ enrollmentId: enrollment.campaignEnrollmentId || enrollment.id, error: String(error.message || error) });
      }
    }
    return results;
  }

  async processEnrollment(candidate) {
    const enrollmentId = candidate.campaignEnrollmentId || candidate.id;
    const claimed = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.campaignEnrollments, enrollmentId);
      const dueAt = toDate(current?.nextRunAt);
      const lockedAt = toDate(current?.lockedAt);
      const stale = current?.status === "PROCESSING" && (!lockedAt || Date.now() - lockedAt.getTime() > 15 * 60 * 1000);
      if (!current || !["ACTIVE", "PROCESSING"].includes(current.status) || (current.status === "PROCESSING" && !stale) || !dueAt || dueAt.getTime() > Date.now()) return null;
      tx.update(COLLECTIONS.campaignEnrollments, enrollmentId, { status: "PROCESSING", lockedAt: now(), updatedAt: now() });
      return current;
    });
    if (!claimed) return { skipped: true };
    try {
      const [campaign, contact] = await Promise.all([
        this.getCampaign(claimed.orgId, claimed.campaignId),
        this.contacts.get(claimed.orgId, claimed.contactId)
      ]);
      if (campaign.status !== "ACTIVE") return this.finishEnrollment(claimed, "PAUSED", { nextRunAt: claimed.nextRunAt }, {}, "PROCESSING");
      if (!marketingEligible(contact)) return this.finishEnrollment(claimed, "SUPPRESSED", { suppressionReason: eligibilityReason(contact), nextRunAt: null }, { active: -1, suppressed: 1 }, "PROCESSING");
      const step = campaign.steps[claimed.currentStepIndex];
      if (!step) return this.finishEnrollment(claimed, "COMPLETED", { nextRunAt: null }, { active: -1, completed: 1 }, "PROCESSING");
      const conversation = await this.ensureWhatsappConversation(claimed.orgId, contact);
      const prepared = this.templates.prepare(campaign.templateId, {
        customer_name: customerName(contact),
        interest: campaign.interestLabel,
        message_line: step.messageLine
      });
      const latest = await this.store.get(COLLECTIONS.campaignEnrollments, enrollmentId);
      if (latest?.status !== "PROCESSING") return { enrollmentId, status: latest?.status || "SKIPPED" };
      const result = await this.messages.queueOutbound({
        orgId: claimed.orgId,
        conversationId: conversation.conversationId,
        text: prepared.text,
        type: prepared.type,
        metadata: {
          ...prepared.metadata,
          campaignId: campaign.campaignId,
          campaignEnrollmentId: enrollmentId,
          campaignStepId: step.stepId
        },
        senderType: "SYSTEM",
        senderId: "MARKETING_CAMPAIGN",
        idempotencyKey: `CAMPAIGN:${enrollmentId}:${step.stepId}`
      });
      const nextIndex = claimed.currentStepIndex + 1;
      const nextStep = campaign.steps[nextIndex];
      const completed = !nextStep;
      return this.finishEnrollment(claimed, completed ? "COMPLETED" : "ACTIVE", {
        conversationId: conversation.conversationId,
        currentStepIndex: nextIndex,
        nextRunAt: completed ? null : addDays(now(), nextStep.delayDays),
        sentCount: Number(claimed.sentCount || 0) + 1,
        lastMessageId: result.message?.messageId || claimed.lastMessageId,
        lockedAt: null
      }, completed ? { sent: 1, active: -1, completed: 1 } : { sent: 1 }, "PROCESSING");
    } catch (error) {
      await this.finishEnrollment(claimed, "ACTIVE", {
        nextRunAt: new Date(Date.now() + 15 * 60 * 1000),
        lockedAt: null,
        lastError: { code: String(error.code || "CAMPAIGN_SEND_FAILED"), message: String(error.message || error).slice(0, 300) },
      }, {}, "PROCESSING");
      throw error;
    }
  }

  async handleInbound({ orgId, contactId, message }) {
    const text = String(message?.text || "").trim().toUpperCase();
    const command = text.split(/\s+/)[0]?.replace(/[^A-Z]/g, "") || "";
    if (STOP_WORDS.has(command)) {
      await this.recordConsent(orgId, contactId, { status: "OPTED_OUT", source: "WHATSAPP_REPLY", note: `Customer replied ${text}` });
      return { optedOut: true };
    }
    const changed = await this.stopContactEnrollments(orgId, contactId, "PAUSED_REPLIED", {
      replyMessageId: message?.messageId || null,
      conversationId: message?.conversationId || null
    });
    return { optedOut: false, pausedCampaigns: changed };
  }

  async attributeOrder(orgId, contactId, orderId) {
    const changed = await this.stopContactEnrollments(orgId, contactId, "CONVERTED", { orderId, convertedAt: now() });
    return { convertedCampaigns: changed };
  }

  async stopContactEnrollments(orgId, contactId, targetStatus, patch = {}) {
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["orgId", "==", orgId], ["contactId", "==", contactId]],
      limit: MAX_AUDIENCE_SIZE
    });
    let changed = 0;
    for (const enrollment of result.items.filter((item) => ACTIVE_ENROLLMENT_STATUSES.has(item.status) && item.status !== targetStatus)) {
      const fromActive = ["ACTIVE", "PROCESSING", "PAUSED"].includes(enrollment.status);
      const delta = {};
      if (fromActive) delta.active = -1;
      if (targetStatus === "PAUSED_REPLIED") delta.replied = 1;
      if (targetStatus === "CONVERTED") delta.converted = 1;
      if (targetStatus === "OPTED_OUT") delta.optedOut = 1;
      await this.finishEnrollment(enrollment, targetStatus, { ...patch, nextRunAt: null, lockedAt: null }, delta);
      changed += 1;
    }
    return changed;
  }

  async finishEnrollment(enrollment, status, patch = {}, statsDelta = {}, expectedStatus = null) {
    const enrollmentId = enrollment.campaignEnrollmentId || enrollment.id;
    const changed = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.campaignEnrollments, enrollmentId);
      if (!current || (expectedStatus && current.status !== expectedStatus)) return false;
      tx.update(COLLECTIONS.campaignEnrollments, enrollmentId, { status, ...patch, updatedAt: now() });
      return true;
    });
    if (!changed) return { enrollmentId, status: "SKIPPED" };
    if (Object.keys(statsDelta).length) await this.incrementCampaignStats(enrollment.campaignId, statsDelta);
    return { enrollmentId, status };
  }

  async incrementCampaignStats(campaignId, delta) {
    await this.store.runTransaction(async (tx) => {
      const campaign = await tx.get(COLLECTIONS.marketingCampaigns, campaignId);
      if (!campaign) return;
      const stats = { ...emptyStats(), ...(campaign.stats || {}) };
      for (const [key, value] of Object.entries(delta)) stats[key] = Math.max(0, Number(stats[key] || 0) + Number(value || 0));
      const patch = { stats, updatedAt: now() };
      if (campaign.status === "ACTIVE" && stats.eligible > 0 && stats.active === 0) {
        patch.status = "COMPLETED";
        patch.completedAt = now();
      }
      tx.update(COLLECTIONS.marketingCampaigns, campaignId, patch);
    });
  }

  async moveCampaignEnrollments(orgId, campaignId, fromStatus, toStatus, patch = {}) {
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["orgId", "==", orgId], ["campaignId", "==", campaignId], ["status", "==", fromStatus]],
      limit: MAX_AUDIENCE_SIZE
    });
    if (!result.items.length) return 0;
    return this.store.batchUpdate(COLLECTIONS.campaignEnrollments, result.items.map((item) => ({
      id: item.campaignEnrollmentId || item.id,
      data: { status: toStatus, ...patch, updatedAt: now() }
    })));
  }

  async ensureWhatsappConversation(orgId, contact) {
    if (!contact.primaryPhone) throw new ConflictError("Customer does not have a WhatsApp phone number");
    const account = await this.channelAccounts.resolveForSend(orgId, "WHATSAPP", null);
    const identities = await this.contacts.listIdentities(orgId, contact.contactId);
    let identity = identities.items.find((item) => item.channel === "WHATSAPP" && item.active === true);
    if (!identity) {
      identity = await this.contacts.addIdentity(orgId, contact.contactId, {
        channel: "WHATSAPP",
        externalUserId: contact.primaryPhone,
        channelAccountId: account.channelAccountId || account.id,
        active: true
      }, { userId: "MARKETING_CAMPAIGN" });
    }
    return this.conversations.findOrCreate({
      orgId,
      contactId: contact.contactId,
      channel: "WHATSAPP",
      channelAccountId: identity.channelAccountId || account.channelAccountId || account.id,
      assignedTo: contact.assignedTo || null
    });
  }

  async assertContacts(orgId, contactIds) {
    const contacts = await this.store.getMany(COLLECTIONS.contacts, contactIds);
    const valid = new Set(contacts.filter((item) => item.orgId === orgId).map((item) => item.contactId || item.id));
    const missing = contactIds.filter((contactId) => !valid.has(contactId));
    if (missing.length) throw new ConflictError(`${missing.length} selected customer record(s) are unavailable`);
  }
}

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function addDays(date, days) {
  return new Date(toDate(date).getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function customerName(contact) {
  return String(contact.contactPerson || contact.companyName || "Customer").trim().slice(0, 100);
}

function marketingEligible(contact) {
  return contact.status === "ACTIVE" && Boolean(contact.primaryPhone) && contact.marketingConsent?.status === "OPTED_IN";
}

function eligibilityReason(contact) {
  if (contact.status !== "ACTIVE") return "CONTACT_INACTIVE";
  if (!contact.primaryPhone) return "PHONE_MISSING";
  if (contact.marketingConsent?.status === "OPTED_OUT") return "OPTED_OUT";
  return "OPT_IN_NOT_RECORDED";
}

function contactSummary(contact) {
  return {
    contactId: contact.contactId || contact.id,
    companyName: contact.companyName || "",
    contactPerson: contact.contactPerson || "",
    primaryPhone: contact.primaryPhone || "",
    city: contact.city || "",
    status: contact.status || "ACTIVE",
    assignedTo: contact.assignedTo || null,
    marketingConsent: contact.marketingConsent || null,
    eligibleForMarketing: marketingEligible(contact),
    marketingSuppressionReason: marketingEligible(contact) ? null : eligibilityReason(contact)
  };
}

function eligibilitySummary(contacts) {
  const eligible = contacts.filter((contact) => contact.eligibleForMarketing).length;
  return { total: contacts.length, eligible, suppressed: contacts.length - eligible };
}

function emptyStats() {
  return { total: 0, eligible: 0, active: 0, suppressed: 0, sent: 0, replied: 0, converted: 0, completed: 0, optedOut: 0 };
}
