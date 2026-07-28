import { getContainer } from "../container.js";
import { COLLECTIONS } from "../config/constants.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { parseMigrationArgs, loadLegacyDocuments, printStats, runDocuments, writeMigrationReport } from "./lib/migration-runner.js";

const options = parseMigrationArgs();
const c = getContainer();
const documents = await loadLegacyDocuments(c.firebase.db, "messages", options, (message) => !message.messageId);
const stats = await runDocuments({
  name: "backfill-messages",
  documents,
  dryRun: options.dryRun,
  handler: async (legacy) => {
    const keyId = sha256(`${options.orgId}:LEGACY_MESSAGE:${legacy.id}`);
    if (await c.store.get(COLLECTIONS.idempotencyKeys, keyId)) return { status: "skipped" };
    const legacyLead = await c.firebase.db.collection("leads").doc(legacy.leadId).get();
    const leadData = legacyLead.data();
    if (!leadData?.contactId || !leadData?.conversationId || !leadData?.migratedLeadId) {
      throw new Error("Run contact and conversation backfills first");
    }
    if (legacy.role === "user") {
      await c.messages.createInbound({
        orgId: options.orgId,
        conversationId: leadData.conversationId,
        contactId: leadData.contactId,
        leadId: leadData.migratedLeadId,
        channel: "WHATSAPP",
        channelAccountId: leadData.channelAccountId || c.env.DEFAULT_CHANNEL_ACCOUNT_ID,
        type: "TEXT",
        text: legacy.text || "",
        providerMessageId: legacy.whatsappMessageId || `legacy:${legacy.id}`,
        providerTimestamp: legacy.timestamp ? new Date(legacy.timestamp) : null,
        senderId: legacy.phone || legacy.leadId,
        metadata: { legacySourceId: legacy.id }
      });
    } else {
      const messageId = createId("message");
      await c.store.create(COLLECTIONS.messages, messageId, {
        messageId,
        orgId: options.orgId,
        conversationId: leadData.conversationId,
        contactId: leadData.contactId,
        leadId: leadData.migratedLeadId,
        channel: "WHATSAPP",
        channelAccountId: leadData.channelAccountId || c.env.DEFAULT_CHANNEL_ACCOUNT_ID,
        direction: "OUTBOUND",
        type: "TEXT",
        text: legacy.text || "",
        providerMessageId: legacy.whatsappMessageId || null,
        senderType: legacy.role === "ai" ? "AI" : "AGENT",
        senderId: legacy.role || "LEGACY",
        attachmentIds: [],
        status: "SENT",
        metadata: { legacySourceId: legacy.id },
        createdAt: legacy.timestamp ? new Date(legacy.timestamp) : now(),
        updatedAt: now()
      });
    }
    await c.store.create(COLLECTIONS.idempotencyKeys, keyId, { orgId: options.orgId, kind: "LEGACY_MESSAGE", sourceId: legacy.id, createdAt: now() });
    return { status: "migrated" };
  }
});
const report = await writeMigrationReport(stats);
printStats(stats, report);
