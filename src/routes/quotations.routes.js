import express from "express";
import { authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { quotationSchema } from "../validators/schemas.js";

export function quotationsRoutes(controller) {
  const router = express.Router();
  router.post("/", authorizePermission("quotations.create"), validate(quotationSchema), controller.create);
  router.get("/", authorizePermission("quotations.read"), controller.list);
  router.get("/:quotationId", authorizePermission("quotations.read"), controller.get);
  router.patch("/:quotationId", authorizePermission("quotations.update"), validate(quotationSchema.partial()), controller.update);
  router.post("/:quotationId/generate-pdf", authorizePermission("quotations.update"), controller.generatePdf);
  router.post("/:quotationId/send", authorizePermission("quotations.send"), controller.send);
  router.post("/:quotationId/accept", authorizePermission("quotations.update"), controller.accept);
  router.post("/:quotationId/reject", authorizePermission("quotations.update"), controller.reject);
  return router;
}
