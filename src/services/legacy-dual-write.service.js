import { findOrCreateLeadByPhone, saveMessage } from "../../services/leadStore.js";

export class LegacyDualWriteService {
  constructor(enabled) {
    this.enabled = enabled;
  }

  async saveInbound(event) {
    if (!this.enabled || event.channel !== "WHATSAPP" || !event.text) return { skipped: true };
    const lead = await findOrCreateLeadByPhone(event.senderId);
    await saveMessage({
      leadId: lead.id,
      phone: event.senderId,
      role: "user",
      text: event.text,
      whatsappMessageId: event.providerMessageId
    });
    return { skipped: false, legacyLeadId: lead.id };
  }
}
