import { getContainer } from "../container.js";

export async function queueLegacyWhatsAppMessage(to, input) {
  const container = getContainer();
  const { contact } = await container.contacts.resolveInboundIdentity({
    orgId: container.env.ORG_ID,
    channel: "WHATSAPP",
    externalUserId: to,
    channelAccountId: container.env.DEFAULT_CHANNEL_ACCOUNT_ID
  });
  const lead = await container.domain.ensureLead({ orgId: container.env.ORG_ID, contact, source: "WHATSAPP" });
  const account = await container.channelAccounts.resolveForSend(container.env.ORG_ID, "WHATSAPP", container.env.DEFAULT_CHANNEL_ACCOUNT_ID);
  const conversation = await container.conversations.findOrCreate({
    orgId: container.env.ORG_ID,
    contactId: contact.contactId,
    leadId: lead.leadId,
    channel: "WHATSAPP",
    channelAccountId: account.channelAccountId || account.id,
    assignedTo: lead.assignedTo
  });
  return container.messages.queueOutbound({
    orgId: container.env.ORG_ID,
    conversationId: conversation.conversationId,
    text: input.text || "",
    type: input.type || "TEXT",
    attachmentIds: input.attachmentIds || [],
    metadata: input.metadata || {},
    senderType: input.senderType || "SYSTEM",
    senderId: input.senderId || "LEGACY"
  });
}
