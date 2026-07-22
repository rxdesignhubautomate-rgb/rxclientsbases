import express from "express";
import { authorizePermission } from "../middleware/authorize.js";

export function whatsappRoutes(controller) {
  const router = express.Router();
  router.get("/utility-templates", authorizePermission("messages.send"), controller.utilityTemplates);
  return router;
}
