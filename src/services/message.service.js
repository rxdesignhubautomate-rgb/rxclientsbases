import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { customerServiceWindow } from "./conversation.service.js";

export class MessageService {
  constructor({ store, conversations, contacts, channelAccounts, channelManager = null, audit }) {
    this.store = store;
    this.conversations = conversations;
    this.contacts = contacts;
    this.channelAccounts = channelAccounts;
    this.channelManager = channelManager;
    this.audit = audit;
  }

  async createInbound(input) {
    const messageId = createId("message");
    const timestamp = now();
    const providerKeyId = input.providerMessageId
      ? sha256(`${input.orgId}:${input.channelAccountId}:${input.providerMessageId}`)
      : sha256(`${input.orgId}:${input.conversationId}:${input.payloadHash || messageId}`);
    const message = {
      messageId,
      orgId: input.orgId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      leadId: input.leadId || null,
      channel: input.channel,
      channelAccountId: input.channelAccountId,
      direction: "INBOUND",
      type: input.type || "TEXT",
      text: input.text || "",
      providerMessageId: input.providerMessageId || null,
      providerTimestamp: input.providerTimestamp || null,
      senderType: "CUSTOMER",
      senderId: input.senderId,
      replyToMessageId: input.replyToMessageId || null,
      attachmentIds: [],
      status: "RECEIVED",
      errorCode: null,
      errorMessage: null,
      metadata: input.metadata || {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.runTransaction(async (tx) => {
      const key = await tx.get(COLLECTIONS.providerMessageKeys, providerKeyId);
      if (key) return { duplicate: true, message: await tx.get(COLLECTIONS.messages, key.messageId) };
      const conversation = await tx.get(COLLECTIONS.conversations, input.conversationId);
      tx.create(COLLECTIONS.messages, messageId, message);
      tx.create(COLLECTIONS.providerMessageKeys, providerKeyId, {
        orgId: input.orgId,
        providerMessageId: input.providerMessageId || null,
        messageId,
        createdAt: timestamp
      });
      tx.update(COLLECTIONS.conversations, input.conversationId, {
        unreadCount: Number(conversation?.unreadCount || 0) + 1,
        messageCount: Number(conversation?.messageCount || 0) + 1,
        lastMessageAt: timestamp,
        lastMessagePreview: preview(input.text, input.type),
        lastInboundAt: timestamp,
        currentChannel: input.channel,
        currentChannelAccountId: input.channelAccountId,
        updatedAt: timestamp
      });
      tx.update(COLLECTIONS.contacts, input.contactId, { lastInteractionAt: timestamp, updatedAt: timestamp });
      return { duplicate: false, message };
    });
  }

  async queueOutbound({ orgId, conversationId, text = "", type = "TEXT", attachmentIds = [], replyToMessageId = null, metadata = {}, senderType = "AGENT", senderId = "SYSTEM", idempotencyKey = null }) {
    const conversation = await this.conversations.get(orgId, conversationId);
    if (conversation.currentChannel === "WHATSAPP" && type !== "TEMPLATE") {
      const lastInboundAt = await this.resolveLastInboundAt(orgId, conversation);
      if (!customerServiceWindow(lastInboundAt).open) {
        throw new ConflictError("The 24-hour WhatsApp reply window is closed. Send an approved Utility template instead.");
      }
    }
    const account = await this.channelAccounts.resolveForSend(
      orgId,
      conversation.currentChannel,
      conversation.currentChannelAccountId
    );
    const identities = await this.contacts.listIdentities(orgId, conversation.contactId);
    const identity = identities.items.find(
      (item) => item.channel === conversation.currentChannel && item.active === true
    );
    if (!identity) throw new ConflictError("Contact has no active identity for the conversation channel");
    const messageId = createId("message");
    const outboxId = createId("outbox");
    const timestamp = now();
    const message = {
      messageId,
      orgId,
      conversationId,
      contactId: conversation.contactId,
      leadId: conversation.leadId || null,
      channel: conversation.currentChannel,
      channelAccountId: account.channelAccountId || account.id,
      direction: "OUTBOUND",
      type,
      text,
      providerMessageId: null,
      providerTimestamp: null,
      senderType,
      senderId,
      recipientId: identity.externalUserId,
      replyToMessageId,
      attachmentIds,
      status: "QUEUED",
      errorCode: null,
      errorMessage: null,
      metadata,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const outbox = {
      outboxId,
      orgId,
      messageId,
      channel: message.channel,
      channelAccountId: message.channelAccountId,
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: timestamp,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.runTransaction(async (tx) => {
      if (idempotencyKey) {
        const keyId = sha256(`${orgId}:OUTBOUND:${idempotencyKey}`);
        const key = await tx.get(COLLECTIONS.providerMessageKeys, keyId);
        if (key) return { duplicate: true, message: await tx.get(COLLECTIONS.messages, key.messageId) };
        tx.create(COLLECTIONS.providerMessageKeys, keyId, { orgId, messageId, kind: "OUTBOUND", createdAt: timestamp });
      }
      tx.create(COLLECTIONS.messages, messageId, message);
      tx.create(COLLECTIONS.outbox, outboxId, outbox);
      tx.update(COLLECTIONS.conversations, conversationId, {
        messageCount: Number(conversation.messageCount || 0) + 1,
        lastMessageAt: timestamp,
        lastMessagePreview: preview(text, type),
        currentChannelAccountId: message.channelAccountId,
        updatedAt: timestamp
      });
      return { duplicate: false, message, outbox };
    });
  }

  async createDraft({ orgId, conversationId, text, metadata = {}, sourceMessageId }) {
    const conversation = await this.conversations.get(orgId, conversationId);
    const messageId = createId("message");
    const keyId = sha256(`${orgId}:AI_DRAFT:${sourceMessageId}`);
    const timestamp = now();
    const draft = {
      messageId,
      orgId,
      conversationId,
      contactId: conversation.contactId,
      leadId: conversation.leadId || null,
      channel: conversation.currentChannel,
      channelAccountId: conversation.currentChannelAccountId,
      direction: "INTERNAL",
      type: "TEXT",
      text,
      providerMessageId: null,
      senderType: "AI",
      senderId: "AI",
      attachmentIds: [],
      status: "QUEUED",
      metadata: { ...metadata, draft: true, sourceMessageId },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.runTransaction(async (tx) => {
      const key = await tx.get(COLLECTIONS.providerMessageKeys, keyId);
      if (key) return { duplicate: true, message: await tx.get(COLLECTIONS.messages, key.messageId) };
      tx.create(COLLECTIONS.messages, messageId, draft);
      tx.create(COLLECTIONS.providerMessageKeys, keyId, { orgId, messageId, kind: "AI_DRAFT", createdAt: timestamp });
      return { duplicate: false, message: draft };
    });
  }

  async createInternalNote(orgId, conversationId, text, actor) {
    const conversation = await this.conversations.get(orgId, conversationId);
    const messageId = createId("message");
    const timestamp = now();
    const note = {
      messageId,
      orgId,
      conversationId,
      contactId: conversation.contactId,
      leadId: conversation.leadId || null,
      channel: conversation.currentChannel,
      channelAccountId: conversation.currentChannelAccountId,
      direction: "INTERNAL",
      type: "NOTE",
      text,
      senderType: "AGENT",
      senderId: actor.userId,
      attachmentIds: [],
      status: "RECEIVED",
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.create(COLLECTIONS.messages, messageId, note);
    await this.audit.write({ orgId, actorType: "USER", actorId: actor.userId, action: "INTERNAL_NOTE_ADDED", entityType: "CONVERSATION", entityId: conversationId, after: { messageId } });
    return note;
  }

  async get(orgId, messageId) {
    const message = await this.store.get(COLLECTIONS.messages, messageId);
    if (!message || message.orgId !== orgId) throw new NotFoundError("Message");
    return message;
  }

  list(orgId, conversationId, options = {}) {
    const filters = [["orgId", "==", orgId], ["conversationId", "==", conversationId]];
    if (options.from) filters.push(["createdAt", ">=", options.from]);
    return this.store.find(COLLECTIONS.messages, {
      filters,
      orderBy: ["createdAt", options.sortOrder || "desc"],
      limit: options.limit,
      cursor: options.cursor,
      search: options.search,
      searchFields: ["text"]
    });
  }

  async resolveLastInboundAt(orgId, conversation) {
    if (conversation.lastInboundAt) return conversation.lastInboundAt;
    const inbound = await this.store.find(COLLECTIONS.messages, {
      filters: [["orgId", "==", orgId], ["conversationId", "==", conversation.conversationId], ["direction", "==", "INBOUND"]],
      orderBy: ["createdAt", "desc"],
      limit: 1
    });
    const lastInboundAt = inbound.items[0]?.createdAt || null;
    if (lastInboundAt) {
      await this.store.update(COLLECTIONS.conversations, conversation.conversationId, { lastInboundAt, updatedAt: now() });
    }
    return lastInboundAt;
  }

  async retry(orgId, messageId, actor) {
    const message = await this.get(orgId, messageId);
    if (message.direction !== "OUTBOUND") throw new ConflictError("Only outbound messages can be retried");
    const existing = await this.store.find(COLLECTIONS.outbox, {
      filters: [["orgId", "==", orgId], ["messageId", "==", messageId]],
      limit: 10
    });
    const active = existing.items.find((item) => ["PENDING", "PROCESSING", "RETRY"].includes(item.status));
    if (active) return active;
    const account = await this.channelAccounts.resolveForSend(orgId, message.channel, message.channelAccountId);
    const channelAccountId = account.channelAccountId || account.id;
    const outboxId = createId("outbox");
    const timestamp = now();
    const outbox = {
      outboxId,
      orgId,
      messageId,
      channel: message.channel,
      channelAccountId,
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: timestamp,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      manualRetryBy: actor.userId
    };
    await this.store.create(COLLECTIONS.outbox, outboxId, outbox);
    await this.store.update(COLLECTIONS.messages, messageId, { status: "QUEUED", channelAccountId, errorCode: null, errorMessage: null, updatedAt: timestamp });
    await this.audit.write({ orgId, actorType: "USER", actorId: actor.userId, action: "MESSAGE_RETRIED", entityType: "MESSAGE", entityId: messageId, after: { outboxId } });
    return outbox;
  }

  async markRead(orgId, messageId, _actor = {}) {
    const message = await this.get(orgId, messageId);
    if (message.direction === "INBOUND" && message.providerMessageId && this.channelManager) {
      const account = await this.channelAccounts.get(orgId, message.channelAccountId);
      await this.channelManager.markAsRead({ account, providerMessageId: message.providerMessageId });
    }
    await this.store.update(COLLECTIONS.messages, messageId, { status: "READ", updatedAt: now() });
    if (message.direction === "INBOUND") {
      await this.store.update(COLLECTIONS.conversations, message.conversationId, { unreadCount: 0, updatedAt: now() });
    }
    return this.get(orgId, messageId);
  }

  async updateProviderStatus(orgId, providerMessageId, status, error = null) {
    const result = await this.store.find(COLLECTIONS.messages, {
      filters: [["orgId", "==", orgId], ["providerMessageId", "==", providerMessageId]],
      limit: 2
    });
    const message = result.items[0];
    if (!message) return null;
    await this.store.update(COLLECTIONS.messages, message.messageId || message.id, {
      status,
      errorCode: error?.code || null,
      errorMessage: error?.message?.slice(0, 500) || null,
      updatedAt: now()
    });
    return message;
  }
}

function preview(text, type) {
  return (text || `[${type || "MESSAGE"}]`).replace(/\s+/g, " ").trim().slice(0, 180);
}
