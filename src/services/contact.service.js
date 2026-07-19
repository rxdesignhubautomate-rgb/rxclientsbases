import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { normalizePhone } from "../utils/phone.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

export class ContactService {
  constructor({ store, audit, notifications }) {
    this.store = store;
    this.audit = audit;
    this.notifications = notifications;
  }

  async create(orgId, input, actor = {}) {
    const phones = normalizePhones(input.primaryPhone, input.phones);
    const primaryPhone = phones[0] || null;
    const contactId = createId("contact");
    const timestamp = now();
    const contact = {
      contactId,
      orgId,
      companyName: input.companyName || "",
      contactPerson: input.contactPerson || "",
      primaryPhone,
      phones,
      emails: unique(input.emails || []),
      city: input.city || "",
      state: input.state || "",
      country: input.country || "India",
      assignedTo: input.assignedTo || null,
      tags: unique(input.tags || []),
      notes: input.notes || "",
      source: input.source || "MANUAL",
      status: input.status || "ACTIVE",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastInteractionAt: timestamp
    };
    await this.store.runTransaction(async (tx) => {
      for (const phone of phones) {
        const keyId = sha256(`${orgId}:PHONE:${phone}`);
        const existing = await tx.get(COLLECTIONS.contactPhoneKeys, keyId);
        if (existing) throw new ConflictError(`A contact already exists for phone ${phone}`);
      }
      tx.create(COLLECTIONS.contacts, contactId, contact);
      for (const phone of phones) {
        const keyId = sha256(`${orgId}:PHONE:${phone}`);
        tx.create(COLLECTIONS.contactPhoneKeys, keyId, { orgId, phone, contactId, createdAt: timestamp });
      }
    });
    await this.audit.write(actorAudit(actor, orgId, "CONTACT_CREATED", "CONTACT", contactId, {}, contact));
    return contact;
  }

  async get(orgId, contactId) {
    const contact = await this.store.get(COLLECTIONS.contacts, contactId);
    if (!contact || contact.orgId !== orgId) throw new NotFoundError("Contact");
    return contact;
  }

  async list(orgId, options = {}) {
    const filters = [["orgId", "==", orgId]];
    if (options.status) filters.push(["status", "==", options.status]);
    if (options.assignedTo) filters.push(["assignedTo", "==", options.assignedTo]);
    return this.store.find(COLLECTIONS.contacts, {
      filters,
      orderBy: [safeContactSort(options.sortBy), options.sortOrder || "desc"],
      limit: options.limit,
      cursor: options.cursor,
      search: options.search,
      searchFields: ["companyName", "contactPerson", "primaryPhone", "city"]
    });
  }

  async update(orgId, contactId, input, actor = {}) {
    const before = await this.get(orgId, contactId);
    const patch = { ...input, updatedAt: now() };
    if (input.primaryPhone !== undefined || input.phones !== undefined) {
      const phones = normalizePhones(input.primaryPhone ?? before.primaryPhone, input.phones ?? before.phones);
      patch.primaryPhone = phones[0] || null;
      patch.phones = phones;
      await this.store.runTransaction(async (tx) => {
        for (const phone of phones) {
          const keyId = sha256(`${orgId}:PHONE:${phone}`);
          const key = await tx.get(COLLECTIONS.contactPhoneKeys, keyId);
          if (key && key.contactId !== contactId) throw new ConflictError(`Phone ${phone} belongs to another contact`);
          tx.set(COLLECTIONS.contactPhoneKeys, keyId, { orgId, phone, contactId, updatedAt: now() }, { merge: true });
        }
        tx.update(COLLECTIONS.contacts, contactId, patch);
      });
    } else {
      await this.store.update(COLLECTIONS.contacts, contactId, patch);
    }
    await this.audit.write(actorAudit(actor, orgId, "CONTACT_UPDATED", "CONTACT", contactId, before, patch));
    return this.get(orgId, contactId);
  }

  async addIdentity(orgId, contactId, input, actor = {}) {
    await this.get(orgId, contactId);
    const externalUserId = input.channel === "WHATSAPP" ? normalizePhone(input.externalUserId) : input.externalUserId;
    if (!externalUserId) throw new ConflictError("Invalid channel identity");
    const keyId = sha256(`${orgId}:${input.channel}:${externalUserId}`);
    const existingKey = await this.store.get(COLLECTIONS.channelIdentityKeys, keyId);
    if (existingKey) {
      if (existingKey.contactId !== contactId) throw new ConflictError("Channel identity belongs to another contact");
      return this.store.get(COLLECTIONS.channelIdentities, existingKey.channelIdentityId);
    }
    const channelIdentityId = createId("channelIdentity");
    const identity = {
      channelIdentityId,
      orgId,
      contactId,
      channel: input.channel,
      externalUserId,
      channelAccountId: input.channelAccountId || null,
      active: input.active ?? true,
      verified: input.verified ?? false,
      createdAt: now(),
      updatedAt: now()
    };
    await this.store.runTransaction(async (tx) => {
      const key = await tx.get(COLLECTIONS.channelIdentityKeys, keyId);
      if (key && key.contactId !== contactId) throw new ConflictError("Channel identity belongs to another contact");
      if (key) return;
      tx.create(COLLECTIONS.channelIdentities, channelIdentityId, identity);
      tx.create(COLLECTIONS.channelIdentityKeys, keyId, {
        orgId,
        channel: input.channel,
        externalUserId,
        contactId,
        channelIdentityId,
        createdAt: now()
      });
    });
    await this.audit.write(actorAudit(actor, orgId, "CHANNEL_IDENTITY_ADDED", "CONTACT", contactId, {}, identity));
    return identity;
  }

  async listIdentities(orgId, contactId) {
    await this.get(orgId, contactId);
    return this.store.find(COLLECTIONS.channelIdentities, {
      filters: [["orgId", "==", orgId], ["contactId", "==", contactId]],
      orderBy: ["createdAt", "asc"],
      limit: 100
    });
  }

  async updateIdentity(orgId, identityId, patch, actor = {}) {
    const before = await this.store.get(COLLECTIONS.channelIdentities, identityId);
    if (!before || before.orgId !== orgId) throw new NotFoundError("Channel identity");
    const allowed = { active: patch.active, verified: patch.verified, channelAccountId: patch.channelAccountId };
    Object.keys(allowed).forEach((key) => allowed[key] === undefined && delete allowed[key]);
    allowed.updatedAt = now();
    await this.store.update(COLLECTIONS.channelIdentities, identityId, allowed);
    await this.audit.write(actorAudit(actor, orgId, "CHANNEL_IDENTITY_UPDATED", "CHANNEL_IDENTITY", identityId, before, allowed));
    return { ...before, ...allowed };
  }

  async resolveInboundIdentity({ orgId, channel, externalUserId, channelAccountId, profileName = "" }) {
    const normalizedExternal = channel === "WHATSAPP" ? normalizePhone(externalUserId) : String(externalUserId || "").trim();
    if (!normalizedExternal) throw new ConflictError("Inbound message has no valid external identity");
    const identityKeyId = sha256(`${orgId}:${channel}:${normalizedExternal}`);
    const existingKey = await this.store.get(COLLECTIONS.channelIdentityKeys, identityKeyId);
    if (existingKey) {
      return {
        contact: await this.get(orgId, existingKey.contactId),
        identity: await this.store.get(COLLECTIONS.channelIdentities, existingKey.channelIdentityId)
      };
    }

    let contactId = null;
    let ambiguous = [];
    if (channel === "WHATSAPP") {
      const phoneKeyId = sha256(`${orgId}:PHONE:${normalizedExternal}`);
      const phoneKey = await this.store.get(COLLECTIONS.contactPhoneKeys, phoneKeyId);
      if (phoneKey) contactId = phoneKey.contactId;
      if (!contactId) {
        const matches = await this.store.find(COLLECTIONS.contacts, {
          filters: [["orgId", "==", orgId], ["phones", "array-contains", normalizedExternal]],
          limit: 3
        });
        if (matches.items.length === 1) contactId = matches.items[0].contactId;
        if (matches.items.length > 1) ambiguous = matches.items.map((item) => item.contactId);
      }
    }

    const contact = contactId
      ? await this.get(orgId, contactId)
      : await this.create(orgId, {
          contactPerson: profileName,
          primaryPhone: channel === "WHATSAPP" ? normalizedExternal : undefined,
          source: channel,
          tags: ambiguous.length ? ["DUPLICATE_REVIEW"] : []
        });
    const identity = await this.addIdentity(orgId, contact.contactId, {
      channel,
      externalUserId: normalizedExternal,
      channelAccountId,
      active: true,
      verified: false
    });
    if (ambiguous.length) {
      await this.notifications.create(orgId, {
        type: "CONTACT_DUPLICATE_REVIEW",
        severity: "WARNING",
        title: "Multiple phone matches need review",
        entityType: "CONTACT",
        entityId: contact.contactId,
        metadata: { candidateContactIds: ambiguous }
      });
    }
    return { contact, identity };
  }

  async merge(orgId, primaryId, duplicateId, actor = {}) {
    if (primaryId === duplicateId) throw new ConflictError("Primary and duplicate contacts must differ");
    const [primary, duplicate] = await Promise.all([this.get(orgId, primaryId), this.get(orgId, duplicateId)]);
    if (duplicate.status === "MERGED") throw new ConflictError("Duplicate contact is already merged");
    const timestamp = now();
    const relations = [
      COLLECTIONS.channelIdentities,
      COLLECTIONS.leads,
      COLLECTIONS.conversations,
      COLLECTIONS.messages,
      COLLECTIONS.quotations,
      COLLECTIONS.followUps,
      COLLECTIONS.orders,
      COLLECTIONS.attachments,
      COLLECTIONS.payments
    ];
    const moved = {};
    const movedDocuments = {};
    for (const collection of relations) {
      const result = await this.store.find(collection, {
        filters: [["orgId", "==", orgId], ["contactId", "==", duplicateId]],
        limit: 500
      });
      movedDocuments[collection] = result.items;
      moved[collection] = await this.store.batchUpdate(
        collection,
        result.items.map((item) => ({ id: item.id, data: { contactId: primaryId, updatedAt: timestamp } }))
      );
    }
    const phones = unique([...(primary.phones || []), ...(duplicate.phones || [])]);
    const emails = unique([...(primary.emails || []), ...(duplicate.emails || [])]);
    await this.store.update(COLLECTIONS.contacts, primaryId, {
      phones,
      primaryPhone: primary.primaryPhone || duplicate.primaryPhone || phones[0] || null,
      emails,
      tags: unique([...(primary.tags || []), ...(duplicate.tags || [])]).filter((tag) => tag !== "DUPLICATE_REVIEW"),
      updatedAt: timestamp
    });
    await this.store.update(COLLECTIONS.contacts, duplicateId, {
      status: "MERGED",
      mergedIntoContactId: primaryId,
      mergedAt: timestamp,
      updatedAt: timestamp
    });
    for (const phone of phones) {
      await this.store.set(
        COLLECTIONS.contactPhoneKeys,
        sha256(`${orgId}:PHONE:${phone}`),
        { orgId, phone, contactId: primaryId, updatedAt: timestamp },
        { merge: true }
      );
    }
    for (const identity of movedDocuments[COLLECTIONS.channelIdentities] || []) {
      const keyId = sha256(`${orgId}:${identity.channel}:${identity.externalUserId}`);
      await this.store.set(COLLECTIONS.channelIdentityKeys, keyId, {
        orgId,
        channel: identity.channel,
        externalUserId: identity.externalUserId,
        contactId: primaryId,
        channelIdentityId: identity.channelIdentityId || identity.id,
        updatedAt: timestamp
      }, { merge: true });
    }
    for (const conversation of movedDocuments[COLLECTIONS.conversations] || []) {
      if (conversation.status === "CLOSED") continue;
      const keyId = sha256(`${orgId}:${primaryId}:${conversation.currentChannel}:OPEN`);
      if (!(await this.store.get(COLLECTIONS.openConversationKeys, keyId))) {
        await this.store.set(COLLECTIONS.openConversationKeys, keyId, {
          orgId,
          contactId: primaryId,
          channel: conversation.currentChannel,
          conversationId: conversation.conversationId || conversation.id,
          active: true,
          updatedAt: timestamp
        });
      }
    }
    const activeLead = (movedDocuments[COLLECTIONS.leads] || []).find(
      (lead) => !["CLOSED_WON", "CLOSED_LOST"].includes(lead.leadStatus)
    );
    if (activeLead) {
      const keyId = sha256(`${orgId}:${primaryId}:ACTIVE_LEAD`);
      if (!(await this.store.get(COLLECTIONS.activeLeadKeys, keyId))) {
        await this.store.set(COLLECTIONS.activeLeadKeys, keyId, {
          orgId,
          contactId: primaryId,
          leadId: activeLead.leadId || activeLead.id,
          updatedAt: timestamp
        });
      }
    }
    await this.audit.write(actorAudit(actor, orgId, "CONTACT_MERGED", "CONTACT", primaryId, { primary, duplicate }, { moved }));
    return { primary: await this.get(orgId, primaryId), duplicateId, moved };
  }
}

function normalizePhones(primaryPhone, values = []) {
  return unique([primaryPhone, ...(values || [])].map((value) => normalizePhone(value)).filter(Boolean));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeContactSort(field) {
  return ["createdAt", "updatedAt", "lastInteractionAt", "companyName", "contactPerson"].includes(field)
    ? field
    : "updatedAt";
}

function actorAudit(actor, orgId, action, entityType, entityId, before, after) {
  return {
    orgId,
    actorType: actor.userId ? "USER" : "SYSTEM",
    actorId: actor.userId || "SYSTEM",
    action,
    entityType,
    entityId,
    before,
    after
  };
}
