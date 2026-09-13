import express from "express";
import { authorizePermission } from "../middleware/authorize.js";

export function dashboardRoutes(controller) {
  const router = express.Router();
  router.use(authorizePermission("dashboard.read"));
  router.get("/summary", controller.summary);
  router.get("/pipeline", controller.pipeline);
  router.get("/followups", controller.followUps);
  router.get("/sales-performance", controller.performance);
  router.get("/unread-counts", controller.unread);
  return router;
}
