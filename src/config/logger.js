import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "rx-communication-crm", version: "2.0.0" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "authorization",
      "accessToken",
      "token",
      "privateKey",
      "payload.entry",
      "customerMessage"
    ],
    censor: "[REDACTED]"
  }
});
