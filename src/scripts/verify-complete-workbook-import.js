import fs from "node:fs/promises";
import path from "node:path";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { COLLECTIONS, ORG_ID } from "../config/constants.js";

const flags = parseFlags(process.argv.slice(2));
if (!flags["service-account"]) {
  throw new Error("Usage: node src/scripts/verify-complete-workbook-import.js --service-account=<path> [--org-id=RXDH]");
}

const orgId = flags["org-id"] || ORG_ID;
const serviceAccount = JSON.parse(await fs.readFile(path.resolve(flags["service-account"]), "utf8"));
const app = initializeApp({ credential: cert(serviceAccount) }, `complete-workbook-verify-${Date.now()}`);
const db = getFirestore(app);

const sourceNames = new Set([
  "SALES APRIL 2026 - APRIL.csv",
  "SALES APRIL 2026.xlsx#JANUARY",
  "SALES APRIL 2026.xlsx#FEBRUARY",
  "SALES APRIL 2026.xlsx#MARCH",
  "SALES APRIL 2026.xlsx#MAY",
]);

try {
  const [keysSnapshot, ordersSnapshot, itemsSnapshot, paymentsSnapshot, contactsSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.importKeys).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.orders).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.orderItems).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.payments).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.contacts).where("orgId", "==", orgId).get(),
  ]);

  const keys = keysSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => sourceNames.has(item.sourceName));
  const orders = ordersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => sourceNames.has(item.importedFrom));
  const orderIds = new Set(orders.map((order) => order.orderId || order.id));
  const items = itemsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => orderIds.has(item.orderId));
  const payments = paymentsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => orderIds.has(item.orderId));
  const contactIds = new Set(orders.map((order) => order.contactId).filter(Boolean));
  const contacts = contactsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((contact) => contactIds.has(contact.contactId || contact.id));
  const alluviumContacts = contacts.filter((contact) => normalizeName(contact.companyName) === "ALLUVIUM");
  const alluviumContactIds = new Set(alluviumContacts.map((contact) => contact.contactId || contact.id));
  const alluviumOrders = orders.filter((order) => alluviumContactIds.has(order.contactId));

  const actual = {
    importKeys: keys.length,
    doneImportKeys: keys.filter((item) => item.status === "DONE").length,
    failedImportKeys: keys.filter((item) => item.status === "FAILED").length,
    orders: orders.length,
    orderItems: items.length,
    uniqueContacts: contacts.length,
    orderValue: sum(orders, "totalAmount"),
    zeroValueOrders: orders.filter((order) => Number(order.totalAmount || 0) === 0).length,
    payments: payments.length,
    paymentValue: sum(payments, "amount"),
    assignments: countBy(contacts, (contact) => contact.assignedTo ? "assigned" : "unassigned"),
    contactSalesPeople: countBy(contacts, (contact) => contact.salesPersonName || "(blank)"),
    orderSalesPeople: countBy(orders, (order) => order.salesPersonName || "(blank)"),
    alluviumContacts: alluviumContacts.length,
    alluviumOrders: alluviumOrders.length,
    bySource: Object.fromEntries([...sourceNames].map((sourceName) => [sourceName, {
      orders: orders.filter((order) => order.importedFrom === sourceName).length,
      orderValue: sum(orders.filter((order) => order.importedFrom === sourceName), "totalAmount"),
      doneImportKeys: keys.filter((item) => item.sourceName === sourceName && item.status === "DONE").length,
    }])),
  };

  const expected = {
    importKeys: 140,
    doneImportKeys: 140,
    failedImportKeys: 0,
    orders: 140,
    orderItems: 140,
    uniqueContacts: 139,
    orderValue: 1250714,
    zeroValueOrders: 4,
    payments: 159,
    paymentValue: 621543,
    alluviumContacts: 1,
    alluviumOrders: 2,
  };
  const errors = Object.entries(expected)
    .filter(([field, expectedValue]) => actual[field] !== expectedValue)
    .map(([field, expectedValue]) => `${field}: expected ${expectedValue}, found ${actual[field]}`);

  console.log(JSON.stringify({ success: errors.length === 0, errors, expected, actual }, null, 2));
  if (errors.length) process.exitCode = 2;
} finally {
  await deleteApp(app);
}

function parseFlags(args) {
  return Object.fromEntries(args.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item[field] || 0), 0);
}

function countBy(items, selector) {
  return Object.fromEntries([...items.reduce((map, item) => {
    const key = selector(item);
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase().replace(/[^A-Z0-9 ]/g, "");
}
