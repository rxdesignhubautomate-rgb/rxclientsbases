import express from "express";
import { authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { quickReplyCreateSchema, quickReplyUpdateSchema } from "../validators/schemas.js";

export function whatsappRoutes(controller) {
  const router = express.Router();
  router.get("/utility-templates", authorizePermission("messages.send"), controller.utilityTemplates);
  router.get("/capabilities", authorizePermission("conversations.read", "conversations.read_assigned"), controller.capabilities);
  router.get("/quick-replies", authorizePermission("messages.send"), controller.listQuickReplies);
  router.post("/quick-replies", authorizePermission("messages.send"), validate(quickReplyCreateSchema), controller.createQuickReply);
  router.patch("/quick-replies/:quickReplyId", authorizePermission("messages.send"), validate(quickReplyUpdateSchema), controller.updateQuickReply);
  return router;
}
