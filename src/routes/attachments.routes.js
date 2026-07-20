import express from "express";
import { authorizePermission } from "../middleware/authorize.js";

export function attachmentsRoutes(controller) {
  const router = express.Router();
  router.post("/", authorizePermission("attachments.write"), express.raw({ type: "*/*", limit: "20mb" }), controller.upload);
  router.get("/:attachmentId", authorizePermission("attachments.read"), controller.get);
  return router;
}
