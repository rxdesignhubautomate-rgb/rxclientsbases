import { BaseChannelAdapter, ChannelError } from "../base-channel.adapter.js";
import { verifyHmacSha256 } from "../../utils/hashing.js";
import { normalizeWhatsAppWebhook } from "./whatsapp.normalizer.js";

export class WhatsAppMetaAdapter extends BaseChannelAdapter {
  constructor({ accessToken, appSecret, graphApiVersion = "v20.0", fetchImpl = fetch }) {
    super();
    this.accessToken = accessToken;
    this.appSecret = appSecret;
    this.graphApiVersion = graphApiVersion;
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

  async request(path, options) {
    const response = await this.fetch(`https://graph.facebook.com/${this.graphApiVersion}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw await channelError(response, "WhatsApp API request failed");
    return response.json();
  }
}

function buildMessageBody(message, attachments) {
  if (message.type === "TEMPLATE" && message.metadata?.template) {
    return { type: "template", template: message.metadata.template };
  }
  const attachment = attachments[0];
  const mediaTypes = { IMAGE: "image", DOCUMENT: "document", AUDIO: "audio", VIDEO: "video" };
  const providerType = mediaTypes[message.type];
  if (providerType && message.metadata?.providerMedia) {
    const media = { ...message.metadata.providerMedia };
    if (message.text && providerType !== "audio") media.caption = message.text;
    return { type: providerType, [providerType]: media };
  }
  if (providerType && attachment) {
    const media = attachment.providerMediaId
      ? { id: attachment.providerMediaId }
      : { link: attachment.signedUrl };
    if (message.text && providerType !== "audio") media.caption = message.text;
    if (providerType === "document" && attachment.originalFilename) media.filename = attachment.originalFilename;
    return { type: providerType, [providerType]: media };
  }
  return { type: "text", text: { preview_url: false, body: message.text } };
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
    retryable
  });
}
