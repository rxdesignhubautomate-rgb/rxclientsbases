import { config } from "../config.js";
import { scoreLabel } from "./leadScoring.js";
import { updateLead } from "./leadStore.js";
import { sendWhatsAppText } from "./whatsapp.js";

export async function maybeSendHotLeadAlert({ lead, aiResult, customerMessage = "", leadScore = 0 } = {}) {
  try {
    if (!config.salesAlertsEnabled || !lead?.id) return { sent: false, reason: "alerts_disabled" };

    const isHot = aiResult?.temperature === "hot";
    const needsHandoff = Boolean(aiResult?.handoff_required);
    if (!isHot && !needsHandoff) return { sent: false, reason: "not_hot" };

    if (isWithinCooldown(lead.lastHotAlertAt)) {
      return { sent: false, reason: "cooldown" };
    }

    const assignee = normalizeAssignee(lead.assignedTo);
    const recipients = alertRecipients(assignee);
    if (!recipients.length) return { sent: false, reason: "no_alert_number" };

    const message = buildHotLeadMessage({ lead, aiResult, customerMessage, leadScore });
    let sent = 0;

    for (const phone of recipients) {
      try {
        await sendWhatsAppText(phone, message);
        sent++;
      } catch (error) {
        console.error("hot_lead_alert_send_failed", {
          leadId: lead.id,
          alertPhone: phone,
          error: error.message
        });
      }
    }

    if (sent > 0) {
      await updateLead(lead.id, { lastHotAlertAt: new Date().toISOString() });
    }

    return { sent: sent > 0, recipients: sent };
  } catch (error) {
    console.error("hot_lead_alert_failed", { leadId: lead?.id, error: error.message });
    return { sent: false, reason: "error" };
  }
}

function normalizeAssignee(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pinky") return "ankit";
  return normalized;
}

function alertRecipients(assignee) {
  const recipients = [];
  const primary = config.alertNumbers[assignee] || "";
  if (primary) recipients.push(primary);

  if (config.alertCopyAdmin && config.alertNumbers.admin && config.alertNumbers.admin !== primary) {
    recipients.push(config.alertNumbers.admin);
  }

  if (!recipients.length && config.alertNumbers.admin) {
    recipients.push(config.alertNumbers.admin);
  }

  return recipients;
}

function isWithinCooldown(lastHotAlertAt) {
  if (!lastHotAlertAt) return false;
  const lastAlert = new Date(lastHotAlertAt);
  if (Number.isNaN(lastAlert.getTime())) return false;
  const cooldownMs = config.hotAlertCooldownMinutes * 60 * 1000;
  return Date.now() - lastAlert.getTime() < cooldownMs;
}

function buildHotLeadMessage({ lead, aiResult, customerMessage, leadScore }) {
  const fields = aiResult?.fields || {};
  const name = fields.name || lead.name || "Unknown";
  const city = fields.city || lead.city || "-";
  const requirement = fields.requirement || lead.requirement || "-";
  const summary = aiResult?.summary || lead.leadSummary || "";
  const lastMessage = String(customerMessage || "").trim().slice(0, 160);

  const lines = [
    "🔥 HOT LEAD ALERT — RX CRM",
    "",
    `👤 ${name} | ${city}`,
    `📱 ${lead.phone}`,
    `📦 ${requirement}`,
    `📊 Score: ${leadScore}/100 (${scoreLabel(leadScore)})`
  ];

  if (summary) {
    lines.push("", `📝 ${summary.slice(0, 220)}`);
  }
  if (lastMessage) {
    lines.push("", `💬 Last msg: "${lastMessage}"`);
  }

  lines.push("", `👉 Reply now: https://wa.me/${lead.phone}`, "", "⏱ 5 minute me contact = best conversion!");

  return lines.join("\n");
}
