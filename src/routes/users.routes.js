import express from "express";
import { authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { userSchema } from "../validators/schemas.js";

export function usersRoutes(controller) {
  const router = express.Router();
  router.use(authorizeRole("ADMIN"));
  router.get("/", controller.list);
  router.post("/", validate(userSchema), controller.create);
  router.patch("/:userId", validate(userSchema.partial()), controller.update);
  return router;
}
