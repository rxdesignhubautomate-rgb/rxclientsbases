import rateLimit from "express-rate-limit";

export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }
});

export const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  standardHeaders: "draft-7",
  legacyHeaders: false
});
