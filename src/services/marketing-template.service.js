import { getWhatsAppTemplateRegistry } from "../config/whatsapp-templates.js";
import { ConflictError } from "../utils/errors.js";
import { prepareTemplate } from "./utility-template.service.js";

export class MarketingTemplateService {
  constructor({ overrides = {} } = {}) {
    this.templates = getWhatsAppTemplateRegistry(overrides);
  }

  list() {
    return Object.values(this.templates)
      .filter((template) => template.category === "MARKETING")
      .map((template) => ({
        id: template.key,
        name: template.name,
        languageCode: template.language,
        category: template.category,
        label: template.key === "interest_followup" ? "Interest follow-up" : template.key,
        description: template.body,
        body: template.body,
        variables: template.variables,
        header: template.header
      }));
  }

  prepare(templateId, values = {}) {
    const template = this.templates[templateId];
    if (!template || template.category !== "MARKETING") throw new ConflictError("Select a supported WhatsApp Marketing template");
    return prepareTemplate(template, templateId, values, "marketingTemplateId");
  }
}
