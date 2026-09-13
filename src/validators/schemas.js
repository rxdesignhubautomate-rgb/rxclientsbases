import { z } from "zod";
import {
  AI_MODES,
  CHANNELS,
  CONVERSATION_STATUSES,
  LEAD_STATUSES,
  MESSAGE_TYPES,
  USER_ROLES
} from "../config/constants.js";

const nullableText = z.string().trim().max(1000).nullable().optional();
const id = z.string().trim().min(4).max(80);

export const contactCreateSchema = z.object({
  companyName: z.string().trim().max(200).optional().default(""),
  contactPerson: z.string().trim().max(160).optional().default(""),
  primaryPhone: z.string().trim().max(30).optional(),
  phones: z.array(z.string().trim().max(30)).max(20).optional().default([]),
  emails: z.array(z.string().email()).max(20).optional().default([]),
  city: z.string().trim().max(120).optional().default(""),
  state: z.string().trim().max(120).optional().default(""),
  country: z.string().trim().max(120).optional().default("India"),
  address: z.string().trim().max(1000).optional().default(""),
  gstNumber: z.string().trim().max(30).optional().default(""),
  relationshipType: z.enum(["EXISTING_CLIENT", "PROSPECT", "LEAD", "VENDOR", "OTHER"]).optional().default("PROSPECT"),
  salesPersonName: z.string().trim().max(160).optional().default(""),
  assignedTo: id.nullable().optional(),
  tags: z.array(z.string().trim().max(60)).max(50).optional().default([]),
  notes: z.string().trim().max(5000).optional().default(""),
  source: z.enum(CHANNELS).or(z.string().trim().max(50)).optional().default("MANUAL"),
  status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]).optional().default("ACTIVE")
});

export const contactUpdateSchema = contactCreateSchema.partial().strict();

export const channelIdentitySchema = z.object({
  channel: z.enum(CHANNELS),
  externalUserId: z.string().trim().min(1).max(320),
  channelAccountId: id.nullable().optional(),
  active: z.boolean().optional().default(true),
  verified: z.boolean().optional().default(false)
});

export const channelAccountSchema = z.object({
  channelAccountId: id,
  channel: z.enum(CHANNELS),
  provider: z.string().trim().min(2).max(80),
  displayName: z.string().trim().min(1).max(160),
  displayNumber: z.string().trim().max(40).optional().default(""),
  phoneNumberId: z.string().trim().max(160).optional().default(""),
  businessAccountId: z.string().trim().max(160).optional().default(""),
  status: z.enum(["ACTIVE", "DISABLED"]).optional().default("ACTIVE"),
  sendEnabled: z.boolean().optional().default(true),
  receiveEnabled: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false)
});

export const conversationActionSchema = z.object({
  assignedTo: id.nullable().optional(),
  aiMode: z.enum(AI_MODES).optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  snoozedUntil: z.coerce.date().optional(),
  enabled: z.boolean().optional(),
  note: z.string().trim().min(1).max(5000).optional()
});

export const conversationStartSchema = z.object({
  contactId: id
});

export const marketingConsentSchema = z.object({
  status: z.enum(["OPTED_IN", "OPTED_OUT"]),
  source: z.enum(["WHATSAPP_REPLY", "WEBSITE_FORM", "IN_PERSON", "PHONE", "ORDER_FORM", "OTHER"]),
  note: z.string().trim().max(1000).optional().default("")
});

export const marketingAudienceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  relationshipType: z.enum(["EXISTING_CLIENT", "PROSPECT"]).optional(),
  contactIds: z.array(id).min(1).max(500)
});

export const marketingBatchAudienceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  relationshipType: z.enum(["EXISTING_CLIENT", "PROSPECT"]),
  batchSize: z.number().int().min(1).max(500).optional().default(500),
  onlyOptedIn: z.boolean().optional().default(false)
});

export const marketingCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  audienceId: id,
  interestLabel: z.string().trim().min(2).max(160),
  templateId: z.string().trim().min(2).max(80).default("interest_followup"),
  templateHeaderAttachmentId: id.optional(),
  deliveryMode: z.enum(["AUTO", "OPEN_WINDOW_ONLY"]).optional().default("AUTO"),
  trigger: z.enum(["MANUAL", "CUSTOMER_REPLY"]).optional().default("MANUAL"),
  steps: z.array(z.object({
    delayDays: z.number().int().min(0).max(90),
    delayMinutes: z.number().int().min(0).max(43200).optional(),
    messageLine: z.string().trim().min(2).max(1024),
    messageType: z.enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "AUDIO"]).optional().default("TEXT"),
    attachmentIds: z.array(id).max(1).optional().default([])
  })).min(1).max(5)
}).superRefine((value, context) => {
  value.steps.forEach((step, index) => {
    if (step.messageType !== "TEXT" && step.attachmentIds.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", index, "attachmentIds"],
        message: "A media drip step needs exactly one uploaded file"
      });
    }
    if (step.messageType !== "TEXT" && value.deliveryMode !== "OPEN_WINDOW_ONLY") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryMode"],
        message: "Media drip campaigns must use the 24-hour open-window mode"
      });
    }
  });
});

export const directExistingCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  interestLabel: z.string().trim().min(2).max(160),
  templateId: z.string().trim().min(2).max(80).default("interest_followup"),
  templateHeaderAttachmentId: id.optional(),
  batchSize: z.number().int().min(1).max(500).optional().default(220),
  intervalDays: z.number().int().min(0).max(60).optional().default(1),
  intervalMinutes: z.number().int().min(5).max(240).optional().default(10),
  startAt: z.coerce.date().optional(),
  messageLine: z.string().trim().min(2).max(1024).optional().default("Approved existing-client marketing update"),
  confirmOptIn: z.literal(true)
}).strict();

export const marketingLaunchSchema = z.object({
  startAt: z.coerce.date().optional()
});

export const marketingProspectUpdateSchema = z.object({
  important: z.boolean().optional(),
  assignedTo: id.nullable().optional(),
  repeatMarketing: z.boolean().optional()
}).strict().refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: "Select at least one replied-customer setting to update" }
);

const messageEventType = z.enum([
  "ORDER_CONFIRMATION",
  "DESIGN_APPROVED",
  "READY_TO_DISPATCH",
  "EXPERIENCE_FEEDBACK",
  "LEAD_REENGAGEMENT",
  "CAMPAIGN_MESSAGE",
  "CUSTOMER_REQUEST"
]);

export const smartMessageSchema = z.object({
  leadId: id.optional(),
  contactId: id.optional(),
  conversationId: id.optional(),
  eventType: messageEventType,
  messageIntent: z.string().trim().max(500).optional().default(""),
  isPromotional: z.boolean().optional().default(false),
  requestedByCustomer: z.boolean().optional().default(false),
  orderId: id.optional(),
  quotationId: id.optional(),
  trackingDetails: z.string().trim().max(1000).optional(),
  campaignId: id.optional(),
  templateKey: z.string().trim().min(2).max(100).optional(),
  templateData: z.record(z.unknown()).optional().default({}),
  textMessage: z.string().trim().max(4096).optional(),
  messageType: z.enum(["TEXT", "IMAGE", "DOCUMENT", "AUDIO", "VIDEO", "LOCATION", "CONTACT", "INTERACTIVE", "REACTION"]).optional().default("TEXT"),
  attachmentIds: z.array(id).max(20).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  idempotencyKey: z.string().trim().min(4).max(250).optional()
}).strict().refine((value) => value.leadId || value.contactId, {
  message: "leadId or contactId is required"
});

export const campaignScheduleSchema = z.object({
  startAt: z.coerce.date()
});

const eventBase = {
  leadId: id.optional(),
  contactId: id.optional(),
  customerName: z.string().trim().max(160).optional(),
  metadata: z.record(z.unknown()).optional().default({})
};

export const quotationReadyEventSchema = z.object({
  ...eventBase,
  quotationId: id,
  product: z.string().trim().min(1).max(200),
  quantity: z.union([z.string(), z.number()]).optional(),
  amount: z.union([z.string(), z.number()]),
  quotationUrl: z.string().url()
}).refine((value) => value.leadId || value.contactId, { message: "leadId or contactId is required" });

export const designProofEventSchema = z.object({
  ...eventBase,
  orderId: id,
  proofUrl: z.string().url()
}).refine((value) => value.leadId || value.contactId, { message: "leadId or contactId is required" });

export const designApprovalEventSchema = designProofEventSchema;

export const paymentReceivedEventSchema = z.object({
  ...eventBase,
  orderId: id,
  amount: z.union([z.string(), z.number()])
}).refine((value) => value.leadId || value.contactId, { message: "leadId or contactId is required" });

export const orderDispatchedEventSchema = z.object({
  ...eventBase,
  orderId: id,
  courierName: z.string().trim().min(1).max(160),
  trackingNumber: z.string().trim().min(1).max(160),
  trackingUrl: z.string().url().optional()
}).refine((value) => value.leadId || value.contactId, { message: "leadId or contactId is required" });

export const orderConfirmationEventSchema = z.object({
  ...eventBase,
  orderId: id,
  orderValue: z.union([z.string().trim().min(1).max(100), z.number()]),
  templateKey: z.literal("order_confirmation").optional().default("order_confirmation"),
  templateAttachmentIds: z.array(id).max(1).optional().default([])
}).refine((value) => value.leadId || value.contactId, { message: "leadId or contactId is required" });

export const orderConfirmationBatchSchema = z.object({
  orderIds: z.array(id).min(1).max(50).transform((items) => [...new Set(items)]),
  templateKey: z.literal("order_confirmation").optional().default("order_confirmation"),
  templateAttachmentId: id,
  confirmTransactionalUse: z.literal(true)
}).strict();

export const orderUpdateEventSchema = z.object({
  ...eventBase,
  orderId: id
}).refine((value) => value.leadId || value.contactId, { message: "leadId or contactId is required" });

export const outboundMessageSchema = z.object({
  text: z.string().trim().max(4096).optional(),
  type: z.enum(MESSAGE_TYPES).optional().default("TEXT"),
  attachmentIds: z.array(id).max(20).optional().default([]),
  replyToMessageId: id.nullable().optional(),
  draftMessageId: id.optional(),
  utilityTemplateId: z.string().trim().max(80).optional(),
  templateVariables: z.record(z.string().trim().max(500)).optional().default({}),
  metadata: z.record(z.unknown()).optional().default({})
}).superRefine((value, context) => {
  if (value.type === "TEMPLATE") {
    if (!value.utilityTemplateId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Utility template is required", path: ["utilityTemplateId"] });
    return;
  }
  const structuredPayload = (
    (value.type === "LOCATION" && value.metadata?.location)
    || (value.type === "CONTACT" && value.metadata?.contacts)
    || (value.type === "INTERACTIVE" && value.metadata?.interactive)
    || (value.type === "REACTION" && value.replyToMessageId && value.text)
  );
  if (!value.text && !value.attachmentIds.length && !structuredPayload) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text, attachment, or structured message payload is required" });
  }
});

export const quickReplyCreateSchema = z.object({
  shortcut: z.string().trim().min(2).max(40).regex(/^\/[a-z0-9_-]+$/i, "Shortcut must look like /price"),
  title: z.string().trim().min(2).max(80),
  text: z.string().trim().min(1).max(4096),
  category: z.enum(["GENERAL", "SALES", "SUPPORT", "ORDER", "PAYMENT"]).optional().default("GENERAL"),
  active: z.boolean().optional().default(true)
}).strict();

export const quickReplyUpdateSchema = quickReplyCreateSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one quick-reply field is required" }
);

export const leadSchema = z.object({
  contactId: id,
  conversationId: id.nullable().optional(),
  companyName: z.string().trim().max(200).optional().default(""),
  mobileNumber: z.string().trim().max(30).optional().default(""),
  city: z.string().trim().max(120).optional().default(""),
  leadSource: z.string().trim().max(80).optional().default("MANUAL"),
  productRequired: z.array(z.string().trim().max(80)).max(20).optional().default([]),
  quantity: z.number().int().positive().nullable().optional(),
  pages: z.number().int().positive().nullable().optional(),
  finish: nullableText,
  leadStatus: z.enum(LEAD_STATUSES).optional().default("NEW_LEAD"),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional().default("NORMAL"),
  assignedTo: id.nullable().optional(),
  nextFollowupDate: z.coerce.date().nullable().optional(),
  interestLevel: z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"]).optional().default("UNKNOWN"),
  remarks: z.string().trim().max(5000).optional().default("")
});

export const quotationSchema = z.object({
  contactId: id,
  leadId: id.optional(),
  conversationId: id.optional(),
  assignedTo: id.nullable().optional(),
  validUntil: z.coerce.date().optional(),
  currency: z.string().trim().length(3).optional().default("INR"),
  notes: z.string().trim().max(5000).optional().default(""),
  taxAmount: z.number().min(0).optional().default(0),
  discountAmount: z.number().min(0).optional().default(0),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive(),
    unitPrice: z.number().min(0),
    productCode: z.string().trim().max(80).optional()
  })).min(1).max(100)
});

export const followUpSchema = z.object({
  contactId: id,
  leadId: id.optional(),
  conversationId: id.optional(),
  assignedTo: id.nullable().optional(),
  dueAt: z.coerce.date(),
  type: z.enum(["CALL", "MESSAGE", "EMAIL", "MEETING", "OTHER"]).optional().default("CALL"),
  notes: z.string().trim().max(5000).optional().default("")
});

export const orderSchema = z.object({
  contactId: id,
  leadId: id.optional(),
  quotationId: id.optional(),
  assignedTo: id.nullable().optional(),
  designerAssigned: id.nullable().optional(),
  status: z.string().trim().max(80).optional().default("CONFIRMED"),
  currency: z.string().trim().length(3).optional().default("INR"),
  notes: z.string().trim().max(5000).optional().default(""),
  orderDate: z.coerce.date().nullable().optional(),
  assignedDate: z.coerce.date().nullable().optional(),
  deliveryNote: z.string().trim().max(500).optional().default(""),
  salesPersonName: z.string().trim().max(160).optional().default(""),
  designerName: z.string().trim().max(160).optional().default(""),
  rateText: z.string().trim().max(2000).optional().default(""),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive(),
    unitPrice: z.number().min(0),
    productCode: z.string().trim().max(80).optional()
  })).min(1).max(100)
});

export const orderRegisterImportSchema = z.object({
  sourceName: z.string().trim().max(200).optional().default("order-register"),
  headers: z.array(z.string().max(200)).min(5).max(50),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()])).max(50)).min(1).max(1000)
});

export const userSchema = z.object({
  firebaseUid: z.string().trim().min(3).max(200),
  name: z.string().trim().min(1).max(160),
  email: z.string().email().optional(),
  phone: z.string().trim().max(30).optional(),
  role: z.enum(USER_ROLES),
  active: z.boolean().optional().default(true),
  permissions: z.array(z.string().trim().min(3).max(120)).max(200).optional().default([])
});

export const aiOutputSchema = z.object({
  intent: z.string().trim().min(1).max(80),
  reply: z.string().trim().min(1).max(1500),
  leadUpdates: z.object({
    productRequired: z.array(z.string().trim().max(80)).max(20).optional(),
    quantity: z.number().int().positive().nullable().optional(),
    pages: z.number().int().positive().nullable().optional(),
    finish: z.string().trim().max(100).nullable().optional(),
    city: z.string().trim().max(120).optional(),
    interestLevel: z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"]).optional(),
    remarks: z.string().trim().max(1000).optional()
  }).default({}),
  nextAction: z.string().trim().min(1).max(200),
  needsHuman: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().max(500)
});
