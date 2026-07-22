import { ConflictError } from "../utils/errors.js";

const TEMPLATES = Object.freeze([
  Object.freeze({
    id: "interest_followup",
    metaName: "rx_interest_followup",
    languageCode: "en",
    category: "MARKETING",
    label: "Interest follow-up",
    description: "Follow up with a customer who opted in after showing interest.",
    body: "Hello {{1}}, you previously showed interest in {{2}}. {{3}} If you would like details or help placing an order, reply to this message. Reply STOP to opt out.",
    variables: Object.freeze([
      Object.freeze({ key: "customer_name", label: "Customer name" }),
      Object.freeze({ key: "interest", label: "Interest" }),
      Object.freeze({ key: "message_line", label: "Campaign message" })
    ])
  })
]);

export class MarketingTemplateService {
  list() {
    return TEMPLATES.map(({ metaName, ...template }) => ({ ...template, name: metaName }));
  }

  prepare(templateId, values = {}) {
    const template = TEMPLATES.find((item) => item.id === templateId);
    if (!template) throw new ConflictError("Select a supported WhatsApp Marketing template");
    const normalized = {};
    for (const field of template.variables) {
      const value = String(values[field.key] ?? "").replace(/\s+/g, " ").trim();
      if (!value) throw new ConflictError(`${field.label} is required for ${template.label}`);
      if (value.length > 500) throw new ConflictError(`${field.label} is too long`);
      normalized[field.key] = value;
    }
    const parameters = template.variables.map((field) => ({ type: "text", text: normalized[field.key] }));
    return {
      text: template.variables.reduce(
        (body, field, index) => body.replaceAll(`{{${index + 1}}}`, normalized[field.key]),
        template.body
      ),
      type: "TEMPLATE",
      metadata: {
        marketingTemplateId: template.id,
        templateCategory: "MARKETING",
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
