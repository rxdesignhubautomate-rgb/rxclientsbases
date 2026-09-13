import {
  getMessage,
  claimOutbound,
  messageKey,
  recordMessage,
} from "./chatStore.js";
import { sendStructuredMessage } from "./whatsapp.js";
import { updateLead } from "./leadStore.js";
import { bad, timestamp } from "./chatFeaturesStore.js";
export async function forwardMessages(req, { leadFor, assertCanSend }) {
  const { lead: source } = await leadFor(req),
    targetReq = { ...req, params: { leadId: String(req.body.targetId || "") } };
  const { lead: target } = await leadFor(targetReq),
    ids = req.body.messageIds,
    key = String(req.body.clientMessageId || "");
  if (source.id === target.id || req.body.permission !== true)
    throw bad("Choose a different recipient and confirm sharing permission.");
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10 ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(key)
  )
    throw bad("Select between 1 and 10 messages.");
  assertCanSend(target);
  const messages = [];
  for (const id of ids) {
    const m = await getMessage(String(id));
    if (m?.leadId !== source.id || m.mediaHidden)
      throw bad("A selected message is unavailable.");
    if (
      ![
        "text",
        "template",
        "image",
        "video",
        "audio",
        "document",
        "contacts",
        "location",
      ].includes(m.type)
    )
      throw bad(
        "Select text, photos, video, audio, documents, contacts or locations to forward.",
      );
    if (
      ["image", "video", "audio", "document"].includes(m.type) &&
      !m.media?.id
    )
      throw bad("An attachment has no reusable media ID.");
    messages.push(m);
  }
  let sent = 0,
    failed = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let claim;
    try {
      const fresh = (await leadFor(targetReq)).lead;
      await leadFor(req);
      assertCanSend(fresh);
      const type = m.type === "template" ? "text" : m.type;
      const body =
        type === "text"
          ? { type, text: { body: m.text } }
          : type === "contacts"
            ? { type, contacts: m.contacts }
            : type === "location"
              ? { type, location: m.location }
              : {
                  type,
                  [type]: {
                    id: m.media.id,
                    ...(type !== "audio" && m.text ? { caption: m.text } : {}),
                    ...(type === "document"
                      ? { filename: m.media.filename || "document" }
                      : {}),
                  },
                };
      claim = await claimOutbound(
        target.id,
        `${key}-${i}`,
        messageKey(JSON.stringify({ source: source.id, id: m.id, body })),
      );
      if (claim.existing) {
        sent++;
        continue;
      }
      await updateLead(target.id, {
        aiEnabled: false,
        lastHumanTouchAt: timestamp(),
        ...(fresh.sequenceStatus === "active"
          ? { sequenceStatus: "paused", sequenceStopReason: "human_reply" }
          : {}),
      });
      const result = await sendStructuredMessage(target.phone, body),
        whatsappMessageId = result.messages?.[0]?.id;
      if (!whatsappMessageId) throw new Error("No WhatsApp message ID.");
      await claim.ref.set(
        { state: "accepted", whatsappMessageId },
        { merge: true },
      );
      const message = await recordMessage({
        leadId: target.id,
        phone: target.phone,
        role: "sales",
        type,
        text: m.text,
        media: m.media,
        contacts: m.contacts,
        location: m.location,
        whatsappMessageId,
        clientMessageId: `${key}-${i}`,
        status: "accepted",
      });
      await claim.ref.set({ state: "sent", message }, { merge: true });
      sent++;
    } catch (error) {
      if (claim?.ref)
        await claim.ref
          .set(
            { state: "unknown", error: String(error.message).slice(0, 300) },
            { merge: true },
          )
          .catch(() => {});
      failed = String(error.message).slice(0, 350);
      break;
    }
  }
  return { sent, failed };
}
