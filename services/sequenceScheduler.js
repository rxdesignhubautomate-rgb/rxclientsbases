import { config } from "../config.js";
import {
  advanceLeadSequence,
  listActiveSequenceLeads,
  saveMessage,
  startLeadSequence
} from "./leadStore.js";
import {
  addHours,
  detectSequenceProduct,
  getProductSequence,
} from "./productVideoSequences.js";
import { getVisualAidSequenceConfig } from "./sequenceVideoStore.js";
import { sendWhatsAppImage, sendWhatsAppText, sendWhatsAppVideo } from "./whatsapp.js";

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
let schedulerHandle = null;
let schedulerRunning = false;

export async function startSequenceIfNeeded({ lead, customerMessage = "", aiResult = null, forceProduct = "" } = {}) {
  if (!lead?.id || !lead?.phone) return { started: false, reason: "missing_lead" };
  if (lead.optedOut === true) return { started: false, reason: "opted_out" };
  if (["converted", "lost"].includes(lead.status || "")) {
    return { started: false, reason: "closed_lead" };
  }

  const product = forceProduct || detectSequenceProduct({
    text: customerMessage,
    requirement: aiResult?.fields?.requirement || lead.requirement || ""
  });

  if (!product) return { started: false, reason: "no_sequence_product" };

  if (lead.sequenceStatus === "active" && lead.activeSequenceProduct === product) {
    return { started: false, reason: "already_active" };
  }

  const sequence = await getSequence(product);
  const firstStep = sequence?.steps?.[0];

  if (!sequence || !firstStep) {
    return { started: false, reason: "sequence_not_configured" };
  }

  const startedAt = new Date().toISOString();

  await startLeadSequence(lead.id, {
    activeSequenceProduct: product,
    sequenceStartedAt: startedAt,
    sequenceStepIndex: 0,
    nextSequenceAt: addHours(startedAt, firstStep.delayHours),
    sequenceStopReason: null
  });

  return { started: true, product };
}

export function startSequenceScheduler() {
  if (!config.sequenceSchedulerEnabled || schedulerHandle) return;

  schedulerHandle = setInterval(() => {
    runDueSequences().catch((error) => {
      console.error("sequence_scheduler_failed", { error: error.message });
    });
  }, config.sequenceCheckIntervalMs);

  runDueSequences().catch((error) => {
    console.error("sequence_scheduler_start_failed", { error: error.message });
  });
}

export async function runDueSequences() {
  if (schedulerRunning) return { skipped: true, reason: "already_running" };
  schedulerRunning = true;

  try {
    const now = new Date();
    const activeLeads = await listActiveSequenceLeads(100);
    let processed = 0;

    for (const lead of activeLeads) {
      if (!isDue(lead.nextSequenceAt, now)) continue;
      await processLeadSequence(lead, now);
      processed++;
    }

    return { processed };
  } finally {
    schedulerRunning = false;
  }
}

async function processLeadSequence(lead, now) {
  if (lead.optedOut === true) return stopSequence(lead, "opted_out");
  if (["converted", "lost"].includes(lead.status || "")) return stopSequence(lead, "closed_lead");
  if (!isInsideCustomerServiceWindow(lead, now)) return stopSequence(lead, "customer_service_window_expired");

  const product = lead.activeSequenceProduct;
  const stepIndex = Number(lead.sequenceStepIndex) || 0;
  const sequence = await getSequence(product);
  const step = sequence?.steps?.[stepIndex] || null;

  if (!step) return stopSequence(lead, "sequence_completed", true);

  try {
    if (step.type === "video") {
      await sendWhatsAppVideo(lead.phone, {
        media: step.media,
        caption: step.caption
      });
      await saveSequenceMessage(lead, `Video: ${step.caption || "Product sample video"}`);
    } else if (step.type === "image") {
      await sendWhatsAppImage(lead.phone, {
        media: step.media,
        caption: step.caption
      });
      await saveSequenceMessage(lead, `Image: ${step.caption || "Product sample image"}`);
    } else {
      await sendWhatsAppText(lead.phone, step.text);
      await saveSequenceMessage(lead, step.text);
    }
  } catch (error) {
    console.error("sequence_step_send_failed", {
      leadId: lead.id,
      phone: lead.phone,
      product,
      stepIndex,
      error: error.message
    });

    return advanceLeadSequence(lead.id, {
      sequenceStatus: "active",
      sequenceStopReason: `send_failed: ${error.message}`.slice(0, 300),
      nextSequenceAt: addMinutes(new Date().toISOString(), 30)
    });
  }

  const nextStep = sequence?.steps?.[stepIndex + 1] || null;
  if (!nextStep) return stopSequence(lead, "sequence_completed", true);

  return advanceLeadSequence(lead.id, {
    sequenceStatus: "active",
    sequenceStepIndex: stepIndex + 1,
    lastSequenceSentAt: new Date().toISOString(),
    nextSequenceAt: addHours(lead.sequenceStartedAt || new Date().toISOString(), nextStep.delayHours),
    sequenceStopReason: null
  });
}

async function saveSequenceMessage(lead, text) {
  await saveMessage({
    leadId: lead.id,
    phone: lead.phone,
    role: "sequence",
    text
  });
}

function stopSequence(lead, reason, completed = false) {
  return advanceLeadSequence(lead.id, {
    sequenceStatus: completed ? "completed" : "stopped",
    sequenceStopReason: reason,
    nextSequenceAt: null
  });
}

function isDue(value, now) {
  if (!value) return false;
  const dueAt = new Date(value);
  if (Number.isNaN(dueAt.getTime())) return false;
  return dueAt.getTime() <= now.getTime();
}

function isInsideCustomerServiceWindow(lead, now) {
  const lastInbound = new Date(lead.lastInboundAt || lead.sequenceStartedAt || lead.createdAt || 0);
  if (Number.isNaN(lastInbound.getTime())) return false;
  return now.getTime() - lastInbound.getTime() < CUSTOMER_SERVICE_WINDOW_MS;
}

async function getSequence(product) {
  if (product === "visual_aid") {
    const sequenceConfig = await getVisualAidSequenceConfig(config.visualAidSequenceVideos);
    return getProductSequence(product, sequenceConfig.videos, sequenceConfig.captions);
  }

  return getProductSequence(product);
}

function addMinutes(dateValue, minutes) {
  return new Date(new Date(dateValue).getTime() + Number(minutes || 0) * 60 * 1000).toISOString();
}