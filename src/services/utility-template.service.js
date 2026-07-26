import { getWhatsAppTemplateRegistry } from "../config/whatsapp-templates.js";
import { ConflictError } from "../utils/errors.js";

const LABELS = Object.freeze({
  order_confirmation: "Order confirmed",
  design_ready: "Design ready",
  payment_reminder: "Payment reminder",
  dispatch_update: "Dispatch update",
  order_delivered: "Order delivered"
});

export class UtilityTemplateService {
  constructor({ overrides = {} } = {}) {
    this.templates = getWhatsAppTemplateRegistry(overrides);
  }

  list() {
    return Object.values(this.templates)
      .filter((template) => template.category === "UTILITY")
      .map((template) => ({
        id: template.key,
        name: template.name,
        label: LABELS[template.key] || title(template.key),
        description: template.body,
        body: template.body,
        category: template.category,
        eventType: template.eventType || template.key,
        variables: template.variables
      }));
  }

  prepare(templateId, values = {}) {
    const template = this.templates[templateId];
    if (!template || template.category !== "UTILITY") throw new ConflictError("Select a supported WhatsApp utility template");
    return prepareTemplate(template, templateId, values, "utilityTemplateId");
  }
}

export function prepareTemplate(template, templateId, values, idField = "templateKey") {
  const normalized = {};
  for (const field of template.variables) {
    const value = String(values[field.key] ?? "").replace(/\s+/g, " ").trim();
    if (!value) throw new ConflictError(`${field.label} is required for ${title(templateId)}`);
    if (value.length > 500) throw new ConflictError(`${field.label} is too long`);
    normalized[field.key] = value;
  }
  const parameters = template.variables.map((field) => ({ type: "text", text: normalized[field.key] }));
  return {
    text: template.variables.reduce((body, field, index) => body.replaceAll(`{{${index + 1}}}`, normalized[field.key]), template.body),
    type: "TEMPLATE",
    metadata: {
      [idField]: templateId,
      templateKey: templateId,
      templateCategory: template.category,
      templateValues: normalized,
      template: {
        name: template.name,
        language: { code: template.language },
        components: parameters.length ? [{ type: "body", parameters }] : []
      }
    }
  };
}

function title(value) {
  return String(value).toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
