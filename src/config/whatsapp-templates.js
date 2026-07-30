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
  interest_followup: marketing(
    "1_marketing",
    [
      "Hello {{1}} 👋",
      "",
      "Doctors ke saamne apne pharma brands ko professionally present kijiye with premium Visual Aid Designing & Printing by RX Design Hub.",
      "",
      "✅ Scientific content support",
      "✅ Premium doctor-engaging design",
      "✅ Gloss, Matte, Velvet & UV finishing",
      "✅ PAN-India delivery",
      "",
      "Sirf Brand Name aur Composition share kijiye—baaki designing aur visual development hamari team karegi.",
      "",
      "Kya aap latest samples aur pricing dekhna chahenge?",
      "",
      "Reply STOP TO STOP RECEIVING FROM US"
    ].join("\n"),
    ["customer_name"],
    "LEAD_REENGAGEMENT",
    { type: "VIDEO", required: true }
  )
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

function marketing(name, body, variables, eventType = null, header = null) {
  return defineTemplate({ name, body, variables, category: "MARKETING", eventType, header });
}

function defineTemplate({ name, body, variables, category, eventType, header = null }) {
  return Object.freeze({
    name,
    language: "en",
    category,
    eventType,
    body,
    header: header ? Object.freeze(header) : null,
    variables: Object.freeze(variables.map((key) => Object.freeze({ key, label: labelFor(key) })))
  });
}

function labelFor(key) {
  const value = key.replaceAll("_", " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}
