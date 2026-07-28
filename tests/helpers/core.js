import { MemoryStore } from "./memory-store.js";
import { AuditService } from "../../src/services/audit.service.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { ContactService } from "../../src/services/contact.service.js";
import { ChannelAccountService } from "../../src/services/channel-account.service.js";
import { ConversationService } from "../../src/services/conversation.service.js";
import { MessageService } from "../../src/services/message.service.js";
import { DomainService } from "../../src/services/domain.service.js";

export function makeCore({ defaultAiMode = "ASSIST" } = {}) {
  const store = new MemoryStore();
  const audit = new AuditService(store);
  const notifications = new NotificationService(store);
  const contacts = new ContactService({ store, audit, notifications });
  const channelAccounts = new ChannelAccountService({ store, audit });
  const conversations = new ConversationService({ store, audit, defaultAiMode });
  const messages = new MessageService({ store, conversations, contacts, channelAccounts, audit });
  const domain = new DomainService({ store, audit });
  return { store, audit, notifications, contacts, channelAccounts, conversations, messages, domain };
}

export async function seedConversation(core, { aiMode = "ASSIST", accountStatus = "ACTIVE", sendEnabled = true } = {}) {
  const account = await core.channelAccounts.create("RXDH", {
    channelAccountId: "WA_RX_01",
    channel: "WHATSAPP",
    provider: "META_CLOUD_API",
    displayName: "RX Design Hub",
    phoneNumberId: "phone-id",
    businessAccountId: "business-id",
    status: accountStatus,
    sendEnabled,
    receiveEnabled: true,
    isDefault: false
  });
  if (accountStatus === "ACTIVE" && sendEnabled) await core.channelAccounts.makeDefault("RXDH", "WA_RX_01");
  const contact = await core.contacts.create("RXDH", { contactPerson: "Rahul", primaryPhone: "9876543210", source: "WHATSAPP" });
  await core.contacts.addIdentity("RXDH", contact.contactId, {
    channel: "WHATSAPP",
    externalUserId: "919876543210",
    channelAccountId: "WA_RX_01"
  });
  const lead = await core.domain.ensureLead({ orgId: "RXDH", contact, source: "WHATSAPP" });
  const conversation = await core.conversations.findOrCreate({
    orgId: "RXDH",
    contactId: contact.contactId,
    leadId: lead.leadId,
    channel: "WHATSAPP",
    channelAccountId: "WA_RX_01"
  });
  await core.store.update("conversations", conversation.conversationId, { lastInboundAt: new Date() });
  if (conversation.aiMode !== aiMode) {
    await core.conversations.transition("RXDH", conversation.conversationId, "AI_MODE", { aiMode });
  }
  return { account, contact, lead, conversation: await core.conversations.get("RXDH", conversation.conversationId) };
}
