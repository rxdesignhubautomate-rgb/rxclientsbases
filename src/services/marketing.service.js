import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { now, toDate } from "../utils/dates.js";
import { normalizePhone } from "../utils/phone.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { customerServiceWindow } from "./conversation.service.js";
import {
  canAccessRelationship,
  CLIENT_SCOPES,
  normalizeSegment,
  relationshipTypesForScope,
  resolveClientScope
} from "../utils/client-scope.js";

const ACTIVE_ENROLLMENT_STATUSES = new Set(["ACTIVE", "PROCESSING", "WAITING_FOR_WINDOW", "PAUSED", "PAUSED_REPLIED", "COMPLETED"]);
const RUNNING_CAMPAIGN_STATUSES = new Set(["ACTIVE", "RUNNING"]);
const OPT_OUT_PHRASES = Object.freeze(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "NOT INTERESTED", "NO MORE MESSAGES", "BAND KARO", "MESSAGE MAT KARO"]);
const OPT_IN_PHRASES = new Set(["START", "YES", "INTERESTED", "SEND DETAILS", "SEND SAMPLE", "PRICE BHEJO"]);
const MAX_AUDIENCE_SIZE = 10000;
const MAX_RECIPIENTS_PER_BATCH = 500;
// Daily marketing send: 220 keeps a safety buffer under the 250/day (Tier 0)
// WhatsApp messaging limit so no message in a batch is rejected for cap overflow.
const DAILY_MARKETING_BATCH_SIZE = 220;
const MAX_SEGMENT_CONTACTS = 50000;
const TEMPERATURE_RANK = Object.freeze({ HOT: 3, WARM: 2, COLD: 1 });

export class MarketingService {
  constructor({ store, contacts, conversations, channelAccounts, messages, templates, templateRegistry = null, smartMessages = null, audit, config = {} }) {
    this.store = store;
    this.contacts = contacts;
    this.conversations = conversations;
    this.channelAccounts = channelAccounts;
    this.messages = messages;
    this.templates = templates;
    this.templateRegistry = templateRegistry;
    this.smartMessages = smartMessages;
    this.audit = audit;
    this.config = {
      jobLockMinutes: Number(config.jobLockMinutes) || 15,
      maxRetries: Number(config.maxRetries) || 5
    };
  }

  listTemplates() {
    return this.templates.list();
  }

  async listRepliedProspects(orgId, options = {}) {
    const result = await this.store.find(COLLECTIONS.marketingProspects, {
      filters: [["orgId", "==", orgId]],
      limit: Math.min(Math.max(Number(options.limit) || 100, 1), 500),
      cursor: options.cursor
    });
    let items = result.items;
    if (options.relationshipTypes?.length) {
      const missingType = items.filter((item) => !item.relationshipType);
      const contacts = missingType.length
        ? await this.store.getMany(COLLECTIONS.contacts, missingType.map((item) => item.contactId))
        : [];
      const typeByContact = new Map(contacts.map((contact) => [contact.contactId || contact.id, contact.relationshipType || "PROSPECT"]));
      items = items.filter((item) => options.relationshipTypes.includes(item.relationshipType || typeByContact.get(item.contactId) || "PROSPECT"));
    }
    if (options.temperature) items = items.filter((item) => item.aiTemperature === options.temperature);
    if (options.important !== undefined) items = items.filter((item) => Boolean(item.important) === options.important);
    if (options.repeatMarketing !== undefined) items = items.filter((item) => Boolean(item.repeatMarketing) === options.repeatMarketing);
    if (options.assignedTo) items = items.filter((item) => item.assignedTo === options.assignedTo);
    return { ...result, items: sortRepliedProspects(items) };
  }

  async recordRepliedProspect({ orgId, contactId, message, campaignContext = {}, aiResult = null }) {
    const contact = await this.contacts.get(orgId, contactId);
    const timestamp = toDate(message?.createdAt) || now();
    const classification = classifyMarketingReply(aiResult, message?.text);
    const prospect = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.marketingProspects, contactId);
      const next = {
        prospectId: contactId,
        orgId,
        contactId,
        companyName: contact.companyName || "",
        contactPerson: contact.contactPerson || "",
        primaryPhone: contact.primaryPhone || "",
        city: contact.city || "",
        relationshipType: contact.relationshipType || "PROSPECT",
        status: "REPLIED",
        aiTemperature: classification.temperature,
        aiConfidence: classification.confidence,
        aiReason: classification.reason,
        classificationSource: classification.source,
        lastReplyText: String(message?.text || "").trim().slice(0, 1000),
        lastReplyMessageId: message?.messageId || null,
        lastReplyAt: timestamp,
        conversationId: message?.conversationId || current?.conversationId || null,
        lastCampaignId: campaignContext.campaignId || current?.lastCampaignId || null,
        lastCampaignEnrollmentId: campaignContext.campaignEnrollmentId || current?.lastCampaignEnrollmentId || null,
        replyCount: Number(current?.replyCount || 0) + 1,
        important: Boolean(current?.important),
        repeatMarketing: Boolean(current?.repeatMarketing),
        assignedTo: current?.assignedTo ?? contact.assignedTo ?? null,
        suppressed: contact.marketingConsent?.status === "OPTED_OUT",
        suppressionReason: contact.marketingConsent?.status === "OPTED_OUT" ? "OPTED_OUT" : null,
        createdAt: current?.createdAt || timestamp,
        updatedAt: timestamp
      };
      tx.set(COLLECTIONS.marketingProspects, contactId, next, { merge: true });
      return { ...(current || {}), ...next };
    });
    return prospect;
  }

  async updateRepliedProspect(orgId, contactId, input, actor = {}) {
    const before = await this.store.get(COLLECTIONS.marketingProspects, contactId);
    if (!before || before.orgId !== orgId) throw new NotFoundError("Replied marketing customer");
    const contact = await this.contacts.get(orgId, contactId);
    this.assertActorRelationship(actor, contact.relationshipType);
    if (input.assignedTo) {
      const user = await this.store.get(COLLECTIONS.users, input.assignedTo);
      if (!user || user.orgId !== orgId || !user.active || !["OWNER", "ADMIN", "SALES_MANAGER", "SALES"].includes(user.role)) {
        throw new ConflictError("Select an active sales user");
      }
    }
    if (input.repeatMarketing === true) {
      if (contact.marketingConsent?.status !== "OPTED_IN") {
        throw new ConflictError("Record WhatsApp marketing opt-in before adding this customer to repeat marketing");
      }
    }
    const timestamp = now();
    const patch = { updatedAt: timestamp };
    if (input.important !== undefined) {
      patch.important = input.important;
      patch.importantUpdatedAt = timestamp;
      patch.importantUpdatedBy = actor.userId || "SYSTEM";
    }
    if (input.assignedTo !== undefined) {
      patch.assignedTo = input.assignedTo;
      patch.assignmentUpdatedAt = timestamp;
      patch.assignmentUpdatedBy = actor.userId || "SYSTEM";
    }
    if (input.repeatMarketing !== undefined) {
      patch.repeatMarketing = input.repeatMarketing;
      patch.repeatMarketingUpdatedAt = timestamp;
      patch.repeatMarketingUpdatedBy = actor.userId || "SYSTEM";
    }
    await this.store.update(COLLECTIONS.marketingProspects, contactId, patch);
    await this.audit.write({
      orgId,
      actorType: actor.userId ? "USER" : "SYSTEM",
      actorId: actor.userId || "SYSTEM",
      action: "MARKETING_REPLIED_CUSTOMER_UPDATED",
      entityType: "CONTACT",
      entityId: contactId,
      before: { important: before.important, assignedTo: before.assignedTo, repeatMarketing: before.repeatMarketing },
      after: { important: patch.important, assignedTo: patch.assignedTo, repeatMarketing: patch.repeatMarketing }
    });
    return { ...before, ...patch };
  }

  async findContactCampaignContext(orgId, contactId) {
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["contactId", "==", contactId]],
      limit: MAX_AUDIENCE_SIZE
    });
    return sortRecent(result.items.filter((item) => item.orgId === orgId))[0] || null;
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
    await this.store.update(COLLECTIONS.contacts, contactId, {
      marketingConsent: consent,
      marketingOptIn: input.status === "OPTED_IN",
      marketingOptOut: input.status === "OPTED_OUT",
      marketingOptOutAt: input.status === "OPTED_OUT" ? timestamp : null,
      optInStatus: input.status,
      optInSource: input.source,
      optInTimestamp: input.status === "OPTED_IN" ? timestamp : contact.optInTimestamp || null,
      suppressed: input.status === "OPTED_OUT",
      updatedAt: timestamp
    });
    const leads = await this.store.find(COLLECTIONS.leads, { filters: [["contactId", "==", contactId]], limit: MAX_AUDIENCE_SIZE });
    for (const lead of leads.items.filter((item) => item.orgId === orgId && !["CLOSED_WON", "CLOSED_LOST"].includes(item.leadStatus))) {
      await this.store.update(COLLECTIONS.leads, lead.leadId || lead.id, {
        marketingOptIn: input.status === "OPTED_IN",
        marketingOptOut: input.status === "OPTED_OUT",
        marketingOptOutAt: input.status === "OPTED_OUT" ? timestamp : null,
        optInStatus: input.status,
        optInSource: input.source,
        optInTimestamp: input.status === "OPTED_IN" ? timestamp : lead.optInTimestamp || null,
        suppressed: input.status === "OPTED_OUT",
        updatedAt: timestamp
      });
    }
    if (input.status === "OPTED_OUT") await this.stopContactEnrollments(orgId, contactId, "OPTED_OUT");
    const prospect = await this.store.get(COLLECTIONS.marketingProspects, contactId);
    if (prospect?.orgId === orgId) {
      await this.store.update(COLLECTIONS.marketingProspects, contactId, {
        suppressed: input.status === "OPTED_OUT",
        suppressionReason: input.status === "OPTED_OUT" ? "OPTED_OUT" : null,
        ...(input.status === "OPTED_OUT" ? { repeatMarketing: false } : {}),
        updatedAt: timestamp
      });
    }
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
    if (contactIds.length > MAX_RECIPIENTS_PER_BATCH) throw new ConflictError(`Create separate batches of up to ${MAX_RECIPIENTS_PER_BATCH} customers`);
    const contacts = await this.assertContacts(orgId, contactIds);
    const relationshipType = normalizeSegment(input.relationshipType)
      || singleSegment(contacts)
      || "MIXED";
    this.assertActorRelationship(actor, relationshipType);
    if (actor.role === "SALES" && relationshipType === "MIXED") {
      throw new ConflictError("A sales user cannot create a mixed client/prospect audience");
    }
    const audienceId = createId("marketingAudience");
    const timestamp = now();
    const audience = {
      audienceId,
      orgId,
      name: input.name,
      description: input.description || "",
      relationshipType,
      ownerScope: resolveClientScope(actor),
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

  async createSegmentBatches(orgId, input, actor = {}) {
    const relationshipType = normalizeSegment(input.relationshipType);
    if (!relationshipType) throw new ConflictError("Select Existing Client or Prospect");
    this.assertActorRelationship(actor, relationshipType);
    const relationshipTypes = relationshipType === "PROSPECT" ? ["PROSPECT", "LEAD"] : ["EXISTING_CLIENT"];
    const result = await this.store.find(COLLECTIONS.contacts, {
      filters: [["orgId", "==", orgId]],
      limit: MAX_SEGMENT_CONTACTS
    });
    const contacts = result.items
      .filter((contact) => relationshipTypes.includes(contact.relationshipType || "PROSPECT"))
      .filter((contact) => contact.status === "ACTIVE")
      .filter((contact) => !input.onlyOptedIn || contact.marketingConsent?.status === "OPTED_IN" || contact.marketingOptIn === true)
      .sort((left, right) => String(left.contactId || left.id).localeCompare(String(right.contactId || right.id)));
    if (!contacts.length) throw new ConflictError(`No active ${relationshipType === "EXISTING_CLIENT" ? "existing clients" : "prospects"} were found`);
    const batchSize = Math.min(Number(input.batchSize) || MAX_RECIPIENTS_PER_BATCH, MAX_RECIPIENTS_PER_BATCH);
    const chunks = chunk(contacts, batchSize);
    const batchGroupId = createId("marketingAudience");
    const created = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const audienceId = createId("marketingAudience");
      const contactIds = chunks[index].map((contact) => contact.contactId || contact.id);
      const timestamp = now();
      const batch = {
        audienceId,
        orgId,
        name: `${input.name} - Batch ${index + 1} of ${chunks.length}`,
        description: input.description || `${relationshipType === "EXISTING_CLIENT" ? "Existing clients" : "Prospects"} batch`,
        relationshipType,
        ownerScope: resolveClientScope(actor),
        contactIds,
        contactCount: contactIds.length,
        batchGroupId,
        batchNumber: index + 1,
        batchCount: chunks.length,
        batchSize: contactIds.length,
        createdBy: actor.userId || "SYSTEM",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      created.push(batch);
    }
    await this.store.batchUpdate(COLLECTIONS.marketingAudiences, created.map((batch) => ({
      id: batch.audienceId,
      data: batch
    })));
    await this.audit.write({
      orgId,
      actorId: actor.userId || "SYSTEM",
      action: "MARKETING_AUDIENCE_BATCHES_CREATED",
      entityType: "MARKETING_AUDIENCE_GROUP",
      entityId: batchGroupId,
      after: { relationshipType, totalContacts: contacts.length, batchCount: created.length, batchSize }
    });
    return {
      batchGroupId,
      relationshipType,
      totalContacts: contacts.length,
      batchSize,
      batchCount: created.length,
      audiences: created
    };
  }

  async createDirectExistingCampaigns(orgId, input, actor = {}) {
    const prepared = this.templates.prepare(input.templateId, {
      customer_name: "Customer",
      interest: input.interestLabel,
      message_line: input.messageLine
    });
    const templateHeader = prepared.metadata.templateHeader;
    if (templateHeader?.required && !input.templateHeaderAttachmentId) {
      throw new ConflictError(`Upload the ${String(templateHeader.type || "media").toLowerCase()} used by this approved Meta template`);
    }
    if (input.templateHeaderAttachmentId) {
      await this.assertTemplateHeaderAttachment(orgId, input.templateHeaderAttachmentId, templateHeader);
    }
    if (this.templateRegistry) await this.templateRegistry.assertApproved(orgId, input.templateId);

    const batches = await this.createSegmentBatches(orgId, {
      name: input.name,
      description: input.description || "Direct campaign for opted-in existing clients",
      relationshipType: "EXISTING_CLIENT",
      batchSize: input.batchSize || DAILY_MARKETING_BATCH_SIZE,
      onlyOptedIn: true
    }, actor);
    const minimumStart = new Date(Date.now() + 2 * 60 * 1000);
    const requestedStart = toDate(input.startAt);
    const baseStart = requestedStart && requestedStart.getTime() > minimumStart.getTime()
      ? requestedStart
      : minimumStart;
    // intervalDays > 0 spaces each batch one (or more) whole days apart so only
    // one batch (<=220) sends per 24h and the daily messaging limit is respected.
    // intervalDays 0 falls back to the legacy minute-level stagger.
    const intervalDays = Math.max(Number(input.intervalDays) || 0, 0);
    const intervalMinutes = Math.max(Number(input.intervalMinutes) || 10, 5);
    const spacingMinutes = intervalDays > 0 ? intervalDays * 24 * 60 : intervalMinutes;
    const campaigns = [];
    const campaignRecords = [];
    const timestamp = now();

    for (let index = 0; index < batches.audiences.length; index += 1) {
      const audience = batches.audiences[index];
      const campaignId = createId("marketingCampaign");
      const campaignName = `${input.name} - Batch ${index + 1} of ${batches.batchCount}`;
      const startAt = new Date(baseStart.getTime() + index * spacingMinutes * 60 * 1000);
      const campaign = {
        campaignId,
        orgId,
        audienceId: audience.audienceId,
        audienceName: audience.name,
        name: campaignName,
        description: input.description || "",
        interestLabel: input.interestLabel,
        templateId: input.templateId,
        templateHeaderAttachmentId: input.templateHeaderAttachmentId || null,
        relationshipType: "EXISTING_CLIENT",
        ownerScope: resolveClientScope(actor),
        deliveryMode: "AUTO",
        trigger: "MANUAL",
        steps: [{
          stepId: "STEP_1",
          position: 1,
          delayDays: 0,
          delayMinutes: 0,
          messageLine: input.messageLine,
          messageType: "TEXT",
          attachmentIds: []
        }],
        templateCategory: "MARKETING",
        status: "SCHEDULED",
        lifecycleStatus: "SCHEDULED",
        startAt,
        submittedAt: timestamp,
        submittedBy: actor.userId || "SYSTEM",
        approvedAt: timestamp,
        approvedBy: actor.userId || "SYSTEM",
        approvalMode: "DIRECT_OWNER_ADMIN",
        scheduledAt: timestamp,
        scheduledBy: actor.userId || "SYSTEM",
        createdBy: actor.userId || "SYSTEM",
        stats: emptyStats(),
        directSendGroupId: batches.batchGroupId,
        directExistingClientSend: true,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      campaignRecords.push({ id: campaignId, data: campaign });
      campaigns.push({
        campaignId,
        name: campaignName,
        audienceId: audience.audienceId,
        contactCount: audience.contactCount,
        status: "SCHEDULED",
        startAt
      });
    }
    await this.store.batchUpdate(COLLECTIONS.marketingCampaigns, campaignRecords);

    await this.audit.write({
      orgId,
      actorId: actor.userId || "SYSTEM",
      action: "DIRECT_EXISTING_CLIENT_CAMPAIGNS_SCHEDULED",
      entityType: "MARKETING_CAMPAIGN_GROUP",
      entityId: batches.batchGroupId,
      after: {
        totalContacts: batches.totalContacts,
        batchCount: batches.batchCount,
        intervalDays,
        intervalMinutes,
        spacingMinutes,
        firstStartAt: baseStart
      }
    });
    return {
      directSendGroupId: batches.batchGroupId,
      relationshipType: "EXISTING_CLIENT",
      totalContacts: batches.totalContacts,
      batchCount: batches.batchCount,
      batchSize: batches.batchSize,
      intervalDays,
      intervalMinutes,
      spacingMinutes,
      dailyBatches: intervalDays > 0,
      firstStartAt: baseStart,
      campaigns
    };
  }

  async previewExistingAudience(orgId, { batchSize } = {}) {
    const result = await this.store.find(COLLECTIONS.contacts, {
      filters: [["orgId", "==", orgId]],
      limit: MAX_SEGMENT_CONTACTS
    });
    const contacts = result.items.filter((contact) => contact.relationshipType === "EXISTING_CLIENT");
    const reasons = contacts.map((contact) => eligibilityReason(contact));
    const addressable = reasons.filter((reason) => reason === null).length;
    const resolvedBatchSize = Math.min(
      Math.max(Number(batchSize) || DAILY_MARKETING_BATCH_SIZE, 1),
      MAX_RECIPIENTS_PER_BATCH
    );
    const dailyBatches = Math.ceil(addressable / resolvedBatchSize);
    const suppressed = {
      optedOut: reasons.filter((reason) => reason === "OPTED_OUT").length,
      noPhone: reasons.filter((reason) => reason === "INVALID_PHONE").length,
      optInNotRecorded: reasons.filter((reason) => reason === "OPT_IN_NOT_RECORDED").length,
      inactiveOrOther: reasons.filter((reason) => reason && !["OPTED_OUT", "INVALID_PHONE", "OPT_IN_NOT_RECORDED"].includes(reason)).length
    };
    return {
      totalExistingClients: contacts.length,
      active: contacts.filter((contact) => contact.status === "ACTIVE").length,
      addressable,
      suppressed,
      batchSize: resolvedBatchSize,
      dailyBatches,
      daysToComplete: dailyBatches,
      note: addressable
        ? `${addressable} opted-in existing clients can be scheduled across ${dailyBatches} daily batch(es).`
        : "No existing client is currently eligible. Record explicit WhatsApp marketing opt-in before scheduling."
    };
  }

  async updateAudience(orgId, audienceId, input, actor = {}) {
    const before = await this.getAudience(orgId, audienceId, { includeContacts: false, actor });
    const contactIds = input.contactIds ? unique(input.contactIds) : before.contactIds;
    if (!contactIds.length) throw new ConflictError("Select at least one interested customer");
    if (contactIds.length > MAX_RECIPIENTS_PER_BATCH) throw new ConflictError(`An audience can contain up to ${MAX_RECIPIENTS_PER_BATCH} customers`);
    const contacts = await this.assertContacts(orgId, contactIds);
    const relationshipType = normalizeSegment(input.relationshipType) || singleSegment(contacts) || before.relationshipType || "MIXED";
    this.assertActorRelationship(actor, relationshipType);
    const patch = {
      name: input.name ?? before.name,
      description: input.description ?? before.description,
      relationshipType,
      contactIds,
      contactCount: contactIds.length,
      updatedAt: now()
    };
    await this.store.update(COLLECTIONS.marketingAudiences, audienceId, patch);
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_AUDIENCE_UPDATED", entityType: "MARKETING_AUDIENCE", entityId: audienceId, before: { contactCount: before.contactCount }, after: { contactCount: patch.contactCount } });
    return this.getAudience(orgId, audienceId);
  }

  async listAudiences(orgId, options = {}) {
    const result = await this.store.find(COLLECTIONS.marketingAudiences, {
      filters: [["orgId", "==", orgId]],
      limit: options.limit || 100,
      cursor: options.cursor
    });
    const items = this.filterForActor(result.items, options.actor);
    return { ...result, items: sortRecent(items) };
  }

  async getAudience(orgId, audienceId, { includeContacts = true, actor = {} } = {}) {
    const audience = await this.store.get(COLLECTIONS.marketingAudiences, audienceId);
    if (!audience || audience.orgId !== orgId) throw new NotFoundError("Marketing audience");
    this.assertActorRelationship(actor, audience.relationshipType || "MIXED");
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
    const audience = await this.getAudience(orgId, input.audienceId, { includeContacts: false, actor });
    await this.assertCampaignAttachments(orgId, input.steps);
    const preparedTemplate = this.templates.prepare(input.templateId, {
      customer_name: "Customer",
      interest: input.interestLabel,
      message_line: input.steps[0].messageLine
    });
    const templateHeader = preparedTemplate.metadata.templateHeader;
    if (input.deliveryMode !== "OPEN_WINDOW_ONLY" && templateHeader?.required && !input.templateHeaderAttachmentId) {
      throw new ConflictError(`Upload the ${String(templateHeader.type || "media").toLowerCase()} used by this approved Meta template`);
    }
    if (input.templateHeaderAttachmentId) {
      await this.assertTemplateHeaderAttachment(orgId, input.templateHeaderAttachmentId, templateHeader);
    }
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
      templateHeaderAttachmentId: input.templateHeaderAttachmentId || null,
      relationshipType: audience.relationshipType || "MIXED",
      ownerScope: resolveClientScope(actor),
      deliveryMode: input.deliveryMode || "AUTO",
      trigger: input.trigger || "MANUAL",
      steps: input.steps.map((step, index) => ({
        stepId: `STEP_${index + 1}`,
        position: index + 1,
        delayDays: step.delayDays,
        delayMinutes: step.delayMinutes ?? Number(step.delayDays || 0) * 24 * 60,
        messageLine: step.messageLine,
        messageType: step.messageType || "TEXT",
        attachmentIds: step.attachmentIds || []
      })),
      templateCategory: "MARKETING",
      status: "DRAFT",
      lifecycleStatus: "DRAFT",
      startAt: null,
      createdBy: actor.userId || "SYSTEM",
      approvedBy: null,
      approvedAt: null,
      stats: emptyStats(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.create(COLLECTIONS.marketingCampaigns, campaignId, campaign);
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_CREATED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId, after: { name: campaign.name, audienceId: campaign.audienceId, steps: campaign.steps.length } });
    return campaign;
  }

  async listCampaigns(orgId, options = {}) {
    const result = await this.store.find(COLLECTIONS.marketingCampaigns, {
      filters: [["orgId", "==", orgId]],
      limit: options.limit || 100,
      cursor: options.cursor
    });
    let items = this.filterForActor(result.items, options.actor);
    if (options.status) items = items.filter((item) => item.status === options.status);
    return { ...result, items: sortRecent(items) };
  }

  async getCampaign(orgId, campaignId, { includeEnrollments = false, actor = {} } = {}) {
    const campaign = await this.store.get(COLLECTIONS.marketingCampaigns, campaignId);
    if (!campaign || campaign.orgId !== orgId) throw new NotFoundError("Marketing campaign");
    this.assertActorRelationship(actor, campaign.relationshipType || "MIXED");
    if (!includeEnrollments) return campaign;
    const enrollments = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["campaignId", "==", campaignId]],
      limit: MAX_AUDIENCE_SIZE
    });
    return { ...campaign, enrollments: sortRecent(enrollments.items.filter((item) => item.orgId === orgId)) };
  }

  async submitCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (campaign.status !== "DRAFT") throw new ConflictError("Only a draft campaign can be submitted");
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, {
      status: "PENDING_APPROVAL",
      lifecycleStatus: "PENDING_APPROVAL",
      submittedAt: now(),
      submittedBy: actor.userId || "SYSTEM",
      updatedAt: now()
    });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_SUBMITTED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async approveCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (campaign.status !== "PENDING_APPROVAL") throw new ConflictError("Only a submitted campaign can be approved");
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, {
      status: "APPROVED",
      lifecycleStatus: "APPROVED",
      approvedAt: now(),
      approvedBy: actor.userId || "SYSTEM",
      updatedAt: now()
    });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_APPROVED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async scheduleCampaign(orgId, campaignId, startAt, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (campaign.status !== "APPROVED") throw new ConflictError("Only an approved campaign can be scheduled");
    const scheduledAt = toDate(startAt);
    if (!scheduledAt || scheduledAt.getTime() <= Date.now()) throw new ConflictError("Schedule time must be in the future");
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, {
      status: "SCHEDULED",
      lifecycleStatus: "SCHEDULED",
      startAt: scheduledAt,
      scheduledAt,
      scheduledBy: actor.userId || "SYSTEM",
      updatedAt: now()
    });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_SCHEDULED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId, after: { startAt: scheduledAt } });
    return this.getCampaign(orgId, campaignId);
  }

  async startCampaign(orgId, campaignId, input = {}, actor = {}) {
    return this.launchCampaign(orgId, campaignId, { ...input, requireApproval: true }, actor);
  }

  async launchCampaign(orgId, campaignId, input = {}, actor = {}) {
    let campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (campaign.status === "DRAFT" && input.requireApproval !== true) {
      if (actor.role === "SALES") throw new ConflictError("Submit this campaign for admin approval before starting it");
      await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, {
        status: "APPROVED",
        lifecycleStatus: "APPROVED",
        approvedAt: now(),
        approvedBy: actor.userId || "SYSTEM",
        approvalMode: "LEGACY_ADMIN_LAUNCH",
        updatedAt: now()
      });
      campaign = await this.getCampaign(orgId, campaignId, { actor });
    }
    if (!["APPROVED", "SCHEDULED"].includes(campaign.status)) throw new ConflictError("Campaign must be internally approved before it can start");
    if (this.templateRegistry && campaign.deliveryMode !== "OPEN_WINDOW_ONLY") {
      await this.templateRegistry.assertApproved(orgId, campaign.templateId);
    }
    const audience = await this.getAudience(orgId, campaign.audienceId, { actor });
    const requestedStartAt = toDate(input.startAt) || now();
    if (campaign.status !== "SCHEDULED" && requestedStartAt.getTime() < Date.now() - 60_000) {
      throw new ConflictError("Campaign start time cannot be in the past");
    }
    const startAt = campaign.status === "SCHEDULED" && requestedStartAt.getTime() < Date.now() ? now() : requestedStartAt;
    const firstStep = campaign.steps[0];
    const enrollmentItems = [];
    let eligible = 0;
    let waiting = 0;
    let suppressed = 0;
    for (const contact of audience.contacts) {
      const frequency = this.smartMessages?.marketingFrequency(contact, campaign.templateId, startAt);
      const reason = eligibilityReason(contact)
        || (frequency?.limitReached ? "FREQUENCY_LIMIT" : null)
        || (frequency?.cooldownActive ? "COOLDOWN_ACTIVE" : null);
      const isEligible = !reason;
      const openWindow = serviceWindowForContact(contact, startAt).open;
      const waitsForReply = isEligible
        && campaign.deliveryMode === "OPEN_WINDOW_ONLY"
        && (!openWindow || campaign.trigger === "CUSTOMER_REPLY");
      const enrollmentId = createId("campaignEnrollment");
      const status = !isEligible ? "SUPPRESSED" : waitsForReply ? "WAITING_FOR_WINDOW" : "ACTIVE";
      if (isEligible) eligible += 1;
      if (waitsForReply) waiting += 1;
      if (!isEligible) suppressed += 1;
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
          suppressionReason: isEligible ? null : reason,
          waitingReason: waitsForReply ? (campaign.trigger === "CUSTOMER_REPLY" ? "WAITING_FOR_CUSTOMER_REPLY" : "SERVICE_WINDOW_CLOSED") : null,
          currentStepIndex: 0,
          nextRunAt: status === "ACTIVE" ? addStepDelay(startAt, firstStep) : null,
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
    const stats = {
      ...emptyStats(),
      total: audience.contacts.length,
      eligible,
      active: eligible - waiting,
      waiting,
      suppressed,
      skipped: suppressed
    };
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, { status: "ACTIVE", lifecycleStatus: "RUNNING", startAt, launchedAt: now(), startedAt: now(), launchedBy: actor.userId || "SYSTEM", stats, updatedAt: now() });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_LAUNCHED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId, after: { startAt, stats } });
    return this.getCampaign(orgId, campaignId);
  }

  async pauseCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (!RUNNING_CAMPAIGN_STATUSES.has(campaign.status)) throw new ConflictError("Only an active campaign can be paused");
    await this.moveCampaignEnrollments(orgId, campaignId, "ACTIVE", "PAUSED", { nextRunAt: null });
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, { status: "PAUSED", lifecycleStatus: "PAUSED", pausedAt: now(), updatedAt: now() });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_PAUSED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async resumeCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (campaign.status !== "PAUSED") throw new ConflictError("Only a paused campaign can be resumed");
    await this.moveCampaignEnrollments(orgId, campaignId, "PAUSED", "ACTIVE", { nextRunAt: now() });
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, { status: "ACTIVE", lifecycleStatus: "RUNNING", resumedAt: now(), updatedAt: now() });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_RESUMED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async cancelCampaign(orgId, campaignId, actor = {}) {
    const campaign = await this.getCampaign(orgId, campaignId, { actor });
    if (["COMPLETED", "CANCELLED"].includes(campaign.status)) throw new ConflictError("Campaign is already finished");
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, { filters: [["campaignId", "==", campaignId]], limit: MAX_AUDIENCE_SIZE });
    const active = result.items.filter((item) => item.orgId === orgId && ["ACTIVE", "PROCESSING", "WAITING_FOR_WINDOW", "PAUSED"].includes(item.status));
    if (active.length) {
      await this.store.batchUpdate(COLLECTIONS.campaignEnrollments, active.map((item) => ({
        id: item.campaignEnrollmentId || item.id,
        data: { status: "CANCELLED", nextRunAt: null, lockedAt: null, updatedAt: now() }
      })));
    }
    await this.store.update(COLLECTIONS.marketingCampaigns, campaignId, {
      status: "CANCELLED",
      lifecycleStatus: "CANCELLED",
      stats: {
        ...emptyStats(),
        ...(campaign.stats || {}),
        active: 0,
        waiting: 0,
        cancelled: active.length
      },
      cancelledAt: now(),
      cancelledBy: actor.userId || "SYSTEM",
      updatedAt: now()
    });
    await this.audit.write({ orgId, actorId: actor.userId || "SYSTEM", action: "MARKETING_CAMPAIGN_CANCELLED", entityType: "MARKETING_CAMPAIGN", entityId: campaignId });
    return this.getCampaign(orgId, campaignId);
  }

  async processDue(limit = 20) {
    await this.startScheduledCampaigns();
    const due = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["nextRunAt", "<=", now()]],
      orderBy: ["nextRunAt", "asc"],
      limit: Math.min(limit * 5, 100)
    });
    const results = [];
    const runnable = due.items.filter((item) => ["ACTIVE", "PROCESSING"].includes(item.status)).slice(0, limit);
    for (const enrollment of runnable) {
      try {
        results.push(await this.processEnrollment(enrollment));
      } catch (error) {
        results.push({ enrollmentId: enrollment.campaignEnrollmentId || enrollment.id, error: String(error.message || error) });
      }
    }
    return results;
  }

  async startScheduledCampaigns() {
    const result = await this.store.find(COLLECTIONS.marketingCampaigns, {
      filters: [["startAt", "<=", now()]],
      limit: 25
    });
    for (const campaign of result.items.filter((item) => item.status === "SCHEDULED")) {
      await this.startCampaign(campaign.orgId, campaign.campaignId || campaign.id, { startAt: campaign.startAt }, { userId: "CAMPAIGN_WORKER" });
    }
  }

  async processEnrollment(candidate) {
    const enrollmentId = candidate.campaignEnrollmentId || candidate.id;
    const claimed = await this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.campaignEnrollments, enrollmentId);
      const dueAt = toDate(current?.nextRunAt);
      const lockedAt = toDate(current?.lockedAt);
      const stale = current?.status === "PROCESSING" && (!lockedAt || Date.now() - lockedAt.getTime() > this.config.jobLockMinutes * 60 * 1000);
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
      if (!RUNNING_CAMPAIGN_STATUSES.has(campaign.status)) return this.finishEnrollment(claimed, "PAUSED", { nextRunAt: claimed.nextRunAt }, {}, "PROCESSING");
      if (!marketingEligible(contact)) return this.finishEnrollment(claimed, "SUPPRESSED", { suppressionReason: eligibilityReason(contact), nextRunAt: null }, { active: -1, suppressed: 1, skipped: 1 }, "PROCESSING");
      const step = campaign.steps[claimed.currentStepIndex];
      if (!step) return this.finishEnrollment(claimed, "COMPLETED", { nextRunAt: null }, { active: -1, completed: 1 }, "PROCESSING");
      const conversation = await this.ensureWhatsappConversation(claimed.orgId, contact);
      if (campaign.deliveryMode === "OPEN_WINDOW_ONLY" && !serviceWindowForContact(contact, now(), conversation).open) {
        return this.finishEnrollment(claimed, "WAITING_FOR_WINDOW", {
          waitingReason: "SERVICE_WINDOW_CLOSED",
          nextRunAt: null,
          lockedAt: null
        }, { active: -1, waiting: 1 }, "PROCESSING");
      }
      const prepared = this.templates.prepare(campaign.templateId, {
        customer_name: customerName(contact),
        interest: campaign.interestLabel,
        message_line: step.messageLine
      });
      const approvedTemplate = this.templateRegistry && !this.smartMessages
        ? await this.templateRegistry.assertApproved(claimed.orgId, campaign.templateId)
        : null;
      useProviderTemplateLanguage(prepared, approvedTemplate);
      const latest = await this.store.get(COLLECTIONS.campaignEnrollments, enrollmentId);
      if (latest?.status !== "PROCESSING") return { enrollmentId, status: latest?.status || "SKIPPED" };
      const result = this.smartMessages
        ? await this.smartMessages.smartSend(claimed.orgId, {
          contactId: claimed.contactId,
          conversationId: conversation.conversationId,
          eventType: "CAMPAIGN_MESSAGE",
          messageIntent: campaign.interestLabel,
          isPromotional: true,
          textMessage: step.messageLine,
          messageType: step.messageType || "TEXT",
          attachmentIds: step.attachmentIds || [],
          templateAttachmentIds: campaign.templateHeaderAttachmentId ? [campaign.templateHeaderAttachmentId] : [],
          templateKey: campaign.templateId,
          templateData: prepared.metadata.templateValues,
          campaignId: campaign.campaignId,
          idempotencyKey: `CAMPAIGN:${enrollmentId}:${step.stepId}`,
          metadata: {
            campaignId: campaign.campaignId,
            campaignEnrollmentId: enrollmentId,
            campaignStepId: step.stepId,
            deliveryMode: campaign.deliveryMode,
            marketingContent: true
          }
        }, { userId: "MARKETING_CAMPAIGN" })
        : await this.messages.queueOutbound({
          orgId: claimed.orgId,
          conversationId: conversation.conversationId,
          text: campaign.deliveryMode === "OPEN_WINDOW_ONLY" ? step.messageLine : prepared.text,
          type: campaign.deliveryMode === "OPEN_WINDOW_ONLY" ? (step.messageType || "TEXT") : prepared.type,
          attachmentIds: campaign.deliveryMode === "OPEN_WINDOW_ONLY"
            ? (step.attachmentIds || [])
            : (campaign.templateHeaderAttachmentId ? [campaign.templateHeaderAttachmentId] : []),
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
      if (this.smartMessages && !result.queued) {
        return this.finishEnrollment(claimed, "SUPPRESSED", {
          suppressionReason: result.reason,
          nextRunAt: null,
          lockedAt: null
        }, { active: -1, suppressed: 1, skipped: 1 }, "PROCESSING");
      }
      const nextIndex = claimed.currentStepIndex + 1;
      const nextStep = campaign.steps[nextIndex];
      const completed = !nextStep;
      return this.finishEnrollment(claimed, completed ? "COMPLETED" : "ACTIVE", {
        conversationId: conversation.conversationId,
        currentStepIndex: nextIndex,
        nextRunAt: completed ? null : addStepDelay(now(), nextStep),
        sentCount: Number(claimed.sentCount || 0) + 1,
        lastMessageId: result.messageId || result.message?.messageId || claimed.lastMessageId,
        lockedAt: null
      }, completed ? { sent: 1, active: -1, completed: 1 } : { sent: 1 }, "PROCESSING");
    } catch (error) {
      const retryCount = Number(claimed.retryCount || 0) + 1;
      const final = error.retryable === false || retryCount >= this.config.maxRetries;
      await this.finishEnrollment(claimed, final ? "FAILED" : "ACTIVE", {
        retryCount,
        nextRunAt: final ? null : new Date(Date.now() + Math.min(15 * 60 * 1000 * 2 ** (retryCount - 1), 24 * 60 * 60 * 1000)),
        lockedAt: null,
        lastError: { code: String(error.code || "CAMPAIGN_SEND_FAILED"), message: String(error.message || error).slice(0, 300) },
      }, final ? { active: -1, failed: 1 } : {}, "PROCESSING");
      throw error;
    }
  }

  async handleInbound({ orgId, contactId, message }) {
    const text = normalizeConsentText(message?.text);
    if (isOptOutText(text)) {
      await this.recordConsent(orgId, contactId, { status: "OPTED_OUT", source: "WHATSAPP_REPLY", note: `Customer replied ${text}` });
      return { optedOut: true, campaignReply: false };
    }
    const optedIn = OPT_IN_PHRASES.has(text);
    if (optedIn) {
      await this.recordConsent(orgId, contactId, { status: "OPTED_IN", source: "WHATSAPP_REPLY", note: `Customer explicitly replied ${text}` });
    }
    const activated = await this.activateWaitingEnrollments(orgId, contactId, message);
    const context = await this.findContactCampaignContext(orgId, contactId);
    if (!context) return { optedOut: false, optedIn, campaignReply: activated.length > 0, activatedCampaigns: activated.length, pausedCampaigns: 0 };
    const changed = await this.stopContactEnrollments(orgId, contactId, "PAUSED_REPLIED", {
      replyMessageId: message?.messageId || null,
      conversationId: message?.conversationId || null
    }, { excludeEnrollmentIds: activated });
    return {
      optedOut: false,
      optedIn,
      campaignReply: true,
      activatedCampaigns: activated.length,
      pausedCampaigns: changed,
      campaignId: context.campaignId || null,
      campaignEnrollmentId: context.campaignEnrollmentId || context.id || null
    };
  }

  async activateWaitingEnrollments(orgId, contactId, message = {}) {
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["contactId", "==", contactId]],
      limit: MAX_AUDIENCE_SIZE
    });
    const waiting = result.items.filter((item) => item.orgId === orgId && item.status === "WAITING_FOR_WINDOW");
    const activated = [];
    for (const enrollment of waiting) {
      const campaign = await this.getCampaign(orgId, enrollment.campaignId);
      if (!RUNNING_CAMPAIGN_STATUSES.has(campaign.status) || campaign.deliveryMode !== "OPEN_WINDOW_ONLY") continue;
      const step = campaign.steps[enrollment.currentStepIndex || 0];
      if (!step) continue;
      const enrollmentId = enrollment.campaignEnrollmentId || enrollment.id;
      const changed = await this.store.runTransaction(async (tx) => {
        const current = await tx.get(COLLECTIONS.campaignEnrollments, enrollmentId);
        if (!current || current.status !== "WAITING_FOR_WINDOW") return false;
        tx.update(COLLECTIONS.campaignEnrollments, enrollmentId, {
          status: "ACTIVE",
          waitingReason: null,
          conversationId: message.conversationId || current.conversationId || null,
          nextRunAt: addStepDelay(now(), step),
          activatedByMessageId: message.messageId || null,
          activatedAt: now(),
          updatedAt: now()
        });
        return true;
      });
      if (changed) {
        await this.incrementCampaignStats(campaign.campaignId, { waiting: -1, active: 1 });
        activated.push(enrollmentId);
      }
    }
    return activated;
  }

  async attributeOrder(orgId, contactId, orderId) {
    const changed = await this.stopContactEnrollments(orgId, contactId, "CONVERTED", { orderId, convertedAt: now() });
    const owner = await this.segmentOwner(orgId, "EXISTING_CLIENT");
    const timestamp = now();
    await this.store.update(COLLECTIONS.contacts, contactId, {
      relationshipType: "EXISTING_CLIENT",
      ...(owner ? { assignedTo: owner.userId || owner.id, salesPersonName: owner.name || "Ankit" } : {}),
      updatedAt: timestamp
    });
    const [conversations, leads] = await Promise.all([
      this.store.find(COLLECTIONS.conversations, { filters: [["contactId", "==", contactId]], limit: MAX_AUDIENCE_SIZE }),
      this.store.find(COLLECTIONS.leads, { filters: [["contactId", "==", contactId]], limit: MAX_AUDIENCE_SIZE })
    ]);
    if (conversations.items.length) {
      await this.store.batchUpdate(COLLECTIONS.conversations, conversations.items
        .filter((item) => item.orgId === orgId)
        .map((item) => ({
          id: item.conversationId || item.id,
          data: {
            contactRelationshipType: "EXISTING_CLIENT",
            ...(owner ? { assignedTo: owner.userId || owner.id } : {}),
            updatedAt: timestamp
          }
        })));
    }
    if (leads.items.length && owner) {
      await this.store.batchUpdate(COLLECTIONS.leads, leads.items
        .filter((item) => item.orgId === orgId)
        .map((item) => ({
          id: item.leadId || item.id,
          data: { assignedTo: owner.userId || owner.id, updatedAt: timestamp }
        })));
    }
    const prospect = await this.store.get(COLLECTIONS.marketingProspects, contactId);
    if (prospect?.orgId === orgId) {
      await this.store.update(COLLECTIONS.marketingProspects, contactId, {
        converted: true,
        relationshipType: "EXISTING_CLIENT",
        ...(owner ? { assignedTo: owner.userId || owner.id } : {}),
        lastOrderId: orderId,
        convertedAt: now(),
        updatedAt: now()
      });
    }
    return { convertedCampaigns: changed };
  }

  async stopContactEnrollments(orgId, contactId, targetStatus, patch = {}, options = {}) {
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["contactId", "==", contactId]],
      limit: MAX_AUDIENCE_SIZE
    });
    let changed = 0;
    const excluded = new Set(options.excludeEnrollmentIds || []);
    for (const enrollment of result.items.filter((item) => (
      item.orgId === orgId
      && ACTIVE_ENROLLMENT_STATUSES.has(item.status)
      && item.status !== targetStatus
      && !excluded.has(item.campaignEnrollmentId || item.id)
    ))) {
      const fromActive = ["ACTIVE", "PROCESSING", "PAUSED"].includes(enrollment.status);
      const delta = {};
      if (fromActive) delta.active = -1;
      if (enrollment.status === "WAITING_FOR_WINDOW") delta.waiting = -1;
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
      if (RUNNING_CAMPAIGN_STATUSES.has(campaign.status) && stats.eligible > 0 && stats.active === 0 && stats.waiting === 0) {
        patch.status = "COMPLETED";
        patch.lifecycleStatus = "COMPLETED";
        patch.completedAt = now();
      }
      tx.update(COLLECTIONS.marketingCampaigns, campaignId, patch);
    });
  }

  async moveCampaignEnrollments(orgId, campaignId, fromStatus, toStatus, patch = {}) {
    const result = await this.store.find(COLLECTIONS.campaignEnrollments, {
      filters: [["campaignId", "==", campaignId]],
      limit: MAX_AUDIENCE_SIZE
    });
    const matching = result.items.filter((item) => item.orgId === orgId && item.status === fromStatus);
    if (!matching.length) return 0;
    return this.store.batchUpdate(COLLECTIONS.campaignEnrollments, matching.map((item) => ({
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
      contactRelationshipType: contact.relationshipType || "PROSPECT",
      assignedTo: contact.assignedTo || null
    });
  }

  async assertContacts(orgId, contactIds) {
    const contacts = await this.store.getMany(COLLECTIONS.contacts, contactIds);
    const valid = new Set(contacts.filter((item) => item.orgId === orgId).map((item) => item.contactId || item.id));
    const missing = contactIds.filter((contactId) => !valid.has(contactId));
    if (missing.length) throw new ConflictError(`${missing.length} selected customer record(s) are unavailable`);
    return contacts.filter((item) => item.orgId === orgId);
  }

  assertActorRelationship(actor = {}, relationshipType) {
    if (actor.role !== "SALES") return;
    const scope = resolveClientScope(actor);
    if (scope === CLIENT_SCOPES.ASSIGNED) return;
    if (relationshipType === "MIXED" || !canAccessRelationship(scope, relationshipType)) {
      throw new ConflictError("This client segment belongs to another team member");
    }
  }

  filterForActor(items, actor = {}) {
    if (actor.role !== "SALES") return items;
    const scope = resolveClientScope(actor);
    if (scope === CLIENT_SCOPES.ASSIGNED) {
      return items.filter((item) => item.createdBy === actor.userId || item.assignedTo === actor.userId);
    }
    const allowedTypes = relationshipTypesForScope(scope);
    return items.filter((item) => allowedTypes.includes(item.relationshipType || "PROSPECT"));
  }

  async assertCampaignAttachments(orgId, steps = []) {
    const ids = unique(steps.flatMap((step) => step.attachmentIds || []));
    if (!ids.length) return;
    const attachments = await this.store.getMany(COLLECTIONS.attachments, ids);
    const valid = new Set(attachments
      .filter((item) => item.orgId === orgId && item.purpose === "MARKETING_ASSET")
      .map((item) => item.attachmentId || item.id));
    const missing = ids.filter((id) => !valid.has(id));
    if (missing.length) throw new ConflictError("Upload campaign media through the Marketing media picker before saving the drip");
  }

  async assertTemplateHeaderAttachment(orgId, attachmentId, header = null) {
    if (!header?.type) throw new ConflictError("The selected Meta template does not accept header media");
    const attachment = await this.store.get(COLLECTIONS.attachments, attachmentId);
    if (!attachment || attachment.orgId !== orgId || attachment.purpose !== "MARKETING_ASSET") {
      throw new ConflictError("Upload the approved template media through the Marketing media picker");
    }
    const expectedPrefix = `${String(header.type).toLowerCase()}/`;
    if (!String(attachment.mimeType || "").toLowerCase().startsWith(expectedPrefix)) {
      throw new ConflictError(`This Meta template requires a ${String(header.type).toLowerCase()} file`);
    }
  }

  async segmentOwner(orgId, relationshipType) {
    const targetEmail = normalizeSegment(relationshipType) === "EXISTING_CLIENT"
      ? "ankit@rxdesignhub.com"
      : "reshu@rxdesignhub.com";
    const result = await this.store.find(COLLECTIONS.users, {
      filters: [["orgId", "==", orgId]],
      limit: 100
    });
    return result.items.find((user) => (
      user.active !== false
      && String(user.email || "").trim().toLowerCase() === targetEmail
    )) || null;
  }
}

function useProviderTemplateLanguage(prepared, approvedTemplate) {
  const language = String(approvedTemplate?.language || "").trim();
  if (language && prepared?.metadata?.template?.language) {
    prepared.metadata.template.language.code = language;
  }
}

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function addStepDelay(date, step = {}) {
  const minutes = step.delayMinutes ?? Number(step.delayDays || 0) * 24 * 60;
  return new Date(toDate(date).getTime() + Number(minutes || 0) * 60 * 1000);
}

function customerName(contact) {
  return String(contact.contactPerson || contact.companyName || "Customer").trim().slice(0, 100);
}

function marketingEligible(contact) {
  return !eligibilityReason(contact);
}

function eligibilityReason(contact) {
  if (contact.status !== "ACTIVE") return "CONTACT_INACTIVE";
  if (!normalizePhone(contact.primaryPhone)) return "INVALID_PHONE";
  if (contact.suppressed === true) return contact.marketingOptOut === true ? "OPTED_OUT" : "SUPPRESSED";
  if (contact.marketingConsent?.status === "OPTED_OUT") return "OPTED_OUT";
  if (contact.marketingOptOut === true) return "OPTED_OUT";
  if (contact.marketingConsent?.status !== "OPTED_IN" && contact.marketingOptIn !== true) return "OPT_IN_NOT_RECORDED";
  return null;
}

function contactSummary(contact) {
  return {
    contactId: contact.contactId || contact.id,
    companyName: contact.companyName || "",
    contactPerson: contact.contactPerson || "",
    primaryPhone: contact.primaryPhone || "",
    city: contact.city || "",
    relationshipType: contact.relationshipType || "PROSPECT",
    status: contact.status || "ACTIVE",
    assignedTo: contact.assignedTo || null,
    marketingConsent: contact.marketingConsent || null,
    marketingOptIn: contact.marketingOptIn === true,
    marketingOptOut: contact.marketingOptOut === true,
    suppressed: contact.suppressed === true,
    lastMarketingMessageAt: contact.lastMarketingMessageAt || null,
    lastMarketingTemplateKey: contact.lastMarketingTemplateKey || null,
    marketingSendHistory: contact.marketingSendHistory || [],
    lastUserMessageAt: contact.lastUserMessageAt || null,
    serviceWindowExpiresAt: contact.serviceWindowExpiresAt || null,
    eligibleForMarketing: marketingEligible(contact),
    marketingSuppressionReason: marketingEligible(contact) ? null : eligibilityReason(contact)
  };
}

function eligibilitySummary(contacts) {
  const eligible = contacts.filter((contact) => contact.eligibleForMarketing).length;
  return { total: contacts.length, eligible, suppressed: contacts.length - eligible };
}

function emptyStats() {
  return { total: 0, eligible: 0, active: 0, waiting: 0, suppressed: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0, converted: 0, completed: 0, cancelled: 0, optedOut: 0 };
}

function serviceWindowForContact(contact, current = new Date(), conversation = null) {
  const currentDate = toDate(current) || new Date();
  const explicit = toDate(contact.serviceWindowExpiresAt);
  if (explicit) return { open: explicit.getTime() > currentDate.getTime(), expiresAt: explicit };
  return customerServiceWindow(contact.lastUserMessageAt || conversation?.lastInboundAt, currentDate.getTime());
}

function singleSegment(contacts) {
  const segments = new Set(contacts.map((contact) => normalizeSegment(contact.relationshipType) || "PROSPECT"));
  return segments.size === 1 ? [...segments][0] : null;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function normalizeConsentText(value) {
  return String(value || "").trim().replace(/[^a-zA-Z\s]/g, " ").replace(/\s+/g, " ").toUpperCase();
}

function isOptOutText(text) {
  return OPT_OUT_PHRASES.some((phrase) => text === phrase || text.startsWith(`${phrase} `));
}

function classifyMarketingReply(aiResult, text = "") {
  const result = aiResult?.skipped === false ? aiResult.result : null;
  if (result) {
    const interest = String(result.leadUpdates?.interestLevel || "UNKNOWN").toUpperCase();
    const intent = String(result.intent || "").toUpperCase();
    const hotIntent = ["ORDER", "QUOT", "PRICE", "PURCHASE", "BUY", "CALL", "NEGOT", "DISCOUNT"].some((signal) => intent.includes(signal));
    const coldIntent = ["NOT_INTERESTED", "REJECTION", "OPT_OUT", "UNSUBSCRIBE"].some((signal) => intent.includes(signal));
    const temperature = coldIntent
      ? "COLD"
      : hotIntent || ["HIGH", "VERY_HIGH"].includes(interest)
        ? "HOT"
        : interest === "LOW"
          ? "COLD"
          : "WARM";
    return {
      temperature,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      reason: String(result.reason || `AI detected ${intent || interest.toLowerCase()} intent`).slice(0, 500),
      source: "AI"
    };
  }
  const normalized = String(text || "").trim().toLowerCase();
  if (/\b(not interested|no thanks|maybe later|do not contact|don't contact)\b/.test(normalized)) {
    return { temperature: "COLD", confidence: 0.55, reason: "Reply indicates low or postponed interest; AI review was unavailable.", source: "RULE_FALLBACK" };
  }
  if (/\b(yes|price|quote|quotation|order|buy|purchase|call|interested)\b/.test(normalized) || normalized.includes("send details")) {
    return { temperature: "HOT", confidence: 0.55, reason: "Reply contains a strong buying or quotation signal; AI review was unavailable.", source: "RULE_FALLBACK" };
  }
  return { temperature: "WARM", confidence: 0.4, reason: "Customer replied, but the buying signal needs review because AI was unavailable.", source: "RULE_FALLBACK" };
}

function sortRepliedProspects(items = []) {
  return [...items].sort((left, right) => {
    const important = Number(Boolean(right.important)) - Number(Boolean(left.important));
    if (important) return important;
    const temperature = (TEMPERATURE_RANK[right.aiTemperature] || 0) - (TEMPERATURE_RANK[left.aiTemperature] || 0);
    if (temperature) return temperature;
    return (toDate(right.lastReplyAt)?.getTime() || 0) - (toDate(left.lastReplyAt)?.getTime() || 0);
  });
}

function sortRecent(items = []) {
  return [...items].sort((left, right) => (toDate(right.updatedAt || right.createdAt)?.getTime() || 0) - (toDate(left.updatedAt || left.createdAt)?.getTime() || 0));
}
