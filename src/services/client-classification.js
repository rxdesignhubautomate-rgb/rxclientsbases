import { parsePhoneNumberFromString, isSupportedCountry } from "libphonenumber-js/max";

export const CLASSIFICATION_VERSION = 1;
export const DIRECTORY_VIEWS = ["all", "existing", "future", "premium", "inactive", "review"];

export function timestampMs(value) {
  if (value == null || value === "") return null;
  const result = typeof value?.toMillis === "function" ? value.toMillis()
    : value instanceof Date ? value.getTime()
      : typeof value === "number" ? value
        : value?._seconds != null ? value._seconds * 1000 : Date.parse(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

// Do not use the legacy India-default normalizer for new review or eligibility.
export function inspectDestination(original, countryCode) {
  if (typeof original !== "string") return { original: original == null ? "" : String(original), e164: null, reason: "PHONE_MUST_BE_TEXT" };
  const text = original.trim();
  if (!text) return { original, e164: null, reason: "MISSING_PHONE" };
  if (/^[=@]|[eE][+-]?\d+$/.test(text) || /[A-Za-z]/.test(text)) {
    return { original, e164: null, reason: "UNSAFE_OR_LOSSY_PHONE" };
  }
  const country = typeof countryCode === "string" && isSupportedCountry(countryCode.toUpperCase()) ? countryCode.toUpperCase() : undefined;
  const international = text.startsWith("+") || text.startsWith("00");
  if (!international && !country) return { original, e164: null, reason: "COUNTRY_REQUIRED" };
  const input = text.startsWith("00") ? `+${text.slice(2)}` : text;
  try {
    const parsed = parsePhoneNumberFromString(input, { defaultCountry: country, extract: false });
    if (!parsed?.isValid()) return { original, e164: null, reason: "INVALID_PHONE" };
    return { original, e164: parsed.number, country: parsed.country || null, reason: null };
  } catch {
    return { original, e164: null, reason: "INVALID_PHONE" };
  }
}

export function relationshipOf(contact) {
  // A proven customer must never be downgraded by a stale imported projection.
  if (contact.crmV1FirstOrderId || contact.relationshipType === "EXISTING_CLIENT") return "customer";
  if (["unclassified", "prospect", "customer"].includes(contact.crmV1Relationship)) return contact.crmV1Relationship;
  return ["PROSPECT", "LEAD"].includes(contact.relationshipType) ? "prospect" : "unclassified";
}

export function activityOf(contact, { nowMs = Date.now(), inactivityDays = 90 } = {}) {
  const last = timestampMs(contact.crmV1LastMeaningfulAtMs);
  if (last == null || last > nowMs) return "unknown";
  return nowMs - last >= inactivityDays * 86400000 ? "inactive" : "active";
}

export function qualifyingOrder(order) {
  return Boolean(order?.orderId && order.contactId && !order.isTest && !order.testMode && !order.isSample
    && !["TEST", "DEMO", "SAMPLE"].includes(String(order.source || "").toUpperCase())
    && ["CONFIRMED", "IN_PROGRESS", "DESIGNING", "APPROVAL", "APPROVED", "PRINTING", "BINDING", "PRODUCTION", "READY_FOR_DISPATCH", "PAYMENT_PENDING", "DISPATCHED", "COMPLETED"].includes(order.status));
}

export function classificationProjection(contact) {
  const relationship = relationshipOf(contact);
  const phone = inspectDestination(contact.primaryPhone, contact.phoneCountryCode);
  return {
    crmV1Version: CLASSIFICATION_VERSION,
    crmV1Revision: Number.isInteger(contact.crmV1Revision) ? contact.crmV1Revision : 0,
    crmV1Relationship: relationship,
    crmV1Tier: ["standard", "premium", "vip"].includes(contact.crmV1Tier) ? contact.crmV1Tier : "standard",
    crmV1LastMeaningfulAtMs: timestampMs(contact.crmV1LastMeaningfulAtMs) ?? -1,
    crmV1LastMarketingAtMs: timestampMs(contact.crmV1LastMarketingAtMs) ?? -1,
    crmV1SearchName: String(contact.companyName || contact.contactPerson || "").normalize("NFKC").trim().toLowerCase().slice(0, 180),
    crmV1NeedsReview: relationship === "unclassified" || !contact.crmV1ReviewedAt || Boolean(phone.reason)
  };
}

export function permissionVisibility(contact) {
  // Legacy status is visible evidence to review, never upgraded to a permission grant.
  const legacy = contact.marketingConsent || {};
  const suppressed = legacy.status === "OPTED_OUT" || contact.marketingOptOut === true || contact.optInStatus === "OPTED_OUT" || contact.doNotMarket === true || contact.stopAllCommunications === true;
  return {
    channel: "WHATSAPP", purpose: "marketing", state: suppressed ? "suppressed" : "unknown",
    eligible: false, reason: suppressed ? "SUPPRESSED" : "DESTINATION_EVIDENCE_REVIEW_REQUIRED",
    legacyStatus: legacy.status || "UNKNOWN", source: legacy.source || null,
    recordedAt: timestampMs(legacy.recordedAt || legacy.updatedAt || legacy.optedInAt || legacy.optedOutAt),
    sendingAvailable: false
  };
}
