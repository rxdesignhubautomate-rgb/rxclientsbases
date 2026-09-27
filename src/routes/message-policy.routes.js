import express from "express";
import { authorizeRole, authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { sendData, sendList } from "../utils/http.js";
import { decodeCursor, listQuery } from "../utils/pagination.js";
import { normalizePhone } from "../utils/phone.js";
import { validateTemplateHeaderMedia } from "../services/template-header-media.js";
import { COLLECTIONS } from "../config/constants.js";
import { ConflictError } from "../utils/errors.js";
import {
  campaignScheduleSchema,
  directExistingCampaignSchema,
  marketingCampaignSchema,
  marketingLaunchSchema,
  orderConfirmationBatchSchema,
  utilityBatchSchema,
  orderConfirmationEventSchema,
  orderUpdateEventSchema,
  smartMessageSchema
} from "../validators/schemas.js";

const UTILITY_BATCH_ACTIVE_ORDER_STATUSES = Object.freeze([
  "CONFIRMED", "IN_DESIGN", "DESIGN_READY", "IN_PRODUCTION", "READY_TO_DISPATCH", "ON_HOLD",
  "ORDER_RECEIVED", "IN_PROGRESS", "DESIGNING", "APPROVAL", "APPROVED", "PRINT_BIND", "PRODUCTION",
  "READY_TO_SHIP", "READY_FOR_DISPATCH", "PAYMENT_PENDING", "PENDING", "PROCESSING", "WORK_STARTED"
]);
const TERMINAL_ORDER_STATUSES = new Set(["CANCELLED", "COMPLETED", "DELIVERED", "DISPATCHED"]);

export function messagePolicyRoutes(container) {
  const router = express.Router();
  router.use(authorizeRole("OWNER", "ADMIN", "SALES"));

  router.post("/message/decide", authorizePermission("messages.send"), validate(smartMessageSchema), wrap(async (req, res) => {
    const evaluated = await container.smartMessages.decide(req.auth.orgId, req.body, req.auth);
    return sendData(res, {
      ...evaluated.decision,
      frequency: evaluated.frequency,
      transactionVerified: evaluated.transactionVerified
    });
  }));
  router.post("/message/smart-send", authorizePermission("messages.send"), validate(smartMessageSchema), wrap(async (req, res) => {
    return sendData(res, await container.smartMessages.smartSend(req.auth.orgId, req.body, req.auth), 202);
  }));

  router.get("/whatsapp/templates", wrap(async (req, res) => {
    return sendList(res, await container.templateRegistry.list(req.auth.orgId, listQuery(req.query)));
  }));
  router.get("/whatsapp/templates/configured", wrap(async (_req, res) => {
    return sendData(res, container.templateRegistry.listConfigured());
  }));
  router.post("/whatsapp/templates/sync", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    return sendData(res, await container.templateRegistry.syncFromMeta(req.auth.orgId, req.auth));
  }));

  router.post("/campaigns", validate(marketingCampaignSchema), wrap(async (req, res) => {
    return sendData(res, await container.marketing.createCampaign(req.auth.orgId, req.body, req.auth), 201);
  }));
  router.get("/campaigns/direct-existing/preview", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    return sendData(res, await container.marketing.previewExistingAudience(req.auth.orgId, { batchSize: req.query.batchSize }));
  }));
  router.post("/campaigns/direct-existing", authorizeRole("OWNER", "ADMIN"), validate(directExistingCampaignSchema), wrap(async (req, res) => {
    return sendData(res, await container.marketing.createDirectExistingCampaigns(req.auth.orgId, req.body, req.auth), 202);
  }));
  router.get("/campaigns", wrap(async (req, res) => {
    return sendList(res, await container.marketing.listCampaigns(req.auth.orgId, { ...listQuery(req.query), status: req.query.status, actor: req.auth }));
  }));
  router.get("/campaigns/:campaignId", wrap(async (req, res) => {
    return sendData(res, await container.marketing.getCampaign(req.auth.orgId, req.params.campaignId, { includeEnrollments: true, actor: req.auth }));
  }));
  router.get("/campaigns/:campaignId/stats", wrap(async (req, res) => {
    const campaign = await container.marketing.getCampaign(req.auth.orgId, req.params.campaignId, { actor: req.auth });
    return sendData(res, { campaignId: campaign.campaignId, status: campaign.status, lifecycleStatus: campaign.lifecycleStatus, stats: campaign.stats || {} });
  }));
  router.post("/campaigns/:campaignId/submit", wrap(async (req, res) => {
    return sendData(res, await container.marketing.submitCampaign(req.auth.orgId, req.params.campaignId, req.auth));
  }));
  router.post("/campaigns/:campaignId/approve", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    return sendData(res, await container.marketing.approveCampaign(req.auth.orgId, req.params.campaignId, req.auth));
  }));
  router.post("/campaigns/:campaignId/schedule", validate(campaignScheduleSchema), wrap(async (req, res) => {
    return sendData(res, await container.marketing.scheduleCampaign(req.auth.orgId, req.params.campaignId, req.body.startAt, req.auth));
  }));
  router.post("/campaigns/:campaignId/start", validate(marketingLaunchSchema), wrap(async (req, res) => {
    return sendData(res, await container.marketing.startCampaign(req.auth.orgId, req.params.campaignId, req.body, req.auth), 202);
  }));
  router.post("/campaigns/:campaignId/pause", wrap(async (req, res) => {
    return sendData(res, await container.marketing.pauseCampaign(req.auth.orgId, req.params.campaignId, req.auth));
  }));
  router.post("/campaigns/:campaignId/resume", wrap(async (req, res) => {
    return sendData(res, await container.marketing.resumeCampaign(req.auth.orgId, req.params.campaignId, req.auth));
  }));
  router.post("/campaigns/:campaignId/cancel", wrap(async (req, res) => {
    return sendData(res, await container.marketing.cancelCampaign(req.auth.orgId, req.params.campaignId, req.auth));
  }));
  router.post("/workers/campaign/run", authorizeRole("OWNER", "ADMIN"), wrap(async (_req, res) => {
    return sendData(res, { processed: await container.marketing.processDue(container.env.CAMPAIGN_BATCH_SIZE) });
  }));

  router.get("/events/order-confirmed/batch/clients", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const result = await container.store.find(COLLECTIONS.contacts, {
      // Keep this endpoint on Firestore's automatic single-field index. The
      // composite contact index may still be building after a new deployment.
      filters: [["orgId", "==", req.auth.orgId]],
      cursor: decodeCursor(req.query.cursor),
      limit
    });
    return sendList(res, {
      ...result,
      items: result.items.filter((contact) => contact.relationshipType === "EXISTING_CLIENT")
    });
  }));

  router.get("/events/order-confirmed/batch/orders", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const result = await container.store.find(COLLECTIONS.orders, {
      // Filtering the page in the API avoids making this screen depend on a
      // separately deployed Firestore composite index.
      filters: [["orgId", "==", req.auth.orgId]],
      cursor: decodeCursor(req.query.cursor),
      limit
    });
    const activeStatuses = new Set(UTILITY_BATCH_ACTIVE_ORDER_STATUSES);
    return sendList(res, {
      ...result,
      items: result.items.filter((order) => activeStatuses.has(String(order.status || "").toUpperCase()))
    });
  }));

  router.get("/events/utility/batch/orders", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const result = await container.store.find(COLLECTIONS.orders, {
      filters: [["orgId", "==", req.auth.orgId]],
      cursor: decodeCursor(req.query.cursor),
      limit
    });
    const activeStatuses = new Set(UTILITY_BATCH_ACTIVE_ORDER_STATUSES);
    return sendList(res, {
      ...result,
      items: result.items.filter((order) => activeStatuses.has(String(order.status || "").toUpperCase()))
    });
  }));

  router.post("/events/utility/batch", authorizeRole("OWNER", "ADMIN"), validate(utilityBatchSchema), wrap(async (req, res) => {
    const { template } = await container.templateRegistry.resolveApprovedUtility(req.auth.orgId, req.body.templateKey);
    const templateAttachmentIds = await validateTemplateHeaderMedia({
      media: container.media,
      orgId: req.auth.orgId,
      contactId: null,
      template,
      attachmentIds: req.body.templateAttachmentId ? [req.body.templateAttachmentId] : [],
      allowSharedUtilityAsset: true
    });
    return sendData(res, await sendUtilityBatch(container, req, template, templateAttachmentIds), 202);
  }));

  router.post("/events/order-confirmed/batch", authorizeRole("OWNER", "ADMIN"), validate(orderConfirmationBatchSchema), wrap(async (req, res) => {
    const template = container.templateRegistry.resolve(req.body.templateKey, "UTILITY");
    await container.templateRegistry.assertApproved(req.auth.orgId, req.body.templateKey);
    const [templateAttachmentId] = await validateTemplateHeaderMedia({
      media: container.media,
      orgId: req.auth.orgId,
      contactId: null,
      template,
      attachmentIds: [req.body.templateAttachmentId],
      allowSharedUtilityAsset: true
    });
    const batchId = `UTILITY_BATCH_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const orders = container.store.getMany
      ? await container.store.getMany(COLLECTIONS.orders, req.body.orderIds)
      : await Promise.all(req.body.orderIds.map((orderId) => container.store.get(COLLECTIONS.orders, orderId)));
    const orderById = new Map(orders.filter(Boolean).map((order) => [order.orderId || order.id, order]));
    const history = await utilityBatchHistory(container.store, req.auth.orgId, req.body.templateKey);
    const seenDestinations = new Set();
    const results = [];

    for (let index = 0; index < req.body.orderIds.length; index += 5) {
      const chunk = req.body.orderIds.slice(index, index + 5);
      const chunkResults = await Promise.all(chunk.map(async (orderId) => {
        try {
          const order = orderById.get(orderId);
          if (!order || order.orgId !== req.auth.orgId) return batchResult(orderId, "SKIPPED", "ORDER_NOT_FOUND");
          if (!order.contactId) return batchResult(orderId, "SKIPPED", "ORDER_HAS_NO_LINKED_CLIENT");
          if (TERMINAL_ORDER_STATUSES.has(String(order.status || "").toUpperCase())) {
            return batchResult(orderId, "SKIPPED", `ORDER_STATUS_${String(order.status).toUpperCase()}`);
          }
          const contact = await container.contacts.get(req.auth.orgId, order.contactId);
          if (contact.relationshipType !== "EXISTING_CLIENT") return batchResult(orderId, "SKIPPED", "NOT_EXISTING_CLIENT", contact);
          const historyReason = history.get(orderId);
          if (historyReason) return batchResult(orderId, "SKIPPED", historyReason, contact);
          if (contact.suppressed === true || contact.status === "BLOCKED" || contact.stopAllCommunications === true) {
            return batchResult(orderId, "SKIPPED", "SUPPRESSED", contact);
          }
          if (contact.marketingOptOut === true || contact.marketingConsent?.status === "OPTED_OUT" || contact.optInStatus === "OPTED_OUT") {
            return batchResult(orderId, "SKIPPED", "OPTED_OUT", contact);
          }
          const destination = normalizePhone(contact.primaryPhone) || `CONTACT:${contact.contactId}`;
          if (seenDestinations.has(destination)) return batchResult(orderId, "SKIPPED", "DUPLICATE_NUMBER", contact);
          seenDestinations.add(destination);
          const sendResult = await container.smartMessages.smartSend(req.auth.orgId, {
            contactId: contact.contactId,
            eventType: "ORDER_CONFIRMATION",
            requestedByCustomer: true,
            requestedMode: "UTILITY_TEMPLATE",
            isPromotional: false,
            orderId,
            templateKey: req.body.templateKey,
            templateAttachmentIds: [templateAttachmentId],
            templateData: {
              customer_name: contact.contactPerson || contact.companyName || "Customer",
              order_reference: order.orderNumber || order.externalOrderId || orderId,
              order_value: formatOrderValue(order)
            },
            metadata: { utilityBatchId: batchId, source: "VERIFIED_ORDER_BATCH" }
          }, req.auth);
          return batchResult(orderId, sendResult.queued ? "QUEUED" : "SKIPPED", sendResult.reason, contact, sendResult.messageId);
        } catch (error) {
          return batchResult(orderId, "FAILED", error.message || "BATCH_SEND_FAILED");
        }
      }));
      results.push(...chunkResults);
    }

    const exclusionCounts = results
      .filter((item) => item.status === "SKIPPED")
      .reduce((counts, item) => ({ ...counts, [item.reason]: (counts[item.reason] || 0) + 1 }), {});
    return sendData(res, {
      batchId,
      requested: req.body.orderIds.length,
      queued: results.filter((item) => item.status === "QUEUED").length,
      skipped: results.filter((item) => item.status === "SKIPPED").length,
      failed: results.filter((item) => item.status === "FAILED").length,
      exclusionCounts,
      results
    }, 202);
  }));
  router.post("/events/order-confirmed", validate(orderConfirmationEventSchema), eventHandler(container, "ORDER_CONFIRMATION", (body) => ({
    customer_name: body.customerName,
    order_reference: body.orderId,
    order_value: String(body.orderValue)
  })));
  router.post("/events/design-approved", validate(orderUpdateEventSchema), eventHandler(container, "DESIGN_APPROVED", (body) => ({
    customer_name: body.customerName,
    order_reference: body.orderId
  })));
  router.post("/events/ready-to-dispatch", validate(orderUpdateEventSchema), eventHandler(container, "READY_TO_DISPATCH", (body) => ({
    customer_name: body.customerName,
    order_reference: body.orderId
  })));
  router.post("/events/experience-feedback", validate(orderUpdateEventSchema), eventHandler(container, "EXPERIENCE_FEEDBACK", (body) => ({
    customer_name: body.customerName,
    order_reference: body.orderId
  })));

  return router;
}

function eventHandler(container, eventType, templateData) {
  return wrap(async (req, res) => {
    const templateKey = req.body.templateKey || templateKeyForEvent(eventType);
    const template = container.templateRegistry.resolve(templateKey, "UTILITY");
    const contactId = req.body.contactId || (req.body.leadId
      ? (await container.store.get(COLLECTIONS.leads, req.body.leadId))?.contactId
      : null);
    if (templateKey === "order_confirmation") {
      const contact = await container.contacts.get(req.auth.orgId, contactId);
      if (contact.relationshipType !== "EXISTING_CLIENT") {
        throw new ConflictError("Order-confirmation video Utility updates are available only for existing clients");
      }
    }
    const templateAttachmentIds = await validateTemplateHeaderMedia({
      media: container.media,
      orgId: req.auth.orgId,
      contactId,
      template,
      attachmentIds: req.body.templateAttachmentIds
    });
    return sendData(res, await container.smartMessages.smartSend(req.auth.orgId, {
      ...req.body,
      eventType,
      requestedByCustomer: true,
      requestedMode: "UTILITY_TEMPLATE",
      isPromotional: false,
      templateKey,
      templateAttachmentIds,
      templateData: templateData(req.body),
      metadata: { ...(req.body.metadata || {}), eventEndpoint: eventType }
    }, req.auth), 202);
  });
}

function templateKeyForEvent(eventType) {
  return ({
    ORDER_CONFIRMATION: "order_confirmation",
    DESIGN_APPROVED: "design_approved",
    READY_TO_DISPATCH: "ready_to_dispatch",
    EXPERIENCE_FEEDBACK: "experience_feedback"
  })[eventType] || null;
}

function formatOrderValue(order) {
  const value = Number(order.totalAmount ?? order.orderAmount ?? order.finalAmount ?? 0);
  return `${order.currency || "INR"} ${Number.isFinite(value) ? value.toLocaleString("en-IN") : "0"}`;
}

async function sendUtilityBatch(container, req, template, templateAttachmentIds) {
  const batchId = `UTILITY_BATCH_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const orders = container.store.getMany
    ? await container.store.getMany(COLLECTIONS.orders, req.body.orderIds)
    : await Promise.all(req.body.orderIds.map((orderId) => container.store.get(COLLECTIONS.orders, orderId)));
  const orderById = new Map(orders.filter(Boolean).map((order) => [order.orderId || order.id, order]));
  const history = await utilityBatchHistory(container.store, req.auth.orgId, req.body.templateKey);
  const seenDestinations = new Set();
  const results = [];

  for (let index = 0; index < req.body.orderIds.length; index += 5) {
    const chunk = req.body.orderIds.slice(index, index + 5);
    const chunkResults = await Promise.all(chunk.map(async (orderId) => {
      try {
        const order = orderById.get(orderId);
        if (!order || order.orgId !== req.auth.orgId) return batchResult(orderId, "SKIPPED", "ORDER_NOT_FOUND");
        if (!order.contactId) return batchResult(orderId, "SKIPPED", "ORDER_HAS_NO_LINKED_CLIENT");
        if (TERMINAL_ORDER_STATUSES.has(String(order.status || "").toUpperCase())) {
          return batchResult(orderId, "SKIPPED", `ORDER_STATUS_${String(order.status).toUpperCase()}`);
        }
        const contact = await container.contacts.get(req.auth.orgId, order.contactId);
        if (contact.relationshipType !== "EXISTING_CLIENT") return batchResult(orderId, "SKIPPED", "NOT_EXISTING_CLIENT", contact);
        const historyReason = history.get(orderId);
        if (historyReason) return batchResult(orderId, "SKIPPED", historyReason, contact);
        if (contact.suppressed === true || contact.status === "BLOCKED" || contact.stopAllCommunications === true) {
          return batchResult(orderId, "SKIPPED", "SUPPRESSED", contact);
        }
        if (contact.marketingOptOut === true || contact.marketingConsent?.status === "OPTED_OUT" || contact.optInStatus === "OPTED_OUT") {
          return batchResult(orderId, "SKIPPED", "OPTED_OUT", contact);
        }
        const destination = normalizePhone(contact.primaryPhone) || `CONTACT:${contact.contactId}`;
        if (seenDestinations.has(destination)) return batchResult(orderId, "SKIPPED", "DUPLICATE_NUMBER", contact);
        seenDestinations.add(destination);
        const sendResult = await container.smartMessages.smartSend(req.auth.orgId, {
          contactId: contact.contactId,
          eventType: template.eventType || "GENERIC_UTILITY_UPDATE",
          requestedByCustomer: true,
          requestedMode: "UTILITY_TEMPLATE",
          isPromotional: false,
          orderId,
          templateKey: req.body.templateKey,
          templateAttachmentIds,
          templateData: utilityTemplateData(template, contact, order, req.body.variableValues),
          idempotencyKey: `UTILITY:${template.key}:${orderId}`,
          metadata: { utilityBatchId: batchId, source: "APPROVED_UTILITY_BATCH" }
        }, req.auth);
        return batchResult(orderId, sendResult.queued ? "QUEUED" : "SKIPPED", sendResult.reason, contact, sendResult.messageId);
      } catch (error) {
        return batchResult(orderId, "FAILED", error.message || "BATCH_SEND_FAILED");
      }
    }));
    results.push(...chunkResults);
  }

  const exclusionCounts = results
    .filter((item) => item.status === "SKIPPED")
    .reduce((counts, item) => ({ ...counts, [item.reason]: (counts[item.reason] || 0) + 1 }), {});
  return {
    batchId,
    templateKey: template.key,
    templateName: template.name,
    requested: req.body.orderIds.length,
    queued: results.filter((item) => item.status === "QUEUED").length,
    skipped: results.filter((item) => item.status === "SKIPPED").length,
    failed: results.filter((item) => item.status === "FAILED").length,
    exclusionCounts,
    results
  };
}

function utilityTemplateData(template, contact, order, supplied = {}) {
  const context = {
    customer_name: contact.contactPerson || contact.companyName || "Customer",
    company_name: contact.companyName || contact.contactPerson || "Customer",
    contact_person: contact.contactPerson || contact.companyName || "Customer",
    order_reference: order.orderNumber || order.externalOrderId || order.orderId || order.id,
    order_value: formatOrderValue(order),
    amount_due: String(order.amountDue ?? order.balanceAmount ?? order.pendingAmount ?? formatOrderValue(order)),
    order_status: String(order.status || "").replaceAll("_", " "),
    city: contact.city || order.city || order.deliveryAddress?.city || "",
    courier_name: order.courierName || "",
    tracking_reference: order.trackingNumber || order.trackingReference || ""
  };
  const positionalDefaults = ["customer_name", "order_reference", "order_status", "order_value"];
  return (template.variables || []).reduce((values, field, index) => {
    const namedKey = String(field.key || "").replace(/^header_/, "");
    const fallbackKey = Object.hasOwn(context, namedKey) ? namedKey : positionalDefaults[index];
    const rawValue = Object.hasOwn(supplied, field.key) ? supplied[field.key] : `{{${fallbackKey}}}`;
    const value = String(rawValue || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => context[key] ?? "").trim();
    if (!value) throw new ConflictError(`Value is required for template variable ${field.label || field.key}`);
    values[field.key] = value;
    return values;
  }, {});
}

function batchResult(orderId, status, reason = null, contact = null, messageId = null) {
  return {
    orderId,
    status,
    reason: reason || null,
    contactId: contact?.contactId || null,
    customer: contact?.companyName || contact?.contactPerson || null,
    messageId: messageId || null
  };
}

async function utilityBatchHistory(store, orgId, templateKey) {
  const reasons = new Map();
  let cursor = null;
  let scanned = 0;
  do {
    const page = await store.find(COLLECTIONS.messages, {
      filters: [["orgId", "==", orgId]],
      cursor,
      limit: Math.min(500, 100000 - scanned)
    });
    scanned += page.items.length;
    for (const message of page.items) {
      const metadata = message.metadata || {};
      if (message.direction !== "OUTBOUND" || metadata.templateCategory !== "UTILITY" || metadata.templateKey !== templateKey || !metadata.orderId) continue;
      const reason = message.status === "DELIVERY_UNKNOWN" || message.submissionState === "submission_unknown"
        ? "DELIVERY_UNCERTAIN"
        : message.submissionState === "accepted" || ["SENT", "DELIVERED", "READ"].includes(message.status)
          ? "ALREADY_SENT"
          : ["QUEUED", "SENDING"].includes(message.status)
            ? "QUEUED_OR_SENDING"
            : null;
      if (reason) setUtilityHistoryReason(reasons, metadata.orderId, reason);
    }
    cursor = scanned < 100000 && page.pagination?.hasMore ? decodeCursor(page.pagination.nextCursor) : null;
  } while (cursor);
  return reasons;
}

function setUtilityHistoryReason(reasons, orderId, reason) {
  const priority = { QUEUED_OR_SENDING: 1, ALREADY_SENT: 2, DELIVERY_UNCERTAIN: 3 };
  const current = reasons.get(orderId);
  if (!current || priority[reason] > priority[current]) reasons.set(orderId, reason);
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
