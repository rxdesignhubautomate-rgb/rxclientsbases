import { ZodError } from "zod";
import { AppError } from "../utils/errors.js";
import { logger } from "../config/logger.js";

export function errorHandler(error, req, res, _next) {
  const known = error instanceof AppError;
  const validation = error instanceof ZodError;
  const status = known ? error.status : validation ? 400 : 500;
  const code = known ? error.code : validation ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
  const message = status === 500 ? "Internal server error" : error.message;
  const details = known ? error.details : validation ? error.issues : undefined;
  const log = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status,
    code,
    userId: req.auth?.userId,
    orgId: req.auth?.orgId,
    error: error.message
  };
  if (status >= 500) logger.error(log, "request_failed");
  else logger.warn(log, "request_rejected");
  res.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    meta: { requestId: req.id }
  });
}
