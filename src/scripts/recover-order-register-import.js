import fs from "node:fs/promises";
import path from "node:path";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { OrderRegisterImportService } from "../services/order-register-import.service.js";
import { COLLECTIONS, ORG_ID } from "../config/constants.js";
import { sha256 } from "../utils/hashing.js";

const flags = parseFlags(process.argv.slice(2));
if (!flags.payload || !flags["service-account"]) {
  throw new Error("Usage: node src/scripts/recover-order-register-import.js --payload=<path> --service-account=<path> [--org-id=RXDH]");
}

const orgId = flags["org-id"] || ORG_ID;
const payload = JSON.parse(await fs.readFile(path.resolve(flags.payload), "utf8"));
const serviceAccount = JSON.parse(await fs.readFile(path.resolve(flags["service-account"]), "utf8"));
const app = initializeApp({ credential: cert(serviceAccount) }, `order-register-recovery-${Date.now()}`);
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

try {
  const importer = new OrderRegisterImportService({});
  const preview = importer.preview(payload);
  const rows = preview.rows.filter((row) => row.valid);

  const [ordersSnapshot, itemsSnapshot, contactsSnapshot, keysSnapshot, paymentsSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.orders).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.orderItems).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.contacts).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.importKeys).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.payments).where("orgId", "==", orgId).get(),
  ]);

  const orders = ordersSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((order) => order.importedFrom === payload.sourceName);
  const ordersByRow = uniqueByRow(orders);
  if (ordersByRow.size !== rows.length) {
    throw new Error(`Recovery requires exactly ${rows.length} imported orders, found ${ordersByRow.size}`);
  }

  const orderIds = new Set(orders.map((order) => order.orderId || order.id));
  const orderItems = itemsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => orderIds.has(item.orderId));
  if (orderItems.length !== rows.length) {
    throw new Error(`Recovery requires exactly ${rows.length} imported order items, found ${orderItems.length}`);
  }

  const contactsById = new Map(contactsSnapshot.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]));
  const keysByRow = new Map(keysSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => item.sourceName === payload.sourceName && item.importType === "ORDER_REGISTER")
    .map((item) => [Number(item.sourceRow), item]));
  const existingPayments = paymentsSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((payment) => orderIds.has(payment.orderId));

  if (keysByRow.size !== rows.length) {
    throw new Error(`Recovery requires exactly ${rows.length} import keys, found ${keysByRow.size}`);
  }

  let createdPayments = 0;
  let reusedPayments = 0;
  const touchedContacts = new Set();
  const now = Timestamp.now();

  for (const row of rows) {
    const order = ordersByRow.get(row.rowNumber);
    const orderId = order.orderId || order.id;
    const contact = contactsById.get(order.contactId);
    if (!contact) throw new Error(`Contact ${order.contactId} for source row ${row.rowNumber} is missing`);

    const expectedPayments = [];
    if (row.advanceAmount > 0) expectedPayments.push({
      amount: row.advanceAmount,
      reference: "Imported advance payment",
      receivedAt: row.orderDate || now,
    });
    if (row.finalPaymentAmount > 0) expectedPayments.push({
      amount: row.finalPaymentAmount,
      reference: "Imported final payment",
      receivedAt: row.finalPaymentDate || now,
    });

    const orderPayments = [];
    for (const expected of expectedPayments) {
      const existing = existingPayments.find((payment) => payment.orderId === orderId && payment.reference === expected.reference);
      if (existing) {
        orderPayments.push(existing);
        reusedPayments += 1;
        continue;
      }
      const paymentId = `PAY_RECOVERY_${sha256(`${orgId}:${orderId}:${expected.reference}`).slice(0, 24).toUpperCase()}`;
      const payment = {
        paymentId,
        orgId,
        orderId,
        contactId: order.contactId,
        amount: expected.amount,
        currency: order.currency || "INR",
        method: "OTHER",
        reference: expected.reference,
        status: "RECEIVED",
        receivedAt: expected.receivedAt,
        recordedBy: "CODEX_ORDER_REGISTER_RECOVERY",
        createdAt: now,
        updatedAt: now,
      };
      await db.collection(COLLECTIONS.payments).doc(paymentId).create(payment);
      existingPayments.push({ id: paymentId, ...payment });
      orderPayments.push(payment);
      createdPayments += 1;
    }

    const paidAmount = orderPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    await db.collection(COLLECTIONS.orders).doc(order.id).update({
      paidAmount,
      paymentStatus: paidAmount >= Number(order.totalAmount || 0) ? "PAID" : paidAmount > 0 ? "PARTIAL" : "PENDING",
      updatedAt: now,
    });

    const lastOrderAt = laterTimestamp(contact.lastOrderAt, row.orderDate);
    await db.collection(COLLECTIONS.contacts).doc(contact.id).update({
      relationshipType: "EXISTING_CLIENT",
      salesPersonName: contact.salesPersonName || row.salesPersonName,
      city: contact.city || row.city,
      tags: [...new Set([...(contact.tags || []), "EXISTING_CLIENT", "IMPORTED_ORDER_REGISTER"])],
      lastOrderAt,
      updatedAt: now,
    });
    touchedContacts.add(contact.id);

    const importKeyId = sha256(`${orgId}:ORDER_REGISTER:${row.identity}`);
    const importKey = keysByRow.get(row.rowNumber);
    if (importKey.id !== importKeyId) throw new Error(`Import key mismatch on source row ${row.rowNumber}`);
    await db.collection(COLLECTIONS.importKeys).doc(importKeyId).set({
      status: "DONE",
      contactId: contact.contactId || contact.id,
      orderId,
      error: null,
      completedAt: now,
      recoveredAt: now,
    }, { merge: true });
  }

  const auditLogId = `AUD_RECOVERY_${sha256(`${orgId}:${payload.sourceName}`).slice(0, 24).toUpperCase()}`;
  await db.collection(COLLECTIONS.auditLogs).doc(auditLogId).set({
    auditLogId,
    orgId,
    actorType: "SYSTEM",
    actorId: "CODEX_ORDER_REGISTER_RECOVERY",
    action: "ORDER_REGISTER_IMPORT_RECOVERED",
    entityType: "IMPORT",
    entityId: sha256(`${orgId}:${payload.sourceName}`),
    before: { failedRows: rows.length },
    after: { recoveredRows: rows.length, createdPayments, reusedPayments },
    metadata: { sourceName: payload.sourceName },
    createdAt: now,
  }, { merge: true });

  const verification = await verify(db, orgId, payload.sourceName, preview.summary, rows);
  console.log(JSON.stringify({
    success: verification.ok,
    recoveredRows: rows.length,
    touchedContacts: touchedContacts.size,
    createdPayments,
    reusedPayments,
    verification,
  }, null, 2));
  if (!verification.ok) process.exitCode = 2;
} finally {
  await deleteApp(app);
}

function parseFlags(args) {
  return Object.fromEntries(args.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

function uniqueByRow(orders) {
  const result = new Map();
  for (const order of orders) {
    const rowNumber = Number(order.importedSourceRow);
    if (result.has(rowNumber)) throw new Error(`Duplicate imported order found for source row ${rowNumber}`);
    result.set(rowNumber, order);
  }
  return result;
}

function laterTimestamp(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  const currentDate = typeof current.toDate === "function" ? current.toDate() : new Date(current);
  return currentDate >= candidate ? current : candidate;
}

async function verify(db, orgId, sourceName, summary, rows) {
  const [keysSnapshot, ordersSnapshot, itemsSnapshot, paymentsSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.importKeys).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.orders).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.orderItems).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.payments).where("orgId", "==", orgId).get(),
  ]);
  const keys = keysSnapshot.docs.map((doc) => doc.data()).filter((item) => item.sourceName === sourceName && item.importType === "ORDER_REGISTER");
  const orders = ordersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((order) => order.importedFrom === sourceName);
  const orderIds = new Set(orders.map((order) => order.orderId || order.id));
  const items = itemsSnapshot.docs.map((doc) => doc.data()).filter((item) => orderIds.has(item.orderId));
  const payments = paymentsSnapshot.docs.map((doc) => doc.data()).filter((payment) => orderIds.has(payment.orderId));
  const expectedPayments = rows.reduce((count, row) => count + (row.advanceAmount > 0 ? 1 : 0) + (row.finalPaymentAmount > 0 ? 1 : 0), 0);
  const expectedPaymentValue = rows.reduce((sum, row) => sum + Number(row.advanceAmount || 0) + Number(row.finalPaymentAmount || 0), 0);
  const errors = [];
  if (keys.filter((item) => item.status === "DONE").length !== summary.usableRows) errors.push("Not all import keys are DONE");
  if (orders.length !== summary.usableRows) errors.push(`Expected ${summary.usableRows} orders, found ${orders.length}`);
  if (items.length !== summary.usableRows) errors.push(`Expected ${summary.usableRows} order items, found ${items.length}`);
  if (orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0) !== summary.totalOrderValue) errors.push("Imported order total does not match preview");
  if (payments.length !== expectedPayments) errors.push(`Expected ${expectedPayments} payments, found ${payments.length}`);
  if (payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) !== expectedPaymentValue) errors.push("Imported payment total does not match preview");
  return {
    ok: errors.length === 0,
    errors,
    doneImportKeys: keys.filter((item) => item.status === "DONE").length,
    orders: orders.length,
    orderItems: items.length,
    orderValue: orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    payments: payments.length,
    paymentValue: payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
  };
}
