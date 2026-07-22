import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

export class ConversationService {
  constructor({ store, audit, defaultAiMode = "ASSIST" }) {
    this.store = store;
    this.audit = audit;
    this.defaultAiMode = defaultAiMode;
  }

  async findOrCreate({ orgId, contactId, leadId = null, channel, channelAccountId, assignedTo = null }) {
    const keyId = sha256(`${orgId}:${contactId}:${channel}:OPEN`);
    const key = await this.store.get(COLLECTIONS.openConversationKeys, keyId);
    if (key) {
      const existing = await this.store.get(COLLECTIONS.conversations, key.conversationId);
      if (existing?.orgId === orgId && existing.status !== "CLOSED") return existing;
    }
    const conversationId = createId("conversation");
    const timestamp = now();
    const conversation = {
      conversationId,
      orgId,
      contactId,
      leadId,
      status: "OPEN",
      assignedTo,
      currentChannel: channel,
      currentChannelAccountId: channelAccountId,
      aiMode: this.defaultAiMode,
      humanTakeover: false,
      unreadCount: 0,
      messageCount: 0,
      lastMessageAt: timestamp,
      lastMessagePreview: "",
      summary: "",
      summaryUpdatedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.runTransaction(async (tx) => {
      const currentKey = await tx.get(COLLECTIONS.openConversationKeys, keyId);
      if (currentKey) {
        const current = await tx.get(COLLECTIONS.conversations, currentKey.conversationId);
        if (current?.status !== "CLOSED") return current;
      }
      tx.create(COLLECTIONS.conversations, conversationId, conversation);
      tx.set(COLLECTIONS.openConversationKeys, keyId, {
        orgId,
        contactId,
        channel,
        conversationId,
        createdAt: timestamp
      });
      return conversation;
    });
  }

  async get(orgId, conversationId) {
    const conversation = await this.store.get(COLLECTIONS.conversations, conversationId);
    if (!conversation || conversation.orgId !== orgId) throw new NotFoundError("Conversation");
    return conversation;
  }

  async list(orgId, options = {}) {
    const filters = [["orgId", "==", orgId]];
    if (options.status) filters.push(["status", "==", options.status]);
    if (options.assignedTo) filters.push(["assignedTo", "==", options.assignedTo]);
    if (options.contactId) filters.push(["contactId", "==", options.contactId]);
    if (options.from) filters.push(["updatedAt", ">=", options.from]);
    const result = await this.store.find(COLLECTIONS.conversations, {
      filters,
      orderBy: [safeSort(options.sortBy), options.sortOrder || "desc"],
      limit: options.limit,
      cursor: options.cursor,
      search: options.search,
      searchFields: ["lastMessagePreview", "summary"]
    });
    const contacts = this.store.getMany
      ? await this.store.getMany(COLLECTIONS.contacts, result.items.map((item) => item.contactId))
      : await Promise.all(result.items.map((item) => this.store.get(COLLECTIONS.contacts, item.contactId)));
    const contactById = new Map(contacts.filter(Boolean).map((item) => [item.contactId || item.id, item]));
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        contact: contactSummary(contactById.get(item.contactId)),
        customerServiceWindow: customerServiceWindow(item.lastInboundAt)
      }))
    };
  }

  async transition(orgId, conversationId, action, input = {}, actor = {}) {
    const before = await this.get(orgId, conversationId);
    const timestamp = now();
    const patch = { updatedAt: timestamp };
    if (action === "CLOSE") patch.status = "CLOSED";
    if (action === "REOPEN") patch.status = "OPEN";
    if (action === "SNOOZE") {
      if (!input.snoozedUntil) throw new ConflictError("snoozedUntil is required");
      patch.status = "SNOOZED";
      patch.snoozedUntil = input.snoozedUntil;
    }
    if (action === "ASSIGN") {
      if (!input.assignedTo) throw new ConflictError("assignedTo is required");
      patch.assignedTo = input.assignedTo;
    }
    if (action === "HUMAN_TAKEOVER") patch.humanTakeover = input.enabled ?? true;
    if (action === "AI_MODE") {
      if (!input.aiMode) throw new ConflictError("aiMode is required");
      patch.aiMode = input.aiMode;
    }
    if (Object.keys(patch).length === 1) throw new ConflictError(`Unsupported conversation action: ${action}`);
    await this.store.update(COLLECTIONS.conversations, conversationId, patch);
    const keyId = sha256(`${orgId}:${before.contactId}:${before.currentChannel}:OPEN`);
    if (action === "CLOSE") {
      await this.store.set(COLLECTIONS.openConversationKeys, keyId, { closedAt: timestamp, conversationId, active: false }, { merge: true });
    }
    if (action === "REOPEN") {
      await this.store.set(COLLECTIONS.openConversationKeys, keyId, {
        orgId,
        contactId: before.contactId,
        channel: before.currentChannel,
        conversationId,
        active: true,
        updatedAt: timestamp
      });
    }
    await this.audit.write({
      orgId,
      actorType: actor.userId ? "USER" : "SYSTEM",
      actorId: actor.userId || "SYSTEM",
      action: `CONVERSATION_${action}`,
      entityType: "CONVERSATION",
      entityId: conversationId,
      before,
      after: patch
    });
    return this.get(orgId, conversationId);
  }
}

function safeSort(value) {
  return ["lastMessageAt", "createdAt", "updatedAt", "unreadCount"].includes(value) ? value : "lastMessageAt";
}

export function customerServiceWindow(lastInboundAt, currentTime = Date.now()) {
  const inboundAt = toDate(lastInboundAt);
  const expiresAt = inboundAt ? new Date(inboundAt.getTime() + 24 * 60 * 60 * 1000) : null;
  return { open: Boolean(expiresAt && expiresAt.getTime() > currentTime), expiresAt };
}

function contactSummary(contact) {
  if (!contact) return null;
  return {
    contactId: contact.contactId || contact.id,
    companyName: contact.companyName || "",
    contactPerson: contact.contactPerson || "",
    primaryPhone: contact.primaryPhone || "",
    city: contact.city || "",
    salesPersonName: contact.salesPersonName || ""
  };
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (value._seconds) return new Date(value._seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
