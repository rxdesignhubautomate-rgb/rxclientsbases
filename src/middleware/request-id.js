import { randomUUID } from "node:crypto";

export function requestId(req, res, next) {
  req.id = String(req.headers["x-request-id"] || randomUUID()).slice(0, 128);
  res.setHeader("x-request-id", req.id);
  next();
}
