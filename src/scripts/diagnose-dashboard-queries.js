import process from "node:process";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS are required");
}

if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const account = await db.collection("users").where("email", "==", "admin@rxdesignhub.com").limit(1).get();
const user = account.docs[0]?.data();
if (!user?.orgId) throw new Error("Admin CRM user or orgId was not found");

const now = new Date();
const checks = [
  ["contacts", () => db.collection("contacts").where("orgId", "==", user.orgId).limit(1001).get()],
  ["conversations", () => db.collection("conversations").where("orgId", "==", user.orgId).where("status", "==", "OPEN").limit(1001).get()],
  ["leads", () => db.collection("leads").where("orgId", "==", user.orgId).limit(1001).get()],
  ["followUps", () => db.collection("followUps").where("orgId", "==", user.orgId).where("status", "==", "SCHEDULED").where("dueAt", "<=", now).limit(501).get()],
  ["orders", () => db.collection("orders").where("orgId", "==", user.orgId).where("status", "not-in", ["CANCELLED", "COMPLETED", "DISPATCHED"]).limit(501).get()]
];

let failed = 0;
for (const [name, query] of checks) {
  try {
    const result = await query();
    console.log(JSON.stringify({ name, status: "ok", count: result.size }));
  } catch (error) {
    failed += 1;
    console.log(JSON.stringify({ name, status: "failed", code: error.code, message: error.message }));
  }
}

if (failed) process.exitCode = 1;
