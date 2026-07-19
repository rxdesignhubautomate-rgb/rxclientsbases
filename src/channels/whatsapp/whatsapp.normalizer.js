const TYPE_MAP = {
  text: "TEXT",
  image: "IMAGE",
  document: "DOCUMENT",
  audio: "AUDIO",
  video: "VIDEO",
  location: "LOCATION",
  contacts: "CONTACT",
  button: "INTERACTIVE",
  interactive: "INTERACTIVE",
  sticker: "IMAGE"
};

const STATUS_MAP = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED"
};

export function normalizeWhatsAppWebhook(payload) {
  const events = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || "";
      const profileByWaId = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name || ""]));
      for (const message of value.messages || []) {
        const media = mediaFrom(message);
        events.push({
          kind: "MESSAGE",
          phoneNumberId,
          providerMessageId: message.id,
          externalUserId: message.from,
          profileName: profileByWaId.get(message.from) || "",
          type: TYPE_MAP[message.type] || "SYSTEM",
          text: textFrom(message),
          providerTimestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000) : null,
          replyToProviderMessageId: message.context?.id || null,
          media,
          metadata: {
            providerType: message.type,
            referral: message.referral || null,
            location: message.location || null,
            contacts: message.contacts || null
          }
        });
      }
      for (const status of value.statuses || []) {
        events.push({
          kind: "STATUS",
          phoneNumberId,
          providerMessageId: status.id,
          status: STATUS_MAP[status.status] || "SENT",
          providerTimestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000) : null,
          error: status.errors?.[0]
            ? { code: String(status.errors[0].code || "META_ERROR"), message: status.errors[0].title || status.errors[0].message || "Delivery failed" }
            : null,
          metadata: { conversation: status.conversation || null, pricing: status.pricing || null }
        });
      }
    }
  }
  return events;
}

export function webhookPhoneNumberId(payload) {
  return payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
}

export function providerEventId(payload, fallback) {
  const value = payload.entry?.[0]?.changes?.[0]?.value || {};
  return value.messages?.[0]?.id || value.statuses?.[0]?.id || fallback;
}

function textFrom(message) {
  if (message.text?.body) return message.text.body;
  if (message.button?.text) return message.button.text;
  if (message.interactive?.button_reply) return message.interactive.button_reply.title || message.interactive.button_reply.id || "";
  if (message.interactive?.list_reply) return message.interactive.list_reply.title || message.interactive.list_reply.id || "";
  if (message.image?.caption) return message.image.caption;
  if (message.video?.caption) return message.video.caption;
  if (message.document?.caption) return message.document.caption;
  return "";
}

function mediaFrom(message) {
  const value = message.image || message.document || message.audio || message.video || message.sticker;
  if (!value?.id) return null;
  return {
    providerMediaId: value.id,
    mimeType: value.mime_type || null,
    sha256: value.sha256 || null,
    filename: value.filename || `${message.type}-${message.id}`,
    caption: value.caption || ""
  };
}
