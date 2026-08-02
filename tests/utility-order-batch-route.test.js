import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { messagePolicyRoutes } from "../src/routes/message-policy.routes.js";
import { errorHandler } from "../src/middleware/error-handler.js";

function testApp() {
  const smartSend = vi.fn().mockResolvedValue({ queued: true, reason: "VERIFIED", messageId: "MSG_1001" });
  const orders = [
    { orderId: "ORD_1001", orgId: "RXDH", contactId: "CON_1001", orderNumber: "1001", status: "CONFIRMED", currency: "INR", totalAmount: 25000 },
    { orderId: "ORD_1002", orgId: "RXDH", contactId: "CON_1002", orderNumber: "1002", status: "DELIVERED", currency: "INR", totalAmount: 5000 }
  ];
  const container = {
    templateRegistry: {
      resolve: () => ({ key: "order_confirmation", category: "UTILITY", header: { type: "VIDEO", required: true } }),
      assertApproved: vi.fn().mockResolvedValue({ status: "APPROVED" })
    },
    media: {
      get: vi.fn().mockResolvedValue({ attachmentId: "ATT_BATCH_VIDEO", orgId: "RXDH", purpose: "UTILITY_TEMPLATE_ASSET", mimeType: "video/mp4" })
    },
    store: {
      getMany: vi.fn().mockResolvedValue(orders)
    },
    contacts: {
      get: vi.fn().mockImplementation(async (_orgId, contactId) => ({
        contactId,
        relationshipType: "EXISTING_CLIENT",
        companyName: contactId === "CON_1001" ? "Alpha Pharma" : "Beta Pharma"
      }))
    },
    smartMessages: { smartSend }
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { orgId: "RXDH", userId: "USR_OWNER", role: "OWNER" };
    next();
  });
  app.use("/", messagePolicyRoutes(container));
  app.use(errorHandler);
  return { app, smartSend };
}

describe("verified order Utility batch route", () => {
  it("queues active existing-client orders and skips terminal orders", async () => {
    const { app, smartSend } = testApp();
    const response = await request(app).post("/events/order-confirmed/batch").send({
      orderIds: ["ORD_1001", "ORD_1002"],
      templateKey: "order_confirmation",
      templateAttachmentId: "ATT_BATCH_VIDEO",
      confirmTransactionalUse: true
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({ requested: 2, queued: 1, skipped: 1, failed: 0 });
    expect(response.body.data.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: "ORD_1001", status: "QUEUED" }),
      expect.objectContaining({ orderId: "ORD_1002", status: "SKIPPED", reason: "ORDER_STATUS_DELIVERED" })
    ]));
    expect(smartSend).toHaveBeenCalledTimes(1);
    expect(smartSend.mock.calls[0][1]).toMatchObject({
      orderId: "ORD_1001",
      templateKey: "order_confirmation",
      templateAttachmentIds: ["ATT_BATCH_VIDEO"]
    });
  });

  it("requires an explicit transactional-use confirmation", async () => {
    const { app, smartSend } = testApp();
    const response = await request(app).post("/events/order-confirmed/batch").send({
      orderIds: ["ORD_1001"],
      templateKey: "order_confirmation",
      templateAttachmentId: "ATT_BATCH_VIDEO"
    });

    expect(response.status).toBe(400);
    expect(smartSend).not.toHaveBeenCalled();
  });
});
