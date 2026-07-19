import cors from "cors";
import express from "express";
import { config, assertRequiredConfig } from "./config.js";
import { requireAdminDevice, requireApprovedDevice, requireDashboardKey } from "./middleware/auth.js";
import { devicesRouter } from "./routes/devices.js";
import { leadsRouter } from "./routes/leads.js";
import { startDigestScheduler } from "./services/dailyDigest.js";
import { processIncomingWhatsAppMessage } from "./services/leadProcessor.js";
import { startSequenceScheduler } from "./services/sequenceScheduler.js";
import { extractIncomingMessages } from "./services/whatsapp.js";

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
  res.sendStatus(200);

  for (const message of incomingMessages) {
    processIncomingWhatsAppMessage(message).catch((error) => {
      console.error("message_processing_failed", {
        whatsappMessageId: message.whatsappMessageId,
        error: error.message
      });
    });
  }
});

app.use("/api/devices", requireDashboardKey, requireAdminDevice, devicesRouter);
app.use("/api/leads", requireDashboardKey, requireApprovedDevice, leadsRouter);

app.use((error, _req, res, _next) => {
  console.error("request_failed", { error: error.message });
  res.status(500).json({ error: "Internal server error", detail: error.message });
});

app.listen(config.port, () => {
  console.log(`WhatsApp AI Sales CRM running on port ${config.port}`);
  startSequenceScheduler();
  startDigestScheduler();
});
