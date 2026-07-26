import { COLLECTIONS } from "../config/constants.js";
import { getWhatsAppTemplateRegistry } from "../config/whatsapp-templates.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { ConflictError } from "../utils/errors.js";

export class TemplateRegistryService {
  constructor({ store, whatsappAdapter, businessAccountId, overrides = {}, audit = null }) {
    this.store = store;
    this.whatsappAdapter = whatsappAdapter;
    this.businessAccountId = businessAccountId;
    this.templates = getWhatsAppTemplateRegistry(overrides);
    this.audit = audit;
  }

  listConfigured() {
    return Object.values(this.templates).map(publicTemplate);
  }

  resolve(templateKey, expectedCategory = null) {
    const template = this.templates[templateKey];
    if (!template) throw new ConflictError("Select a server-approved WhatsApp template");
    if (expectedCategory && template.category !== expectedCategory) {
      throw new ConflictError(`${templateKey} is not a ${expectedCategory} template`);
    }
    return template;
  }

  prepare(templateKey, values = {}, expectedCategory = null) {
    const template = this.resolve(templateKey, expectedCategory);
    const normalized = {};
    for (const field of template.variables) {
      const value = String(values[field.key] ?? "").replace(/\s+/g, " ").trim();
      if (!value) throw new ConflictError(`${field.label} is required`);
      if (value.length > 500) throw new ConflictError(`${field.label} is too long`);
      normalized[field.key] = value;
    }
    const parameters = template.variables.map((field) => ({ type: "text", text: normalized[field.key] }));
    return {
      text: template.variables.reduce((body, field, index) => body.replaceAll(`{{${index + 1}}}`, normalized[field.key]), template.body),
      type: "TEMPLATE",
      metadata: {
        templateKey,
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

  async getStatus(orgId, name, language = "en") {
    const record = await this.store.get(COLLECTIONS.templateRegistry, templateDocumentId(orgId, name, language));
    return record?.orgId === orgId ? record : null;
  }

  async assertApproved(orgId, templateOrKey) {
    const template = typeof templateOrKey === "string" ? this.resolve(templateOrKey) : templateOrKey;
    const record = await this.getStatus(orgId, template.name, template.language);
    if (!record) throw new ConflictError(`Sync Meta templates before sending ${template.name}`);
    if (record.status !== "APPROVED") throw new ConflictError(`Meta template ${template.name} is ${record.status || "UNKNOWN"}`);
    return record;
  }

  async list(orgId, options = {}) {
    return this.store.find(COLLECTIONS.templateRegistry, {
      filters: [["orgId", "==", orgId]],
      limit: Math.min(Number(options.limit) || 250, 500),
      cursor: options.cursor
    });
  }

  async syncFromMeta(orgId, actor = {}) {
    if (!this.businessAccountId) throw new ConflictError("META_WHATSAPP_BUSINESS_ACCOUNT_ID is required to sync templates");
    const remoteTemplates = await this.whatsappAdapter.listMessageTemplates({ businessAccountId: this.businessAccountId });
    const syncedAt = now();
    const items = remoteTemplates.map((template) => ({
      id: templateDocumentId(orgId, template.name, template.language),
      data: {
        templateId: String(template.id || ""),
        orgId,
        name: String(template.name || ""),
        language: String(template.language || "en"),
        category: String(template.category || "UNKNOWN").toUpperCase(),
        status: String(template.status || "UNKNOWN").toUpperCase(),
        qualityScore: template.quality_score?.score || template.quality_score || null,
        rejectedReason: template.rejected_reason || null,
        components: Array.isArray(template.components) ? template.components : [],
        lastSyncedAt: syncedAt,
        updatedAt: syncedAt
      }
    }));
    if (items.length) await this.store.batchUpdate(COLLECTIONS.templateRegistry, items);
    if (this.audit) {
      await this.audit.write({
        orgId,
        actorType: actor.userId ? "USER" : "SYSTEM",
        actorId: actor.userId || "SYSTEM",
        action: "META_TEMPLATES_SYNCED",
        entityType: "TEMPLATE_REGISTRY",
        entityId: orgId,
        after: { synced: items.length }
      });
    }
    return { synced: items.length, templates: items.map((item) => ({ id: item.id, ...item.data })) };
  }
}

export function templateDocumentId(orgId, name, language = "en") {
  return sha256(`${orgId}:${String(name).toLowerCase()}:${String(language).toLowerCase()}`);
}

function publicTemplate(template) {
  return {
    key: template.key,
    name: template.name,
    language: template.language,
    category: template.category,
    eventType: template.eventType,
    body: template.body,
    variables: template.variables
  };
}
