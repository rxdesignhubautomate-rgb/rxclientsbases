import fs from "node:fs/promises";
import path from "node:path";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { AuditService } from "../services/audit.service.js";
import { ContactService } from "../services/contact.service.js";
import { DomainService } from "../services/domain.service.js";
import { OrderRegisterImportService } from "../services/order-register-import.service.js";
import { FirestoreStore } from "../repositories/firestore-store.js";
import { COLLECTIONS, ORG_ID } from "../config/constants.js";

const flags = parseFlags(process.argv.slice(2));
const mode = flags.mode || "dry-run";
if (!flags.payload || !flags["service-account"]) {
  throw new Error("Usage: node src/scripts/import-order-register-payload.js --mode=dry-run|commit --payload=<path> --service-account=<path> [--backup=<path>] [--org-id=RXDH]");
}
if (!['dry-run', 'commit'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);

const orgId = flags["org-id"] || ORG_ID;
const payload = JSON.parse(await fs.readFile(path.resolve(flags.payload), "utf8"));
const serviceAccount = JSON.parse(await fs.readFile(path.resolve(flags["service-account"]), "utf8"));
const app = initializeApp({ credential: cert(serviceAccount) }, `order-register-import-${Date.now()}`);
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

try {
  const store = new FirestoreStore(db);
  const audit = new AuditService(store);
  const contacts = new ContactService({ store, audit, notifications: null });
  const domain = new DomainService({ store, audit, orgTimeZone: "Asia/Kolkata" });
  const importer = new OrderRegisterImportService({ store, contacts, domain, audit });
  const preview = importer.preview(payload);
  validatePreview(preview.summary, payload.validatedSummary);

  const before = await inspectImportState(db, orgId, payload.sourceName);
  const users = await loadSalesUsers(db, orgId);

  if (mode === "dry-run") {
    console.log(JSON.stringify({
      success: true,
      mode,
      projectId: serviceAccount.project_id,
      orgId,
      preview: preview.summary,
      activeSalesUsers: users,
      existingImportState: before,
    }, null, 2));
    process.exitCode = 0;
  } else {
    if (!flags.backup) throw new Error("Commit mode requires --backup=<path>");
    const backupPath = path.resolve(flags.backup);
    const backup = await createBackup(db, orgId, serviceAccount.project_id);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");

    const importResult = await importer.commit(orgId, payload, {
      userId: "CODEX_ORDER_REGISTER_IMPORT",
      role: "OWNER",
    });
    const after = await inspectImportState(db, orgId, payload.sourceName);
    const verification = verifyResult(preview.summary, importResult, after);

    console.log(JSON.stringify({
      success: verification.ok,
      mode,
      projectId: serviceAccount.project_id,
      orgId,
      backupPath,
      preview: importResult.preview,
      result: importResult.result,
      verification,
      importedState: after,
    }, null, 2));

    if (!verification.ok) process.exitCode = 2;
  }
} finally {
  await deleteApp(app);
}

function parseFlags(args) {
  return Object.fromEntries(args.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

function validatePreview(actual, expected) {
  for (const field of ["sourceRows", "usableRows", "skippedBlankRows", "totalOrderValue"]) {
    if (Number(actual[field]) !== Number(expected[field])) {
      throw new Error(`Payload preview mismatch for ${field}: expected ${expected[field]}, received ${actual[field]}`);
    }
  }
}

async function loadSalesUsers(db, orgId) {
  const snapshot = await db.collection(COLLECTIONS.users).where("orgId", "==", orgId).get();
  return snapshot.docs
    .map((doc) => ({ userId: doc.data().userId || doc.id, name: doc.data().name || "", role: doc.data().role || "", active: doc.data().active === true }))
    .filter((user) => user.active && ["SALES", "SALES_MANAGER"].includes(user.role))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function inspectImportState(db, orgId, sourceName) {
  const [keysSnapshot, ordersSnapshot, paymentsSnapshot, contactsSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.importKeys).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.orders).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.payments).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.contacts).where("orgId", "==", orgId).get(),
  ]);

  const importKeys = keysSnapshot.docs.map((doc) => doc.data()).filter((item) => item.sourceName === sourceName && item.importType === "ORDER_REGISTER");
  const orders = ordersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => item.importedFrom === sourceName);
  const orderIds = new Set(orders.map((item) => item.orderId || item.id));
  const payments = paymentsSnapshot.docs.map((doc) => doc.data()).filter((item) => orderIds.has(item.orderId));
  const contactIds = new Set(orders.map((item) => item.contactId).filter(Boolean));
  const contacts = contactsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => contactIds.has(item.contactId || item.id));

  const keyStatuses = importKeys.reduce((acc, item) => {
    acc[item.status || "UNKNOWN"] = (acc[item.status || "UNKNOWN"] || 0) + 1;
    return acc;
  }, {});
  const assignments = contacts.reduce((acc, item) => {
    const label = item.assignedTo ? "assigned" : "unassigned";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const salesPeople = contacts.reduce((acc, item) => {
    const label = item.salesPersonName || "(blank)";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  return {
    importKeys: importKeys.length,
    keyStatuses,
    orders: orders.length,
    orderValue: orders.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0),
    payments: payments.length,
    paymentValue: payments.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    linkedContacts: contacts.length,
    assignments,
    salesPeople,
  };
}

async function createBackup(db, orgId, projectId) {
  const collectionNames = [
    COLLECTIONS.contacts,
    COLLECTIONS.contactNameKeys,
    COLLECTIONS.contactPhoneKeys,
    COLLECTIONS.orders,
    COLLECTIONS.orderItems,
    COLLECTIONS.payments,
    COLLECTIONS.importKeys,
    COLLECTIONS.auditLogs,
  ];
  const collections = {};
  for (const collectionName of collectionNames) {
    const snapshot = await db.collection(collectionName).where("orgId", "==", orgId).get();
    collections[collectionName] = snapshot.docs.map((doc) => ({ id: doc.id, data: serializeFirestoreValue(doc.data()) }));
  }
  return {
    createdAt: new Date().toISOString(),
    projectId,
    orgId,
    collections,
  };
}

function serializeFirestoreValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return { __type: "date", value: value.toISOString() };
  if (typeof value.toDate === "function") return { __type: "timestamp", value: value.toDate().toISOString() };
  if (typeof value.path === "string" && value.firestore) return { __type: "reference", value: value.path };
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeFirestoreValue(item)]));
  return value;
}

function verifyResult(preview, importResult, state) {
  const errors = [];
  if (importResult.result.failed !== 0) errors.push(`${importResult.result.failed} rows failed`);
  if (state.keyStatuses.DONE !== preview.usableRows) errors.push(`Expected ${preview.usableRows} DONE import keys, found ${state.keyStatuses.DONE || 0}`);
  if (state.orders !== preview.usableRows) errors.push(`Expected ${preview.usableRows} imported orders, found ${state.orders}`);
  if (Number(state.orderValue) !== Number(preview.totalOrderValue)) errors.push(`Expected order value ${preview.totalOrderValue}, found ${state.orderValue}`);
  return { ok: errors.length === 0, errors };
}
