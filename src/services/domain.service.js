import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { businessDateTime, now } from "../utils/dates.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const RESOURCE_CONFIG = {
  leads: { collection: COLLECTIONS.leads, idType: "lead", idField: "leadId", statusField: "leadStatus" },
  quotations: { collection: COLLECTIONS.quotations, idType: "quotation", idField: "quotationId", statusField: "status" },
  followUps: { collection: COLLECTIONS.followUps, idType: "followUp", idField: "followUpId", statusField: "status" },
  orders: { collection: COLLECTIONS.orders, idType: "order", idField: "orderId", statusField: "status" }
};

export class DomainService {
  constructor({ store, audit, orgTimeZone = "Asia/Kolkata" }) {
    this.store = store;
    this.audit = audit;
    this.orgTimeZone = orgTimeZone;
  }

  async ensureLead({ orgId, contact, conversationId = null, assignedTo = null, source = "WHATSAPP" }) {
    const keyId = sha256(`${orgId}:${contact.contactId}:ACTIVE_LEAD`);
    const key = await this.store.get(COLLECTIONS.activeLeadKeys, keyId);
    if (key) {
      const lead = await this.store.get(COLLECTIONS.leads, key.leadId);
      if (lead && !["CLOSED_WON", "CLOSED_LOST"].includes(lead.leadStatus)) return lead;
    }
    const leadId = createId("lead");
    const timestamp = now();
    const local = businessDateTime(timestamp, this.orgTimeZone);
    const lead = {
      leadId,
      orgId,
      contactId: contact.contactId,
      conversationId,
      date: local.date,
      time: local.time,
      companyName: contact.companyName || "",
      mobileNumber: contact.primaryPhone || "",
      city: contact.city || "",
      leadSource: source,
      productRequired: [],
      quantity: null,
      pages: null,
      finish: null,
      leadStatus: "NEW_LEAD",
      priority: "NORMAL",
      assignedTo: assignedTo || contact.assignedTo || null,
      nextFollowupDate: null,
      lastFollowup: null,
      interestLevel: "UNKNOWN",
      remarks: "",
      quotationSent: false,
      orderAmount: 0,
      designerAssigned: null,
      dispatchStatus: "NOT_STARTED",
      paymentStatus: "PENDING",
      lastUpdatedBy: "SYSTEM",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.runTransaction(async (tx) => {
      const currentKey = await tx.get(COLLECTIONS.activeLeadKeys, keyId);
      if (currentKey) {
        const current = await tx.get(COLLECTIONS.leads, currentKey.leadId);
        if (current && !["CLOSED_WON", "CLOSED_LOST"].includes(current.leadStatus)) return current;
      }
      tx.create(COLLECTIONS.leads, leadId, lead);
      tx.set(COLLECTIONS.activeLeadKeys, keyId, { orgId, contactId: contact.contactId, leadId, createdAt: timestamp });
      return lead;
    });
  }

  async create(resource, orgId, input, actor = {}) {
    const cfg = resourceConfig(resource);
    const id = createId(cfg.idType);
    const timestamp = now();
    let document = { ...input, [cfg.idField]: id, orgId, createdAt: timestamp, updatedAt: timestamp };
    if (resource === "leads") {
      const local = businessDateTime(timestamp, this.orgTimeZone);
      document = {
        date: local.date,
        time: local.time,
        quotationSent: false,
        orderAmount: 0,
        dispatchStatus: "NOT_STARTED",
        paymentStatus: "PENDING",
        lastUpdatedBy: actor.userId || "SYSTEM",
        ...document
      };
    }
    if (resource === "followUps") document.status = input.status || "SCHEDULED";
    if (["quotations", "orders"].includes(resource)) {
      const items = input.items || [];
      const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      document.subtotal = subtotal;
      document.totalAmount = Math.max(0, subtotal + Number(input.taxAmount || 0) - Number(input.discountAmount || 0));
      document.status = input.status || (resource === "quotations" ? "DRAFT" : "CONFIRMED");
      delete document.items;
      await this.store.create(cfg.collection, id, document);
      const itemCollection = resource === "quotations" ? COLLECTIONS.quotationItems : COLLECTIONS.orderItems;
      const itemType = resource === "quotations" ? "quotationItem" : "orderItem";
      for (let index = 0; index < items.length; index += 1) {
        const itemId = createId(itemType);
        await this.store.create(itemCollection, itemId, {
          ...items[index],
          [`${cfg.idField}`]: id,
          itemId,
          orgId,
          lineNumber: index + 1,
          lineTotal: items[index].quantity * items[index].unitPrice,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }
    } else {
      await this.store.create(cfg.collection, id, document);
    }
    await this.audit.write({ orgId, actorType: actor.userId ? "USER" : "SYSTEM", actorId: actor.userId || "SYSTEM", action: `${resource.toUpperCase()}_CREATED`, entityType: resource.toUpperCase(), entityId: id, after: document });
    return this.get(resource, orgId, id);
  }

  async get(resource, orgId, id) {
    const cfg = resourceConfig(resource);
    const document = await this.store.get(cfg.collection, id);
    if (!document || document.orgId !== orgId) throw new NotFoundError(resource.slice(0, -1));
    if (["quotations", "orders"].includes(resource)) {
      const itemCollection = resource === "quotations" ? COLLECTIONS.quotationItems : COLLECTIONS.orderItems;
      const items = await this.store.find(itemCollection, {
        filters: [["orgId", "==", orgId], [cfg.idField, "==", id]],
        orderBy: ["lineNumber", "asc"],
        limit: 100
      });
      document.items = items.items;
    }
    return document;
  }

  list(resource, orgId, options = {}) {
    const cfg = resourceConfig(resource);
    const filters = [["orgId", "==", orgId]];
    if (options.status) filters.push([cfg.statusField, "==", options.status]);
    if (options.assignedTo) filters.push(["assignedTo", "==", options.assignedTo]);
    if (options.contactId) filters.push(["contactId", "==", options.contactId]);
    if (options.from) filters.push([resource === "followUps" ? "dueAt" : "createdAt", ">=", options.from]);
    if (options.to) filters.push([resource === "followUps" ? "dueAt" : "createdAt", "<=", options.to]);
    return this.store.find(cfg.collection, {
      filters,
      orderBy: [safeResourceSort(resource, options.sortBy), options.sortOrder || "desc"],
      limit: options.limit,
      cursor: options.cursor,
      search: options.search,
      searchFields: ["companyName", "mobileNumber", "remarks", "notes", "status"]
    });
  }

  async update(resource, orgId, id, patch, actor = {}, action = "UPDATED") {
    const cfg = resourceConfig(resource);
    const before = await this.get(resource, orgId, id);
    const safePatch = { ...patch, updatedAt: now() };
    delete safePatch.orgId;
    delete safePatch[cfg.idField];
    delete safePatch.createdAt;
    delete safePatch.items;
    if (resource === "leads") safePatch.lastUpdatedBy = actor.userId || "SYSTEM";
    await this.store.update(cfg.collection, id, safePatch);
    await this.audit.write({ orgId, actorType: actor.userId ? "USER" : "SYSTEM", actorId: actor.userId || "SYSTEM", action: `${resource.toUpperCase()}_${action}`, entityType: resource.toUpperCase(), entityId: id, before, after: safePatch });
    return this.get(resource, orgId, id);
  }

  async addPayment(orgId, orderId, input, actor = {}) {
    const order = await this.get("orders", orgId, orderId);
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ConflictError("Payment amount must be positive");
    const paymentId = createId("payment");
    const payment = {
      paymentId,
      orgId,
      orderId,
      contactId: order.contactId,
      amount,
      currency: order.currency || "INR",
      method: input.method || "OTHER",
      reference: input.reference || "",
      status: input.status || "RECEIVED",
      receivedAt: input.receivedAt || now(),
      recordedBy: actor.userId || "SYSTEM",
      createdAt: now(),
      updatedAt: now()
    };
    await this.store.create(COLLECTIONS.payments, paymentId, payment);
    const payments = await this.store.find(COLLECTIONS.payments, {
      filters: [["orgId", "==", orgId], ["orderId", "==", orderId], ["status", "==", "RECEIVED"]],
      limit: 500
    });
    const paidAmount = payments.items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    await this.store.update(COLLECTIONS.orders, orderId, {
      paidAmount,
      paymentStatus: paidAmount >= Number(order.totalAmount || 0) ? "PAID" : paidAmount > 0 ? "PARTIAL" : "PENDING",
      updatedAt: now()
    });
    await this.audit.write({ orgId, actorType: "USER", actorId: actor.userId, action: "PAYMENT_RECORDED", entityType: "ORDER", entityId: orderId, after: payment });
    return payment;
  }
}

function resourceConfig(resource) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) throw new ConflictError(`Unsupported resource: ${resource}`);
  return cfg;
}

function safeResourceSort(resource, value) {
  const allowed = resource === "followUps" ? ["dueAt", "createdAt", "updatedAt"] : ["createdAt", "updatedAt", "totalAmount"];
  return allowed.includes(value) ? value : allowed[0];
}
