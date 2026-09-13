import { config } from "../config.js";
import { runLeadAgent } from "./aiAgent.js";
import {
  findOrCreateLeadByPhone,
  getRecentMessages,
  hasMessage,
  saveMessage,
  updateLead,
  updateLeadFromAi
} from "./leadStore.js";
import { computeLeadScore, detectBuyingSignal } from "./leadScoring.js";
import { getRuleReply } from "./ruleReplies.js";
import { maybeSendHotLeadAlert } from "./salesAlerts.js";
import { startSequenceIfNeeded } from "./sequenceScheduler.js";
import { sendWhatsAppText } from "./whatsapp.js";

export async function processIncomingWhatsAppMessage(incoming) {
  if (isInternalTeamNumber(incoming.from)) {
    return { skipped: true, reason: "internal_team_number" };
  }

  if (await hasMessage(incoming.whatsappMessageId)) {
    return { skipped: true, reason: "duplicate" };
  }

  const lead = await findOrCreateLeadByPhone(incoming.from);
  const isFirstCustomerMessage = Number(lead.messageCount || 0) === 0;

  const savedInbound = await saveMessage({
    leadId: lead.id,
    phone: incoming.from,
    role: "user",
    text: incoming.text,
    whatsappMessageId: incoming.whatsappMessageId,
    type: incoming.type || "text",
    media: incoming.media,
    context: incoming.context,
    location: incoming.location,
    contacts: incoming.contacts,
    reaction: incoming.reaction,
    order: incoming.order,
    timestamp: incoming.timestamp && Number.isFinite(Number(incoming.timestamp)) && Math.abs(Number(incoming.timestamp)) <= 8640000000000 ? new Date(Math.min(Number(incoming.timestamp) * 1000, Date.now())).toISOString() : undefined
  });
  if (savedInbound.duplicate) return { skipped: true, reason: "duplicate" };
  if (incoming.type && !["text", "interactive", "button"].includes(incoming.type)) return { skippedAi: true, reason: "attachment_saved" };

  const ruleReply = getRuleReply(incoming.text, lead);
  if (ruleReply) {
    const command = incoming.text.trim().toLowerCase();

    if (["stop", "unsubscribe", "band", "band karo"].includes(command)) {
      const optedOutAt = new Date().toISOString();
      await updateLead(lead.id, {
        aiEnabled: false,
        status: "lost",
        lostReason: "Customer replied STOP",
        optedOut: true,
        sequenceStatus: "stopped",
        sequenceStopReason: "opted_out",
        nextSequenceAt: null,
        broadcastOptOutAt: optedOutAt,
        marketingAwaitingReply: false,
        marketingReplyPending: false
      });
    } else if (["start", "subscribe"].includes(command)) {
      const wasLostAfterOptOut =
        lead.status === "lost" && lead.lostReason === "Customer replied STOP";
      await updateLead(lead.id, {
        aiEnabled: true,
        optedOut: false,
        broadcastOptInAt: new Date().toISOString(),
        broadcastOptOutAt: null,
        ...(wasLostAfterOptOut
          ? {
              status: "new",
              lostReason: null,
              sequenceStatus: "none",
              sequenceStopReason: null
            }
          : {})
      });
    }

    await sendAndSaveReply(lead.id, incoming.from, ruleReply);
    return { skippedAi: true, reply: ruleReply };
  }

  if (lead.aiEnabled === false || lead.optedOut === true || lead.whatsappBlocked) return { skippedAi: true, reason: "ai_disabled" };
  if (["converted", "lost"].includes(lead.status)) return { skippedAi: true, reason: "closed_lead" };

  if (isHumanHandling(lead)) {
    if (shouldSendHumanAck(lead)) {
      await sendAndSaveReply(lead.id, incoming.from, humanHandlingAck());
      await updateLead(lead.id, { lastHumanAckAt: new Date().toISOString() });
    }
    return { skippedAi: true, reason: "human_handling" };
  }

  if (!config.aiAutoReplyEnabled) {
    const automatedReply = fallbackContactReply();
    await sendAndSaveReply(lead.id, incoming.from, automatedReply);
    await startSequenceIfNeeded({
      lead,
      customerMessage: incoming.text,
      forceProduct: ""
    });

    return { skippedAi: true, reason: "ai_disabled_fallback_sent", reply: automatedReply };
  }

  const recentMessages = await getRecentMessages(lead.id, 5);
  let aiResult;

  try {
    aiResult = await runLeadAgent({
      lead,
      recentMessages,
      customerMessage: incoming.text
    });
  } catch (error) {
    console.error("ai_reply_failed", {
      leadId: lead.id,
      phone: incoming.from,
      error: error.message
    });

    const fallbackReply = fallbackContactReply();

    const latest = await findOrCreateLeadByPhone(incoming.from);
    if (latest.aiEnabled === false || latest.optedOut || latest.whatsappBlocked || isHumanHandling(latest) || ['converted', 'lost'].includes(latest.status)) return { skippedAi: true, reason: 'human_or_closed_before_fallback' };
    await updateLead(lead.id, {
      status: "follow_up",
      nextAction: "Team should follow up because AI reply failed."
    });

    await sendAndSaveReply(lead.id, incoming.from, fallbackReply);

    await startSequenceIfNeeded({
      lead,
      customerMessage: incoming.text,
      forceProduct: ""
    });

    return { skippedAi: true, reason: "ai_error_fallback_sent", reply: fallbackReply };
  }

  if (detectBuyingSignal(incoming.text) && aiResult.temperature !== "hot") {
    aiResult.temperature = "hot";
    aiResult.handoff_required = true;
  }

  const leadScore = computeLeadScore({
    lead,
    aiResult,
    customerMessage: incoming.text
  });

  const scorePatch = { leadScore };
  if ((aiResult.temperature === "hot" || aiResult.handoff_required) && !lead.followUpAt) {
    scorePatch.followUpAt = nextDayFollowUpAt();
    scorePatch.followUpReason = "Auto: hot lead - contact within 24h";
    scorePatch.reminderStatus = "scheduled";
  }

  const current = await findOrCreateLeadByPhone(incoming.from);
  if (!current.aiEnabled || current.optedOut || isHumanHandling(current) || ["converted", "lost"].includes(current.status)) return { skippedAi: true, reason: "human_or_closed_before_send" };
  await updateLeadFromAi(lead.id, aiResult, lead);
  await updateLead(lead.id, scorePatch);
  await sendAndSaveReply(lead.id, incoming.from, aiResult.reply);

  maybeSendHotLeadAlert({
    lead,
    aiResult,
    customerMessage: incoming.text,
    leadScore
  }).catch((error) => {
    console.error("hot_lead_alert_dispatch_failed", { leadId: lead.id, error: error.message });
  });

  await startSequenceIfNeeded({
    lead,
    customerMessage: incoming.text,
    aiResult,
    forceProduct: ""
  });

  return { skippedAi: false, aiResult };
}

function isHumanHandling(lead) {
  if (!lead.lastHumanTouchAt) return false;
  const touched = new Date(lead.lastHumanTouchAt).getTime();
  if (Number.isNaN(touched)) return false;
  return Date.now() - touched < config.humanTakeoverCoolingHours * 60 * 60 * 1000;
}

function shouldSendHumanAck(lead) {
  if (!lead.lastHumanAckAt) return true;
  const acked = new Date(lead.lastHumanAckAt).getTime();
  if (Number.isNaN(acked)) return true;
  return Date.now() - acked > 6 * 60 * 60 * 1000;
}

function humanHandlingAck() {
  return "Ji Sir, message mil gaya hai.\n\nRX Design Hub team aapke touch me hai aur jaldi hi aapko update de degi.";
}

function nextDayFollowUpAt() {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const tomorrowTenThirtyIst = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate() + 1,
    10,
    30
  ) - IST_OFFSET_MS;
  return new Date(tomorrowTenThirtyIst).toISOString();
}

function isInternalTeamNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return false;
  return Object.values(config.alertNumbers).some((teamNumber) => teamNumber && teamNumber === digits);
}

function fallbackContactReply() {
  return "Sir, message receive ho gaya hai.\n\nRX Design Hub team jaldi hi aapse connect karegi.\n\nAap urgent baat ke liye is number par call kar sakte hain: 9129172980";
}

async function sendAndSaveReply(leadId, phone, reply) {
  const result = await sendWhatsAppText(phone, reply);
  await saveMessage({
    leadId,
    phone,
    role: "ai",
    text: reply,
    whatsappMessageId: result.messages?.[0]?.id || null,
    status: "accepted"
  });
}
