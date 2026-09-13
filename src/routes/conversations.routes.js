import express from "express";
import { authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { conversationActionSchema, conversationStartSchema, outboundMessageSchema } from "../validators/schemas.js";

export function conversationsRoutes(controller, messageController) {
  const router = express.Router();
  router.post("/start", authorizePermission("messages.send"), validate(conversationStartSchema), controller.start);
  router.get("/", authorizePermission("conversations.read", "conversations.read_assigned"), controller.list);
  router.get("/:conversationId", authorizePermission("conversations.read", "conversations.read_assigned"), controller.get);
  router.get("/:conversationId/messages", authorizePermission("conversations.read", "conversations.read_assigned"), controller.messages);
  router.post("/:conversationId/messages", authorizePermission("messages.send"), validate(outboundMessageSchema), messageController.send);
  router.post("/:conversationId/assign", authorizePermission("conversations.assign"), validate(conversationActionSchema), controller.action("ASSIGN"));
  router.post("/:conversationId/close", authorizePermission("conversations.update"), controller.action("CLOSE"));
  router.post("/:conversationId/reopen", authorizePermission("conversations.update"), controller.action("REOPEN"));
  router.post("/:conversationId/snooze", authorizePermission("conversations.update"), validate(conversationActionSchema), controller.action("SNOOZE"));
  router.post("/:conversationId/human-takeover", authorizePermission("conversations.update"), validate(conversationActionSchema), controller.action("HUMAN_TAKEOVER"));
  router.post("/:conversationId/ai-mode", authorizePermission("conversations.update"), validate(conversationActionSchema), controller.action("AI_MODE"));
  router.post("/:conversationId/internal-note", authorizePermission("messages.send"), validate(conversationActionSchema), controller.note);
  return router;
}
