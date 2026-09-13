import { config } from "../config.js";
import { getDb } from "../firebase.js";
import { saveMessage } from "./leadStore.js";
import { detectSequenceProduct } from "./productVideoSequences.js";
import { defaultSequence, sequenceControl } from "./sequenceControls.js";
import {
  sendWhatsAppImage,
  sendWhatsAppText,
  sendWhatsAppVideo,
} from "./whatsapp.js";
import { messageKey } from "./chatStore.js";
import { invalidMediaError, sequenceMediaKey } from "./sequenceMedia.js";
import {
  isFirestoreQuotaError,
  noteFirestoreAvailable,
  noteFirestoreQuotaError,
  quotaStatus,
} from "./firestoreQuota.js";
let timer,
  running = false;
const now = () => new Date().toISOString();
const eligible = (lead) =>
  lead?.sequenceStatus === "active" &&
  !lead.optedOut &&
  !lead.whatsappBlocked &&
  lead.aiEnabled !== false &&
  !["converted", "lost"].includes(lead.status) &&
  !(
    lead.lastHumanTouchAt &&
    Date.now() - Date.parse(lead.lastHumanTouchAt) <
      config.humanTakeoverCoolingHours * 3600000
  );
export async function startSequenceIfNeeded({
  lead,
  customerMessage = "",
  aiResult,
  forceProduct = "",
} = {}) {
  if (!lead?.id) return { started: false, reason: "missing_lead" };
  const fresh = (await getDb().collection("leads").doc(lead.id).get()).data();
  if (
    !fresh ||
    fresh.optedOut ||
    fresh.whatsappBlocked ||
    fresh.aiEnabled === false ||
    ["converted", "lost"].includes(fresh.status)
  )
    return { started: false, reason: "not_eligible" };
  if (
    fresh.sequenceStartedAt ||
    (fresh.sequenceStatus && fresh.sequenceStatus !== "none")
  )
    return { started: false, reason: "already_enrolled" };
  const product =
    forceProduct ||
    detectSequenceProduct({
      text: customerMessage,
      requirement: aiResult?.fields?.requirement || fresh.requirement,
    });
  if (product !== "visual_aid")
    return { started: false, reason: "no_sequence_product" };
  await sequenceControl(lead.id, "start");
  return { started: true, product };
}
export function startSequenceScheduler() {
  if (!config.sequenceSchedulerEnabled || timer) return;
  const run = () =>
    runDueSequences().catch((e) =>
      console.error("sequence_scheduler_failed", { error: e.message }),
    );
  timer = setInterval(run, config.sequenceCheckIntervalMs);
  run();
}
export async function runDueSequences() {
  if (running) return { skipped: true };
  const quota = quotaStatus();
  if (quota.active)
    return {
      skipped: true,
      reason: "firestore_quota_backoff",
      retryAt: quota.retryAt,
    };
  running = true;
  try {
    const snap = await getDb()
      .collection("leads")
      .where("sequenceStatus", "==", "active")
      .where("nextSequenceAt", "<=", now())
      .orderBy("nextSequenceAt")
      .limit(100)
      .get();
    for (const doc of snap.docs)
      try {
        await processLead(doc.id);
      } catch (e) {
        if (isFirestoreQuotaError(e)) throw e;
        console.error("sequence_step_failed", {
          leadId: doc.id,
          error: e.message,
        });
      }
    noteFirestoreAvailable();
    return { processed: snap.docs.length };
  } catch (error) {
    noteFirestoreQuotaError(error);
    throw error;
  } finally {
    running = false;
  }
}
async function processLead(id) {
  const db = getDb(),
    ref = db.collection("leads").doc(id),
    defaults = await defaultSequence();
  const claim = await db.runTransaction(async (tx) => {
    const lead = (await tx.get(ref)).data();
    if (
      !lead ||
      lead.sequenceStatus !== "active" ||
      Date.parse(lead.nextSequenceAt) > Date.now()
    )
      return null;
    if (!eligible(lead)) {
      tx.set(
        ref,
        { sequenceStatus: "paused", sequenceStopReason: "manual_or_closed" },
        { merge: true },
      );
      return null;
    }
    if (
      !Number.isFinite(Date.parse(lead.lastInboundAt)) ||
      Date.now() - Date.parse(lead.lastInboundAt) >= 86400000
    ) {
      tx.set(
        ref,
        {
          sequenceStatus: "stopped",
          nextSequenceAt: null,
          sequenceStopReason: "customer_service_window_expired",
        },
        { merge: true },
      );
      return null;
    }
    const steps = lead.sequencePlan || defaults.steps,
      index = Number(lead.sequenceStepIndex) || 0,
      step = steps[index];
    if (!step) {
      tx.set(
        ref,
        { sequenceStatus: "completed", nextSequenceAt: null },
        { merge: true },
      );
      return null;
    }
    const deliveryRef = db
        .collection("sequenceDeliveries")
        .doc(
          messageKey(
            `${id}:${lead.sequenceRunId || lead.sequenceStartedAt}:${index}`,
          ),
        ),
      old = (await tx.get(deliveryRef)).data();
    if (old && old.state !== "cancelled") {
      if (
        old.state === "pending" &&
        Date.now() - Date.parse(old.createdAt) < 120000
      )
        return null;
      tx.set(
        ref,
        {
          sequenceStatus: "paused",
          sequenceStopReason: "delivery_uncertain_review_required",
        },
        { merge: true },
      );
      return null;
    }
    tx.set(deliveryRef, {
      state: "pending",
      leadId: id,
      index,
      createdAt: now(),
    });
    return {
      lead,
      steps,
      index,
      step,
      deliveryRef,
      version: Number(lead.sequenceControlVersion) || 0,
    };
  });
  if (!claim) return;
  const { lead, steps, index, step, deliveryRef, version } = claim;
  const mediaFailureRef = ["video", "image"].includes(step.type)
    ? db.collection("sequenceMediaFailures").doc(sequenceMediaKey(step))
    : null;
  let acceptedMessageId = null;
  const fresh = (await ref.get()).data();
  if (
    !eligible(fresh) ||
    (Number(fresh.sequenceControlVersion) || 0) !== version
  ) {
    await deliveryRef.set({ state: "cancelled" }, { merge: true });
    return;
  }
  try {
    if (mediaFailureRef && (await mediaFailureRef.get()).data()?.blocked) {
      throw invalidMediaError(
        "This sequence media was already rejected by WhatsApp. Upload a new file and repair the paused step before resuming.",
      );
    }
    const result =
      step.type === "video"
        ? await sendWhatsAppVideo(lead.phone, step)
        : step.type === "image"
          ? await sendWhatsAppImage(lead.phone, step)
          : await sendWhatsAppText(lead.phone, step.text);
    const whatsappMessageId = result.messages?.[0]?.id;
    if (!whatsappMessageId) throw new Error("No WhatsApp message ID.");
    acceptedMessageId = whatsappMessageId;
    // Preserve acceptance before history writes. Uncertain outcomes are never retried automatically.
    await deliveryRef.set(
      { state: "accepted", whatsappMessageId, acceptedAt: now() },
      { merge: true },
    );
    await saveMessage({
      leadId: id,
      phone: lead.phone,
      role: "sequence",
      text: step.text || step.caption || "",
      type: step.type,
      media: step.media
        ? /^https:\/\//i.test(step.media)
          ? { link: step.media }
          : { id: step.media }
        : null,
      whatsappMessageId,
      status: "accepted",
    });
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      tx.set(deliveryRef, { state: "sent" }, { merge: true });
      if (
        current.sequenceRunId !== lead.sequenceRunId ||
        Number(current.sequenceStepIndex || 0) !== index
      )
        return;
      const next = steps[index + 1],
        changed =
          (Number(current.sequenceControlVersion) || 0) !== version ||
          current.sequenceStatus !== "active";
      const patch = { sequenceStepIndex: index + 1, lastSequenceSentAt: now() };
      if (!next)
        Object.assign(patch, {
          nextSequenceAt: null,
          ...(!changed
            ? {
                sequenceStatus: "completed",
                sequenceStopReason: "sequence_completed",
              }
            : {}),
        });
      else if (current.sequenceStatus !== "stopped") {
        const scheduled =
            Date.parse(lead.sequenceStartedAt) + next.delayHours * 3600000,
          gap = Math.max(60000, (next.delayHours - step.delayHours) * 3600000);
        patch.nextSequenceAt = new Date(
          Math.max(scheduled, Date.now() + gap),
        ).toISOString();
      }
      tx.set(ref, patch, { merge: true });
    });
  } catch (error) {
    const rejectedMedia =
      !acceptedMessageId &&
      error.invalidMedia === true &&
      error.deliveryRejected === true;
    if (rejectedMedia && mediaFailureRef) {
      await mediaFailureRef.set(
        {
          blocked: true,
          type: step.type,
          error: String(error.message).slice(0, 400),
          checkedAt: now(),
        },
        { merge: true },
      );
    }
    await deliveryRef
      .set(
        {
          state: rejectedMedia ? "rejected" : "unknown",
          error: String(error.message).slice(0, 400),
        },
        { merge: true },
      )
      .catch(() => {});
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (
        (Number(current.sequenceControlVersion) || 0) === version &&
        current.sequenceStatus === "active"
      )
        tx.set(
          ref,
          {
            sequenceStatus: "paused",
            sequenceStopReason: rejectedMedia
              ? "invalid_sequence_media"
              : "delivery_uncertain_review_required",
            sequenceError: String(error.message).slice(0, 400),
            ...(rejectedMedia && !current.sequencePlan
              ? { sequencePlan: steps }
              : {}),
          },
          { merge: true },
        );
    });
  }
}
