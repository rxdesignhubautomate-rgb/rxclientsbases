import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  ORG_ID: z.string().min(2).default("RXDH"),
  ORG_TIMEZONE: z.string().default("Asia/Kolkata"),
  ORG_CURRENCY: z.string().default("INR"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_STORAGE_BUCKET: z.string().optional(),
  FIREBASE_WEB_API_KEY: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v20.0"),
  DEFAULT_CHANNEL_ACCOUNT_ID: z.string().default("WA_RX_01"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_SUMMARY_MODEL: z.string().default("gpt-4o-mini"),
  AI_DEFAULT_MODE: z.enum(["OFF", "ASSIST", "AUTO"]).default("ASSIST"),
  AI_AUTO_SEND_ENABLED: booleanFromString,
  AI_SUMMARY_MESSAGE_INTERVAL: z.coerce.number().int().positive().default(12),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  MAX_OUTBOX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_RETRY_DELAYS_MS: z.string().default("0,60000,300000,1800000,7200000"),
  INBOUND_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15000),
  MEDIA_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(60000),
  INBOUND_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  WORKERS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  WORKER_ID: z.string().optional(),
  ENABLE_LEGACY_DUAL_WRITE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  USE_NEW_CRM_READS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  LEGACY_JOBS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  OTP_LOGIN_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  PASSWORD_LOGIN_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  OTP_DELIVERY_EMAIL: z.string().email().optional(),
  OTP_SMTP_USER: z.string().email().optional(),
  OTP_SMTP_APP_PASSWORD: z.string().min(12).optional(),
  OTP_HASH_SECRET: z.string().min(32).optional(),
  OTP_TTL_MINUTES: z.coerce.number().int().min(2).max(30).default(10),
  OTP_SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  OTP_LOGIN_USERS: z.string().default("admin@rxdesignhub.com|Admin|OWNER;ankit@rxdesignhub.com|Ankit|SALES;reshu@rxdesignhub.com|Reshu|SALES;shubham@rxdesignhub.com|Shubham|SALES")
});

function aliases(source) {
  return {
    ...source,
    META_ACCESS_TOKEN: source.META_ACCESS_TOKEN || source.WHATSAPP_TOKEN,
    META_VERIFY_TOKEN: source.META_VERIFY_TOKEN || source.WHATSAPP_VERIFY_TOKEN,
    META_PHONE_NUMBER_ID: source.META_PHONE_NUMBER_ID || source.WHATSAPP_PHONE_NUMBER_ID
  };
}

export function loadEnv(source = process.env) {
  const parsed = schema.safeParse(aliases(source));
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const value = parsed.data;
  return Object.freeze({
    ...value,
    FIREBASE_PRIVATE_KEY: value.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    ALLOWED_ORIGINS: value.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    OUTBOX_RETRY_DELAYS_MS: value.OUTBOX_RETRY_DELAYS_MS.split(",").map(Number).filter(Number.isFinite),
    WORKER_ID: value.WORKER_ID || `worker-${process.pid}`
  });
}

export const env = loadEnv();

export function assertStartupEnv(value = env) {
  const required = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_STORAGE_BUCKET",
    "META_VERIFY_TOKEN",
    "META_ACCESS_TOKEN",
    "META_PHONE_NUMBER_ID"
  ];
  if (value.NODE_ENV === "production") required.push("META_APP_SECRET");
  if (value.AI_DEFAULT_MODE !== "OFF") required.push("OPENAI_API_KEY");
  if (value.OTP_LOGIN_ENABLED) {
    required.push("OTP_DELIVERY_EMAIL", "OTP_SMTP_USER", "OTP_SMTP_APP_PASSWORD", "OTP_HASH_SECRET");
  }
  if (value.PASSWORD_LOGIN_ENABLED) required.push("FIREBASE_WEB_API_KEY");
  const missing = required.filter((key) => !value[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
