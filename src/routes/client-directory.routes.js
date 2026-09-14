import express from "express";
import { sendData } from "../utils/http.js";
import { validate } from "../middleware/validate.js";
import { authorizePermission } from "../middleware/authorize.js";
import { classificationReviewSchema } from "../services/client-directory.service.js";

export function clientDirectoryRoutes(service) {
  const router = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.use(authorizePermission("contacts.read", "contacts.read_assigned"));
  router.get("/capabilities", wrap(async (req, res) => sendData(res, await service.capabilities(req.auth))));
  router.get('/owners', wrap(async (req, res) => sendData(res, await service.owners(req.auth, req.query))));
  router.get('/bulk', wrap(async (req, res) => sendData(res, await service.bulk.list(req.auth))));
  router.post('/bulk', wrap(async (req, res) => sendData(res, await service.bulk.create(req.auth, req.body), 201)));
  router.get('/bulk/:id', wrap(async (req, res) => sendData(res, await service.bulk.get(req.auth, req.params.id))));
  router.get('/bulk/:id/members', wrap(async (req, res) => sendData(res, await service.bulk.members(req.auth, req.params.id, req.query))));
  router.post('/bulk/:id/action', wrap(async (req, res) => sendData(res, await service.bulk.action(req.auth, req.params.id, req.body))));
  router.get("/counts", wrap(async (req, res) => sendData(res, await service.counts(req.auth, req.query))));
  router.get("/", wrap(async (req, res) => sendData(res, await service.list(req.auth, req.query))));
  router.get("/:contactId", wrap(async (req, res) => sendData(res, await service.profile(req.auth, req.params.contactId))));
  router.patch("/:contactId/classification", authorizePermission("contacts.classify"), validate(classificationReviewSchema),
    wrap(async (req, res) => sendData(res, await service.review(req.auth, req.params.contactId, req.body))));
  return router;
}
