import { getContainer } from "../container.js";
import { parseMigrationArgs, printStats, writeMigrationReport } from "./lib/migration-runner.js";

const options = parseMigrationArgs();
const { firebase } = getContainer();
const collections = ["leads", "messages", "salesUsers", "settings", "devices"];
const counts = {};
for (const name of collections) {
  const snapshot = await firebase.db.collection(name).count().get();
  counts[name] = snapshot.data().count;
}
const stats = {
  name: "existing-data-audit",
  dryRun: options.dryRun,
  orgId: options.orgId,
  scanned: Object.values(counts).reduce((sum, count) => sum + count, 0),
  migrated: 0,
  skipped: 0,
  failed: 0,
  duplicateMatches: 0,
  counts,
  durationMs: 0
};
const report = await writeMigrationReport(stats);
printStats(stats, report);
