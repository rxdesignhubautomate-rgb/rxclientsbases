import express from "express";
import { authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { followUpSchema } from "../validators/schemas.js";

export function followUpsRoutes(controller) {
  const router = express.Router();
  router.post("/", authorizePermission("followups.write"), validate(followUpSchema), controller.create);
  router.get("/", authorizePermission("followups.read"), controller.list);
  router.get("/due", authorizePermission("followups.read"), controller.due);
  router.get("/:followUpId", authorizePermission("followups.read"), controller.get);
  router.patch("/:followUpId", authorizePermission("followups.write"), validate(followUpSchema.partial()), controller.update);
  router.post("/:followUpId/complete", authorizePermission("followups.write"), controller.complete);
  router.post("/:followUpId/reschedule", authorizePermission("followups.write"), controller.reschedule);
  return router;
}
