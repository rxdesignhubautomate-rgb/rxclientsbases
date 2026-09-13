import { config } from "../config.js";
import { mediaReference, mediaSendError } from "./sequenceMedia.js";

export function extractIncomingMessages(payload = {}) {
  const messages = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (
        value.metadata?.phone_number_id &&
        value.metadata.phone_number_id !== config.whatsappPhoneNumberId
      )
        continue;
      for (const message of value.messages || []) {
        if (!message.id || !/^\d{7,15}$/.test(message.from || "")) continue;
        const type = message.type || (message.text ? "text" : "interactive");
        const media = message[type];
        const isMedia = [
          "image",
          "video",
          "audio",
          "document",
          "sticker",
        ].includes(type);
        const text =
          extractMessageText(message) ||
          (isMedia
            ? media?.caption || ""
            : type === "location"
              ? message.location?.name || "Location"
              : type === "contacts"
                ? "Contact card"
                : `[${type}]`);

        messages.push({
          whatsappMessageId: message.id,
          from: message.from,
          text,
          timestamp: message.timestamp,
          type,
          media:
            isMedia && media?.id
              ? {
                  id: media.id,
                  mimeType: media.mime_type || "",
                  filename: media.filename || "",
                  voice: media.voice === true,
                }
              : null,
          context: message.context?.id ? { id: message.context.id } : null,
          location: message.location || null,
          contacts: message.contacts || null,
          reaction: message.reaction || null,
          order: message.order || null,
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
  if (message.interactive?.button_reply?.title)
    return message.interactive.button_reply.title;
  if (message.interactive?.button_reply?.id)
    return message.interactive.button_reply.id;
  if (message.interactive?.list_reply?.title)
    return message.interactive.list_reply.title;
  if (message.interactive?.list_reply?.id)
    return message.interactive.list_reply.id;
  return "";
}

export async function sendWhatsAppText(to, text, options = {}) {
  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      ...(options.replyTo ? { context: { message_id: options.replyTo } } : {}),
      type: "text",
      text: {
        preview_url: false,
        body: text,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp send failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

export function extractMessageStatuses(payload = {}) {
  return (Array.isArray(payload.entry) ? payload.entry : []).flatMap((entry) =>
    (entry.changes || []).flatMap((change) => {
      const value = change.value || {};
      if (
        value.metadata?.phone_number_id &&
        value.metadata.phone_number_id !== config.whatsappPhoneNumberId
      )
        return [];
      return Array.isArray(value.statuses) ? value.statuses : [];
    }),
  );
}

export async function sendWhatsAppMedia(to, options) {
  if (!["image", "video", "audio", "document"].includes(options.type))
    throw new Error("Unsupported media type");
  const media = { id: options.media };
  if (options.caption && options.type !== "audio")
    media.caption = options.caption;
  if (options.type === "document")
    media.filename = options.filename || "document";
  return graphRequest("messages", {
    messaging_product: "whatsapp",
    to,
    type: options.type,
    [options.type]: media,
    ...(options.replyTo ? { context: { message_id: options.replyTo } } : {}),
  });
}
export async function markWhatsAppMessageRead(id) {
  return graphRequest("messages", {
    messaging_product: "whatsapp",
    status: "read",
    message_id: id,
  });
}
export async function graphRequest(endpoint, body) {
  const response = await fetch(
    `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/${endpoint}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new Error(
      `WhatsApp request failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  return response.json();
}

// All paths are constructed by server code; client input cannot supply a Graph host.
export async function graphApi(path, { method = "GET", body, query } = {}) {
  const url = new URL(
    `https://graph.facebook.com/${config.whatsappGraphVersion}/${path}`,
  );
  for (const [key, value] of Object.entries(query || {}))
    if (value !== undefined && value !== "")
      url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    const e = data.error || {};
    throw Object.assign(
      new Error(
        `WhatsApp: ${String(e.message || "Request failed").slice(0, 350)}`,
      ),
      { status: 502, graphCode: e.code },
    );
  }
  return data;
}
export const sendStructuredMessage = (to, body) =>
  graphApi(`${config.whatsappPhoneNumberId}/messages`, {
    method: "POST",
    body: { messaging_product: "whatsapp", to, ...body },
  });
export const sendTypingIndicator = (id) =>
  graphApi(`${config.whatsappPhoneNumberId}/messages`, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      status: "read",
      message_id: id,
      typing_indicator: { type: "text" },
    },
  });
export async function downloadWhatsAppMedia(id) {
  if (!/^\d+$/.test(String(id)))
    throw Object.assign(new Error("Invalid media ID"), { status: 400 });
  const response = await fetch(
    `https://graph.facebook.com/${config.whatsappGraphVersion}/${id}`,
    {
      headers: { Authorization: `Bearer ${config.whatsappToken}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw Object.assign(
      new Error("This WhatsApp attachment is no longer available"),
      { status: 410 },
    );
  const metadata = await response.json();
  const url = new URL(metadata.url);
  if (
    url.protocol !== "https:" ||
    !["facebook.com", "fbcdn.net", "fbsbx.com"].some(
      (host) => url.hostname === host || url.hostname.endsWith("." + host),
    )
  )
    throw new Error("Unexpected media host");
  if (Number(metadata.file_size) > 16 * 1024 * 1024)
    throw Object.assign(
      new Error("This attachment exceeds the 16 MB viewing limit"),
      { status: 413 },
    );
  const media = await fetch(url, {
    headers: { Authorization: `Bearer ${config.whatsappToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!media.ok)
    throw Object.assign(new Error("Attachment download failed"), {
      status: 502,
    });
  const chunks = [];
  let size = 0;
  for await (const chunk of media.body) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024)
      throw Object.assign(new Error("Attachment exceeds 16 MB"), {
        status: 413,
      });
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    mimeType: metadata.mime_type || "application/octet-stream",
  };
}

export async function sendWhatsAppVideo(to, options = {}) {
  const media = String(
    options.media || options.link || options.id || "",
  ).trim();

  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`;
  const video = mediaReference(media);
  const caption = String(options.caption || "").trim();
  if (caption) video.caption = caption;

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "video",
      video,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw mediaSendError(response.status, errorText, "video");
  }

  return response.json();
}

export async function sendWhatsAppImage(to, options = {}) {
  const media = String(
    options.media || options.link || options.id || "",
  ).trim();

  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`;
  const image = mediaReference(media);
  const caption = String(options.caption || "").trim();
  if (caption) image.caption = caption;

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw mediaSendError(response.status, errorText, "image");
  }

  return response.json();
}

export async function sendWhatsAppTemplate(to, options = {}) {
  const templateName = String(options.name || "").trim();
  if (!templateName) throw new Error("WhatsApp template name is required");

  const languageCode = String(options.languageCode || "en").trim() || "en";
  const components = buildTemplateComponents(options);
  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `WhatsApp template send failed: ${response.status} ${errorText}`,
    );
  }

  return response.json();
}

export async function uploadWhatsAppMedia(fileBuffer, options = {}) {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error("Media file is required");
  }

  const mimeType =
    String(options.mimeType || "video/mp4").trim() || "video/mp4";
  const filename =
    String(options.filename || "broadcast-video.mp4").trim() ||
    "broadcast-video.mp4";
  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `WhatsApp media upload failed: ${response.status} ${errorText}`,
    );
  }

  return response.json();
}

function buildTemplateComponents(options = {}) {
  const components = [];
  const header = buildMediaHeader(options.headerType, options.headerMedia);
  const headerTextParameters = normalizeTextParameters(
    options.headerTextParameters,
  );
  const bodyParameters = Array.isArray(options.bodyParameters)
    ? normalizeTextParameters(options.bodyParameters)
    : [];
  const buttonParameters = Array.isArray(options.buttonParameters)
    ? options.buttonParameters
        .map((item) => ({
          index: String(item?.index ?? "").trim(),
          text: String(item?.text || "").trim(),
        }))
        .filter(
          (item) => /^\d+$/.test(item.index) && item.text && item.text.length <= 1024,
        )
    : [];

  if (header) components.push(header);
  else if (headerTextParameters.length) {
    components.push({
      type: "header",
      parameters: headerTextParameters,
    });
  }
  if (bodyParameters.length) {
    components.push({
      type: "body",
      parameters: bodyParameters,
    });
  }
  for (const item of buttonParameters) {
    components.push({
      type: "button",
      sub_type: "url",
      index: item.index,
      parameters: [{ type: "text", text: item.text }],
    });
  }

  return components;
}

function normalizeTextParameters(values) {
  return Array.isArray(values)
    ? values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((text) => ({ type: "text", text }))
    : [];
}

function buildMediaHeader(headerType, mediaValue) {
  const type = String(headerType || "")
    .trim()
    .toLowerCase();
  const value = String(mediaValue || "").trim();
  if (!["image", "video", "document"].includes(type) || !value) return null;

  const media =
    value.startsWith("http://") || value.startsWith("https://")
      ? { link: value }
      : { id: value };

  return {
    type: "header",
    parameters: [
      {
        type,
        [type]: media,
      },
    ],
  };
}
