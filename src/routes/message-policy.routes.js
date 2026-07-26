import express from "express";
import { authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { sendData, sendList } from "../utils/http.js";
import { listQuery } from "../utils/pagination.js";
import {
  campaignScheduleSchema,
  designApprovalEventSchema,
  designProofEventSchema,
  marketingCampaignSchema,
  marketingLaunchSchema,
  orderDispatchedEventSchema,
  paymentReceivedEventSchema,
  quotationReadyEventSchema,
  smartMessageSchema
} from "../validators/schemas.js";

export function messagePolicyRoutes(container) {
  const router = express.Router();
  router.use(authorizeRole("OWNER", "ADMIN"));

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
  router.post("/whatsapp/templates/sync", wrap(async (req, res) => {
    return sendData(res, await container.templateRegistry.syncFromMeta(req.auth.orgId, req.auth));
  }));

  router.post("/campaigns", validate(marketingCampaignSchema), wrap(async (req, res) => {
    return sendData(res, await container.marketing.createCampaign(req.auth.orgId, req.body, req.auth), 201);
  }));
  router.get("/campaigns", wrap(async (req, res) => {
    return sendList(res, await container.marketing.listCampaigns(req.auth.orgId, { ...listQuery(req.query), status: req.query.status }));
  }));
  router.get("/campaigns/:campaignId", wrap(async (req, res) => {
    return sendData(res, await container.marketing.getCampaign(req.auth.orgId, req.params.campaignId, { includeEnrollments: true }));
  }));
  router.get("/campaigns/:campaignId/stats", wrap(async (req, res) => {
    const campaign = await container.marketing.getCampaign(req.auth.orgId, req.params.campaignId);
    return sendData(res, { campaignId: campaign.campaignId, status: campaign.status, lifecycleStatus: campaign.lifecycleStatus, stats: campaign.stats || {} });
  }));
  router.post("/campaigns/:campaignId/submit", wrap(async (req, res) => {
    return sendData(res, await container.marketing.submitCampaign(req.auth.orgId, req.params.campaignId, req.auth));
  }));
  router.post("/campaigns/:campaignId/approve", wrap(async (req, res) => {
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
  router.post("/workers/campaign/run", wrap(async (_req, res) => {
    return sendData(res, { processed: await container.marketing.processDue(container.env.CAMPAIGN_BATCH_SIZE) });
  }));

  router.post("/events/quotation-ready", validate(quotationReadyEventSchema), eventHandler(container, "QUOTATION_READY", (body) => ({
    customer_name: body.customerName,
    quotation_id: body.quotationId,
    product: body.product,
    amount: String(body.amount),
    quotation_url: body.quotationUrl
  })));
  router.post("/events/design-proof-ready", validate(designProofEventSchema), eventHandler(container, "DESIGN_PROOF_READY", (body) => ({
    customer_name: body.customerName,
    order_id: body.orderId,
    proof_url: body.proofUrl
  })));
  router.post("/events/design-approval-pending", validate(designApprovalEventSchema), eventHandler(container, "DESIGN_APPROVAL_PENDING", (body) => ({
    customer_name: body.customerName,
    order_id: body.orderId,
    proof_url: body.proofUrl
  })));
  router.post("/events/payment-received", validate(paymentReceivedEventSchema), eventHandler(container, "PAYMENT_RECEIVED", (body) => ({
    customer_name: body.customerName,
    amount: String(body.amount),
    order_id: body.orderId
  })));
  router.post("/events/order-dispatched", validate(orderDispatchedEventSchema), eventHandler(container, "ORDER_DISPATCHED", (body) => ({
    customer_name: body.customerName,
    order_id: body.orderId,
    courier_name: body.courierName,
    tracking_number: body.trackingNumber
  })));

  return router;
}

function eventHandler(container, eventType, templateData) {
  return wrap(async (req, res) => sendData(res, await container.smartMessages.smartSend(req.auth.orgId, {
    ...req.body,
    eventType,
    requestedByCustomer: true,
    isPromotional: false,
    templateKey: eventType,
    templateData: templateData(req.body),
    metadata: { ...(req.body.metadata || {}), eventEndpoint: eventType }
  }, req.auth), 202));
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
