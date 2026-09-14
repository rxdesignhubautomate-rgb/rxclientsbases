import { assertLocalMigrationEnvironment, backfillClassificationPage } from "../src/migrations/client-classification-backfill.js";

// Check the environment BEFORE importing any Firebase runtime. No dotenv import.
assertLocalMigrationEnvironment(process.env);
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.length ? value.join("=") : true];
}));
if (Object.keys(args).some(key => !["org-id", "cursor", "limit", "commit", "dry-run"].includes(key))) throw new Error("Unknown migration option");
if (args.commit && args["dry-run"]) throw new Error("Choose --commit or --dry-run");
const { initializeApp, deleteApp } = await import("firebase-admin/app");
const { getFirestore } = await import("firebase-admin/firestore");
const { FirestoreStore } = await import("../src/repositories/firestore-store.js");
const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, "classification-local-migration");
try {
  const report = await backfillClassificationPage(new FirestoreStore(getFirestore(app)), {
    orgId: args["org-id"], cursor: args.cursor, limit: Number(args.limit || 100), commit: args.commit === true
  });
  console.log(JSON.stringify(report, null, 2));
} finally { await deleteApp(app); }
