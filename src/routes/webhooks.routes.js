import express from "express";

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
      res.status(200).json({ received: true, duplicate: result.duplicate });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
