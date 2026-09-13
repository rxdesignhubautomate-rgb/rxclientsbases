import { normalizeIndianPhoneNumber } from "../../utils/phone.js";

export const BROADCAST_SEGMENTS = Object.freeze([
  Object.freeze({
    key: "EXISTING_CUSTOMERS",
    name: "Existing Customers",
    tag: "BROADCAST_EXISTING_CUSTOMER",
    relationshipType: "EXISTING_CLIENT",
    sourceKey: "RX_BROADCAST_EXISTING_CUSTOMERS",
    description:
      "Existing RX customers imported from the verified WhatsApp broadcast workbook. Review consent and template eligibility before launching a campaign.",
  }),
  Object.freeze({
    key: "INTERESTED",
    name: "Interested",
    tag: "BROADCAST_INTERESTED",
    relationshipType: "PROSPECT",
    sourceKey: "RX_BROADCAST_INTERESTED",
    description:
      "Customers marked Interested in the verified WhatsApp broadcast workbook. Review consent and template eligibility before launching a campaign.",
  }),
  Object.freeze({
    key: "POSSIBLY_INTERESTED",
    name: "Possibly Interested",
    tag: "BROADCAST_POSSIBLY_INTERESTED",
    relationshipType: "PROSPECT",
    sourceKey: "RX_BROADCAST_POSSIBLY_INTERESTED",
    description:
      "Customers marked Possibly Interested in the verified WhatsApp broadcast workbook. Review consent and template eligibility before launching a campaign.",
  }),
]);

export function validateBroadcastPayload(payload) {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.segments)) {
    throw new Error("Unsupported broadcast payload");
  }
  const sourceName = clean(payload.sourceName).slice(0, 200);
  const sourceSha256 = clean(payload.sourceSha256).toLowerCase();
  if (!sourceName) throw new Error("Broadcast payload has no sourceName");
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("Broadcast payload has an invalid sourceSha256");

  const segmentsByKey = new Map(payload.segments.map((segment) => [segment.key, segment]));
  const seenPhones = new Set();
  const segments = BROADCAST_SEGMENTS.map((definition) => {
    const source = segmentsByKey.get(definition.key);
    if (!source || !Array.isArray(source.rows) || !source.rows.length) {
      throw new Error(`Broadcast payload is missing segment ${definition.name}`);
    }
    if (source.rows.length > 10_000) throw new Error(`${definition.name} exceeds the 10,000-contact audience limit`);
    const rows = source.rows.map((row, index) => {
      const phone = normalizeIndianPhoneNumber(row.phone);
      if (!phone) throw new Error(`Invalid Indian phone in ${definition.name}, row ${index + 1}`);
      if (seenPhones.has(phone)) throw new Error(`A phone appears in more than one segment (${definition.name})`);
      seenPhones.add(phone);
      return {
        phone,
        name: clean(row.name).slice(0, 200),
        city: clean(row.city).slice(0, 120),
        interestLevel: clean(row.interestLevel).slice(0, 160) || definition.name,
        note: clean(row.note).slice(0, 1000),
        lastActivity: normalizeIsoDate(row.lastActivity),
      };
    });
    return {
      ...definition,
      sheetName: clean(source.sheetName).slice(0, 120),
      rows,
    };
  });

  return {
    version: 1,
    sourceName,
    sourceSha256,
    extractedAt: clean(payload.extractedAt),
    segments,
    totalContacts: seenPhones.size,
  };
}

export function buildNewContact({ orgId, contactId, row, segment, payload, timestamp }) {
  const activityAt = row.lastActivity ? new Date(`${row.lastActivity}T12:00:00.000Z`) : timestamp;
  return {
    contactId,
    orgId,
    companyName: row.name,
    contactPerson: "",
    primaryPhone: row.phone,
    phones: [row.phone],
    emails: [],
    city: row.city,
    state: "",
    country: "India",
    address: "",
    gstNumber: "",
    relationshipType: segment.relationshipType,
    salesPersonName: "",
    assignedTo: null,
    tags: mergeTags([], ["RX_BROADCAST_LIST", segment.tag]),
    notes: "",
    source: "RX_BROADCAST_LIST",
    status: "ACTIVE",
    broadcastImport: buildBroadcastMetadata(row, segment, payload, timestamp),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastInteractionAt: activityAt,
  };
}

export function buildExistingContactPatch({ contact, row, segment, payload, timestamp }) {
  const patch = {
    tags: mergeTags(contact.tags, ["RX_BROADCAST_LIST", segment.tag]),
    broadcastImport: buildBroadcastMetadata(row, segment, payload, timestamp),
    updatedAt: timestamp,
  };
  if (!clean(contact.companyName) && !clean(contact.contactPerson) && row.name) {
    patch.companyName = row.name;
  }
  if (!clean(contact.city) && row.city) patch.city = row.city;
  return patch;
}

export function buildAudiencePlan({ existing, importedContactIds, segment, payload, timestamp }) {
  const imported = unique(importedContactIds);
  const current = unique(existing?.contactIds);
  const previousManaged = unique(existing?.managedContactIds);
  const manual = previousManaged.length
    ? current.filter((contactId) => !previousManaged.includes(contactId))
    : existing?.sourceKey === segment.sourceKey
      ? []
      : current;
  const contactIds = unique([...manual, ...imported]);
  if (contactIds.length > 10_000) {
    throw new Error(`${segment.name} would exceed the 10,000-contact audience limit`);
  }
  return {
    audienceId: existing?.audienceId || existing?.id || null,
    orgId: existing?.orgId,
    name: segment.name,
    description: segment.description,
    contactIds,
    contactCount: contactIds.length,
    managedContactIds: imported,
    managedContactCount: imported.length,
    sourceKey: segment.sourceKey,
    importSource: payload.sourceName,
    importSourceSha256: payload.sourceSha256,
    updatedAt: timestamp,
    manualContactsPreserved: manual.length,
  };
}

export function mergeTags(existing = [], additions = []) {
  return unique([...additions, ...(Array.isArray(existing) ? existing : [])]).slice(0, 50);
}

function buildBroadcastMetadata(row, segment, payload, timestamp) {
  return {
    sourceName: payload.sourceName,
    sourceSha256: payload.sourceSha256,
    sourceSheet: segment.sheetName,
    segmentKey: segment.key,
    segmentName: segment.name,
    interestLevel: row.interestLevel,
    note: row.note,
    lastActivity: row.lastActivity || null,
    syncedAt: timestamp,
  };
}

function normalizeIsoDate(value) {
  const text = clean(value);
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid broadcast activity date: ${text}`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`Invalid broadcast activity date: ${text}`);
  }
  return text;
}

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function clean(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}
