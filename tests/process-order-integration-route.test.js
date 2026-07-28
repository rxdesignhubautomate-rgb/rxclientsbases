import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { integrationsRoutes } from "../src/routes/integrations.routes.js";
import { errorHandler } from "../src/middleware/error-handler.js";

function appWith(secret = "a".repeat(40)) {
  const sync = vi.fn().mockResolvedValue({
    orderId: "ORD_SYNC_123",
    contactId: "CNT_123",
    externalOrderId: "PROC_1",
    created: true,
    status: "CONFIRMED",
    syncedAt: new Date()
  });
  const container = {
    env: { ORG_ID: "RXDH", PROCESS_ORDER_SYNC_SECRET: secret },
    processOrderSync: { sync }
  };
  const app = express();
  app.use(express.json());
  app.use("/", integrationsRoutes(container));
  app.use(errorHandler);
  return { app, sync };
}

describe("process order integration route", () => {
  it("rejects requests without the server integration secret", async () => {
    const { app, sync } = appWith();
    const response = await request(app).post("/process-orders").send({ externalOrderId: "PROC_1" });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INTEGRATION_UNAUTHORIZED");
    expect(sync).not.toHaveBeenCalled();
  });

  it("accepts a matching secret and forwards the organization-scoped payload", async () => {
    const secret = "b".repeat(40);
    const { app, sync } = appWith(secret);
    const body = {
      source: "RX_PROCESS_MANAGEMENT",
      externalOrderId: "PROC_1",
      order: { partyName: "Customer" }
    };
    const response = await request(app)
      .post("/process-orders")
      .set("x-process-sync-secret", secret)
      .send(body);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      data: { orderId: "ORD_SYNC_123", created: true }
    });
    expect(sync).toHaveBeenCalledWith("RXDH", body);
  });
});
