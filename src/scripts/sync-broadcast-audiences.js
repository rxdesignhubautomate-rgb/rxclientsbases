import fs from "node:fs/promises";
import path from "node:path";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { COLLECTIONS, ORG_ID } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { normalizeIndianPhoneNumber } from "../utils/phone.js";
import { sha256 } from "../utils/hashing.js";
import {
  buildAudiencePlan,
  buildExistingContactPatch,
  buildNewContact,
  validateBroadcastPayload,
} from "./lib/broadcast-audience-sync.js";

const flags = parseFlags(process.argv.slice(2));
const mode = flags.mode || "dry-run";
if (!["dry-run", "commit"].includes(mode) || !flags["service-account"]) {
  throw new Error(
    "Usage: node src/scripts/sync-broadcast-audiences.js --mode=dry-run|commit --service-account=<path> [--payload=<path>|--stdin] [--org-id=RXDH]",
  );
}
if (!flags.payload && flags.stdin !== true) throw new Error("Provide --payload=<path> or --stdin");

const orgId = flags["org-id"] || ORG_ID;
const rawPayload = flags.payload
  ? JSON.parse(await fs.readFile(path.resolve(flags.payload), "utf8"))
  : JSON.parse(await readStdin());
const payload = validateBroadcastPayload(rawPayload);
const serviceAccount = JSON.parse(
  await fs.readFile(path.resolve(String(flags["service-account"])), "utf8"),
);
const app = initializeApp(
  { credential: cert(serviceAccount) },
  `broadcast-audience-sync-${Date.now()}`,
);
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

try {
  const timestamp = new Date();
  const state = await loadCurrentState(db, orgId, payload);
  const plan = buildSyncPlan({ db, orgId, payload, state, timestamp });
  const summary = summarizePlan(plan, payload, state);

  if (mode === "dry-run") {
    console.log(
      JSON.stringify(
        {
          success: true,
          mode,
          projectId: serviceAccount.project_id,
          orgId,
          ...summary,
          safety: {
            campaignsCreated: 0,
            campaignsStarted: 0,
            consentFieldsChanged: 0,
            existingContactFieldsOverwritten: false,
          },
        },
        null,
        2,
      ),
    );
  } else {
    if (plan.ambiguousPhones.length) {
      throw new Error(
        `${plan.ambiguousPhones.length} phones match multiple contacts without a canonical phone key; resolve duplicates before commit`,
      );
    }
    await commitContactGroups(db, plan.contactMutationGroups);
    const audienceResults = await commitAudiences(db, orgId, payload, plan.audiences, timestamp);
    await writeAuditLog(db, orgId, payload, summary, audienceResults, timestamp);
    const verification = await verifyImport(db, orgId, payload, audienceResults);
    console.log(
      JSON.stringify(
        {
          success: verification.ok,
          mode,
          projectId: serviceAccount.project_id,
          orgId,
          ...summary,
          audiences: audienceResults.map((audience) => ({
            name: audience.name,
            audienceId: audience.audienceId,
            importedContacts: audience.managedContactCount,
            totalContacts: audience.contactCount,
            manualContactsPreserved: audience.manualContactsPreserved,
          })),
          verification,
          safety: {
            campaignsCreated: 0,
            campaignsStarted: 0,
            consentFieldsChanged: 0,
          },
        },
        null,
        2,
      ),
    );
    if (!verification.ok) process.exitCode = 2;
  }
} finally {
  await deleteApp(app);
}

async function loadCurrentState(db, orgId, payload) {
  const phones = payload.segments.flatMap((segment) => segment.rows.map((row) => row.phone));
  const [contactsSnapshot, audienceSnapshot, phoneKeySnapshots] = await Promise.all([
    db.collection(COLLECTIONS.contacts).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.marketingAudiences).where("orgId", "==", orgId).get(),
    getAllInChunks(
      db,
      phones.map((phone) =>
        db.collection(COLLECTIONS.contactPhoneKeys).doc(sha256(`${orgId}:PHONE:${phone}`)),
      ),
    ),
  ]);

  const contacts = contactsSnapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  }));
  const contactsById = new Map(
    contacts.map((contact) => [contact.contactId || contact.id, contact]),
  );
  const contactsByPhone = new Map();
  for (const contact of contacts) {
    const contactId = contact.contactId || contact.id;
    for (const value of [contact.primaryPhone, ...(contact.phones || [])]) {
      const phone = normalizeIndianPhoneNumber(value);
      if (!phone) continue;
      if (!contactsByPhone.has(phone)) contactsByPhone.set(phone, []);
      contactsByPhone.get(phone).push(contactId);
    }
  }
  const keysByPhone = new Map(
    phoneKeySnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => {
        const data = snapshot.data();
        return [data.phone, { id: snapshot.id, ...data }];
      }),
  );
  const audiences = audienceSnapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  }));
  return { contacts, contactsById, contactsByPhone, keysByPhone, audiences };
}

function buildSyncPlan({ db, orgId, payload, state, timestamp }) {
  const contactMutationGroups = [];
  const contactIdsByPhone = new Map();
  const ambiguousPhones = [];
  let existingContacts = 0;
  let newContacts = 0;
  let phoneKeysToCreate = 0;

  for (const segment of payload.segments) {
    for (const row of segment.rows) {
      const keyId = sha256(`${orgId}:PHONE:${row.phone}`);
      const key = state.keysByPhone.get(row.phone);
      const keyedContact = key ? state.contactsById.get(key.contactId) : null;
      const candidates = [...new Set(state.contactsByPhone.get(row.phone) || [])]
        .map((contactId) => state.contactsById.get(contactId))
        .filter(Boolean)
        .filter((contact) => contact.status !== "MERGED");
      const existing = keyedContact || (candidates.length === 1 ? candidates[0] : null);

      if (!existing && candidates.length > 1) {
        ambiguousPhones.push(row.phone);
        continue;
      }

      if (existing) {
        const contactId = existing.contactId || existing.id;
        contactIdsByPhone.set(row.phone, contactId);
        const mutations = [
          {
            type: "set",
            ref: db.collection(COLLECTIONS.contacts).doc(existing.id || contactId),
            data: buildExistingContactPatch({
              contact: existing,
              row,
              segment,
              payload,
              timestamp,
            }),
            options: { merge: true },
          },
        ];
        if (!key) {
          phoneKeysToCreate += 1;
          mutations.push({
            type: "create",
            ref: db.collection(COLLECTIONS.contactPhoneKeys).doc(keyId),
            data: { orgId, phone: row.phone, contactId, createdAt: timestamp },
          });
        }
        contactMutationGroups.push(mutations);
        existingContacts += 1;
      } else {
        const contactId = createId("contact");
        contactIdsByPhone.set(row.phone, contactId);
        contactMutationGroups.push([
          {
            type: "create",
            ref: db.collection(COLLECTIONS.contacts).doc(contactId),
            data: buildNewContact({
              orgId,
              contactId,
              row,
              segment,
              payload,
              timestamp,
            }),
          },
          {
            type: "create",
            ref: db.collection(COLLECTIONS.contactPhoneKeys).doc(keyId),
            data: { orgId, phone: row.phone, contactId, createdAt: timestamp },
          },
        ]);
        newContacts += 1;
        phoneKeysToCreate += 1;
      }
    }
  }

  const audiences = payload.segments.map((segment) => {
    const matches = findAudienceMatches(state.audiences, segment);
    if (matches.length > 1) {
      throw new Error(`Multiple existing audiences match ${segment.name}; merge or rename them before sync`);
    }
    const importedContactIds = segment.rows
      .map((row) => contactIdsByPhone.get(row.phone))
      .filter(Boolean);
    return {
      segment,
      existing: matches[0] || null,
      plan: buildAudiencePlan({
        existing: matches[0] || null,
        importedContactIds,
        segment,
        payload,
        timestamp,
      }),
    };
  });

  return {
    contactMutationGroups,
    contactIdsByPhone,
    ambiguousPhones,
    existingContacts,
    newContacts,
    phoneKeysToCreate,
    audiences,
  };
}

async function commitContactGroups(db, groups) {
  let batch = db.batch();
  let operationCount = 0;
  for (const group of groups) {
    if (operationCount && operationCount + group.length > 400) {
      await batch.commit();
      batch = db.batch();
      operationCount = 0;
    }
    for (const mutation of group) {
      if (mutation.type === "create") batch.create(mutation.ref, mutation.data);
      else batch.set(mutation.ref, mutation.data, mutation.options || {});
      operationCount += 1;
    }
  }
  if (operationCount) await batch.commit();
}

async function commitAudiences(db, orgId, payload, audiences, timestamp) {
  const results = [];
  for (const item of audiences) {
    const audienceId = item.plan.audienceId || createId("marketingAudience");
    const document = {
      ...item.plan,
      audienceId,
      orgId,
      createdBy: item.existing?.createdBy || "CODEX_BROADCAST_IMPORT",
      createdAt: item.existing?.createdAt || timestamp,
    };
    delete document.manualContactsPreserved;
    await db.collection(COLLECTIONS.marketingAudiences).doc(audienceId).set(document, {
      merge: Boolean(item.existing),
    });
    results.push({
      ...document,
      manualContactsPreserved: item.plan.manualContactsPreserved,
    });
  }
  return results;
}

async function writeAuditLog(db, orgId, payload, summary, audiences, timestamp) {
  const auditLogId = createId("auditLog");
  await db.collection(COLLECTIONS.auditLogs).doc(auditLogId).create({
    auditLogId,
    orgId,
    actorType: "SYSTEM",
    actorId: "CODEX_BROADCAST_IMPORT",
    action: "BROADCAST_AUDIENCES_SYNCED",
    entityType: "MARKETING_AUDIENCE",
    entityId: audiences.map((audience) => audience.audienceId).join(","),
    before: {},
    after: {
      sourceName: payload.sourceName,
      sourceSha256: payload.sourceSha256,
      segmentCounts: Object.fromEntries(
        audiences.map((audience) => [audience.name, audience.managedContactCount]),
      ),
      contactsCreated: summary.contacts.new,
      contactsMatched: summary.contacts.existing,
    },
    metadata: {
      campaignsCreated: 0,
      campaignsStarted: 0,
      consentFieldsChanged: 0,
    },
    createdAt: timestamp,
  });
}

async function verifyImport(db, orgId, payload, audiences) {
  const errors = [];
  const snapshots = await getAllInChunks(
    db,
    audiences.map((audience) =>
      db.collection(COLLECTIONS.marketingAudiences).doc(audience.audienceId),
    ),
  );
  for (const segment of payload.segments) {
    const expected = segment.rows.length;
    const audience = audiences.find((item) => item.sourceKey === segment.sourceKey);
    const snapshot = snapshots.find((item) => item.id === audience?.audienceId);
    if (!snapshot?.exists) {
      errors.push(`${segment.name} audience is missing after sync`);
      continue;
    }
    const data = snapshot.data();
    if (data.orgId !== orgId) errors.push(`${segment.name} has the wrong orgId`);
    if (data.managedContactCount !== expected || data.managedContactIds?.length !== expected) {
      errors.push(
        `${segment.name} expected ${expected} imported contacts, found ${data.managedContactCount || 0}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

function summarizePlan(plan, payload, state) {
  return {
    source: {
      name: payload.sourceName,
      sha256: payload.sourceSha256,
      validatedContacts: payload.totalContacts,
    },
    contacts: {
      existingInCrm: state.contacts.length,
      existing: plan.existingContacts,
      new: plan.newContacts,
      phoneKeysToCreate: plan.phoneKeysToCreate,
      ambiguous: plan.ambiguousPhones.length,
    },
    audiencePlan: plan.audiences.map((item) => ({
      name: item.segment.name,
      action: item.existing ? "update" : "create",
      importedContacts: item.plan.managedContactCount,
      totalContactsAfterSync: item.plan.contactCount,
      manualContactsPreserved: item.plan.manualContactsPreserved,
    })),
  };
}

function findAudienceMatches(audiences, segment) {
  const normalizedName = segment.name.toLowerCase();
  return audiences.filter(
    (audience) =>
      audience.sourceKey === segment.sourceKey ||
      String(audience.name || "").trim().toLowerCase() === normalizedName,
  );
}

async function getAllInChunks(db, references, chunkSize = 250) {
  const snapshots = [];
  for (let index = 0; index < references.length; index += chunkSize) {
    snapshots.push(...(await db.getAll(...references.slice(index, index + chunkSize))));
  }
  return snapshots;
}

function parseFlags(argumentsList) {
  const entries = [];
  for (const argument of argumentsList) {
    if (!argument.startsWith("--")) continue;
    const text = argument.slice(2);
    if (!text.includes("=")) entries.push([text, true]);
    else {
      const [key, ...rest] = text.split("=");
      entries.push([key, rest.join("=")]);
    }
  }
  return Object.fromEntries(entries);
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error("No JSON payload received on stdin");
  return text;
}
