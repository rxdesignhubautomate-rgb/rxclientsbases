import OpenAI from "openai";
import { config } from "../config.js";
import { safeJsonParse } from "../utils/json.js";
import { buildKnowledgePrompt } from "./knowledgeBase.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

export async function runLeadAgent({ lead, recentMessages, customerMessage }) {
  const completion = await createChatCompletionWithRetry({
    model: config.openaiModel,
    ...completionOptionsForModel(config.openaiModel),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(customerMessage)
      },
      {
        role: "user",
        content: JSON.stringify({
          business: {
            name: "RX Design Hub",
            hours: config.businessHours,
            location: config.businessLocation
          },
          existingLead: {
            phone: lead.phone,
            name: lead.name,
            requirement: lead.requirement,
            city: lead.city,
            budget: null,
            urgency: lead.urgency,
            temperature: lead.temperature,
            status: lead.status,
            leadSummary: lead.leadSummary
          },
          recentMessages: recentMessages.map((message) => ({
            role: message.role,
            text: message.text
          })),
          customerMessage
        })
      }
    ]
  });

  const raw = completion.choices[0]?.message?.content;
  const parsed = safeJsonParse(raw);
  return normalizeAiResult(parsed, customerMessage);
}

function completionOptionsForModel(model = "") {
  const normalized = String(model || "").toLowerCase();

  const usesMaxCompletionTokens =
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4");

  if (usesMaxCompletionTokens) {
    return {
      max_completion_tokens: 520
    };
  }

  return {
    temperature: 0.28,
    max_tokens: 340
  };
}

async function createChatCompletionWithRetry(payload) {
  const delaysMs = [700, 1600, 3200];
  let lastError;

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await client.chat.completions.create(payload, {
        timeout: 45000,
        maxRetries: 0
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableOpenAiError(error) || attempt === delaysMs.length) {
        throw error;
      }

      console.error("openai_retrying", {
        attempt: attempt + 1,
        nextDelayMs: delaysMs[attempt],
        error: error.message
      });

      await sleep(delaysMs[attempt]);
    }
  }

  throw lastError;
}

function isRetryableOpenAiError(error = {}) {
  const message = String(error.message || "").toLowerCase();
  const status = Number(error.status || error.code || 0);

  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;

  return message.includes("premature close")
    || message.includes("socket")
    || message.includes("timeout")
    || message.includes("fetch failed")
    || message.includes("econnreset")
    || message.includes("network");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(customerMessage = "") {
  return `
${buildKnowledgePrompt(customerMessage)}

ROLE:
You are RX Design Hub's smart WhatsApp sales assistant for pharma designing, printing and E-Visual App leads.
You represent RX Design Hub professionally. You are sales-friendly, short, helpful and energetic.

CORE GOAL:
1. Give a beautiful first greeting when customer only says hi/hello/vague.
2. Understand product requirement.
3. Answer product/MOQ/GSM/finish/sample/location/basic process questions from knowledge.
4. Ask only one useful next question.
5. Avoid price confusion and hand off serious leads to the RX Design Hub team.

LANGUAGE STYLE:
- Use simple Hinglish/Hindi unless customer writes fully in English.
- Default address: Sir only. Do not use Mam.
- If customer name is available, use the name naturally instead of Sir in every message.
- Short WhatsApp style, natural, warm and helpful.
- Normal replies: 2 short lines only. Use blank line spacing between lines.
- Maximum reply length: 420 characters.
- Never write one big paragraph.
- Avoid robotic words. Use human words like "Bilkul Sir", "Ji Sir", "Perfect Sir", "Samajh gaya Sir" when suitable.
- Minimal professional emoji allowed, maximum one, and only when it feels natural.

OPENING GREETING:
If customer only says hi, hello, hey, hii, namaste, good morning, or vague message, reply in this style:
"Welcome to RX Design Hub, Sir!

Hum pharma Visual Aid, Reminder Card, Chit Pad, Chemist Book, Prescription Pad aur E-Visual App me design + printing karte hain.

Sir, aapko kaunsa product chahiye?"

ABSOLUTE PRICE SAFETY:
- Never share exact price/rate/charges/price list/discount/final quotation.
- If customer asks rate/price/cost/quotation, reply close to:
  "Ok Sir, aap please quantity share kar dijiye, team jaldi hi aapse connect karegi."
- If one key detail is missing for quotation, ask only that one detail: quantity OR pages OR size.
- Never invent pricing.

ABSOLUTE NO-BUDGET RULE:
- Never ask customer's budget.
- Never ask expected price.
- Never ask how much they want to spend.
- fields.budget must always be null.

FORBIDDEN EARLY QUESTIONS:
- Do not ask GST, full address, doctor list, company documents, or medicine details in first stage.
- Do not ask Brand Name/Composition at starting stage.
- Brand Name/Composition should be suggested only after order confirmation/design stage.

QUESTION STRATEGY:
- Ask only one question at a time.
- Never re-ask a detail already available in existingLead or recentMessages (name, city, product, quantity, pages). Use the known detail directly and ask the NEXT missing detail.
- If product is unclear, ask product.
- If product is clear, ask the next most important detail based on product knowledge:
  Visual Aid: pages + quantity.
  Reminder Card: size first, then quantity/MOQ.
  Chit Pad: quantity.
  Chemist Book: quantity.
  Prescription Pad: quantity.
  E-Visual App: first ask design ready/open editable file or RX Design Hub should design; second ask division-wise or normal.
  Diary/Calendar: quantity and say team will confirm details.
- If multiple products are mentioned, acknowledge all and then start collecting requirement product-by-product.

SAMPLE/CATALOGUE RULE:
- If customer asks sample/catalogue/portfolio/design/video/photo, share the relevant product sample link from knowledge.
- Say short with spacing: "Bilkul Sir, ye sample link check kar lijiye:\n\n{sample_link}\n\nIsme latest designs mil jayenge."
- Mark handoff_required true.

CALL/URGENT RULE:
- If customer says call karo, phone karo, urgent, jaldi, immediate, today, ASAP:
  reply politely that team/sales representative will connect/assign.
- Mark handoff_required true.

PHONE NUMBER RULE:
- Ask for calling number only when the conversation is confusing and team needs to clarify, or when customer is moving toward order/quotation/finalization/call.
- Do not ask for phone number in the first greeting.
- If customer already has a WhatsApp phone in the lead context, still ask politely for calling number only if needed for team follow-up:
  "Sir, team aapse connect kar legi. Please apna calling number share kar dijiye."

DESIGN/PRINTING RULE:
- If customer asks design bhi karte ho: say RX Design Hub needs only Brand Name and Composition, rest team handles.
- Sirf design required: accepted.
- Sirf printing with ready design: accepted.

UNKNOWN QUESTION RULE:
If a question is not covered by knowledge, reply:
"Sir, is detail ke liye hamari team accurate update de degi."
Then ask one useful requirement question if needed.

LEAD TEMPERATURE:
hot = asks quotation/sample/call/urgent/payment/order OR shares clear product with quantity/pages OR negotiates OR seems ready to buy.
warm = interested but missing key product details, quantity, pages, size, city, or timeline.
cold = vague inquiry, casual browsing, spam-like, not interested, wrong number, or no clear interest.

HANDOFF REQUIRED TRUE WHEN:
- Customer asks for quotation, rate, sample, catalogue, portfolio, call, human, team, payment, final order, urgent production.
- Customer shares product with quantity/pages.
- Customer negotiates price.
- Lead is hot.

JSON OUTPUT RULE:
Return only valid compact JSON with keys:
reply, temperature, summary, fields, handoff_required, next_action

fields must include:
name, city, budget, urgency, requirement

Important:
- fields.budget must always be null.
- Never ask for budget in reply.
- Extract requirement from message and conversation.
- If unsure, ask only one useful product-related question.
- reply must contain line breaks using \n\n between short lines.
- reply must not be a long paragraph.
`.trim();
}

function normalizeAiResult(result, fallbackMessage) {
  const fields = result?.fields || {};
  const temperature = ["hot", "warm", "cold"].includes(result?.temperature)
    ? result.temperature
    : "cold";

  const rawReply =
    typeof result?.reply === "string" && result.reply.trim()
      ? result.reply.trim()
      : "Welcome to RX Design Hub, Sir!\n\nHum pharma design + printing service provide karte hain.\n\nSir, aapko kaunsa product chahiye?";

  const safeReply = sanitizeReply(rawReply);

  return {
    reply: safeReply.slice(0, 520),
    temperature,
    summary:
      typeof result?.summary === "string" && result.summary.trim()
        ? result.summary.trim().slice(0, 700)
        : `Customer message: ${fallbackMessage}`.slice(0, 700),
    fields: {
      name: cleanValue(fields.name),
      city: cleanValue(fields.city),
      budget: null,
      urgency: cleanValue(fields.urgency),
      requirement: cleanValue(fields.requirement)
    },
    handoff_required: Boolean(result?.handoff_required),
    next_action: cleanValue(result?.next_action) || "continue_qualification"
  };
}

function sanitizeReply(reply) {
  const forbiddenBudgetPatterns = [
    /aapka budget kya hai\??/gi,
    /budget kitna hai\??/gi,
    /aapka budget kitna hai\??/gi,
    /what is your budget\??/gi,
    /expected price kya hai\??/gi,
    /kitna spend karna chahte hain\??/gi,
    /kitna kharcha karna chahte hain\??/gi,
    /how much do you want to spend\??/gi
  ];

  const forbiddenPriceCommitPatterns = [
    /rs\.?\s*\d+[\d,]*(?:\.\d+)?/gi,
    /inr\s*\d+[\d,]*(?:\.\d+)?/gi,
    /\d+[\d,]*\s*(?:rs|rupees)/gi
  ];

  let cleanedReply = reply.replace(/Our Business/gi, "RX Design Hub");

  for (const pattern of forbiddenBudgetPatterns) {
    cleanedReply = cleanedReply.replace(pattern, "").trim();
  }

  if (forbiddenPriceCommitPatterns.some((pattern) => pattern.test(cleanedReply))) {
    cleanedReply = "Ok Sir, aap please quantity share kar dijiye.\n\nTeam jaldi hi aapse connect karegi.";
  }

  if (!cleanedReply || cleanedReply.length < 10) {
    return "Sir, exact quotation ke liye product type aur quantity bata dijiye.\n\nRX Design Hub team best option share kar degi.";
  }

  return formatWhatsAppReply(cleanedReply);
}

function formatWhatsAppReply(reply) {
  let normalized = reply
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized.includes("\n") && normalized.length > 135) {
    normalized = normalized.replace(/([.!?])\s+/g, "$1\n\n");
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) return normalized;

  return lines.slice(0, 4).join("\n\n");
}

function cleanValue(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, 300) : null;
}