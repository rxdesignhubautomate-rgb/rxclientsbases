import { COLLECTIONS } from "../config/constants.js";
import { classificationProjection, CLASSIFICATION_VERSION } from "../services/client-classification.js";
import { decodeCursor } from "../utils/pagination.js";

// Pure store dependency. This module never loads dotenv, credentials or a provider.
export async function backfillClassificationPage(store, { orgId, cursor, limit = 100, commit = false } = {}) {
  if (!orgId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Provide orgId and a page limit between 1 and 100");
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (cursor && (!decoded || decoded.includes("/"))) throw new Error("Invalid migration cursor");
  if (decoded) {
    const previous = await store.get(COLLECTIONS.contacts, decoded);
    if (!previous || previous.orgId !== orgId) throw new Error("Cursor is outside the selected business");
  }
  const page = await store.find(COLLECTIONS.contacts, { filters: [["orgId", "==", orgId]], orderBy: ["__name__", "asc"], cursor: decoded, limit });
  const report = { scanned: page.items.length, prepared: 0, skipped: 0, reviewRequired: 0, committed: commit, nextCursor: page.pagination.nextCursor };
  for (const item of page.items) {
    const result = await store.runTransaction(async tx => {
      const current = await tx.get(COLLECTIONS.contacts, item.id || item.contactId);
      if (!current || current.orgId !== orgId || current.crmV1Version >= CLASSIFICATION_VERSION) return null;
      const patch = classificationProjection(current);
      if (commit) tx.update(COLLECTIONS.contacts, item.id || item.contactId, patch);
      return patch;
    });
    if (!result) report.skipped += 1;
    else { report.prepared += 1; if (result.crmV1NeedsReview) report.reviewRequired += 1; }
  }
  return report;
}

export function assertLocalMigrationEnvironment(environment) {
  if (environment.NODE_ENV === "production" || !/^demo-[a-z0-9-]+$/.test(environment.GCLOUD_PROJECT || "")
    || !/^(localhost|127\.0\.0\.1):\d{2,5}$/.test(environment.FIRESTORE_EMULATOR_HOST || "")
    || environment.FIREBASE_PRIVATE_KEY || environment.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("Migration requires a loopback Firestore emulator, demo-* GCLOUD_PROJECT and no credentials. Production access is refused.");
  }
}
