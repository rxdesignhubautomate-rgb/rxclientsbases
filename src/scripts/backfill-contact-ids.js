import { getContainer } from "../container.js";
import { COLLECTIONS } from "../config/constants.js";
import { normalizePhone } from "../utils/phone.js";
import { now } from "../utils/dates.js";
import { parseMigrationArgs, loadLegacyDocuments, printStats, runDocuments, writeMigrationReport } from "./lib/migration-runner.js";

const options = parseMigrationArgs();
const c = getContainer();
const documents = await loadLegacyDocuments(c.firebase.db, "leads", options, (lead) => !lead.leadId);
const stats = await runDocuments({
  name: "backfill-contacts",
  documents: documents.map((lead) => ({ ...lead, alreadyMigrated: Boolean(lead.contactId) })),
  dryRun: options.dryRun,
  handler: async (lead) => {
    if (lead.contactId) return { status: "skipped" };
    const phone = normalizePhone(lead.phone || lead.id);
    if (!phone) throw new Error("Legacy lead has no valid phone");
    let contact;
    const matches = await c.store.find(COLLECTIONS.contacts, {
      filters: [["orgId", "==", options.orgId], ["phones", "array-contains", phone]],
      limit: 3
    });
    if (matches.items.length > 1) return { status: "duplicate" };
    if (matches.items.length === 1) contact = matches.items[0];
    else {
      contact = await c.contacts.create(options.orgId, {
        contactPerson: lead.name || "",
        primaryPhone: phone,
        city: lead.city || "",
        assignedTo: lead.assignedTo || null,
        source: "WHATSAPP",
        notes: "Migrated from legacy WhatsApp lead"
      });
    }
    await c.firebase.db.collection("leads").doc(lead.id).set({
      orgId: options.orgId,
      contactId: contact.contactId,
      legacyIds: { leadDocumentId: lead.id, phoneDocumentId: lead.id },
      migrationVersion: 2,
      migratedAt: now()
    }, { merge: true });
    return { status: "migrated" };
  }
});
const report = await writeMigrationReport(stats);
printStats(stats, report);
