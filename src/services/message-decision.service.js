import { getWhatsAppTemplate } from "../config/whatsapp-templates.js";
import { toDate } from "../utils/dates.js";
import { normalizePhone } from "../utils/phone.js";

export const MESSAGE_MODES = Object.freeze({
  SERVICE: "SERVICE_MESSAGE",
  UTILITY: "UTILITY_TEMPLATE",
  MARKETING: "MARKETING_TEMPLATE",
  BLOCKED: "DO_NOT_SEND"
});

export const UTILITY_EVENT_REQUIREMENTS = Object.freeze({
  QUOTATION_READY: Object.freeze(["quotationId"]),
  DESIGN_PROOF_READY: Object.freeze(["orderId"]),
  DESIGN_APPROVAL_PENDING: Object.freeze(["orderId"]),
  PAYMENT_RECEIVED: Object.freeze(["orderId"]),
  PAYMENT_DUE: Object.freeze(["orderId"]),
  PRINTING_STARTED: Object.freeze(["orderId"]),
  BINDING_STARTED: Object.freeze(["orderId"]),
  ORDER_READY: Object.freeze(["orderId"]),
  ORDER_DISPATCHED: Object.freeze(["orderId"]),
  TRACKING_UPDATED: Object.freeze(["orderId", "trackingDetails"]),
  DELIVERY_UPDATED: Object.freeze(["orderId"]),
  ORDER_CANCELLED: Object.freeze(["orderId"]),
  REFUND_UPDATED: Object.freeze(["orderId"])
});

const PROMOTIONAL_SIGNALS = /\b(discount|offer|sale|promotion|promo|new product|sample|festival|reactivat|re-engag|upsell|cross[- ]?sell|buy now|special price|limited time|follow[- ]?up)\b/i;

/**
 * Selects a Meta-compliant send mode without making network or database calls.
 * All policy inputs are expected to be server-derived before calling this function.
 */
export function decideMessageType(input = {}) {
  const currentTime = toDate(input.now) || new Date();
  const lead = input.lead || {};
  const phone = input.phone || lead.phone || lead.primaryPhone || lead.mobileNumber;
  const serviceWindow = windowState(
    lead.lastUserMessageAt || lead.lastInboundAt,
    lead.serviceWindowExpiresAt,
    currentTime,
    24
  );
  const freeEntryWindow = explicitWindowState(lead.freeEntryWindowExpiresAt, currentTime);
  const base = {
    serviceWindowOpen: serviceWindow.open,
    freeEntryWindowOpen: freeEntryWindow.open
  };

  if (!normalizePhone(phone)) return blocked("INVALID_PHONE", base);
  if (lead.status === "BLOCKED" || lead.suppressed === true) return blocked("CONTACT_SUPPRESSED", base);
  if (lead.marketingOptOut === true || lead.marketingConsent?.status === "OPTED_OUT") return blocked("CUSTOMER_OPTED_OUT", base);
  if (input.duplicateBlocked === true) return blocked("DUPLICATE_SEND_BLOCKED", base);

  const inspectedContent = [
    input.messageIntent,
    input.textMessage,
    ...Object.values(input.templateData || {}).filter((value) => ["string", "number"].includes(typeof value))
  ].join(" ");
  const promotional = input.isPromotional === true || PROMOTIONAL_SIGNALS.test(inspectedContent);
  const utilityRequirements = UTILITY_EVENT_REQUIREMENTS[input.eventType];
  const isUtilityEvent = Boolean(utilityRequirements);

  if (input.requestedMode === MESSAGE_MODES.UTILITY && isUtilityEvent) {
    const missing = utilityRequirements.filter((field) => !requiredValue(input, field));
    if (missing.length) return blocked(`MISSING_TRANSACTION_DATA:${missing.join(",")}`, base);
    if (input.transactionVerified !== true) return blocked("TRANSACTION_RECORD_NOT_VERIFIED", base);
    const templateKey = utilityTemplateKey(input.templateKey, input.eventType);
    if (!templateKey) return blocked("UTILITY_TEMPLATE_REQUIRED", base);
    return allowed(MESSAGE_MODES.UTILITY, "An agent explicitly selected a verified Utility template", base, templateKey, true);
  }

  if (serviceWindow.open || freeEntryWindow.open) {
    return allowed(MESSAGE_MODES.SERVICE, "A recorded customer-service or free-entry window is open", base, null, false);
  }

  if (promotional) {
    if (!marketingOptedIn(lead)) return blocked("MARKETING_OPT_IN_REQUIRED", base);
    if (input.frequencyLimitReached === true) return blocked("MARKETING_FREQUENCY_LIMIT", base);
    if (input.templateCooldownActive === true) return blocked("MARKETING_TEMPLATE_COOLDOWN", base);
    const templateKey = marketingTemplateKey(input.templateKey, input.eventType);
    if (!templateKey) return blocked("MARKETING_TEMPLATE_REQUIRED", base);
    return allowed(MESSAGE_MODES.MARKETING, "Promotional or re-engagement content requires an approved Marketing template", base, templateKey, true);
  }

  if (isUtilityEvent) {
    const missing = utilityRequirements.filter((field) => !requiredValue(input, field));
    if (missing.length) return blocked(`MISSING_TRANSACTION_DATA:${missing.join(",")}`, base);
    if (input.transactionVerified !== true) return blocked("TRANSACTION_RECORD_NOT_VERIFIED", base);
    const templateKey = utilityTemplateKey(input.templateKey, input.eventType);
    if (!templateKey) return blocked("UTILITY_TEMPLATE_REQUIRED", base);
    return allowed(MESSAGE_MODES.UTILITY, "A verified transaction update requires an approved Utility template outside the service window", base, templateKey, true);
  }

  if (input.requestedByCustomer === true) {
    return blocked("SERVICE_WINDOW_CLOSED", base);
  }
  return blocked("NO_VALID_MESSAGE_TRIGGER", base);
}

function requiredValue(input, field) {
  if (field === "trackingDetails") {
    return input.trackingDetails || input.templateData?.tracking_details || input.templateData?.trackingNumber || input.metadata?.trackingDetails;
  }
  return input[field] || input.templateData?.[field] || input.metadata?.[field];
}

function marketingOptedIn(lead) {
  return lead.marketingOptIn === true || lead.marketingConsent?.status === "OPTED_IN";
}

function utilityTemplateKey(templateKey, eventType) {
  const selected = templateKey || eventType;
  const template = getWhatsAppTemplate(selected);
  return template?.category === "UTILITY" ? selected : null;
}

function marketingTemplateKey(templateKey, eventType) {
  const selected = templateKey || (eventType === "CAMPAIGN_MESSAGE" ? "LEAD_REENGAGEMENT" : eventType);
  const template = getWhatsAppTemplate(selected);
  return template?.category === "MARKETING" ? selected : null;
}

function windowState(lastMessageAt, explicitExpiry, currentTime, hours) {
  const explicit = toDate(explicitExpiry);
  if (explicit) return { open: explicit.getTime() > currentTime.getTime(), expiresAt: explicit };
  const last = toDate(lastMessageAt);
  if (!last) return { open: false, expiresAt: null };
  const expiresAt = new Date(last.getTime() + hours * 60 * 60 * 1000);
  return { open: expiresAt.getTime() > currentTime.getTime(), expiresAt };
}

function explicitWindowState(expiresAt, currentTime) {
  const expiry = toDate(expiresAt);
  return { open: Boolean(expiry && expiry.getTime() > currentTime.getTime()), expiresAt: expiry };
}

function allowed(mode, reason, base, templateKey, requiresTemplate) {
  return { mode, reason, ...base, requiresTemplate, allowed: true, templateKey };
}

function blocked(reason, base) {
  return { mode: MESSAGE_MODES.BLOCKED, reason, ...base, requiresTemplate: false, allowed: false, templateKey: null };
}
