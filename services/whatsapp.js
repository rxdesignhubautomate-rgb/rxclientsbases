import { config } from "../config.js";
import { queueLegacyWhatsAppMessage } from "../src/legacy/bridge.js";

export function extractIncomingMessages(payload) {
  const messages = [];
  const entries = payload.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const message of value.messages || []) {
        const text = extractMessageText(message);
        if (!text) continue;

        messages.push({
          whatsappMessageId: message.id,
          from: message.from,
          text,
          timestamp: message.timestamp
        });
      }
    }
  }

  return messages;
}

function extractMessageText(message = {}) {
  if (message.text?.body) return message.text.body;
  if (message.button?.text) return message.button.text;
  if (message.button?.payload) return message.button.payload;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.interactive?.button_reply?.id) return message.interactive.button_reply.id;
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message.interactive?.list_reply?.id) return message.interactive.list_reply.id;
  return "";
}

export async function sendWhatsAppText(to, text) {
  return queueLegacyWhatsAppMessage(to, { type: "TEXT", text });
}

export async function sendWhatsAppVideo(to, options = {}) {
  const media = String(options.media || options.link || options.id || "").trim();
  if (!media) throw new Error("WhatsApp video media link or id is required");

  return queueLegacyWhatsAppMessage(to, {
    type: "VIDEO",
    text: String(options.caption || "").trim(),
    metadata: { providerMedia: media.startsWith("http") ? { link: media } : { id: media } }
  });
}

export async function sendWhatsAppImage(to, options = {}) {
  const media = String(options.media || options.link || options.id || "").trim();
  if (!media) throw new Error("WhatsApp image media link or id is required");

  return queueLegacyWhatsAppMessage(to, {
    type: "IMAGE",
    text: String(options.caption || "").trim(),
    metadata: { providerMedia: media.startsWith("http") ? { link: media } : { id: media } }
  });
}

export async function sendWhatsAppTemplate(to, options = {}) {
  const templateName = String(options.name || "").trim();
  if (!templateName) throw new Error("WhatsApp template name is required");

  const languageCode = String(options.languageCode || "en").trim() || "en";
  const components = buildTemplateComponents(options);
  return queueLegacyWhatsAppMessage(to, {
    type: "TEMPLATE",
    metadata: {
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {})
      }
    }
  });
}

export async function uploadWhatsAppMedia(fileBuffer, options = {}) {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error("Media file is required");
  }

  const mimeType = String(options.mimeType || "video/mp4").trim() || "video/mp4";
  const filename = String(options.filename || "broadcast-video.mp4").trim() || "broadcast-video.mp4";
  const url = `https://graph.facebook.com/v20.0/${config.whatsappPhoneNumberId}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`
    },
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp media upload failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function buildTemplateComponents(options = {}) {
  const components = [];
  const header = buildMediaHeader(options.headerType, options.headerMedia);
  const bodyParameters = Array.isArray(options.bodyParameters)
    ? options.bodyParameters
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((text) => ({ type: "text", text }))
    : [];

  if (header) components.push(header);
  if (bodyParameters.length) {
    components.push({
      type: "body",
      parameters: bodyParameters
    });
  }

  return components;
}

function buildMediaHeader(headerType, mediaValue) {
  const type = String(headerType || "").trim().toLowerCase();
  const value = String(mediaValue || "").trim();
  if (!["image", "video", "document"].includes(type) || !value) return null;

  const media = value.startsWith("http://") || value.startsWith("https://")
    ? { link: value }
    : { id: value };

  return {
    type: "header",
    parameters: [
      {
        type,
        [type]: media
      }
    ]
  };
}
