import OpenAI from "openai";
import { z } from "zod";
import { aiOutputSchema } from "../validators/schemas.js";
import { SALES_AGENT_PROMPT } from "../prompts/sales-agent.prompt.js";
import { CONVERSATION_SUMMARY_PROMPT } from "../prompts/conversation-summary.prompt.js";
import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";

const ALLOWED_LEAD_FIELDS = new Set([
  "productRequired",
  "quantity",
  "pages",
  "finish",
  "city",
  "interestLevel",
  "remarks"
]);

const ESCALATION_INTENTS = new Set([
  "NEGOTIATION",
  "COMPLAINT",
  "PAYMENT_DISPUTE",
  "DISCOUNT_REQUEST",
  "ORDER_CONFIRMATION",
  "UNUSUAL_REQUEST",
  "HUMAN_REQUEST"
]);

const summarySchema = z.object({
  customer: z.string().nullable(),
  company: z.string().nullable(),
  productInterest: z.array(z.string()),
  pages: z.number().nullable(),
  quantity: z.number().nullable(),
  finish: z.string().nullable(),
  city: z.string().nullable(),
  urgency: z.string().nullable(),
  quotationStatus: z.string().nullable(),
  objections: z.array(z.string()),
  negotiationDetails: z.array(z.string()),
  nextFollowUp: z.string().nullable(),
  pendingQuestions: z.array(z.string()),
  assignedSalesperson: z.string().nullable(),
  importantCommitments: z.array(z.string())
});

export class AiService {
  constructor({ apiKey, model, summaryModel, autoSendEnabled, summaryInterval, store, contacts, conversations, messages, domain, notifications, client }) {
    this.client = client || (apiKey ? new OpenAI({ apiKey }) : null);
    this.model = model;
    this.summaryModel = summaryModel;
    this.autoSendEnabled = autoSendEnabled;
    this.summaryInterval = summaryInterval;
    this.store = store;
    this.contacts = contacts;
    this.conversations = conversations;
    this.messages = messages;
    this.domain = domain;
    this.notifications = notifications;
  }

  async processInbound({ orgId, conversationId, message }) {
    const conversation = await this.conversations.get(orgId, conversationId);
    if (conversation.aiMode === "OFF") return { skipped: true, reason: "AI_OFF" };
    if (conversation.humanTakeover) return { skipped: true, reason: "HUMAN_TAKEOVER" };
    if (!this.client) return { skipped: true, reason: "AI_NOT_CONFIGURED" };

    const [contact, lead, recent] = await Promise.all([
      this.contacts.get(orgId, conversation.contactId),
      conversation.leadId ? this.domain.get("leads", orgId, conversation.leadId) : Promise.resolve(null),
      this.messages.list(orgId, conversationId, { limit: 20, sortOrder: "desc" })
    ]);
    const result = await this.generate({ contact, lead, conversation, recentMessages: recent.items.reverse(), customerMessage: message.text });
    const leadUpdates = Object.fromEntries(
      Object.entries(result.leadUpdates || {}).filter(([key, value]) => ALLOWED_LEAD_FIELDS.has(key) && value !== undefined)
    );
    if (lead && Object.keys(leadUpdates).length) {
      await this.domain.update("leads", orgId, lead.leadId, leadUpdates, {}, "AI_UPDATED");
    }
    const metadata = {
      ai: true,
      intent: result.intent,
      nextAction: result.nextAction,
      needsHuman: result.needsHuman,
      confidence: result.confidence,
      reason: result.reason
    };
    let output;
    const safeAuto =
      conversation.aiMode === "AUTO" &&
      this.autoSendEnabled &&
      !result.needsHuman &&
      !ESCALATION_INTENTS.has(result.intent.toUpperCase()) &&
      result.confidence >= 0.7;
    if (safeAuto) {
      output = await this.messages.queueOutbound({
        orgId,
        conversationId,
        text: result.reply,
        senderType: "AI",
        senderId: "AI",
        metadata,
        idempotencyKey: `AI_REPLY:${message.messageId}`
      });
    } else {
      output = await this.messages.createDraft({
        orgId,
        conversationId,
        text: result.reply,
        metadata,
        sourceMessageId: message.messageId
      });
      if (result.needsHuman || (conversation.aiMode === "AUTO" && !safeAuto)) {
        await this.notifications.create(orgId, {
          type: "AI_HANDOFF",
          severity: result.needsHuman ? "WARNING" : "INFO",
          title: "AI response requires review",
          entityType: "CONVERSATION",
          entityId: conversationId,
          metadata: { intent: result.intent, sourceMessageId: message.messageId }
        });
      }
    }
    await this.maybeSummarize({ orgId, conversation, contact, lead }).catch(() => null);
    return { skipped: false, result, output, mode: safeAuto ? "AUTO_SENT" : "DRAFTED" };
  }

  async generate(context) {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SALES_AGENT_PROMPT },
        { role: "user", content: JSON.stringify(context) }
      ]
    });
    const raw = completion.choices[0]?.message?.content || "{}";
    return aiOutputSchema.parse(JSON.parse(raw));
  }

  async maybeSummarize({ orgId, conversation, contact, lead }) {
    if (!this.client || Number(conversation.messageCount || 0) < this.summaryInterval) return null;
    if (Number(conversation.messageCount || 0) % this.summaryInterval !== 0) return null;
    const recent = await this.messages.list(orgId, conversation.conversationId, { limit: 50, sortOrder: "desc" });
    const completion = await this.client.chat.completions.create({
      model: this.summaryModel,
      response_format: { type: "json_object" },
      temperature: 0.1,
      messages: [
        { role: "system", content: CONVERSATION_SUMMARY_PROMPT },
        { role: "user", content: JSON.stringify({ contact, lead, assignedTo: conversation.assignedTo, messages: recent.items.reverse().map((item) => ({ direction: item.direction, senderType: item.senderType, text: item.text, createdAt: item.createdAt })) }) }
      ]
    });
    const summary = summarySchema.parse(JSON.parse(completion.choices[0]?.message?.content || "{}"));
    await this.store.update(COLLECTIONS.conversations, conversation.conversationId, {
      summary,
      summaryUpdatedAt: now(),
      updatedAt: now()
    });
    return summary;
  }
}
