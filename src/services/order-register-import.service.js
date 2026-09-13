import { COLLECTIONS } from "../config/constants.js";
import { normalizePhone } from "../utils/phone.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";

const DEFAULT_COLUMNS = Object.freeze({
  orderDate: 0,
  assignedDate: 1,
  status: 2,
  salesPersonName: 3,
  partyName: 4,
  phone: 5,
  cityOrCommitment: 6,
  designerName: 7,
  orderDescription: 8,
  rateText: 9,
  advance: 10,
  finalPaymentDate: 11,
  finalPayment: 12,
  total: 13
});

const HEADER_ALIASES = Object.freeze({
  orderDate: ["ORDER DATE", "ORDERDATE"],
  assignedDate: ["ASSIGNED DATE", "ASSIGNEDDATE"],
  status: ["STATUS"],
  salesPersonName: ["SALES PERSON", "SALESPERSON"],
  partyName: ["PARTY NAME", "PARTY", "COMPANY NAME", "CLIENT NAME"],
  phone: ["NUMBER", "PHONE", "MOBILE", "MOBILE NUMBER"],
  cityOrCommitment: ["CITY", "LOCATION", "DELIVERY NOTE"],
  designerName: ["DESIGNER", "PRODUCTION ASSIGNEE", "ASSIGNEE"],
  orderDescription: ["ORDER", "ORDER DESCRIPTION", "PRODUCT"],
  rateText: ["RATE", "RATE DETAILS"],
  advance: ["ADVANCE", "ADVANCE PAYMENT"],
  finalPaymentDate: ["FINAL PAYMENT DATE", "PAYMENT DATE"],
  finalPayment: ["FINAL", "FINAL PAYMENT"],
  total: ["TOTAL", "TOTAL AMOUNT", "AMOUNT"]
});

export class OrderRegisterImportService {
  constructor({ store, contacts, domain, audit }) {
    this.store = store;
    this.contacts = contacts;
    this.domain = domain;
    this.audit = audit;
  }

  preview(input) {
    const indexes = resolveColumns(input.headers || []);
    const rows = (input.rows || []).map((cells, index) => normalizeRow(cells, index + 2, indexes));
    const usableRows = rows.filter((row) => row.valid);
    const warningRows = usableRows.filter((row) => row.warnings.length);
    const statuses = {};
    for (const row of usableRows) statuses[row.status] = (statuses[row.status] || 0) + 1;
    return {
      sourceName: input.sourceName || "order-register",
      summary: {
        sourceRows: rows.length,
        usableRows: usableRows.length,
        skippedBlankRows: rows.filter((row) => row.skipReason === "PARTY_NAME_MISSING").length,
        warningRows: warningRows.length,
        rowsWithoutUsablePhone: usableRows.filter((row) => !row.phone).length,
        totalOrderValue: usableRows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0),
        statuses
      },
      rows
    };
  }

  async commit(orgId, input, actor = {}) {
    const preview = this.preview(input);
    const result = { createdClients: 0, reusedClients: 0, createdOrders: 0, createdPayments: 0, skippedExisting: 0, failed: 0, warnings: [], errors: [] };
    const orgUsers = await this.store.find(COLLECTIONS.users, { filters: [["orgId", "==", orgId]], limit: 100 });
    const salesUsersByName = new Map(
      orgUsers.items
        .filter((user) => user.active === true && ["SALES", "SALES_MANAGER"].includes(user.role))
        .map((user) => [normalizeName(user.name), user.userId || user.id])
    );
    for (const row of preview.rows.filter((candidate) => candidate.valid)) {
      const importKeyId = sha256(`${orgId}:ORDER_REGISTER:${row.identity}`);
      try {
        const existingImport = await this.store.get(COLLECTIONS.importKeys, importKeyId);
        if (existingImport?.status === "DONE" || existingImport?.status === "PROCESSING") {
          result.skippedExisting += 1;
          continue;
        }
        await this.store.set(COLLECTIONS.importKeys, importKeyId, {
          orgId,
          importType: "ORDER_REGISTER",
          sourceName: preview.sourceName,
          sourceRow: row.rowNumber,
          status: "PROCESSING",
          startedAt: now()
        }, { merge: true });

        const assignedTo = salesUsersByName.get(normalizeName(row.salesPersonName)) || null;
        const resolved = await this.resolveContact(orgId, row, actor, assignedTo);
        if (resolved.created) result.createdClients += 1;
        else result.reusedClients += 1;
        result.warnings.push(...resolved.warnings.map((warning) => ({ row: row.rowNumber, warning })));

        const order = await this.domain.create("orders", orgId, {
          contactId: resolved.contact.contactId,
          status: row.status,
          currency: "INR",
          notes: buildOrderNotes(row),
          orderDate: row.orderDate,
          assignedDate: row.assignedDate,
          deliveryNote: row.cityOrCommitment,
          salesPersonName: row.salesPersonName,
          designerName: row.designerName,
          rateText: row.rateText,
          importedFrom: preview.sourceName,
          importedSourceRow: row.rowNumber,
          items: [{
            description: row.orderDescription || "Legacy order",
            quantity: 1,
            unitPrice: Number(row.totalAmount || 0),
            productCode: "LEGACY"
          }]
        }, actor);
        result.createdOrders += 1;

        if (row.advanceAmount > 0) {
          await this.domain.addPayment(orgId, order.orderId, {
            amount: row.advanceAmount,
            method: "OTHER",
            reference: "Imported advance payment",
            status: "RECEIVED",
            receivedAt: row.orderDate || now()
          }, actor);
          result.createdPayments += 1;
        }
        if (row.finalPaymentAmount > 0) {
          await this.domain.addPayment(orgId, order.orderId, {
            amount: row.finalPaymentAmount,
            method: "OTHER",
            reference: "Imported final payment",
            status: "RECEIVED",
            receivedAt: row.finalPaymentDate || now()
          }, actor);
          result.createdPayments += 1;
        }

        const current = await this.contacts.get(orgId, resolved.contact.contactId);
        await this.contacts.update(orgId, current.contactId, {
          relationshipType: "EXISTING_CLIENT",
          salesPersonName: current.salesPersonName || row.salesPersonName,
          assignedTo: current.assignedTo || assignedTo,
          city: current.city || row.city,
          tags: unique([...(current.tags || []), "EXISTING_CLIENT", "IMPORTED_ORDER_REGISTER"]),
          lastOrderAt: laterDate(current.lastOrderAt, row.orderDate),
          updatedAt: now()
        }, actor);

        await this.store.set(COLLECTIONS.importKeys, importKeyId, {
          status: "DONE",
          contactId: current.contactId,
          orderId: order.orderId,
          completedAt: now()
        }, { merge: true });
      } catch (error) {
        result.failed += 1;
        result.errors.push({ row: row.rowNumber, partyName: row.partyName, message: error.message });
        await this.store.set(COLLECTIONS.importKeys, importKeyId, {
          status: "FAILED",
          error: String(error.message || error).slice(0, 500),
          failedAt: now()
        }, { merge: true });
      }
    }
    await this.audit.write({
      orgId,
      actorType: actor.userId ? "USER" : "SYSTEM",
      actorId: actor.userId || "SYSTEM",
      action: "ORDER_REGISTER_IMPORTED",
      entityType: "IMPORT",
      entityId: sha256(`${orgId}:${preview.sourceName}`),
      after: { sourceName: preview.sourceName, summary: preview.summary, result }
    });
    return { preview: preview.summary, result };
  }

  async resolveContact(orgId, row, actor, assignedTo = null) {
    const warnings = [...row.warnings];
    const nameKeyId = sha256(`${orgId}:CONTACT_NAME:${normalizeName(row.partyName)}`);
    const nameKey = await this.store.get(COLLECTIONS.contactNameKeys, nameKeyId);
    if (nameKey) {
      const contact = await this.contacts.get(orgId, nameKey.contactId);
      return { contact, created: false, warnings };
    }

    const nameMatches = await this.contacts.list(orgId, { search: row.partyName, limit: 100 });
    const exactNameMatch = nameMatches.items.find((contact) => normalizeName(contact.companyName) === normalizeName(row.partyName));
    if (exactNameMatch) {
      let contact = exactNameMatch;
      if (row.phone && !contact.primaryPhone) {
        try {
          contact = await this.contacts.update(orgId, contact.contactId, { primaryPhone: row.phone }, actor);
        } catch {
          warnings.push(`Phone ${row.rawPhone} could not be attached to the existing client and needs review`);
        }
      }
      await this.store.set(COLLECTIONS.contactNameKeys, nameKeyId, { orgId, normalizedName: normalizeName(row.partyName), contactId: contact.contactId, updatedAt: now() });
      return { contact, created: false, warnings };
    }

    let phoneForNewContact = row.phone;
    if (row.phone) {
      const phoneKey = await this.store.get(COLLECTIONS.contactPhoneKeys, sha256(`${orgId}:PHONE:${row.phone}`));
      if (phoneKey) {
        const contact = await this.contacts.get(orgId, phoneKey.contactId);
        if (!contact.companyName || normalizeName(contact.companyName) === normalizeName(row.partyName)) {
          if (!contact.companyName) await this.contacts.update(orgId, contact.contactId, { companyName: row.partyName }, actor);
          await this.store.set(COLLECTIONS.contactNameKeys, nameKeyId, { orgId, normalizedName: normalizeName(row.partyName), contactId: contact.contactId, updatedAt: now() });
          return { contact: await this.contacts.get(orgId, contact.contactId), created: false, warnings };
        }
        phoneForNewContact = null;
        warnings.push(`Phone ${row.rawPhone} already belongs to ${contact.companyName}; imported this party without attaching that phone`);
      }
    }

    const contact = await this.contacts.create(orgId, {
      companyName: row.partyName,
      primaryPhone: phoneForNewContact || undefined,
      city: row.city,
      country: "India",
      relationshipType: "EXISTING_CLIENT",
      salesPersonName: row.salesPersonName,
      assignedTo,
      tags: unique(["EXISTING_CLIENT", "IMPORTED_ORDER_REGISTER", ...(phoneForNewContact ? [] : row.rawPhone ? ["PHONE_REVIEW"] : [])]),
      notes: row.rawPhone && !phoneForNewContact ? `Imported phone needs review: ${row.rawPhone}` : "",
      source: "MANUAL",
      status: "ACTIVE"
    }, actor);
    await this.store.set(COLLECTIONS.contactNameKeys, nameKeyId, {
      orgId,
      normalizedName: normalizeName(row.partyName),
      contactId: contact.contactId,
      createdAt: now()
    });
    return { contact, created: true, warnings };
  }
}

function resolveColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  const result = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const found = normalized.findIndex((header) => aliases.map(normalizeHeader).includes(header));
    result[field] = found >= 0 ? found : DEFAULT_COLUMNS[field];
  }
  if (!normalized[result.designerName]) result.designerName = DEFAULT_COLUMNS.designerName;
  return result;
}

function normalizeRow(cells, rowNumber, indexes) {
  const value = (field) => String(cells[indexes[field]] ?? "").trim();
  const partyName = cleanSpace(value("partyName"));
  if (!partyName) return { rowNumber, valid: false, skipReason: "PARTY_NAME_MISSING", warnings: [] };
  const rawPhone = cleanSpace(value("phone"));
  const phone = normalizePhone(rawPhone);
  const orderDate = parseLegacyDate(value("orderDate"));
  const assignedDate = parseLegacyDate(value("assignedDate"));
  let finalPaymentDate = parseLegacyDate(value("finalPaymentDate"));
  const advanceAmount = parseMoney(value("advance"));
  const finalPaymentAmount = parseMoney(value("finalPayment"));
  const totalAmount = parseMoney(value("total"));
  const warnings = [];
  if (rawPhone && !phone) warnings.push(`Phone needs review: ${rawPhone}`);
  if (!rawPhone) warnings.push("Phone is missing");
  if (phone && !/^91[6-9]\d{9}$/.test(phone)) warnings.push(`Non-Indian phone detected: ${rawPhone}`);
  if (totalAmount === null) warnings.push("Total amount is missing or invalid");
  if (finalPaymentDate && orderDate && finalPaymentDate < orderDate) {
    warnings.push(`Ignored placeholder final-payment date: ${value("finalPaymentDate")}`);
    finalPaymentDate = null;
  }
  const cityOrCommitment = cleanSpace(value("cityOrCommitment"));
  const city = looksLikeCity(cityOrCommitment) ? cityOrCommitment : "";
  const status = normalizeStatus(value("status"));
  const orderDescription = cleanSpace(value("orderDescription"));
  const identity = [normalizeName(partyName), phone || normalizeName(rawPhone), iso(orderDate), normalizeName(orderDescription), totalAmount ?? ""].join(":");
  return {
    rowNumber,
    valid: true,
    partyName,
    rawPhone,
    phone,
    city,
    cityOrCommitment,
    salesPersonName: cleanSpace(value("salesPersonName")).toUpperCase(),
    designerName: cleanSpace(value("designerName")).toUpperCase(),
    orderDate,
    assignedDate,
    status,
    orderDescription,
    rateText: cleanSpace(value("rateText")),
    advanceAmount: advanceAmount || 0,
    finalPaymentDate,
    finalPaymentAmount: finalPaymentAmount || 0,
    totalAmount,
    warnings,
    identity
  };
}

function parseLegacyDate(value) {
  const text = cleanSpace(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2})[-/]([A-Za-z]{3}|\d{1,2})[-/](\d{4})$/);
  if (!match) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const month = /^\d+$/.test(match[2]) ? Number(match[2]) - 1 : months[match[2].toUpperCase()];
  if (!Number.isInteger(month) || month < 0 || month > 11) return null;
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1]), 12, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMoney(value) {
  const text = String(value || "").replace(/[₹,]/g, "").trim();
  if (!text || !/\d/.test(text)) return null;
  const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (!numbers.length) return null;
  return text.includes("+") ? numbers.reduce((sum, number) => sum + number, 0) : numbers[0];
}

function normalizeStatus(value) {
  const normalized = normalizeName(value).replace(/\s+/g, "_");
  return normalized || "CONFIRMED";
}

function looksLikeCity(value) {
  if (!value) return false;
  return !/(\d|DAY|DAYS|DIN|MAIL|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY|APRIL|MAY|PRESC)/i.test(value);
}

function buildOrderNotes(row) {
  const parts = [];
  if (row.rateText) parts.push(`Rate details: ${row.rateText}`);
  if (row.cityOrCommitment && !row.city) parts.push(`Legacy city/delivery note: ${row.cityOrCommitment}`);
  if (row.rawPhone && !row.phone) parts.push(`Original phone: ${row.rawPhone}`);
  return parts.join("\n");
}

function cleanSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeHeader(value) {
  return cleanSpace(value).toUpperCase().replace(/[^A-Z0-9 ]/g, "");
}

function normalizeName(value) {
  return normalizeHeader(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function laterDate(current, candidate) {
  const a = current ? new Date(current) : null;
  const b = candidate ? new Date(candidate) : null;
  if (!a || Number.isNaN(a.getTime())) return b || null;
  if (!b || Number.isNaN(b.getTime())) return a;
  return a > b ? a : b;
}

function iso(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : "";
}
