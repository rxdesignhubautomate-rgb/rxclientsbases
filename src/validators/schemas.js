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
  assignedTo: id.optional(),
  aiMode: z.enum(AI_MODES).optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  snoozedUntil: z.coerce.date().optional(),
  enabled: z.boolean().optional(),
  note: z.string().trim().min(1).max(5000).optional()
});

export const outboundMessageSchema = z.object({
  text: z.string().trim().max(4096).optional(),
  type: z.enum(MESSAGE_TYPES).optional().default("TEXT"),
  attachmentIds: z.array(id).max(20).optional().default([]),
  replyToMessageId: id.nullable().optional(),
  draftMessageId: id.optional(),
  metadata: z.record(z.unknown()).optional().default({})
}).refine((value) => value.text || value.attachmentIds.length, "Text or attachment is required");

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
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive(),
    unitPrice: z.number().min(0),
    productCode: z.string().trim().max(80).optional()
  })).min(1).max(100)
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
