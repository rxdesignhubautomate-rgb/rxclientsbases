import { BaseChannelAdapter, ChannelError } from "../base-channel.adapter.js";
import { verifyHmacSha256 } from "../../utils/hashing.js";
import { normalizeWhatsAppWebhook } from "./whatsapp.normalizer.js";
import { normalizeIndianPhoneNumber, validatePhoneNumber } from "../../utils/phone.js";

export class WhatsAppMetaAdapter extends BaseChannelAdapter {
  constructor({ accessToken, appSecret, graphApiVersion = "v25.0", requestTimeoutMs = 15000, fetchImpl = fetch }) {
    super();
    this.accessToken = accessToken;
    this.appSecret = appSecret;
    this.graphApiVersion = graphApiVersion;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetch = fetchImpl;
  }

  async verifyWebhook({ rawBody, signature, allowUnsigned = false }) {
    if (allowUnsigned && !this.appSecret) return true;
    return verifyHmacSha256(rawBody, signature, this.appSecret);
  }

  async normalizeWebhook(payload) {
    return normalizeWhatsAppWebhook(payload);
  }

  async sendMessage({ account, message, attachments = [] }) {
    if (account.status !== "ACTIVE" || account.sendEnabled !== true) {
      throw new ChannelError("Channel account is disabled for sending", { status: 409, code: "ACCOUNT_DISABLED", retryable: false });
    }
    const body = buildMessageBody(message, attachments);
    const response = await this.request(`/${account.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", to: message.recipientId, ...body })
    });
    return { providerMessageId: response.messages?.[0]?.id || null, raw: response };
  }

  sendTextMessage({ account, to, text }) {
    return this.sendMessage({ account, message: { recipientId: to, type: "TEXT", text } });
  }

  sendTemplateMessage({ account, to, name, language = "en", components = [] }) {
    return this.sendMessage({
      account,
      message: { recipientId: to, type: "TEMPLATE", metadata: { template: { name, language: { code: language }, components } } }
    });
  }

  sendInteractiveMessage({ account, to, interactive }) {
    return this.sendMessage({ account, message: { recipientId: to, type: "INTERACTIVE", metadata: { interactive } } });
  }

  sendMediaMessage({ account, to, type, media, caption = "" }) {
    return this.sendMessage({
      account,
      message: { recipientId: to, type, text: caption, metadata: { providerMedia: media } }
    });
  }

  async uploadMedia({ account, buffer, mimeType, filename }) {
    const contentType = mimeType || "application/octet-stream";
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", contentType);
    form.append("file", new Blob([buffer], { type: contentType }), filename || "attachment");
    const response = await this.fetch(
      `https://graph.facebook.com/${this.graphApiVersion}/${account.phoneNumberId}/media`,
      {
        method: "POST",
        signal: globalThis.AbortSignal.timeout(this.requestTimeoutMs),
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: form
      }
    );
    if (!response.ok) throw await channelError(response, "WhatsApp media upload failed");
    const data = await response.json();
    if (!data.id) {
      throw new ChannelError("WhatsApp media upload returned no id", {
        status: 502,
        code: "MEDIA_UPLOAD_NO_ID",
        retryable: true
      });
    }
    return data.id;
  }

  validatePhoneNumber(value) {
    return validatePhoneNumber(value);
  }

  normalizeIndianPhoneNumber(value) {
    return normalizeIndianPhoneNumber(value);
  }

  async downloadMedia({ media }) {
    const metadata = await this.request(`/${media.providerMediaId}`, { method: "GET" });
    const response = await this.fetch(metadata.url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) throw await channelError(response, "WhatsApp media download failed");
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: metadata.mime_type || media.mimeType || response.headers.get("content-type") || "application/octet-stream",
      filename: media.filename,
      providerMediaId: media.providerMediaId
    };
  }

  async markAsRead({ account, providerMessageId }) {
    return this.request(`/${account.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: providerMessageId })
    });
  }

  async listMessageTemplates({ businessAccountId, limit = 100 }) {
    const templates = [];
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: String(limit), fields: "id,name,language,category,status,quality_score,components" });
      if (after) query.set("after", after);
      const response = await this.request(`/${businessAccountId}/message_templates?${query.toString()}`, { method: "GET" });
      templates.push(...(response.data || []));
      after = response.paging?.cursors?.after || null;
      if (!after || !response.paging?.next) break;
    }
    return templates;
  }

  async request(path, options) {
    try {
      const response = await this.fetch(`https://graph.facebook.com/${this.graphApiVersion}${path}`, {
        ...options,
        signal: options.signal || globalThis.AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw await channelError(response, "WhatsApp API request failed");
      return response.json();
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new ChannelError("WhatsApp API request timed out", { status: 504, code: "META_TIMEOUT", retryable: true });
      }
      throw error;
    }
  }
}

function buildMessageBody(message, attachments) {
  const context = message.metadata?.replyToProviderMessageId
    ? { context: { message_id: message.metadata.replyToProviderMessageId } }
    : {};
  if (message.type === "TEMPLATE" && message.metadata?.template) {
    return { ...context, type: "template", template: message.metadata.template };
  }
  if (message.type === "INTERACTIVE" && message.metadata?.interactive) {
    return { ...context, type: "interactive", interactive: message.metadata.interactive };
  }
  if (message.type === "LOCATION" && message.metadata?.location) {
    return { ...context, type: "location", location: message.metadata.location };
  }
  if (message.type === "CONTACT" && message.metadata?.contacts) {
    return { ...context, type: "contacts", contacts: message.metadata.contacts };
  }
  if (message.type === "REACTION" && message.metadata?.replyToProviderMessageId && message.text) {
    return {
      type: "reaction",
      reaction: {
        message_id: message.metadata.replyToProviderMessageId,
        emoji: message.text
      }
    };
  }
  const attachment = attachments[0];
  const mediaTypes = { IMAGE: "image", DOCUMENT: "document", AUDIO: "audio", VIDEO: "video" };
  const providerType = mediaTypes[message.type];
  if (providerType && message.metadata?.providerMedia) {
    const media = { ...message.metadata.providerMedia };
    if (message.text && providerType !== "audio") media.caption = message.text;
    return { ...context, type: providerType, [providerType]: media };
  }
  if (providerType && attachment) {
    const media = attachment.providerMediaId
      ? { id: attachment.providerMediaId }
      : { link: attachment.signedUrl };
    if (message.text && providerType !== "audio") media.caption = message.text;
    if (providerType === "document" && attachment.originalFilename) media.filename = attachment.originalFilename;
    return { ...context, type: providerType, [providerType]: media };
  }
  return { ...context, type: "text", text: { preview_url: true, body: message.text } };
}

async function channelError(response, prefix) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  const message = payload.error?.message || `${prefix}: HTTP ${response.status}`;
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  return new ChannelError(message, {
    status: response.status,
    code: String(payload.error?.code || "META_ERROR"),
    retryable,
    details: {
      errorSubcode: payload.error?.error_subcode || null,
      type: payload.error?.type || null,
      traceId: payload.error?.fbtrace_id || null
    }
  });
}

export function buildTemplateComponents(values = []) {
  return values.length
    ? [{ type: "body", parameters: values.map((value) => ({ type: "text", text: String(value) })) }]
    : [];
}
