import { COLLECTIONS } from "../config/constants.js";
import { getWhatsAppTemplateRegistry } from "../config/whatsapp-templates.js";
import { sha256 } from "../utils/hashing.js";
import { now } from "../utils/dates.js";
import { AppError, ConflictError } from "../utils/errors.js";

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
    if (!/^\d{8,30}$/.test(String(this.businessAccountId))) {
      throw new ConflictError(
        "META_WHATSAPP_BUSINESS_ACCOUNT_ID must be the numeric WhatsApp Business Account ID (WABA ID), not the Business ID or Phone Number ID"
      );
    }

    let remoteTemplates;
    try {
      remoteTemplates = await this.whatsappAdapter.listMessageTemplates({ businessAccountId: this.businessAccountId });
    } catch (error) {
      throw templateSyncError(error, this.businessAccountId);
    }

    const syncedAt = now();
    const items = [...new Map(remoteTemplates.map((template) => {
      const componentSnapshot = serializeMetaComponents(template.components);
      const item = {
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
          componentCount: componentSnapshot.count,
          componentTypes: componentSnapshot.types,
          componentsJson: componentSnapshot.json,
          lastSyncedAt: syncedAt,
          updatedAt: syncedAt
        }
      };
      return [item.id, item];
    })).values()];

    try {
      if (items.length) await this.store.batchUpdate(COLLECTIONS.templateRegistry, items);
    } catch (error) {
      throw templateStorageError(error);
    }

    const configured = configuredTemplateStatus(this.templates, remoteTemplates);
    const matched = configured.filter((template) => template.matched);
    const approved = matched.filter((template) => template.status === "APPROVED");
    const languageMismatches = configured.filter((template) => !template.matched && template.availableLanguages.length);
    const missing = configured.filter((template) => !template.matched && !template.availableLanguages.length);
    const warnings = [];
    let removed = 0;

    try {
      const existing = await this.store.find(COLLECTIONS.templateRegistry, {
        filters: [["orgId", "==", orgId]],
        limit: 500
      });
      const remoteIds = new Set(items.map((item) => item.id));
      const staleIds = existing.items.filter((item) => !remoteIds.has(item.id)).map((item) => item.id);
      if (staleIds.length) removed = await this.store.batchDelete(COLLECTIONS.templateRegistry, staleIds);
    } catch (error) {
      warnings.push(`Templates were saved, but stale registry cleanup was skipped: ${safeOperationalMessage(error)}.`);
    }

    if (!remoteTemplates.length) {
      warnings.push(
        `Meta returned no templates for WABA ending ${maskBusinessAccountId(this.businessAccountId)}. Confirm that this is the WABA where the templates were approved.`
      );
    }
    if (languageMismatches.length) {
      warnings.push(
        `Template language mismatch: ${languageMismatches.map((template) =>
          `${template.name} expects ${template.language}, but Meta has ${template.availableLanguages.join("/")}`
        ).join("; ")}. Update WHATSAPP_TEMPLATE_OVERRIDES_JSON to use the Meta language code.`
      );
    }
    if (missing.length) {
      warnings.push(
        `Configured templates not found in this WABA: ${missing.map((template) => template.name).join(", ")}.`
      );
    }

    if (this.audit) {
      try {
        await this.audit.write({
          orgId,
          actorType: actor.userId ? "USER" : "SYSTEM",
          actorId: actor.userId || "SYSTEM",
          action: "META_TEMPLATES_SYNCED",
          entityType: "TEMPLATE_REGISTRY",
          entityId: orgId,
          after: {
            synced: items.length,
            removed,
            configuredMatched: matched.length,
            configuredApproved: approved.length
          }
        });
      } catch (error) {
        warnings.push(`Templates were saved, but the sync audit entry could not be written: ${safeOperationalMessage(error)}.`);
      }
    }
    if (!matched.length) {
      const expected = configured.map((template) => `${template.name} [${template.language}]`).join(", ");
      const received = remoteTemplates.length
        ? remoteTemplates.slice(0, 20).map((template) => `${template.name} [${template.language || "en"}]`).join(", ")
        : "none";
      throw new AppError(
        "META_TEMPLATES_NOT_MATCHED",
        `Meta connection worked, but no CRM template matched WABA ending ${maskBusinessAccountId(this.businessAccountId)}. Expected: ${expected}. Meta returned: ${received}. ${warnings.join(" ")}`,
        424,
        {
          wabaIdEnding: maskBusinessAccountId(this.businessAccountId),
          remoteTemplateCount: remoteTemplates.length,
          expectedTemplates: configured.map(({ key, name, language, category }) => ({ key, name, language, category })),
          receivedTemplates: remoteTemplates.slice(0, 20).map((template) => ({
            name: String(template.name || ""),
            language: String(template.language || "en"),
            status: String(template.status || "UNKNOWN").toUpperCase()
          })),
          warnings
        }
      );
    }
    return {
      synced: items.length,
      removed,
      matched: matched.length,
      approved: approved.length,
      missing: configured.length - matched.length,
      wabaIdEnding: maskBusinessAccountId(this.businessAccountId),
      warnings,
      configured,
      templates: items.map((item) => ({ id: item.id, ...item.data }))
    };
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

function configuredTemplateStatus(templates, remoteTemplates) {
  const remote = remoteTemplates.map((template) => ({
    name: String(template.name || ""),
    language: String(template.language || "en"),
    category: String(template.category || "UNKNOWN").toUpperCase(),
    status: String(template.status || "UNKNOWN").toUpperCase()
  }));

  return Object.values(templates).map((template) => {
    const sameName = remote.filter((candidate) => normalize(candidate.name) === normalize(template.name));
    const exact = sameName.find((candidate) => normalize(candidate.language) === normalize(template.language));
    return {
      key: template.key,
      name: template.name,
      language: template.language,
      category: template.category,
      matched: Boolean(exact),
      status: exact?.status || "NOT_SYNCED",
      metaCategory: exact?.category || null,
      availableLanguages: [...new Set(sameName.map((candidate) => candidate.language))].sort()
    };
  });
}

function templateSyncError(error, businessAccountId) {
  const providerCode = String(error?.code || "META_ERROR");
  const providerStatus = Number(error?.status) || 502;
  const errorSubcode = error?.details?.errorSubcode || null;
  const message = String(error?.message || "Unknown Meta API error");
  const waba = maskBusinessAccountId(businessAccountId);
  let safeMessage;

  if (providerCode === "190" || providerStatus === 401) {
    safeMessage =
      "Meta access token is invalid or expired. Create a permanent System User token for this WhatsApp Business Account, update META_ACCESS_TOKEN in Render, and redeploy.";
  } else if (providerStatus === 403 || providerCode === "10" || providerCode === "200") {
    safeMessage =
      "Meta token cannot read templates for this WhatsApp Business Account. Assign the WABA to the System User and grant whatsapp_business_management plus whatsapp_business_messaging, then generate a new token.";
  } else if (providerCode === "100") {
    safeMessage =
      `Meta cannot access WABA ending ${waba}. Verify META_WHATSAPP_BUSINESS_ACCOUNT_ID is the WABA that owns the approved templates—not the Business ID or Phone Number ID—and that the token belongs to it.`;
  } else if (providerStatus === 429 || providerCode === "4" || providerCode === "80004") {
    safeMessage = "Meta rate-limited the template sync. Wait a few minutes and try Sync from Meta again.";
  } else if (providerCode === "META_TIMEOUT" || providerStatus === 504) {
    safeMessage = "Meta did not respond before the sync timed out. Try Sync from Meta again.";
  } else {
    safeMessage = `Meta template sync failed: ${message}`;
  }

  return new AppError("META_TEMPLATE_SYNC_FAILED", safeMessage, 424, {
    providerCode,
    providerStatus,
    errorSubcode,
    type: error?.details?.type || null,
    traceId: error?.details?.traceId || null,
    wabaIdEnding: waba
  });
}

function templateStorageError(error) {
  const code = String(error?.code || "FIRESTORE_ERROR");
  const message = safeOperationalMessage(error);
  let safeMessage;
  if (code === "7" || /permission[-_ ]denied/i.test(message)) {
    safeMessage =
      "Meta templates were fetched, but Firestore denied the registry write. Confirm the Render Firebase service account belongs to this Firebase project and has Firestore access.";
  } else if (code === "9" || /failed[-_ ]precondition|requires an index/i.test(message)) {
    safeMessage = `Meta templates were fetched, but Firestore rejected the registry write: ${message}`;
  } else {
    safeMessage = `Meta templates were fetched, but the CRM could not save them to Firestore: ${message}`;
  }
  return new AppError("TEMPLATE_REGISTRY_SAVE_FAILED", safeMessage, 424, { provider: "FIRESTORE", providerCode: code });
}

function serializeMetaComponents(value) {
  const components = Array.isArray(value) ? value : [];
  let json;
  try {
    json = JSON.stringify(components);
  } catch {
    json = "[]";
  }
  return {
    count: components.length,
    types: [...new Set(components.map((component) => String(component?.type || "UNKNOWN").toUpperCase()))],
    json: json.slice(0, 200_000)
  };
}

function safeOperationalMessage(error) {
  return String(error?.message || error?.code || "unknown operational error")
    .replace(/https?:\/\/\S+/gi, "[link omitted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function maskBusinessAccountId(value) {
  return String(value || "").slice(-4).padStart(4, "*");
}
