import express from "express";
import { z } from "zod";
import { authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { leadSchema } from "../validators/schemas.js";

export function leadsRoutes(controller) {
  const router = express.Router();
  router.post("/", authorizePermission("leads.write"), validate(leadSchema), controller.create);
  router.get("/", authorizePermission("leads.read", "leads.read_assigned"), controller.list);
  router.get("/:leadId", authorizePermission("leads.read", "leads.read_assigned"), controller.get);
  router.patch("/:leadId", authorizePermission("leads.update"), validate(leadSchema.partial()), controller.update);
  router.post("/:leadId/assign", authorizePermission("leads.assign"), controller.assign);
  router.post("/:leadId/change-status", authorizePermission("leads.update"), validate(z.object({ status: z.string().min(2) })), controller.status);
  router.post("/:leadId/convert", authorizePermission("leads.update"), (req, _res, next) => { req.body = { ...(req.body || {}), status: "CLOSED_WON" }; next(); }, controller.status);
  router.get("/:leadId/timeline", authorizePermission("leads.read", "leads.read_assigned"), controller.timeline);
  return router;
}
