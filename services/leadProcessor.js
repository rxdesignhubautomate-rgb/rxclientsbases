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
import { buildLocalLeadReply } from "./localReplyAgent.js";

export async function processIncomingWhatsAppMessage(incoming) {
  if (isInternalTeamNumber(incoming.from)) {
    return { skipped: true, reason: "internal_team_number" };
  }

  if (await hasMessage(incoming.whatsappMessageId)) {
    return { skipped: true, reason: "duplicate" };
  }

  const lead = await findOrCreateLeadByPhone(incoming.from);
  const isFirstCustomerMessage = Number(lead.messageCount || 0) === 0;

  await saveMessage({
    leadId: lead.id,
    phone: incoming.from,
    role: "user",
    text: incoming.text,
    whatsappMessageId: incoming.whatsappMessageId
  });

  const ruleReply = getRuleReply(incoming.text, lead);
  if (ruleReply) {
    await sendAndSaveReply(lead.id, incoming.from, ruleReply);
    const command = incoming.text.trim().toLowerCase();

    if (["stop", "unsubscribe", "band", "band karo"].includes(command)) {
      await updateLead(lead.id, {
        aiEnabled: false,
        status: "lost",
        optedOut: true,
        sequenceStatus: "stopped",
        sequenceStopReason: "opted_out",
        nextSequenceAt: null,
        broadcastOptOutAt: new Date().toISOString()
      });
    } else if (["start", "subscribe"].includes(command)) {
      await updateLead(lead.id, {
        aiEnabled: true,
        optedOut: false,
        broadcastOptInAt: new Date().toISOString()
      });
    }

    return { skippedAi: true, reply: ruleReply };
  }

  if (isHumanHandling(lead)) {
    if (shouldSendHumanAck(lead)) {
      await sendAndSaveReply(lead.id, incoming.from, humanHandlingAck());
      await updateLead(lead.id, { lastHumanAckAt: new Date().toISOString() });
    }
    return { skippedAi: true, reason: "human_handling" };
  }

  if (!lead.aiEnabled) {
    await updateLead(lead.id, { aiEnabled: true });
    lead.aiEnabled = true;
  }

  const recentMessages = await getRecentMessages(lead.id, 5);
  let aiResult;
  let replySource = "ai";

  if (!config.aiAutoReplyEnabled) {
    replySource = "local_ai_disabled";
    aiResult = buildLocalLeadReply({
      lead,
      recentMessages,
      customerMessage: incoming.text
    });
  } else {
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

      replySource = "local_ai_error";
      aiResult = buildLocalLeadReply({
        lead,
        recentMessages,
        customerMessage: incoming.text
      });
    }
  }

  if (replySource !== "ai") {
    console.warn("local_reply_fallback_used", {
      leadId: lead.id,
      phone: incoming.from,
      reason: replySource
    });
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
  if (replySource !== "ai") {
    scorePatch.nextAction = aiResult.next_action || "Team should follow up if customer needs help.";
  }

  if ((aiResult.temperature === "hot" || aiResult.handoff_required) && !lead.followUpAt) {
    scorePatch.followUpAt = nextDayFollowUpAt();
    scorePatch.followUpReason = replySource === "ai"
      ? "Auto: hot lead - contact within 24h"
      : "Auto: local fallback marked follow-up within 24h";
    scorePatch.reminderStatus = "scheduled";
  }

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
    forceProduct: isFirstCustomerMessage ? "visual_aid" : ""
  });

  return replySource === "ai"
    ? { skippedAi: false, aiResult }
    : { skippedAi: true, reason: replySource, reply: aiResult.reply };
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

async function sendAndSaveReply(leadId, phone, reply) {
  await sendWhatsAppText(phone, reply);
  await saveMessage({
    leadId,
    phone,
    role: "ai",
    text: reply
  });
}
