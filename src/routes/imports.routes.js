import express from "express";
import { authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { orderRegisterImportSchema } from "../validators/schemas.js";

export function importsRoutes(controller) {
  const router = express.Router();
  router.use(authorizeRole("OWNER", "ADMIN"));
  router.post("/order-register/preview", validate(orderRegisterImportSchema), controller.previewOrderRegister);
  router.post("/order-register/commit", validate(orderRegisterImportSchema), controller.commitOrderRegister);
  return router;
}
