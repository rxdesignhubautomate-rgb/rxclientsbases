export const ORG_ID = "RXDH";

export const COLLECTIONS = Object.freeze({
  organizations: "organizations",
  users: "users",
  contacts: "contacts",
  channelIdentities: "channelIdentities",
  channelAccounts: "channelAccounts",
  leads: "leads",
  conversations: "conversations",
  messages: "messages",
  attachments: "attachments",
  quotations: "quotations",
  quotationItems: "quotationItems",
  followUps: "followUps",
  orders: "orders",
  orderItems: "orderItems",
  payments: "payments",
  webhookEvents: "webhookEvents",
  outbox: "outbox",
  deadLetters: "deadLetters",
  notifications: "notifications",
  auditLogs: "auditLogs",
  automationJobs: "automationJobs",
  systemSettings: "systemSettings",
  idempotencyKeys: "idempotencyKeys",
  channelIdentityKeys: "channelIdentityKeys",
  contactPhoneKeys: "contactPhoneKeys",
  openConversationKeys: "openConversationKeys",
  activeLeadKeys: "activeLeadKeys",
  providerMessageKeys: "providerMessageKeys"
});

export const CHANNELS = ["WHATSAPP", "WEBSITE", "EMAIL", "PHONE", "INDIAMART", "MANUAL"];
export const USER_ROLES = [
  "OWNER",
  "ADMIN",
  "SALES_MANAGER",
  "SALES",
  "DESIGNER",
  "PRINTING",
  "BINDING",
  "DISPATCH",
  "ACCOUNTING"
];
export const LEAD_STATUSES = [
  "NEW_LEAD",
  "FIRST_CONTACT",
  "INTERESTED",
  "QUALIFYING",
  "QUOTATION_SENT",
  "FOLLOW_UP_1",
  "FOLLOW_UP_2",
  "FOLLOW_UP_3",
  "ORDER_CONFIRMED",
  "DESIGNING",
  "APPROVAL",
  "PRINTING",
  "BINDING",
  "DISPATCHED",
  "CLOSED_WON",
  "CLOSED_LOST",
  "ON_HOLD"
];
export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "SNOOZED", "CLOSED"];
export const AI_MODES = ["OFF", "ASSIST", "AUTO"];
export const MESSAGE_TYPES = [
  "TEXT",
  "IMAGE",
  "DOCUMENT",
  "AUDIO",
  "VIDEO",
  "LOCATION",
  "CONTACT",
  "TEMPLATE",
  "INTERACTIVE",
  "SYSTEM",
  "NOTE"
];
export const MESSAGE_STATUSES = [
  "RECEIVED",
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "CANCELLED"
];

export const ID_PREFIXES = Object.freeze({
  contact: "CNT",
  channelIdentity: "CHI",
  lead: "LEAD",
  conversation: "CONV",
  message: "MSG",
  quotation: "QUO",
  quotationItem: "QIT",
  followUp: "FUP",
  order: "ORD",
  orderItem: "OIT",
  payment: "PAY",
  attachment: "ATT",
  webhookEvent: "WHE",
  outbox: "OUT",
  deadLetter: "DLQ",
  notification: "NOT",
  auditLog: "AUD",
  automationJob: "JOB",
  user: "USR"
});
