import { COLLECTIONS } from "../config/constants.js";
import { getWhatsAppTemplate } from "../config/whatsapp-templates.js";
import { decideMessageType, MESSAGE_MODES, UTILITY_EVENT_REQUIREMENTS } from "./message-decision.service.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now, toDate } from "../utils/dates.js";
import { normalizePhone } from "../utils/phone.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

export class SmartMessageService {
  constructor({ store, contacts, conversations, channelAccounts, messages, utilityTemplates, marketingTemplates, templateRegistry, config = {} }) {
    this.store = store;
    this.contacts = contacts;
    this.conversations = conversations;
    this.channelAccounts = channelAccounts;
    this.messages = messages;
    this.utilityTemplates = utilityTemplates;
    this.marketingTemplates = marketingTemplates;
    this.templateRegistry = templateRegistry;
    this.config = {
      marketingMax24h: Number(config.marketingMax24h) || 1,
      marketingMax7d: Number(config.marketingMax7d) || 3,
      marketingMax30d: Number(config.marketingMax30d) || 8,
      marketingCooldownHours: Number(config.marketingCooldownHours) || 24,
      idempotencyLockMinutes: Number(config.idempotencyLockMinutes) || 15
    };
  }

  /** Loads server-owned state and returns the proposed policy decision without sending. */
  async decide(orgId, input) {
    const context = await this.loadContext(orgId, input);
    const transactionVerified = await this.verifyTransaction(orgId, context.contact.contactId, input);
    const frequency = this.marketingFrequency(context.contact, input.templateKey, input.now);
    const idempotencyKey = this.idempotencyKey(context, input);
    const duplicate = await this.store.get(COLLECTIONS.messageDecisionKeys, idempotencyKey);
    const decision = decideMessageType({
      ...input,
      lead: context.policyLead,
      phone: context.contact.primaryPhone,
      transactionVerified,
      duplicateBlocked: Boolean(duplicate && duplicate.status !== "FAILED"),
      frequencyLimitReached: frequency.limitReached,
      templateCooldownActive: frequency.cooldownActive
    });
    return { decision, context, idempotencyKey, frequency, transactionVerified };
  }

  /**
   * Makes one audited policy decision and queues an outbound message through the existing durable outbox.
   */
  async smartSend(orgId, input, actor = {}) {
    let evaluated = await this.decide(orgId, input);
    let { decision } = evaluated;
    let approvedTemplate = null;
    if (decision.allowed && decision.requiresTemplate) {
      try {
        approvedTemplate = await this.templateRegistry.assertApproved(orgId, decision.templateKey);
      } catch (error) {
        decision = blockedDecision(decision, `TEMPLATE_NOT_APPROVED:${error.message}`);
        evaluated = { ...evaluated, decision };
      }
    }

    if (!decision.allowed) {
      const audit = await this.writeDecisionAudit(orgId, input, evaluated, actor, { sent: false });
      await this.saveLastDecision(evaluated.context, decision, audit.messageAuditLogId);
      return { success: true, sent: false, queued: false, mode: decision.mode, reason: decision.reason, metaMessageId: null, error: null, auditId: audit.messageAuditLogId };
    }

    const claimed = await this.claim(evaluated.idempotencyKey, orgId, input, evaluated.context);
    if (!claimed) {
      decision = blockedDecision(decision, "DUPLICATE_SEND_BLOCKED");
      const audit = await this.writeDecisionAudit(orgId, input, { ...evaluated, decision }, actor, { sent: false });
      return { success: true, sent: false, queued: false, mode: decision.mode, reason: decision.reason, metaMessageId: null, error: null, auditId: audit.messageAuditLogId };
    }

    try {
      const conversation = await this.ensureConversation(orgId, evaluated.context.contact, input.conversationId);
      const prepared = this.prepareMessage(decision, input, evaluated.context);
      useProviderTemplateLanguage(prepared, approvedTemplate);
      const result = await this.messages.queueOutbound({
        orgId,
        conversationId: conversation.conversationId,
        text: prepared.text,
        type: prepared.type,
        attachmentIds: decision.requiresTemplate
          ? (input.templateAttachmentIds || [])
          : (input.attachmentIds || []),
        replyToMessageId: input.replyToMessageId || input.metadata?.replyToMessageId || null,
        metadata: {
          ...(input.metadata || {}),
          ...prepared.metadata,
          messageDecisionMode: decision.mode,
          messageDecisionReason: decision.reason,
          messageDecisionKey: evaluated.idempotencyKey,
          eventType: input.eventType || null,
          orderId: input.orderId || null,
          quotationId: input.quotationId || null,
          campaignId: input.campaignId || input.metadata?.campaignId || null
        },
        senderType: actor.userId ? "AGENT" : "SYSTEM",
        senderId: actor.userId || "SMART_SEND",
        idempotencyKey: evaluated.idempotencyKey
      });
      const messageId = result.message?.messageId || result.message?.id || null;
      await this.store.update(COLLECTIONS.messageDecisionKeys, evaluated.idempotencyKey, {
        status: "QUEUED",
        messageId,
        updatedAt: now()
      });
      if (decision.mode === MESSAGE_MODES.MARKETING || input.isPromotional === true) {
        await this.recordMarketingQueued(evaluated.context, decision.templateKey, input.now);
      }
      if (decision.requiresTemplate) await this.recordTemplateQueued(evaluated.context, decision, prepared.metadata?.template, input);
      const audit = await this.writeDecisionAudit(orgId, input, { ...evaluated, decision }, actor, { sent: false, queued: true, messageId });
      await this.saveLastDecision(evaluated.context, decision, audit.messageAuditLogId, messageId);
      return {
        success: true,
        sent: false,
        queued: true,
        duplicate: Boolean(result.duplicate),
        mode: decision.mode,
        reason: decision.reason,
        messageId,
        metaMessageId: result.message?.providerMessageId || null,
        error: null,
        auditId: audit.messageAuditLogId
      };
    } catch (error) {
      await this.store.update(COLLECTIONS.messageDecisionKeys, evaluated.idempotencyKey, {
        status: "FAILED",
        lastError: { code: String(error.code || "SMART_SEND_FAILED"), message: String(error.message || error).slice(0, 500) },
        updatedAt: now()
      });
      await this.writeDecisionAudit(orgId, input, evaluated, actor, { sent: false, error });
      throw error;
    }
  }

  async loadContext(orgId, input) {
    let lead = null;
    if (input.leadId) {
      lead = await this.store.get(COLLECTIONS.leads, input.leadId);
      if (!lead || lead.orgId !== orgId) throw new NotFoundError("Lead");
    }
    const contactId = input.contactId || lead?.contactId;
    if (!contactId) throw new ConflictError("leadId or contactId is required");
    const contact = await this.contacts.get(orgId, contactId);
    if (!lead) lead = await this.latestLead(orgId, contactId);
    let conversation = null;
    if (input.conversationId) {
      conversation = await this.conversations.get(orgId, input.conversationId);
      if (conversation.contactId !== contactId) throw new ConflictError("Conversation does not belong to the selected contact");
    } else {
      const result = await this.store.find(COLLECTIONS.conversations, { filters: [["contactId", "==", contactId]], limit: 100 });
      conversation = result.items
        .filter((item) => item.orgId === orgId && item.channel === "WHATSAPP")
        .sort((a, b) => (toDate(b.lastMessageAt)?.getTime() || 0) - (toDate(a.lastMessageAt)?.getTime() || 0))[0] || null;
    }
    const policyLead = {
      ...(lead || {}),
      primaryPhone: contact.primaryPhone,
      status: contact.status,
      suppressed: contact.suppressed === true || contact.status === "BLOCKED",
      marketingConsent: contact.marketingConsent || null,
      marketingOptIn: contact.marketingOptIn === true || contact.marketingConsent?.status === "OPTED_IN",
      marketingOptOut: contact.marketingOptOut === true || contact.marketingConsent?.status === "OPTED_OUT",
      lastUserMessageAt: lead?.lastUserMessageAt || contact.lastUserMessageAt || conversation?.lastInboundAt || null,
      serviceWindowExpiresAt: lead?.serviceWindowExpiresAt || contact.serviceWindowExpiresAt || null,
      freeEntryWindowExpiresAt: lead?.freeEntryWindowExpiresAt || contact.freeEntryWindowExpiresAt || null
    };
    return { lead, contact, conversation, policyLead };
  }

  async latestLead(orgId, contactId) {
    const result = await this.store.find(COLLECTIONS.leads, { filters: [["contactId", "==", contactId]], limit: 100 });
    return result.items
      .filter((item) => item.orgId === orgId)
      .sort((a, b) => (toDate(b.updatedAt || b.createdAt)?.getTime() || 0) - (toDate(a.updatedAt || a.createdAt)?.getTime() || 0))[0] || null;
  }

  async verifyTransaction(orgId, contactId, input) {
    if (!UTILITY_EVENT_REQUIREMENTS[input.eventType]) return false;
    const collection = input.quotationId ? COLLECTIONS.quotations : COLLECTIONS.orders;
    const id = input.quotationId || input.orderId;
    if (!id) return false;
    const record = await this.store.get(collection, id);
    return Boolean(record && record.orgId === orgId && record.contactId === contactId);
  }

  marketingFrequency(contact, templateKey, current = new Date()) {
    const currentTime = toDate(current) || new Date();
    const history = (contact.marketingSendHistory || []).map(toDate).filter(Boolean);
    const countSince = (hours) => history.filter((date) => currentTime.getTime() - date.getTime() < hours * 60 * 60 * 1000).length;
    const lastAt = toDate(contact.lastMarketingMessageAt);
    const cooldownActive = contact.lastMarketingTemplateKey === templateKey && lastAt
      ? currentTime.getTime() - lastAt.getTime() < this.config.marketingCooldownHours * 60 * 60 * 1000
      : false;
    const counts = { last24Hours: countSince(24), last7Days: countSince(24 * 7), last30Days: countSince(24 * 30) };
    return {
      ...counts,
      cooldownActive,
      limitReached: counts.last24Hours >= this.config.marketingMax24h
        || counts.last7Days >= this.config.marketingMax7d
        || counts.last30Days >= this.config.marketingMax30d
    };
  }

  idempotencyKey(context, input) {
    const raw = input.idempotencyKey || [
      context.lead?.leadId || context.contact.contactId,
      input.eventType || "MESSAGE",
      input.orderId || input.quotationId || input.campaignId || input.metadata?.campaignStepId || input.templateKey || "GENERAL"
    ].join(":");
    return sha256(`${context.contact.orgId}:SMART_SEND:${raw}`);
  }

  async claim(keyId, orgId, input, context) {
    return this.store.runTransaction(async (tx) => {
      const current = await tx.get(COLLECTIONS.messageDecisionKeys, keyId);
      const lockedAt = toDate(current?.lockedAt);
      const staleFailed = current?.status === "FAILED" && (!lockedAt || Date.now() - lockedAt.getTime() > this.config.idempotencyLockMinutes * 60 * 1000);
      if (current && !staleFailed) return false;
      tx.set(COLLECTIONS.messageDecisionKeys, keyId, {
        idempotencyKey: keyId,
        orgId,
        leadId: context.lead?.leadId || null,
        contactId: context.contact.contactId,
        eventType: input.eventType || null,
        orderId: input.orderId || null,
        quotationId: input.quotationId || null,
        campaignId: input.campaignId || input.metadata?.campaignId || null,
        status: "CLAIMED",
        lockedAt: now(),
        createdAt: current?.createdAt || now(),
        updatedAt: now()
      }, { merge: true });
      return true;
    });
  }

  prepareMessage(decision, input, context) {
    const templateData = {
      ...(input.templateData || {}),
      customer_name: input.templateData?.customer_name
        || context.contact.contactPerson
        || context.contact.companyName
        || "Customer"
    };
    if (decision.mode === MESSAGE_MODES.SERVICE) {
      let text = String(input.textMessage || "").trim();
      if (!text && input.templateKey) {
        const template = getWhatsAppTemplate(input.templateKey);
        if (template?.category === "UTILITY") text = this.utilityTemplates.prepare(input.templateKey, templateData).text;
        if (template?.category === "MARKETING") text = this.marketingTemplates.prepare(input.templateKey, templateData).text;
      }
      const structured = ["LOCATION", "CONTACT", "INTERACTIVE", "REACTION"].includes(input.messageType)
        && (input.metadata || input.messageMetadata);
      if (!text && !(input.attachmentIds || []).length && !structured) {
        throw new ConflictError("textMessage, an attachment, or a structured message payload is required");
      }
      return {
        text,
        type: input.messageType || "TEXT",
        metadata: input.messageMetadata || input.metadata || {}
      };
    }
    if (decision.mode === MESSAGE_MODES.UTILITY) return this.utilityTemplates.prepare(decision.templateKey, templateData);
    if (decision.mode === MESSAGE_MODES.MARKETING) return this.marketingTemplates.prepare(decision.templateKey, templateData);
    throw new ConflictError("Message policy blocked this send");
  }

  async ensureConversation(orgId, contact, requestedConversationId = null) {
    if (requestedConversationId) return this.conversations.get(orgId, requestedConversationId);
    if (!normalizePhone(contact.primaryPhone)) throw new ConflictError("Customer does not have a valid WhatsApp number");
    const account = await this.channelAccounts.resolveForSend(orgId, "WHATSAPP", null);
    const identities = await this.contacts.listIdentities(orgId, contact.contactId);
    let identity = identities.items.find((item) => item.channel === "WHATSAPP" && item.active === true);
    if (!identity) {
      identity = await this.contacts.addIdentity(orgId, contact.contactId, {
        channel: "WHATSAPP",
        externalUserId: contact.primaryPhone,
        channelAccountId: account.channelAccountId || account.id,
        active: true
      }, { userId: "SMART_SEND" });
    }
    return this.conversations.findOrCreate({
      orgId,
      contactId: contact.contactId,
      leadId: null,
      channel: "WHATSAPP",
      channelAccountId: identity.channelAccountId || account.channelAccountId || account.id,
      contactRelationshipType: contact.relationshipType || "PROSPECT",
      assignedTo: contact.assignedTo || null
    });
  }

  async recordMarketingQueued(context, templateKey, current = new Date()) {
    const contact = context.contact;
    const timestamp = toDate(current) || now();
    const history = [...(contact.marketingSendHistory || []).map(toDate).filter(Boolean), timestamp]
      .filter((date) => timestamp.getTime() - date.getTime() < 30 * 24 * 60 * 60 * 1000)
      .slice(-50);
    await this.store.update(COLLECTIONS.contacts, contact.contactId, {
      lastMarketingMessageAt: timestamp,
      lastMarketingTemplateKey: templateKey,
      marketingSendHistory: history,
      marketingMessagesLast7Days: history.filter((date) => timestamp.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000).length,
      marketingMessagesLast30Days: history.length,
      updatedAt: timestamp
    });
    if (context.lead?.leadId) {
      await this.store.update(COLLECTIONS.leads, context.lead.leadId, {
        lastMarketingMessageAt: timestamp,
        lastMarketingTemplateKey: templateKey,
        marketingMessagesLast7Days: history.filter((date) => timestamp.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000).length,
        marketingMessagesLast30Days: history.length,
        updatedAt: timestamp
      });
    }
  }

  async recordTemplateQueued(context, decision, preparedTemplate = null, input = {}) {
    const template = getWhatsAppTemplate(decision.templateKey);
    const patch = {
      lastTemplateSentAt: now(),
      lastTemplateName: preparedTemplate?.name || template?.name || null,
      lastTemplateCategory: template?.category || null,
      updatedAt: now()
    };
    await this.store.update(COLLECTIONS.contacts, context.contact.contactId, patch);
    if (context.lead?.leadId) {
      await this.store.update(COLLECTIONS.leads, context.lead.leadId, {
        ...patch,
        ...(input.quotationId ? { quotationRequested: true, quotationId: input.quotationId } : {}),
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...leadEventPatch(input.eventType)
      });
    }
  }

  async writeDecisionAudit(orgId, input, evaluated, actor, result = {}) {
    const id = createId("messageAuditLog");
    const decision = evaluated.decision;
    const context = evaluated.context;
    const record = {
      messageAuditLogId: id,
      orgId,
      leadId: context.lead?.leadId || input.leadId || null,
      contactId: context.contact.contactId,
      campaignId: input.campaignId || input.metadata?.campaignId || null,
      eventType: input.eventType || null,
      requestedMode: input.requestedMode || null,
      selectedMode: decision.mode,
      reason: decision.reason,
      templateName: decision.templateKey ? getWhatsAppTemplate(decision.templateKey)?.name || null : null,
      templateCategory: decision.mode === MESSAGE_MODES.UTILITY ? "UTILITY" : decision.mode === MESSAGE_MODES.MARKETING ? "MARKETING" : null,
      serviceWindowOpen: decision.serviceWindowOpen,
      freeEntryWindowOpen: decision.freeEntryWindowOpen,
      marketingOptIn: context.policyLead.marketingOptIn === true,
      marketingOptOut: context.policyLead.marketingOptOut === true,
      sent: Boolean(result.sent),
      queued: Boolean(result.queued),
      messageId: result.messageId || null,
      metaMessageId: result.metaMessageId || null,
      errorCode: result.error ? String(result.error.code || "SMART_SEND_FAILED") : null,
      errorMessage: result.error ? String(result.error.message || result.error).slice(0, 500) : null,
      requestedBy: actor.userId || "SYSTEM",
      createdAt: now()
    };
    await this.store.create(COLLECTIONS.messageAuditLogs, id, record);
    return record;
  }

  async saveLastDecision(context, decision, auditId, messageId = null) {
    const value = { mode: decision.mode, reason: decision.reason, auditId, messageId, decidedAt: now() };
    await this.store.update(COLLECTIONS.contacts, context.contact.contactId, { lastMessageDecision: value, updatedAt: now() });
    if (context.lead?.leadId) await this.store.update(COLLECTIONS.leads, context.lead.leadId, { lastMessageDecision: value, updatedAt: now() });
  }
}

function useProviderTemplateLanguage(prepared, approvedTemplate) {
  const language = String(approvedTemplate?.language || "").trim();
  if (language && prepared?.metadata?.template?.language) {
    prepared.metadata.template.language.code = language;
  }
}

function blockedDecision(previous, reason) {
  return {
    mode: MESSAGE_MODES.BLOCKED,
    reason,
    serviceWindowOpen: previous.serviceWindowOpen,
    freeEntryWindowOpen: previous.freeEntryWindowOpen,
    requiresTemplate: false,
    allowed: false,
    templateKey: null
  };
}

function leadEventPatch(eventType) {
  if (eventType === "ORDER_CONFIRMATION") return { orderStatus: eventType };
  if (eventType === "DESIGN_APPROVED") return { designStatus: eventType };
  if (eventType === "READY_TO_DISPATCH") return { dispatchStatus: eventType };
  if (eventType === "EXPERIENCE_FEEDBACK") return { feedbackStatus: "REQUESTED" };
  return {};
}
