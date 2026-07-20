const BUYING_SIGNAL_PATTERNS = [
  /kitne\s*ka/i,
  /kitna\s*(?:padega|hoga|lagega|charge)/i,
  /\b(?:rate|price|cost|quotation|quote)\b/i,
  /kya\s*rate/i,
  /\b(?:urgent|jaldi|asap|immediately)\b/i,
  /aaj\s*hi/i,
  /abhi\s*chahiye/i,
  /\border\s*(?:karna|dena|confirm|final)/i,
  /\b(?:payment|advance|paise)\b/i,
  /\bsample\b/i,
  /call\s*(?:kar|karo|kijiye|karna)/i,
  /baat\s*(?:karni|karna|karwao)/i,
  /\bfinal\s*(?:kar|karna|price)\b/i,
  /\bdeal\b/i
];

const QUANTITY_PATTERN = /\b\d{2,6}\s*(?:pcs|pieces?|piece|qty|quantity|pad|pads|book|books|card|cards|copies|copy|nos|units?)\b/i;

export function detectBuyingSignal(text = "") {
  const message = String(text || "").trim();
  if (!message) return false;
  return BUYING_SIGNAL_PATTERNS.some((pattern) => pattern.test(message));
}

export function computeLeadScore({ lead = {}, aiResult = {}, customerMessage = "" } = {}) {
  const fields = aiResult.fields || {};
  const temperature = aiResult.temperature || lead.temperature || "cold";

  let score = temperature === "hot" ? 60 : temperature === "warm" ? 35 : 10;

  if (fields.requirement || lead.requirement) score += 10;
  if (fields.urgency || lead.urgency) score += 8;
  if (fields.city || lead.city) score += 4;
  if (fields.name || lead.name) score += 3;
  if (QUANTITY_PATTERN.test(customerMessage)) score += 10;
  if (detectBuyingSignal(customerMessage)) score += 12;
  if (aiResult.handoff_required) score += 8;
  if (Number(lead.messageCount || 0) >= 4) score += 5;

  return Math.max(0, Math.min(100, score));
}

export function scoreLabel(score) {
  const value = Number(score) || 0;
  if (value >= 70) return "🔥 Very High";
  if (value >= 45) return "🌤 Medium";
  return "❄️ Low";
}
