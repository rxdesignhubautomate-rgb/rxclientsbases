import { randomUUID } from "node:crypto";
import { getDb } from "../firebase.js";
import { config } from "../config.js";
import { getVisualAidSequenceConfig } from "./sequenceVideoStore.js";
import { getProductSequence } from "./productVideoSequences.js";
import { bad, timestamp } from "./chatFeaturesStore.js";
import { inspectSequenceMedia, sequenceMediaKey } from "./sequenceMedia.js";
import { messageKey } from "./chatStore.js";

export function validateSequenceSteps(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10)
    throw bad("Add between 1 and 10 sequence steps.");
  let previous = -1;
  return value.map((step, index) => {
    const delayHours = Number(step.delayHours),
      type = String(step.type || "text");
    if (
      !Number.isFinite(delayHours) ||
      delayHours <= previous ||
      delayHours < 0.05 ||
      delayHours >= 24
    )
      throw bad("Step times must increase, from 0.05 to less than 24 hours.");
    previous = delayHours;
    if (!["text", "image", "video"].includes(type))
      throw bad("Sequence steps support text, images and video.");
    const text = String(step.text || "").trim(),
      caption = String(step.caption || "").trim(),
      media = String(step.media || "").trim();
    if (type === "text" && (!text || text.length > 4096))
      throw bad(`Enter text for step ${index + 1}, up to 4,096 characters.`);
    if (
      type !== "text" &&
      !/^\d+$/.test(media) &&
      !/^https:\/\/[^\s]+$/i.test(media)
    )
      throw bad(
        `Enter a WhatsApp media ID or HTTPS media link for step ${index + 1}.`,
      );
    if (caption.length > 1024)
      throw bad("Caption must be 1,024 characters or fewer.");
    return { delayHours, type, text, caption, media };
  });
}
export async function defaultSequence() {
  const saved = (
    await getDb().collection("settings").doc("chatSequence").get()
  ).data();
  if (saved?.steps?.length)
    return {
      name: saved.name || "Visual Aid Engagement",
      steps: saved.steps,
      product: "visual_aid",
    };
  const settings = await getVisualAidSequenceConfig(
    config.visualAidSequenceVideos,
  );
  return getProductSequence("visual_aid", settings.videos, settings.captions);
}
export async function sequenceControl(leadId, action, input = {}) {
  const defaultPlan = action === "start" ? await defaultSequence() : null;
  const ref = getDb().collection("leads").doc(leadId);
  let repair = null;
  if (action === "repair_media") {
    const before = (await ref.get()).data();
    const index = Number(before?.sequenceStepIndex) || 0;
    const step = before?.sequencePlan?.[index];
    if (
      before?.sequenceStatus !== "paused" ||
      before.sequenceStopReason !== "invalid_sequence_media" ||
      !["video", "image"].includes(step?.type)
    ) {
      throw bad(
        "Only a paused step with a confirmed media rejection can be repaired.",
        409,
      );
    }
    const media = await inspectSequenceMedia(input.media, step.type);
    if (!media.verified || media.id === String(step.media).trim())
      throw bad(
        "Upload the file again and provide its new, verified WhatsApp media ID.",
      );
    repair = {
      before,
      index,
      media,
      steps: before.sequencePlan.map((value, i) =>
        i === index ? { ...value, media: media.id } : value,
      ),
    };
  }
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw bad("Contact not found.", 404);
    const lead = snap.data(),
      now = Date.now();
    let patch;
    if (action === "repair_media") {
      if (
        lead.sequenceStatus !== "paused" ||
        lead.sequenceStopReason !== "invalid_sequence_media" ||
        lead.sequenceRunId !== repair.before.sequenceRunId ||
        Number(lead.sequenceStepIndex || 0) !== repair.index ||
        Number(lead.sequenceControlVersion || 0) !==
          Number(repair.before.sequenceControlVersion || 0)
      )
        throw bad("The sequence changed. Reload it before repairing.", 409);
      const deliveryRef = getDb()
        .collection("sequenceDeliveries")
        .doc(
          messageKey(
            `${leadId}:${lead.sequenceRunId || lead.sequenceStartedAt}:${repair.index}`,
          ),
        );
      const delivery = (await tx.get(deliveryRef)).data();
      const failureRef = getDb()
        .collection("sequenceMediaFailures")
        .doc(sequenceMediaKey(repair.steps[repair.index]));
      const failure = (await tx.get(failureRef)).data();
      if (delivery?.state !== "rejected" || delivery.whatsappMessageId)
        throw bad(
          "This delivery is not a confirmed rejection. Review it before changing the plan.",
          409,
        );
      if (failure?.blocked)
        throw bad(
          "This replacement media was also rejected. Upload a fresh file.",
          409,
        );
      tx.set(
        deliveryRef,
        {
          state: "cancelled",
          repairedAt: timestamp(),
          replacementMediaId: repair.media.id,
        },
        { merge: true },
      );
      patch = {
        sequencePlan: repair.steps,
        sequenceStatus: "paused",
        sequenceStopReason: "paused_by_agent",
        sequenceError: null,
        sequenceMediaRepairedAt: timestamp(),
      };
    } else if (action === "pause")
      patch = {
        sequenceStatus: "paused",
        sequenceStopReason:
          lead.sequenceStatus === "paused" &&
          (lead.sequenceStopReason === "invalid_sequence_media" ||
            String(lead.sequenceStopReason || "").includes(
              "delivery_uncertain",
            ))
            ? lead.sequenceStopReason
            : "paused_by_agent",
        sequencePausedAt: timestamp(),
      };
    else if (action === "stop")
      patch = {
        sequenceStatus: "stopped",
        nextSequenceAt: null,
        sequenceStopReason: "stopped_by_agent",
      };
    else if (action === "resume" || action === "start") {
      if (
        lead.optedOut ||
        lead.whatsappBlocked ||
        ["lost", "converted"].includes(lead.status)
      )
        throw bad("This contact cannot enter an active sequence.", 409);
      if (
        !Number.isFinite(Date.parse(lead.lastInboundAt)) ||
        now - Date.parse(lead.lastInboundAt) >= 86400000
      )
        throw bad(
          "Wait for a new customer message before starting or resuming this sequence.",
          409,
        );
      if (action === "start") {
        if (lead.sequenceStatus === "active")
          throw bad("Pause or stop the current sequence first.", 409);
        const steps = validateSequenceSteps(input.steps || defaultPlan.steps);
        patch = {
          sequenceRunId: randomUUID(),
          sequencePlan: steps,
          activeSequenceProduct: "visual_aid",
          sequenceStartedAt: timestamp(),
          sequenceStatus: "active",
          sequenceStepIndex: 0,
          sequenceStopReason: null,
          lastSequenceSentAt: null,
          nextSequenceAt: new Date(
            now + steps[0].delayHours * 3600000,
          ).toISOString(),
          aiEnabled: true,
          lastHumanTouchAt: null,
        };
      } else {
        if (lead.sequenceStatus !== "paused")
          throw bad("Only a paused sequence can be resumed.", 409);
        if (lead.sequenceStopReason === "invalid_sequence_media")
          throw bad(
            "Replace the rejected media using repair_media before resuming this step.",
            409,
          );
        if (
          String(lead.sequenceStopReason || "").includes("delivery_uncertain")
        )
          throw bad(
            "A previous delivery needs review. Stop this sequence and create a reviewed plan; it will not retry automatically.",
            409,
          );
        const next = Date.parse(lead.nextSequenceAt);
        if (!Number.isFinite(next))
          throw bad("No pending step. Start a new sequence.");
        patch = {
          sequenceStatus: "active",
          sequenceStopReason: null,
          nextSequenceAt: new Date(Math.max(next, now + 60000)).toISOString(),
          aiEnabled: true,
          lastHumanTouchAt: null,
        };
      }
    } else throw bad("Unknown sequence action.");
    patch.sequenceControlVersion =
      (Number(lead.sequenceControlVersion) || 0) + 1;
    patch.updatedAt = timestamp();
    tx.set(ref, patch, { merge: true });
    return { ...lead, ...patch, id: leadId };
  });
}
