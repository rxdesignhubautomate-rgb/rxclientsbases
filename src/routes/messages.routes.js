import express from "express";
import { authorizePermission } from "../middleware/authorize.js";

export function messagesRoutes(controller) {
  const router = express.Router();
  router.get("/:messageId", authorizePermission("conversations.read", "conversations.read_assigned"), controller.get);
  router.post("/:messageId/retry", authorizePermission("messages.retry"), controller.retry);
  router.post("/:messageId/mark-read", authorizePermission("messages.send"), controller.markRead);
  return router;
}
