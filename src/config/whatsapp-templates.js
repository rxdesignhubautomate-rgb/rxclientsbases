const DEFAULT_TEMPLATES = Object.freeze({
  QUOTATION_READY: utility("quotation_ready_v1", "Your requested quotation {{2}} for {{3}} is ready. Amount: {{4}}. View: {{5}}", [
    "customer_name", "quotation_id", "product", "amount", "quotation_url"
  ]),
  DESIGN_PROOF_READY: utility("design_proof_ready_v1", "Hello {{1}}, the design proof for order {{2}} is ready: {{3}}", [
    "customer_name", "order_id", "proof_url"
  ]),
  DESIGN_APPROVAL_PENDING: utility("design_approval_pending_v1", "Hello {{1}}, approval is pending for the design of order {{2}}. Please review: {{3}}", [
    "customer_name", "order_id", "proof_url"
  ]),
  PAYMENT_RECEIVED: utility("payment_received_v1", "Hello {{1}}, we received payment of {{2}} for order {{3}}. Thank you.", [
    "customer_name", "amount", "order_id"
  ]),
  PAYMENT_DUE: utility("payment_due_v1", "Hello {{1}}, payment of {{2}} is due for confirmed order {{3}}.", [
    "customer_name", "amount", "order_id"
  ]),
  PRINTING_STARTED: utility("printing_started_v1", "Hello {{1}}, printing has started for order {{2}}.", ["customer_name", "order_id"]),
  BINDING_STARTED: utility("binding_started_v1", "Hello {{1}}, binding has started for order {{2}}.", ["customer_name", "order_id"]),
  ORDER_READY: utility("order_ready_v1", "Hello {{1}}, order {{2}} is ready.", ["customer_name", "order_id"]),
  ORDER_DISPATCHED: utility("order_dispatched_v1", "Hello {{1}}, order {{2}} was dispatched via {{3}}. Tracking: {{4}}", [
    "customer_name", "order_id", "courier_name", "tracking_number"
  ]),
  TRACKING_UPDATED: utility("tracking_updated_v1", "Hello {{1}}, tracking for order {{2}} was updated: {{3}}", [
    "customer_name", "order_id", "tracking_details"
  ]),
  DELIVERY_UPDATED: utility("delivery_updated_v1", "Hello {{1}}, delivery for order {{2}} is now {{3}}.", [
    "customer_name", "order_id", "delivery_status"
  ]),
  ORDER_CANCELLED: utility("order_cancelled_v1", "Hello {{1}}, order {{2}} has been cancelled. {{3}}", [
    "customer_name", "order_id", "cancellation_note"
  ]),
  REFUND_UPDATED: utility("refund_updated_v1", "Hello {{1}}, refund status for order {{2}} is {{3}}.", [
    "customer_name", "order_id", "refund_status"
  ]),
  LEAD_REENGAGEMENT: marketing("lead_reengagement_v1", "Hello {{1}}, you previously showed interest in {{2}}. {{3}} Reply STOP to opt out.", [
    "customer_name", "interest", "message_line"
  ]),

  // Backward-compatible keys used by the existing CRM inbox.
  order_confirmation: utility("rx_order_confirmation", "Hello {{1}}, your order {{2}} is confirmed. Order value: {{3}}.", [
    "customer_name", "order_reference", "order_value"
  ], "ORDER_READY"),
  design_ready: utility("rx_design_ready", "Hello {{1}}, the design for order {{2}} is ready for review.", [
    "customer_name", "order_reference"
  ], "DESIGN_PROOF_READY"),
  payment_reminder: utility("rx_payment_reminder", "Hello {{1}}, payment of {{2}} is pending for order {{3}}.", [
    "customer_name", "amount_due", "order_reference"
  ], "PAYMENT_DUE"),
  dispatch_update: utility("rx_dispatch_update", "Hello {{1}}, order {{2}} was dispatched via {{3}}. Tracking/reference: {{4}}.", [
    "customer_name", "order_reference", "courier_name", "tracking_reference"
  ], "ORDER_DISPATCHED"),
  order_delivered: utility("rx_order_delivered", "Hello {{1}}, order {{2}} is marked delivered.", [
    "customer_name", "order_reference"
  ], "DELIVERY_UPDATED"),
  interest_followup: marketing("rx_interest_followup", "Hello {{1}}, you previously showed interest in {{2}}. {{3}} If you would like details, reply to this message. Reply STOP to opt out.", [
    "customer_name", "interest", "message_line"
  ], "LEAD_REENGAGEMENT")
});

/** Returns the server-owned template registry with optional name/language overrides. */
export function getWhatsAppTemplateRegistry(overrides = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_TEMPLATES).map(([key, template]) => {
    const override = overrides[key] || {};
    return [key, Object.freeze({
      ...template,
      key,
      name: String(override.name || template.name),
      language: String(override.language || template.language)
    })];
  })));
}

export function getWhatsAppTemplate(templateKey, overrides = {}) {
  return getWhatsAppTemplateRegistry(overrides)[templateKey] || null;
}

function utility(name, body, variables, eventType = null) {
  return defineTemplate({ name, body, variables, category: "UTILITY", eventType });
}

function marketing(name, body, variables, eventType = null) {
  return defineTemplate({ name, body, variables, category: "MARKETING", eventType });
}

function defineTemplate({ name, body, variables, category, eventType }) {
  return Object.freeze({
    name,
    language: "en",
    category,
    eventType,
    body,
    variables: Object.freeze(variables.map((key) => Object.freeze({ key, label: labelFor(key) })))
  });
}

function labelFor(key) {
  const value = key.replaceAll("_", " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}
