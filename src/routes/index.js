import express from "express";
import { createControllers } from "../controllers/api.controllers.js";
import { contactsRoutes, channelIdentitiesRoutes } from "./contacts.routes.js";
import { channelAccountsRoutes } from "./channel-accounts.routes.js";
import { conversationsRoutes } from "./conversations.routes.js";
import { messagesRoutes } from "./messages.routes.js";
import { leadsRoutes } from "./leads.routes.js";
import { quotationsRoutes } from "./quotations.routes.js";
import { followUpsRoutes } from "./followups.routes.js";
import { ordersRoutes } from "./orders.routes.js";
import { dashboardRoutes } from "./dashboard.routes.js";
import { usersRoutes } from "./users.routes.js";
import { attachmentsRoutes } from "./attachments.routes.js";
import { importsRoutes } from "./imports.routes.js";

export function apiRoutes(container, authenticate) {
  const router = express.Router();
  const controller = createControllers(container);
  router.use(authenticate);
  router.use("/contacts", contactsRoutes(controller.contacts));
  router.use("/channel-identities", channelIdentitiesRoutes(controller.contacts));
  router.use("/channel-accounts", channelAccountsRoutes(controller.channelAccounts));
  router.use("/conversations", conversationsRoutes(controller.conversations, controller.messages));
  router.use("/messages", messagesRoutes(controller.messages));
  router.use("/leads", leadsRoutes(controller.leads));
  router.use("/quotations", quotationsRoutes(controller.quotations));
  router.use("/followups", followUpsRoutes(controller.followUps));
  router.use("/orders", ordersRoutes(controller.orders));
  router.use("/dashboard", dashboardRoutes(controller.dashboard));
  router.use("/users", usersRoutes(controller.users));
  router.use("/attachments", attachmentsRoutes(controller.attachments));
  router.use("/imports", importsRoutes(controller.imports));
  router.get("/system/info", controller.system.info);
  return router;
}
