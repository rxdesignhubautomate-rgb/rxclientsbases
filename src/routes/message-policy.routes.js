import express from "express";
import { authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { sendData, sendList } from "../utils/http.js";
import { decodeCursor, listQuery } from "../utils/pagination.js";
import { validateTemplateHeaderMedia } from "../services/template-header-media.js";
import { COLLECTIONS } from "../config/constants.js";
import { ConflictError } from "../utils/errors.js";
import {
  campaignScheduleSchema,
  directExistingCampaignSchema,
  marketingCampaignSchema,
  marketingLaunchSchema,
  orderConfirmationBatchSchema,
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

  router.post("/message/decide", validate(smartMessageSchema), wrap(async (req, res) => {
    const evaluated = await container.smartMessages.decide(req.auth.orgId, req.body);
    return sendData(res, {
      ...evaluated.decision,
      frequency: evaluated.frequency,
      transactionVerified: evaluated.transactionVerified
    });
  }));
  router.post("/message/smart-send", validate(smartMessageSchema), wrap(async (req, res) => {
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
    return sendList(res, await container.store.find(COLLECTIONS.contacts, {
      filters: [["orgId", "==", req.auth.orgId], ["relationshipType", "==", "EXISTING_CLIENT"]],
      orderBy: ["updatedAt", "desc"],
      cursor: decodeCursor(req.query.cursor),
      limit
    }));
  }));

  router.get("/events/order-confirmed/batch/orders", authorizeRole("OWNER", "ADMIN"), wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    return sendList(res, await container.store.find(COLLECTIONS.orders, {
      filters: [["orgId", "==", req.auth.orgId], ["status", "in", UTILITY_BATCH_ACTIVE_ORDER_STATUSES]],
      orderBy: ["updatedAt", "desc"],
      cursor: decodeCursor(req.query.cursor),
      limit
    }));
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

    return sendData(res, {
      batchId,
      requested: req.body.orderIds.length,
      queued: results.filter((item) => item.status === "QUEUED").length,
      skipped: results.filter((item) => item.status === "SKIPPED").length,
      failed: results.filter((item) => item.status === "FAILED").length,
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

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
