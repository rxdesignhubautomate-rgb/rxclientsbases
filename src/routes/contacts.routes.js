import express from "express";
import { authorizePermission, authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { channelIdentitySchema, contactCreateSchema, contactUpdateSchema } from "../validators/schemas.js";

export function contactsRoutes(controller) {
  const router = express.Router();
  router.post("/", authorizePermission("contacts.write"), validate(contactCreateSchema), controller.create);
  router.get("/", authorizePermission("contacts.read", "contacts.read_assigned"), controller.list);
  router.get("/:contactId", authorizePermission("contacts.read", "contacts.read_assigned"), controller.get);
  router.patch("/:contactId", authorizePermission("contacts.write"), validate(contactUpdateSchema), controller.update);
  router.post("/:contactId/merge", authorizeRole("ADMIN"), controller.merge);
  router.get("/:contactId/timeline", authorizePermission("contacts.read", "contacts.read_assigned"), controller.timeline);
  router.post("/:contactId/channel-identities", authorizePermission("contacts.write"), validate(channelIdentitySchema), controller.addIdentity);
  router.get("/:contactId/channel-identities", authorizePermission("contacts.read", "contacts.read_assigned"), controller.listIdentities);
  return router;
}

export function channelIdentitiesRoutes(controller) {
  const router = express.Router();
  router.patch("/:channelIdentityId", authorizePermission("contacts.write"), controller.updateIdentity);
  return router;
}
