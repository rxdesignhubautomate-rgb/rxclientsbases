import { ConflictError } from "../utils/errors.js";

const TEMPLATES = Object.freeze([
  defineTemplate({
    id: "order_confirmation",
    metaName: "rx_order_confirmation",
    label: "Order confirmed",
    description: "Confirm a placed order and its value.",
    suggestedOrderStatus: "CONFIRMED",
    body: "Hello {{1}}, your order {{2}} is confirmed. Order value: {{3}}. We will update you on its progress.",
    variables: [
      variable("customer_name", "Customer name"),
      variable("order_reference", "Order reference"),
      variable("order_value", "Order value")
    ]
  }),
  defineTemplate({
    id: "design_ready",
    metaName: "rx_design_ready",
    label: "Design ready",
    description: "Ask the customer to review the design for an existing order.",
    suggestedOrderStatus: "DESIGN_READY",
    body: "Hello {{1}}, the design for order {{2}} is ready for your review. Please reply with approval or required changes.",
    variables: [
      variable("customer_name", "Customer name"),
      variable("order_reference", "Order reference")
    ]
  }),
  defineTemplate({
    id: "payment_reminder",
    metaName: "rx_payment_reminder",
    label: "Payment reminder",
    description: "Remind the customer about an amount due on an existing order.",
    body: "Hello {{1}}, payment of {{2}} is pending for order {{3}}. Please share the payment confirmation after payment.",
    variables: [
      variable("customer_name", "Customer name"),
      variable("amount_due", "Amount due"),
      variable("order_reference", "Order reference")
    ]
  }),
  defineTemplate({
    id: "dispatch_update",
    metaName: "rx_dispatch_update",
    label: "Dispatch update",
    description: "Share courier and tracking details for an order.",
    suggestedOrderStatus: "DISPATCHED",
    body: "Hello {{1}}, order {{2}} has been dispatched via {{3}}. Tracking/reference: {{4}}.",
    variables: [
      variable("customer_name", "Customer name"),
      variable("order_reference", "Order reference"),
      variable("courier_name", "Courier name"),
      variable("tracking_reference", "Tracking reference")
    ]
  }),
  defineTemplate({
    id: "order_delivered",
    metaName: "rx_order_delivered",
    label: "Order delivered",
    description: "Confirm delivery and invite order-related support.",
    suggestedOrderStatus: "DELIVERED",
    body: "Hello {{1}}, order {{2}} is marked delivered. Please reply if you need any help with this order.",
    variables: [
      variable("customer_name", "Customer name"),
      variable("order_reference", "Order reference")
    ]
  })
]);

export class UtilityTemplateService {
  list() {
    return TEMPLATES.map(publicTemplate);
  }

  prepare(templateId, values = {}) {
    const template = TEMPLATES.find((item) => item.id === templateId);
    if (!template) throw new ConflictError("Select a supported WhatsApp utility template");
    const normalized = {};
    for (const field of template.variables) {
      const value = String(values[field.key] ?? "").trim();
      if (!value) throw new ConflictError(`${field.label} is required for ${template.label}`);
      if (value.length > 500) throw new ConflictError(`${field.label} is too long`);
      normalized[field.key] = value;
    }
    const parameters = template.variables.map((field) => ({ type: "text", text: normalized[field.key] }));
    return {
      text: renderBody(template.body, template.variables.map((field) => normalized[field.key])),
      type: "TEMPLATE",
      metadata: {
        utilityTemplateId: template.id,
        templateCategory: "UTILITY",
        templateValues: normalized,
        template: {
          name: template.metaName,
          language: { code: template.languageCode },
          components: [{ type: "body", parameters }]
        }
      }
    };
  }
}

function defineTemplate(input) {
  return Object.freeze({ languageCode: "en", category: "UTILITY", ...input });
}

function variable(key, label) {
  return Object.freeze({ key, label });
}

function publicTemplate(template) {
  const { metaName, ...safe } = template;
  return { ...safe, name: metaName };
}

function renderBody(body, values) {
  return values.reduce((result, value, index) => result.replaceAll(`{{${index + 1}}}`, value), body);
}
