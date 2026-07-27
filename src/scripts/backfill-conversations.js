import { getContainer } from "../container.js";
import { now } from "../utils/dates.js";
import { parseMigrationArgs, loadLegacyDocuments, printStats, runDocuments, writeMigrationReport } from "./lib/migration-runner.js";

const options = parseMigrationArgs();
const c = getContainer();
const documents = await loadLegacyDocuments(c.firebase.db, "leads", options, (lead) => !lead.leadId && Boolean(lead.contactId));
const stats = await runDocuments({
  name: "backfill-conversations",
  documents: documents.map((lead) => ({ ...lead, alreadyMigrated: Boolean(lead.conversationId && lead.migratedLeadId) })),
  dryRun: options.dryRun,
  handler: async (legacy) => {
    if (legacy.conversationId && legacy.migratedLeadId) return { status: "skipped" };
    const contact = await c.contacts.get(options.orgId, legacy.contactId);
    const lead = await c.domain.ensureLead({
      orgId: options.orgId,
      contact,
      assignedTo: legacy.assignedTo || null,
      source: "WHATSAPP"
    });
    const conversation = await c.conversations.findOrCreate({
      orgId: options.orgId,
      contactId: contact.contactId,
      leadId: lead.leadId,
      channel: "WHATSAPP",
      channelAccountId: legacy.channelAccountId || c.env.DEFAULT_CHANNEL_ACCOUNT_ID,
      assignedTo: lead.assignedTo
    });
    await c.firebase.db.collection("leads").doc(legacy.id).set({
      migratedLeadId: lead.leadId,
      conversationId: conversation.conversationId,
      channelAccountId: conversation.currentChannelAccountId,
      migrationVersion: 2,
      migratedAt: now()
    }, { merge: true });
    await c.store.update("leads", lead.leadId, {
      conversationId: conversation.conversationId,
      legacyIds: { leadDocumentId: legacy.id },
      updatedAt: now()
    });
    return { status: "migrated" };
  }
});
const report = await writeMigrationReport(stats);
printStats(stats, report);
