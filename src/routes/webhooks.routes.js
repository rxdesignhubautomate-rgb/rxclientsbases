import express from "express";
import { waitUntil } from "@vercel/functions";

export function webhooksRoutes(container) {
  const router = express.Router();
  router.get("/whatsapp", (req, res, next) => {
    try {
      res.status(200).send(container.webhook.verifyChallenge(req.query, container.env.META_VERIFY_TOKEN));
    } catch (error) {
      next(error);
    }
  });
  router.post("/whatsapp", async (req, res, next) => {
    try {
      const result = await container.webhook.receiveWhatsApp({
        rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body)),
        payload: req.body,
        signature: req.headers["x-hub-signature-256"]
      });
      if (process.env.VERCEL === "1" && result.webhookEventId) {
        waitUntil(
          container.workers.inbound
            .processOne({ webhookEventId: result.webhookEventId })
            .catch((error) => req.log?.error({ error: error.message, webhookEventId: result.webhookEventId }, "vercel_inbound_processing_failed"))
        );
      }
      res.status(200).json({ received: true, duplicate: result.duplicate });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
