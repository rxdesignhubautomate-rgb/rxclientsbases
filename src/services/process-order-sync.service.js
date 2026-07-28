import { z } from "zod";
import { COLLECTIONS } from "../config/constants.js";
import { normalizePhone } from "../utils/phone.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { ConflictError } from "../utils/errors.js";

const SOURCE = "RX_PROCESS_MANAGEMENT";

const optionalText = (max) => z.union([z.string(), z.number()]).optional().nullable()
  .transform((value) => String(value ?? "").trim().slice(0, max));

const processOrderSchema = z.object({
  source: z.literal(SOURCE).default(SOURCE),
  externalOrderId: z.union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().min(1).max(128)),
  order: z.object({
    partyName: optionalText(200),
    number: optionalText(40),
    city: optionalText(120),
    orderDate: optionalText(40),
    assignedDate: optionalText(40),
    status: optionalText(80),
    salesPerson: optionalText(120),
    designer: optionalText(120),
    orderDetails: optionalText(4000),
    rateDetails: optionalText(1000),
    priority: optionalText(40),
    remarks: optionalText(4000),
    advance: z.coerce.number().finite().min(0).optional().catch(0),
    finalAmount: z.coerce.number().finite().min(0).optional().catch(0),
    total: z.coerce.number().finite().min(0).optional().catch(0),
    finalPaymentDate: optionalText(40),
    paymentStatus: optionalText(80),
    createdBy: optionalText(120),
    updatedBy: optionalText(120),
    createdAt: optionalText(80),
    updatedAt: optionalText(80)
  }).passthrough()
});

export class ProcessOrderSyncService {
  constructor({ store, contacts, marketing, audit }) {
    this.store = store;
    this.contacts = contacts;
    this.marketing = marketing;
    this.audit = audit;
  }

  async sync(orgId, rawInput) {
    const input = processOrderSchema.parse(rawInput);
    const timestamp = now();
    const contact = await this.resolveContact(orgId, input.order);
    const orderId = deterministicId("ORD_SYNC", `${orgId}:${input.source}:${input.externalOrderId}`);
    const itemId = deterministicId("OIT_SYNC", `${orgId}:${input.source}:${input.externalOrderId}:1`);
    const totalAmount = nonNegative(input.order.total);
    const advanceAmount = nonNegative(input.order.advance);
    const orderPatch = {
      orgId,
      contactId: contact.contactId,
      orderNumber: input.externalOrderId,
      externalSource: input.source,
      externalOrderId: input.externalOrderId,
      sourceStatus: input.order.status || "",
      status: mapStatus(input.order.status),
      currency: "INR",
      notes: buildNotes(input.order),
      orderDate: input.order.orderDate || null,
      assignedDate: input.order.assignedDate || null,
      deliveryNote: input.order.city || "",
      salesPersonName: input.order.salesPerson || "",
      designerName: input.order.designer || "",
      designerAssigned: input.order.designer || null,
      priority: input.order.priority || "NORMAL",
      rateText: input.order.rateDetails || "",
      subtotal: totalAmount,
      totalAmount,
      advanceAmount,
      finalAmount: nonNegative(input.order.finalAmount),
      paymentStatus: input.order.paymentStatus || (advanceAmount > 0 ? "PARTIAL" : "PENDING"),
      finalPaymentDate: input.order.finalPaymentDate || null,
      processCreatedBy: input.order.createdBy || "",
      processUpdatedBy: input.order.updatedBy || "",
      sourceCreatedAt: input.order.createdAt || null,
      sourceUpdatedAt: input.order.updatedAt || null,
      syncedAt: timestamp,
      updatedAt: timestamp
    };
    const item = {
      itemId,
      orderId,
      orgId,
      description: input.order.orderDetails || "Process management order",
      quantity: 1,
      unitPrice: totalAmount,
      productCode: "PROCESS_ORDER",
      lineNumber: 1,
      lineTotal: totalAmount,
      updatedAt: timestamp
    };

    const result = await this.store.runTransaction(async (tx) => {
      const existing = await tx.get(COLLECTIONS.orders, orderId);
      if (existing && existing.orgId !== orgId) throw new ConflictError("Order identity belongs to another organization");
      if (existing) {
        tx.set(COLLECTIONS.orders, orderId, orderPatch, { merge: true });
        tx.set(COLLECTIONS.orderItems, itemId, item, { merge: true });
        return { created: false, before: existing };
      }
      tx.create(COLLECTIONS.orders, orderId, {
        ...orderPatch,
        orderId,
        importedFrom: SOURCE,
        createdAt: timestamp
      });
      tx.create(COLLECTIONS.orderItems, itemId, { ...item, createdAt: timestamp });
      return { created: true, before: null };
    });

    await this.marketing.attributeOrder(orgId, contact.contactId, orderId);
    await this.contacts.update(orgId, contact.contactId, {
      relationshipType: "EXISTING_CLIENT",
      city: contact.city || input.order.city || "",
      salesPersonName: contact.salesPersonName || input.order.salesPerson || "",
      tags: unique([...(contact.tags || []), "EXISTING_CLIENT", "PROCESS_ORDER"]),
      lastOrderAt: laterDate(contact.lastOrderAt, input.order.orderDate || timestamp),
      updatedAt: timestamp
    }, { actorType: "SYSTEM", actorId: SOURCE });
    await this.audit.write({
      orgId,
      actorType: "SYSTEM",
      actorId: SOURCE,
      action: result.created ? "PROCESS_ORDER_CREATED" : "PROCESS_ORDER_UPDATED",
      entityType: "ORDER",
      entityId: orderId,
      before: result.before || {},
      after: orderPatch,
      metadata: { externalOrderId: input.externalOrderId, source: input.source }
    });

    return {
      orderId,
      contactId: contact.contactId,
      externalOrderId: input.externalOrderId,
      created: result.created,
      status: orderPatch.status,
      syncedAt: timestamp
    };
  }

  async resolveContact(orgId, order) {
    const phone = normalizePhone(order.number);
    if (phone) {
      const phoneKey = await this.store.get(COLLECTIONS.contactPhoneKeys, sha256(`${orgId}:PHONE:${phone}`));
      if (phoneKey) return this.contacts.get(orgId, phoneKey.contactId);
    }

    const normalizedName = normalizeName(order.partyName);
    if (normalizedName) {
      const nameKeyId = sha256(`${orgId}:CONTACT_NAME:${normalizedName}`);
      const nameKey = await this.store.get(COLLECTIONS.contactNameKeys, nameKeyId);
      if (nameKey) {
        const contact = await this.contacts.get(orgId, nameKey.contactId);
        if (phone && !contact.primaryPhone) {
          try {
            return await this.contacts.update(orgId, contact.contactId, { primaryPhone: phone }, { actorType: "SYSTEM", actorId: SOURCE });
          } catch {
            return contact;
          }
        }
        return contact;
      }

      const candidates = await this.contacts.list(orgId, { search: order.partyName, limit: 100 });
      const exact = candidates.items.find((candidate) => normalizeName(candidate.companyName) === normalizedName);
      if (exact) {
        await this.store.set(COLLECTIONS.contactNameKeys, nameKeyId, {
          orgId,
          normalizedName,
          contactId: exact.contactId,
          updatedAt: now()
        }, { merge: true });
        if (phone && !exact.primaryPhone) {
          try {
            return await this.contacts.update(orgId, exact.contactId, { primaryPhone: phone }, { actorType: "SYSTEM", actorId: SOURCE });
          } catch {
            return exact;
          }
        }
        return exact;
      }
    }

    try {
      const contact = await this.contacts.create(orgId, {
        companyName: order.partyName || `Process order ${Date.now()}`,
        primaryPhone: phone || undefined,
        city: order.city || "",
        country: "India",
        relationshipType: "EXISTING_CLIENT",
        salesPersonName: order.salesPerson || "",
        tags: ["EXISTING_CLIENT", "PROCESS_ORDER"],
        source: SOURCE,
        status: "ACTIVE"
      }, { actorType: "SYSTEM", actorId: SOURCE });
      if (normalizedName) {
        await this.store.set(
          COLLECTIONS.contactNameKeys,
          sha256(`${orgId}:CONTACT_NAME:${normalizedName}`),
          { orgId, normalizedName, contactId: contact.contactId, createdAt: now() },
          { merge: true }
        );
      }
      return contact;
    } catch (error) {
      if (!phone) throw error;
      const phoneKey = await this.store.get(COLLECTIONS.contactPhoneKeys, sha256(`${orgId}:PHONE:${phone}`));
      if (!phoneKey) throw error;
      return this.contacts.get(orgId, phoneKey.contactId);
    }
  }
}

function deterministicId(prefix, identity) {
  return `${prefix}_${sha256(identity).slice(0, 24).toUpperCase()}`;
}

function mapStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  const aliases = {
    "ORDER RECEIVED": "CONFIRMED",
    "WORK STARTED": "IN_PROGRESS",
    DESIGNING: "DESIGNING",
    APPROVED: "APPROVED",
    APPROVAL: "APPROVED",
    "PRINT / BIND": "PRODUCTION",
    "PRINT/BIND": "PRODUCTION",
    "READY FOR DISPATCH": "READY_FOR_DISPATCH",
    "PAYMENT PENDING": "PAYMENT_PENDING",
    DISPATCHED: "DISPATCHED",
    CANCELLED: "CANCELLED"
  };
  return aliases[status] || status.replaceAll(" ", "_") || "CONFIRMED";
}

function buildNotes(order) {
  return [
    order.orderDetails,
    order.remarks && `Remarks: ${order.remarks}`,
    order.rateDetails && `Rate: ${order.rateDetails}`
  ].filter(Boolean).join("\n");
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function nonNegative(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function laterDate(left, right) {
  const leftTime = new Date(left || 0).getTime() || 0;
  const rightTime = new Date(right || 0).getTime() || 0;
  return rightTime >= leftTime ? right : left;
}

export { SOURCE as PROCESS_ORDER_SOURCE, processOrderSchema };
