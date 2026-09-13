import crypto from "node:crypto";
import express from "express";
import { AppError } from "../utils/errors.js";

export function integrationsRoutes(container) {
  const router = express.Router();
  router.post("/process-orders", requireSyncSecret(container.env), async (req, res, next) => {
    try {
      const result = await container.processOrderSync.sync(container.env.ORG_ID, req.body);
      res.status(result.created ? 201 : 200).json({
        success: true,
        data: result,
        meta: { requestId: req.id }
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

function requireSyncSecret(env) {
  return (req, _res, next) => {
    const expected = String(env.PROCESS_ORDER_SYNC_SECRET || "");
    if (!expected) return next(new AppError("INTEGRATION_NOT_CONFIGURED", "Process order sync is not configured", 503));
    const received = String(req.headers["x-process-sync-secret"] || "");
    const left = Buffer.from(expected);
    const right = Buffer.from(received);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      return next(new AppError("INTEGRATION_UNAUTHORIZED", "Invalid integration credentials", 401));
    }
    return next();
  };
}
