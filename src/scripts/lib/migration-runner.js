import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export function parseMigrationArgs(argv = process.argv.slice(2)) {
  const result = { dryRun: false, limit: 100, startAfter: null, orgId: "RXDH" };
  for (const arg of argv) {
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg.startsWith("--limit=")) result.limit = Math.min(Math.max(Number(arg.slice(8)) || 100, 1), 5000);
    else if (arg.startsWith("--start-after=")) result.startAfter = arg.slice(14) || null;
    else if (arg.startsWith("--org-id=")) result.orgId = arg.slice(9) || "RXDH";
  }
  return result;
}

export async function runDocuments({ name, documents, dryRun, handler }) {
  const startedAt = performance.now();
  const stats = { name, dryRun, scanned: 0, migrated: 0, skipped: 0, failed: 0, duplicateMatches: 0, failures: [] };
  for (const document of documents) {
    stats.scanned += 1;
    try {
      const outcome = dryRun ? { status: document.alreadyMigrated ? "skipped" : "migrated" } : await handler(document);
      if (outcome?.status === "skipped") stats.skipped += 1;
      else if (outcome?.status === "duplicate") {
        stats.skipped += 1;
        stats.duplicateMatches += 1;
      } else stats.migrated += 1;
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({ sourceId: document.id, error: String(error.message || error).slice(0, 300) });
    }
  }
  stats.durationMs = Math.round(performance.now() - startedAt);
  return stats;
}

export async function loadLegacyDocuments(db, collection, options, predicate = () => true) {
  let query = db.collection(collection).orderBy("__name__").limit(options.limit);
  if (options.startAfter) query = query.startAfter(options.startAfter);
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(predicate);
}

export async function writeMigrationReport(stats, cwd = process.cwd()) {
  const directory = path.join(cwd, "migration-reports");
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(directory, `${stats.name}-${stamp}.json`);
  const safe = { ...stats, failures: stats.failures?.slice(0, 100) || [] };
  await fs.writeFile(file, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return file;
}

export function printStats(stats, reportFile) {
  console.log(JSON.stringify({ ...stats, reportFile }, null, 2));
}
