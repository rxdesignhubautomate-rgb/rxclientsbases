import dotenv from "dotenv";

dotenv.config();

const SALES_TEAM = (process.env.SALES_TEAM || "ankit,reshu,shubham")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  salesTeam: SALES_TEAM,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  whatsappToken: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
  whatsappPhoneNumberId: process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappVerifyToken: process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN,
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  businessName: process.env.BUSINESS_NAME || "RX Design Hub",
  businessHours: process.env.BUSINESS_HOURS || "10 AM to 7 PM",
  businessLocation: process.env.BUSINESS_LOCATION || "Lucknow, India",
  aiAutoReplyEnabled: process.env.AI_AUTO_REPLY_ENABLED !== "false",
  dashboardApiKey: process.env.DASHBOARD_API_KEY || "",
  deviceApprovalEnabled: process.env.DEVICE_APPROVAL_ENABLED === "true",
  sequenceSchedulerEnabled: process.env.SEQUENCE_SCHEDULER_ENABLED !== "false",
  sequenceCheckIntervalMs: Math.max(Number(process.env.SEQUENCE_CHECK_INTERVAL_MS || 60000), 15000),
  visualAidSequenceVideos: [
    process.env.VISUAL_AID_VIDEO_1,
    process.env.VISUAL_AID_VIDEO_2,
    process.env.VISUAL_AID_VIDEO_3,
    process.env.VISUAL_AID_VIDEO_4,
    ...(process.env.VISUAL_AID_SEQUENCE_VIDEOS || "").split(",")
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean),
  humanTakeoverCoolingHours: Math.max(Number(process.env.HUMAN_TAKEOVER_COOLING_HOURS || 24), 1),
  salesAlertsEnabled: process.env.SALES_ALERTS_ENABLED !== "false",
  hotAlertCooldownMinutes: Math.max(Number(process.env.HOT_ALERT_COOLDOWN_MINUTES || 360), 30),
  alertNumbers: {
    ankit: cleanAlertPhone(process.env.ALERT_NUMBER_ANKIT),
    pinky: cleanAlertPhone(process.env.ALERT_NUMBER_PINKY || process.env.ALERT_NUMBER_RESHU),
    priya: cleanAlertPhone(process.env.ALERT_NUMBER_PRIYA || process.env.ALERT_NUMBER_SHUBHAM),
    reshu: cleanAlertPhone(process.env.ALERT_NUMBER_RESHU),
    shubham: cleanAlertPhone(process.env.ALERT_NUMBER_SHUBHAM),
    admin: cleanAlertPhone(process.env.ALERT_NUMBER_ADMIN)
  },
  alertCopyAdmin: process.env.ALERT_COPY_ADMIN === "true",
  digestEnabled: process.env.DIGEST_ENABLED !== "false",
  morningDigestTime: String(process.env.MORNING_DIGEST_TIME || "09:30").trim(),
  eveningDigestTime: String(process.env.EVENING_DIGEST_TIME || "20:00").trim(),
  adminDeviceCodes: deviceCodes(process.env.ADMIN_DEVICE_CODES || "7A3FCC19,58664D82"),
  fixedDevices: [
    ...deviceCodes(process.env.ANKIT_DEVICE_CODE || "CAB15CF0,A0F9EF19")
      .map((code) => ({ code, role: "ankit", name: "Ankit phone" })),
    ...deviceCodes(process.env.RESHU_DEVICE_CODE || "D9F49CAC")
      .map((code) => ({ code, role: "reshu", name: "Reshu phone" })),
    ...deviceCodes(process.env.SHUBHAM_DEVICE_CODE || "121D5F4C")
      .map((code) => ({ code, role: "shubham", name: "Shubham phone" }))
  ].filter((device) => device.code),
};

function deviceCodes(value) {
  return String(value || "")
    .split(",")
    .map((code) => code.replace(/[^A-Za-z0-9]/g, "").trim().toUpperCase())
    .filter(Boolean);
}

function cleanAlertPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return "";
}

export function assertRequiredConfig() {
  const required = [
    ["OPENAI_API_KEY", config.openaiApiKey],
    ["WHATSAPP_TOKEN", config.whatsappToken],
    ["WHATSAPP_PHONE_NUMBER_ID", config.whatsappPhoneNumberId],
    ["WHATSAPP_VERIFY_TOKEN", config.whatsappVerifyToken],
    ["FIREBASE_PROJECT_ID", config.firebaseProjectId],
    ["FIREBASE_CLIENT_EMAIL", config.firebaseClientEmail],
    ["FIREBASE_PRIVATE_KEY", config.firebasePrivateKey]
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}
