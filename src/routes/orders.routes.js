import express from "express";
import { authorizePermission } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { orderSchema } from "../validators/schemas.js";

export function ordersRoutes(controller) {
  const router = express.Router();
  router.post("/", authorizePermission("orders.write"), validate(orderSchema), controller.create);
  router.get("/", authorizePermission("orders.read"), controller.list);
  router.get("/:orderId", authorizePermission("orders.read"), controller.get);
  router.patch("/:orderId", authorizePermission("orders.write"), validate(orderSchema.partial()), controller.update);
  router.post("/:orderId/change-status", authorizePermission("orders.update_status"), controller.status);
  router.post("/:orderId/assign-designer", authorizePermission("orders.assign"), controller.assignDesigner);
  router.post("/:orderId/add-payment", authorizePermission("payments.write"), controller.payment);
  router.get("/:orderId/timeline", authorizePermission("orders.read"), controller.timeline);
  return router;
}
