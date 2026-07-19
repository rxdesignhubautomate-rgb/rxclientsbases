import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./config/logger.js";
import { createContainer } from "./container.js";
import { requestId } from "./middleware/request-id.js";
import { apiRateLimit, webhookRateLimit } from "./middleware/rate-limit.js";
import { createAuthenticate } from "./middleware/authenticate.js";
import { notFound } from "./middleware/not-found.js";
import { errorHandler } from "./middleware/error-handler.js";
import { apiRoutes } from "./routes/index.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { requireAdminDevice, requireApprovedDevice, requireDashboardKey } from "../middleware/auth.js";
import { devicesRouter } from "../routes/devices.js";
import { leadsRouter } from "../routes/leads.js";

export function createApp(options = {}) {
  const container = options.container || createContainer(options.overrides);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", container.env.TRUST_PROXY);
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customProps: (req) => ({ userId: req.auth?.userId, orgId: req.auth?.orgId }),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode })
      }
    })
  );
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || container.env.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error("Origin is not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id", "x-dashboard-key", "x-device-code", "x-device-user", "x-device-role", "x-filename"]
    })
  );
  app.use(
    express.json({
      limit: "1mb",
      verify(req, _res, buffer) {
        req.rawBody = Buffer.from(buffer);
      }
    })
  );
  app.use(express.static("public"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "rx-communication-crm", version: "2.0.0", timestamp: new Date().toISOString() });
  });
  app.get("/ready", async (_req, res) => {
    try {
      await container.store.get("systemSettings", "readiness");
      res.json({ status: "ready", service: "rx-communication-crm", version: "2.0.0", timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: "not_ready", service: "rx-communication-crm", timestamp: new Date().toISOString() });
    }
  });

  const webhookRouter = webhooksRoutes(container);
  app.use("/webhooks", webhookRateLimit, webhookRouter);
  app.use("/webhook", webhookRateLimit, webhookRouter);

  const authenticate = options.authenticate || createAuthenticate({ auth: container.auth, store: container.store });
  app.use("/api/v1", apiRateLimit, apiRoutes(container, authenticate));

  if (options.mountLegacy !== false) {
    app.use("/api/devices", requireDashboardKey, requireAdminDevice, devicesRouter);
    app.use("/api/leads", requireDashboardKey, requireApprovedDevice, leadsRouter);
  }

  app.use(notFound);
  app.use(errorHandler);
  app.locals.container = container;
  return app;
}
