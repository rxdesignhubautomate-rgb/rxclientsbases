import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { providerEventId, webhookPhoneNumberId } from "../channels/whatsapp/whatsapp.normalizer.js";

export class WebhookService {
  constructor({ store, orgId, whatsappAdapter, channelManager, channelAccounts, contacts, conversations, messages, domain, assignment, media, ai, notifications, marketing = null, legacyDualWrite, allowUnsigned = false }) {
    this.store = store;
    this.orgId = orgId;
    this.whatsappAdapter = whatsappAdapter;
    this.channelManager = channelManager;
    this.channelAccounts = channelAccounts;
    this.contacts = contacts;
    this.conversations = conversations;
    this.messages = messages;
    this.domain = domain;
    this.assignment = assignment;
    this.media = media;
    this.ai = ai;
    this.notifications = notifications;
    this.marketing = marketing;
    this.legacyDualWrite = legacyDualWrite;
    this.allowUnsigned = allowUnsigned;
  }

  verifyChallenge(query, expectedToken) {
    if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === expectedToken) {
      return String(query["hub.challenge"] || "");
    }
    throw new AppError("WEBHOOK_VERIFICATION_FAILED", "Webhook verification failed", 403);
  }

  async receiveWhatsApp({ rawBody, payload, signature }) {
    const verified = await this.whatsappAdapter.verifyWebhook({ rawBody, signature, allowUnsigned: this.allowUnsigned });
    if (!verified) throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Invalid webhook signature", 401);
    const payloadHash = sha256(rawBody);
    const eventProviderId = providerEventId(payload, payloadHash);
    const keyId = sha256(`${this.orgId}:META:WHATSAPP:${eventProviderId}:${payloadHash}`);
    const webhookEventId = createId("webhookEvent");
    const timestamp = now();
    const event = {
      webhookEventId,
      orgId: this.orgId,
      provider: "META",
      channel: "WHATSAPP",
      channelAccountId: null,
      phoneNumberId: webhookPhoneNumberId(payload),
      providerEventId: eventProviderId,
      payloadHash,
      payload,
      processingStatus: "PENDING",
      attemptCount: 0,
      lastError: null,
      receivedAt: timestamp,
      processedAt: null,
      lockedAt: null,
      lockedBy: null
    };
    return this.store.runTransaction(async (tx) => {
      const existing = await tx.get(COLLECTIONS.idempotencyKeys, keyId);
      if (existing) return { duplicate: true, webhookEventId: existing.webhookEventId };
      tx.create(COLLECTIONS.webhookEvents, webhookEventId, event);
      tx.create(COLLECTIONS.idempotencyKeys, keyId, {
        orgId: this.orgId,
        kind: "WEBHOOK",
        providerEventId: eventProviderId,
        payloadHash,
        webhookEventId,
        createdAt: timestamp
      });
      return { duplicate: false, webhookEventId };
    });
  }

  async processEvent(webhookEventId) {
    const record = await this.store.get(COLLECTIONS.webhookEvents, webhookEventId);
    if (!record || record.orgId !== this.orgId) throw new AppError("WEBHOOK_EVENT_NOT_FOUND", "Webhook event not found", 404);
    if (record.processingStatus === "PROCESSED") return { duplicate: true };
    const account = await this.channelAccounts.resolveInbound(this.orgId, record.phoneNumberId);
    const normalized = await this.channelManager.normalizeWebhook(account, record.payload);
    const results = [];
    for (const event of normalized) {
      if (event.kind === "STATUS") {
        results.push(await this.messages.updateProviderStatus(this.orgId, event.providerMessageId, event.status, event.error));
        continue;
      }
      const { contact } = await this.contacts.resolveInboundIdentity({
        orgId: this.orgId,
        channel: "WHATSAPP",
        externalUserId: event.externalUserId,
        channelAccountId: account.channelAccountId || account.id,
        profileName: event.profileName
      });
      if (!contact.assignedTo && this.assignment) {
        const assignedTo = await this.assignment.nextSalesUser(this.orgId);
        if (assignedTo) {
          await this.contacts.update(this.orgId, contact.contactId, { assignedTo });
          contact.assignedTo = assignedTo;
        }
      }
      const lead = await this.domain.ensureLead({
        orgId: this.orgId,
        contact,
        source: "WHATSAPP"
      });
      const conversation = await this.conversations.findOrCreate({
        orgId: this.orgId,
        contactId: contact.contactId,
        leadId: lead.leadId,
        channel: "WHATSAPP",
        channelAccountId: account.channelAccountId || account.id,
        assignedTo: lead.assignedTo
      });
      if (!lead.conversationId) {
        await this.store.update(COLLECTIONS.leads, lead.leadId, { conversationId: conversation.conversationId, updatedAt: now() });
      }
      const saved = await this.messages.createInbound({
        orgId: this.orgId,
        conversationId: conversation.conversationId,
        contactId: contact.contactId,
        leadId: lead.leadId,
        channel: "WHATSAPP",
        channelAccountId: account.channelAccountId || account.id,
        type: event.type,
        text: event.text,
        providerMessageId: event.providerMessageId,
        providerTimestamp: event.providerTimestamp,
        senderId: event.externalUserId,
        metadata: event.metadata
      });
      if (!saved.duplicate) {
        await this.legacyDualWrite.saveInbound({
          channel: "WHATSAPP",
          senderId: event.externalUserId,
          text: event.text,
          providerMessageId: event.providerMessageId
        });
        if (this.marketing) {
          await this.marketing.handleInbound({
            orgId: this.orgId,
            contactId: contact.contactId,
            message: saved.message
          });
        }
      }
      if (event.media && !saved.duplicate) {
        try {
          await this.media.downloadAndStore({
            orgId: this.orgId,
            account,
            contactId: contact.contactId,
            conversationId: conversation.conversationId,
            messageId: saved.message.messageId,
            media: event.media
          });
        } catch (error) {
          const automationJobId = createId("automationJob");
          await this.store.create(COLLECTIONS.automationJobs, automationJobId, {
            automationJobId,
            orgId: this.orgId,
            type: "MEDIA_DOWNLOAD",
            status: "PENDING",
            attemptCount: 0,
            nextAttemptAt: now(),
            payload: {
              channelAccountId: account.channelAccountId || account.id,
              contactId: contact.contactId,
              conversationId: conversation.conversationId,
              messageId: saved.message.messageId,
              media: event.media
            },
            lastError: { message: error.message.slice(0, 300) },
            createdAt: now(),
            updatedAt: now()
          });
          await this.notifications.create(this.orgId, {
            type: "MEDIA_DOWNLOAD_FAILED",
            severity: "ERROR",
            title: "Inbound media could not be archived",
            entityType: "MESSAGE",
            entityId: saved.message.messageId,
            metadata: { providerMediaId: event.media.providerMediaId, automationJobId, error: error.message.slice(0, 300) }
          });
        }
      }
      const aiResult = await this.ai.processInbound({
        orgId: this.orgId,
        conversationId: conversation.conversationId,
        message: saved.message
      });
      results.push({ saved, aiResult });
    }
    await this.store.update(COLLECTIONS.webhookEvents, webhookEventId, {
      channelAccountId: account.channelAccountId || account.id,
      processingStatus: "PROCESSED",
      processedAt: now(),
      lockedAt: null,
      lockedBy: null,
      lastError: null
    });
    return { duplicate: false, results };
  }
}
