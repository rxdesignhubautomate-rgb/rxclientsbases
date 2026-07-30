const DEFAULT_TEMPLATES = Object.freeze({
  order_confirmation: utility(
    "rx_order_confirmation",
    "Hello {{1}}, your order {{2}} has been confirmed. Order value: {{3}}. We will share the next update here.",
    ["customer_name", "order_reference", "order_value"],
    "ORDER_CONFIRMATION"
  ),
  design_approved: utility(
    "rx_design_approved",
    "Hello {{1}}, the design for order {{2}} has been approved. Production will now proceed as approved.",
    ["customer_name", "order_reference"],
    "DESIGN_APPROVED"
  ),
  ready_to_dispatch: utility(
    "rx_ready_to_dispatch",
    "Hello {{1}}, your order {{2}} is ready to dispatch. Dispatch details will be shared after handover.",
    ["customer_name", "order_reference"],
    "READY_TO_DISPATCH"
  ),
  experience_feedback: utility(
    "rx_experience_feedback",
    "Hello {{1}}, order {{2}} has been completed. Please reply and share your experience with this order.",
    ["customer_name", "order_reference"],
    "EXPERIENCE_FEEDBACK"
  ),
  LEAD_REENGAGEMENT: marketing("lead_reengagement_v1", "Hello {{1}}, you previously showed interest in {{2}}. {{3}} Reply STOP to opt out.", [
    "customer_name", "interest", "message_line"
  ]),
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
