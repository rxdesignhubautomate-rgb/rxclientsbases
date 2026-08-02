import { getContainer } from "../container.js";
import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";
import { normalizePhone } from "../utils/phone.js";
import { parseMigrationArgs, printStats, runDocuments, writeMigrationReport } from "./lib/migration-runner.js";

const options = {
  ...parseMigrationArgs(),
  source: argumentValue("source", "EXISTING_CUSTOMER_RELATIONSHIP"),
  note: argumentValue("note", "Existing client consent confirmed from customer records")
};
const c = getContainer();
const result = await c.store.find(COLLECTIONS.contacts, {
  filters: [["orgId", "==", options.orgId]],
  limit: 50000
});
const documents = result.items
  .filter((contact) => contact.relationshipType === "EXISTING_CLIENT")
  .map((contact) => {
    const alreadyOptedIn = contact.marketingConsent?.status === "OPTED_IN" || contact.marketingOptIn === true;
    const alreadyOptedOut = contact.marketingConsent?.status === "OPTED_OUT" || contact.marketingOptOut === true;
    return {
      ...contact,
      id: contact.contactId || contact.id,
      alreadyOptedIn,
      alreadyOptedOut,
      alreadyMigrated: alreadyOptedIn || alreadyOptedOut
    };
  });
const candidates = documents.filter((contact) => !contact.alreadyMigrated && normalizePhone(contact.primaryPhone));
const summary = {
  existingClients: documents.length,
  newlyOptedIn: options.dryRun ? candidates.length : 0,
  alreadyOptedIn: documents.filter((contact) => contact.alreadyOptedIn).length,
  optedOutPreserved: documents.filter((contact) => contact.alreadyOptedOut).length,
  skippedNoPhone: documents.filter((contact) => !contact.alreadyMigrated && !normalizePhone(contact.primaryPhone)).length,
  dryRun: options.dryRun
};

const stats = await runDocuments({
  name: "backfill-existing-client-consent",
  documents,
  dryRun: options.dryRun,
  handler: async (contact) => {
    if (contact.alreadyOptedOut || contact.alreadyOptedIn) return { status: "skipped" };
    if (!normalizePhone(contact.primaryPhone)) return { status: "skipped" };
    const timestamp = now();
    await c.store.update(COLLECTIONS.contacts, contact.id, {
      marketingConsent: {
        channel: "WHATSAPP",
        status: "OPTED_IN",
        source: options.source,
        note: options.note,
        recordedAt: timestamp,
        recordedBy: "CONSENT_BACKFILL",
        optedOutAt: null
      },
      marketingOptIn: true,
      marketingOptOut: false,
      marketingOptOutAt: null,
      optInStatus: "OPTED_IN",
      optInSource: options.source,
      optInTimestamp: timestamp,
      suppressed: false,
      updatedAt: timestamp
    });
    return { status: "migrated" };
  }
});

if (!options.dryRun) summary.newlyOptedIn = stats.migrated;
if (!options.dryRun && stats.migrated > 0) {
  await c.audit.write({
    orgId: options.orgId,
    actorType: "SYSTEM",
    actorId: "CONSENT_BACKFILL",
    action: "WHATSAPP_MARKETING_OPTED_IN_BACKFILL",
    entityType: "CONTACT_GROUP",
    entityId: options.orgId,
    after: { ...summary, source: options.source, note: options.note }
  });
}

const report = await writeMigrationReport(stats);
printStats(stats, report);
console.log(JSON.stringify(summary, null, 2));

function argumentValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() || fallback : fallback;
}
