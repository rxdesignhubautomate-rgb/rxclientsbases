import { getContainer } from "../container.js";
import { COLLECTIONS } from "../config/constants.js";
import { parseMigrationArgs, printStats, writeMigrationReport } from "./lib/migration-runner.js";

const options = parseMigrationArgs();
const c = getContainer();
const legacyLeads = await c.firebase.db.collection("leads").orderBy("__name__").limit(options.limit).get();
const legacy = legacyLeads.docs.filter((doc) => !doc.data().leadId);
const problems = [];
for (const doc of legacy) {
  const data = doc.data();
  if (!data.contactId) problems.push({ sourceId: doc.id, problem: "missing_contactId" });
  if (!data.migratedLeadId) problems.push({ sourceId: doc.id, problem: "missing_migratedLeadId" });
  if (!data.conversationId) problems.push({ sourceId: doc.id, problem: "missing_conversationId" });
  if (data.contactId && !(await c.store.get(COLLECTIONS.contacts, data.contactId))) problems.push({ sourceId: doc.id, problem: "orphan_contactId" });
}
const stats = {
  name: "verify-migration",
  dryRun: true,
  scanned: legacy.length,
  migrated: legacy.length - new Set(problems.map((problem) => problem.sourceId)).size,
  skipped: 0,
  failed: problems.length,
  duplicateMatches: 0,
  failures: problems,
  durationMs: 0
};
const report = await writeMigrationReport(stats);
printStats(stats, report);
if (problems.length) process.exitCode = 1;
