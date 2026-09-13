import cors from "cors";
import express from "express";
import { config, assertRequiredConfig } from "./config.js";
import { requireAdminDevice, requireApprovedDevice, requireDashboardKey } from "./middleware/auth.js";
import { devicesRouter } from "./routes/devices.js";
import { leadsRouter } from "./routes/leads.js";
import { chatsRouter } from "./routes/chats.js";
import { recordStatus } from "./services/chatStore.js";
import { startDigestScheduler } from "./services/dailyDigest.js";
import { processIncomingWhatsAppMessage } from "./services/leadProcessor.js";
import { startSequenceScheduler } from "./services/sequenceScheduler.js";
import {
  firestoreQuotaGuard,
  noteFirestoreQuotaError,
} from "./services/firestoreQuota.js";
import { extractIncomingMessages, extractMessageStatuses } from "./services/whatsapp.js";

assertRequiredConfig();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "whatsapp-ai-sales-crm" });
});

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsappVerifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  const incomingMessages = extractIncomingMessages(req.body);
  const statuses = extractMessageStatuses(req.body);
  res.sendStatus(200);

  for (const status of statuses) recordStatus(status).catch(error => console.error("message_status_failed", { error: error.message }));

  for (const message of incomingMessages) {
    processIncomingWhatsAppMessage(message).catch((error) => {
      console.error("message_processing_failed", {
        whatsappMessageId: message.whatsappMessageId,
        error: error.message
      });
    });
  }
});

app.use("/api", firestoreQuotaGuard);
app.use("/api/devices", requireDashboardKey, requireAdminDevice, devicesRouter);
app.use("/api/leads", requireDashboardKey, requireApprovedDevice, leadsRouter);
app.use("/api/chats", requireDashboardKey, requireApprovedDevice, chatsRouter);

app.use((error, _req, res, _next) => {
  const quota = noteFirestoreQuotaError(error);
  if (quota) {
    if (quota.started)
      console.error("firestore_quota_backoff_started", {
        retryAt: quota.retryAt,
      });
    res.set("Retry-After", String(quota.retryAfterSeconds));
    return res.status(503).json({
      error: "Database quota is temporarily exhausted. Automatic retry is paused.",
      code: "FIRESTORE_QUOTA_BACKOFF",
      retryAt: quota.retryAt,
    });
  }
  console.error("request_failed", { error: error.message });
  res.status(error.status || 500).json({ error: error.status ? error.message : "Internal server error", detail: error.message });
});

app.listen(config.port, () => {
  console.log(`WhatsApp AI Sales CRM running on port ${config.port}`);
  startSequenceScheduler();
  startDigestScheduler();
});
