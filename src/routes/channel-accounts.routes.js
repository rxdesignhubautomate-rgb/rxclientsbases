import express from "express";
import { authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { channelAccountSchema } from "../validators/schemas.js";

export function channelAccountsRoutes(controller) {
  const router = express.Router();
  router.use(authorizeRole("ADMIN"));
  router.get("/", controller.list);
  router.post("/", validate(channelAccountSchema), controller.create);
  router.get("/:channelAccountId", controller.get);
  router.patch("/:channelAccountId", controller.update);
  router.post("/:channelAccountId/activate", controller.activate);
  router.post("/:channelAccountId/disable", controller.disable);
  router.post("/:channelAccountId/make-default", controller.makeDefault);
  return router;
}
