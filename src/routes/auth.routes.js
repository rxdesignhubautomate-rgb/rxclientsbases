import express from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { sendData } from "../utils/http.js";

const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const verifySchema = emailSchema.extend({ code: z.string().trim().regex(/^\d{6}$/) });
const passwordSchema = emailSchema.extend({ password: z.string().min(6).max(128) });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(4096) });

export function authRoutes(container) {
  const router = express.Router();
  router.post("/password/login", validate(passwordSchema), wrap(async (req, res) => {
    return sendData(res, await container.passwordAuth.login(req.body.email, req.body.password));
  }));
  router.post("/password/refresh", validate(refreshSchema), wrap(async (req, res) => {
    return sendData(res, await container.passwordAuth.refresh(req.body.refreshToken));
  }));
  router.post("/otp/request", validate(emailSchema), wrap(async (req, res) => {
    return sendData(res, await container.otpAuth.requestOtp(req.body.email));
  }));
  router.post("/otp/verify", validate(verifySchema), wrap(async (req, res) => {
    return sendData(res, await container.otpAuth.verifyOtp(req.body.email, req.body.code));
  }));
  return router;
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
