import express from "express";
import { installChatFeatureRoutes } from "./chatFeatures.js";
import { viewerKey } from "../services/chatFeaturesStore.js";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../firebase.js";
import { products } from "../services/knowledgeBase.js";
import { updateLead } from "../services/leadStore.js";
import { uploadQuotationToDrive } from "../services/googleDrive.js";
import {
  claimOutbound,
  getMessage,
  listChatMessages,
  listInbox,
  listInboxChanges,
  inboxReadState,
  markChatRead,
  recordMessage,
} from "../services/chatStore.js";
import {
  downloadWhatsAppMedia,
  markWhatsAppMessageRead,
  sendWhatsAppMedia,
  sendWhatsAppText,
  uploadWhatsAppMedia,
} from "../services/whatsapp.js";

export const chatsRouter = express.Router();
const MEDIA = {
  "image/jpeg": ["image", 5],
  "image/png": ["image", 5],
  "video/mp4": ["video", 16],
  "video/3gpp": ["video", 16],
  "audio/mpeg": ["audio", 16],
  "audio/mp4": ["audio", 16],
  "audio/aac": ["audio", 16],
  "audio/amr": ["audio", 16],
  "audio/ogg": ["audio", 16],
  "application/pdf": ["document", 16],
  "text/plain": ["document", 16],
  "application/msword": ["document", 16],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "document",
    16,
  ],
  "application/vnd.ms-excel": ["document", 16],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    "document",
    16,
  ],
  "application/vnd.ms-powerpoint": ["document", 16],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "document",
    16,
  ],
};
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function validateMedia(mime, size) {
  const type = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const rule = MEDIA[type];
  if (!rule)
    throw fail(
      "Unsupported attachment. Use JPG/PNG, MP4, MP3/M4A/OGG, PDF, or an Office document.",
    );
  if (!size || size > rule[1] * 1024 * 1024)
    throw fail(`File must be smaller than ${rule[1]} MB.`);
  return { type: rule[0], mimeType: type };
}
function chatRole(req) {
  // Never derive ownership from x-device-role or x-device-user.
  if (!config.deviceApprovalEnabled) return "admin";
  if (req.device?.headerApproved || !req.device?.approved)
    throw fail("An approved device is required for chat access", 403);
  const role = String(req.device?.role || "").toLowerCase();
  if (!["admin", ...config.salesTeam].includes(role))
    throw fail("This device has no chat access", 403);
  return role;
}
async function leadFor(req) {
  const role = chatRole(req);
  const id = req.params.leadId;
  if (!id || id.includes("/") || id.length > 150) throw fail("Invalid lead ID");
  const snap = await getDb().collection("leads").doc(id).get();
  if (!snap.exists) throw fail("Chat not found", 404);
  const lead = { id: snap.id, ...snap.data() };
  const owner = lead.assignedTo === "pinky" ? "ankit" : lead.assignedTo;
  if (role !== "admin" && owner !== role)
    throw fail("You cannot access this chat", 403);
  lead.assignedTo = owner;
  return { role, lead };
}
export function assertCanSend(lead) {
  if (lead.whatsappBlocked)
    throw fail("This contact is blocked on WhatsApp.", 409);
  if (lead.optedOut)
    throw fail(
      "This customer has stopped messages. Wait for them to opt in again.",
      409,
    );
  const inbound = Date.parse(lead.lastInboundAt);
  if (!Number.isFinite(inbound) || Date.now() - inbound >= 86400000)
    throw fail(
      "The 24-hour reply window has closed. Use an approved WhatsApp template or wait for the customer to message again.",
      409,
    );
}
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
chatsRouter.get(
  "/config",
  handle(async (req, res) => {
    chatRole(req);
    res.json({
      version: 2,
      features: {
        media: true,
        receipts: true,
        replies: true,
        pagination: true,
        unread: true,
        advanced: true,
        inboxDelta: true,
        events: true,
        search: true,
        reactions: true,
        typing: true,
        marketingReplies: true,
      },
      maxUploadBytes: 16 * 1024 * 1024,
      samples: products.map((product) => ({
        name: product.name,
        url: product.sampleLink,
      })),
    });
  }),
);
chatsRouter.get(
  "/changes",
  handle(async (req, res) => {
    const role = chatRole(req);
    res.json(
      await listInboxChanges(
        role,
        String(req.query.since || ""),
        viewerKey(req, role),
      ),
    );
  }),
);
installChatFeatureRoutes(chatsRouter, {
  chatRole,
  leadFor,
  handle,
  assertCanSend,
});
chatsRouter.post(
  "/:leadId/template-media",
  express.raw({ type: () => true, limit: "16mb" }),
  handle(async (req, res) => {
    const { lead } = await leadFor(req);
    if (!Buffer.isBuffer(req.body)) throw fail("Choose a header attachment.");
    const attachment = validateMedia(
      req.headers["content-type"],
      req.body.length,
    );
    if (!["image", "video", "document"].includes(attachment.type))
      throw fail("Template headers support images, video or documents.");
    const filename = String(req.query.filename || "attachment")
      .replace(/[\r\n]/g, "")
      .slice(0, 200);
    const uploaded = await uploadWhatsAppMedia(req.body, {
      mimeType: attachment.mimeType,
      filename,
    });
    if (!/^\d+$/.test(String(uploaded.id)))
      throw fail("Upload was not confirmed.", 502);
    await getDb().collection("chatUploads").doc(uploaded.id).set({
      leadId: lead.id,
      type: attachment.type,
      filename,
      createdAt: new Date().toISOString(),
    });
    res.json({ id: uploaded.id, type: attachment.type, filename });
  }),
);
chatsRouter.get(
  "/",
  handle(async (req, res) =>
    res.json(
      await listInbox(
        chatRole(req),
        String(req.query.cursor || ""),
        viewerKey(req, chatRole(req)),
      ),
    ),
  ),
);
chatsRouter.get(
  "/:leadId/messages",
  handle(async (req, res) => {
    const { lead, role } = await leadFor(req);
    res.json({
      lead: { ...lead, ...inboxReadState(lead, role, viewerKey(req, role)) },
      ...(await listChatMessages(
        lead.id,
        String(req.query.before || ""),
        req.query.limit,
      )),
    });
  }),
);
chatsRouter.post(
  "/:leadId/read",
  handle(async (req, res) => {
    const { lead, role } = await leadFor(req);
    await markChatRead(
      lead.id,
      viewerKey(req, role),
      req.body.inboundCount,
      role,
    );
    if (req.body.messageId) {
      const message = await getMessage(String(req.body.messageId));
      if (
        message?.leadId === lead.id &&
        message.role === "user" &&
        message.whatsappMessageId
      ) {
        // Local unread state is independent of the optional WhatsApp read receipt.
        try {
          await markWhatsAppMessageRead(message.whatsappMessageId);
        } catch (error) {
          console.error("whatsapp_read_receipt_failed", {
            error: error.message,
          });
        }
      }
    }
    res.json({ ok: true });
  }),
);
chatsRouter.get(
  "/:leadId/messages/:messageId/media",
  handle(async (req, res) => {
    const { lead } = await leadFor(req);
    const message = await getMessage(req.params.messageId);
    if (!message || message.leadId !== lead.id || !message.media?.id)
      throw fail("Attachment not found", 404);
    const media = await downloadWhatsAppMedia(message.media.id);
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Type", media.mimeType);
    res.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(message.media.filename || "attachment")}`,
    );
    res.send(media.buffer);
  }),
);
async function contextFor(leadId, id) {
  if (!id) return null;
  const message = await getMessage(String(id));
  if (!message || message.leadId !== leadId || !message.whatsappMessageId)
    throw fail("The original message cannot be replied to");
  return {
    id: message.whatsappMessageId,
    text: message.text || `[${message.type || "message"}]`,
    role: message.role,
  };
}
async function deliver(req, res, attachment = null) {
  const { lead } = await leadFor(req);
  assertCanSend(lead);
  const payload = attachment ? req.query : req.body;
  const text = String(payload.text || payload.caption || "").trim();
  if ((!attachment && !text) || text.length > (attachment ? 1024 : 4096))
    throw fail("Enter a message within the WhatsApp length limit");
  if (attachment?.type === "audio" && text)
    throw fail(
      "Audio attachments cannot have a caption. Send the text separately.",
    );
  const context = await contextFor(lead.id, payload.replyTo);
  const key = String(payload.clientMessageId || "");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        text,
        type: attachment?.type || "text",
        replyTo: payload.replyTo || "",
      }),
    )
    .update(attachment ? req.body : "")
    .digest("hex");
  const claim = await claimOutbound(lead.id, key, fingerprint);
  if (claim.existing) return res.json({ ok: true, message: claim.existing });
  try {
    // Pause automation before the network request, including while upload is in progress.
    await updateLead(lead.id, {
      aiEnabled: false,
      lastHumanTouchAt: new Date().toISOString(),
      ...(lead.sequenceStatus === "active"
        ? { sequenceStatus: "paused", sequenceStopReason: "human_reply" }
        : {}),
    });
    let media = null,
      result;
    if (attachment) {
      const filename = String(payload.filename || "attachment")
        .replace(/[\r\n]/g, "")
        .slice(0, 200);
      const uploaded = await uploadWhatsAppMedia(req.body, {
        mimeType: attachment.mimeType,
        filename,
      });
      media = {
        id: uploaded.id,
        mimeType: attachment.mimeType,
        filename,
        size: req.body.length,
      };
      result = await sendWhatsAppMedia(lead.phone, {
        type: attachment.type,
        media: uploaded.id,
        caption: text,
        filename,
        replyTo: context?.id,
      });
    } else
      result = await sendWhatsAppText(lead.phone, text, {
        replyTo: context?.id,
      });
    const whatsappMessageId = result.messages?.[0]?.id;
    if (!whatsappMessageId)
      throw new Error("WhatsApp did not return a message ID");
    const message = await recordMessage({
      leadId: lead.id,
      phone: lead.phone,
      role: "sales",
      text,
      type: attachment?.type || "text",
      media,
      context,
      whatsappMessageId,
      clientMessageId: key,
      status: "accepted",
    });
    await claim.ref.set(
      { state: "sent", message, updatedAt: new Date().toISOString() },
      { merge: true },
    );
    res.json({ ok: true, message });
  } catch (error) {
    await claim.ref
      .set(
        { state: "unknown", error: String(error.message).slice(0, 500) },
        { merge: true },
      )
      .catch(() => {});
    throw fail(
      "Delivery could not be confirmed. Refresh the chat before sending again. " +
        String(error.message).slice(0, 250),
      502,
    );
  }
}
chatsRouter.post(
  "/:leadId/send",
  handle(async (req, res) => deliver(req, res)),
);
chatsRouter.post(
  "/:leadId/send-media",
  express.raw({ type: () => true, limit: "16mb" }),
  handle(async (req, res) => {
    if (!Buffer.isBuffer(req.body))
      throw fail("Send the attachment as a binary file");
    const attachment = validateMedia(
      req.headers["content-type"],
      req.body.length,
    );
    await deliver(req, res, attachment);
  }),
);
chatsRouter.post(
  "/:leadId/quotation-archive",
  express.raw({ type: "application/pdf", limit: "16mb" }),
  handle(async (req, res) => {
    const { lead } = await leadFor(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      throw fail("Send the quotation as a PDF file");
    const quotationId = String(req.query.quotationId || "").trim();
    const partyName = String(
      req.query.partyName || lead.companyName || lead.company || lead.name || "",
    ).trim();
    const phone = String(req.query.phone || lead.phone || "").trim();
    const file = await uploadQuotationToDrive(req.body, {
      quotationId,
      partyName,
      phone,
      leadId: lead.id,
    });
    res.json({ ok: true, file });
  }),
);
