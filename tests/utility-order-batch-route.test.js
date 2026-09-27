import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { messagePolicyRoutes } from "../src/routes/message-policy.routes.js";
import { errorHandler } from "../src/middleware/error-handler.js";

function testApp(options = {}) {
  const smartSend = vi.fn().mockResolvedValue({ queued: true, reason: "VERIFIED", messageId: "MSG_1001" });
  const orders = options.orders || [
    { orderId: "ORD_1001", orgId: "RXDH", contactId: "CON_1001", orderNumber: "1001", status: "CONFIRMED", currency: "INR", totalAmount: 25000 },
    { orderId: "ORD_1002", orgId: "RXDH", contactId: "CON_1002", orderNumber: "1002", status: "DELIVERED", currency: "INR", totalAmount: 5000 }
  ];
  const container = {
    templateRegistry: {
      resolve: () => ({ key: "order_confirmation", category: "UTILITY", header: { type: "VIDEO", required: true } }),
      assertApproved: vi.fn().mockResolvedValue({ status: "APPROVED" }),
      resolveApprovedUtility: vi.fn().mockResolvedValue({
        template: {
          key: "meta:TPL_NEW",
          name: "new_order_update",
          category: "UTILITY",
          eventType: "GENERIC_UTILITY_UPDATE",
          body: "Hello {{customer_name}}, order {{2}} is {{3}}.",
          header: null,
          variables: [
            { key: "customer_name", label: "Customer name" },
            { key: "variable_2", label: "Variable 2" },
            { key: "variable_3", label: "Variable 3" }
          ]
        }
      })
    },
    media: {
      get: vi.fn().mockResolvedValue({ attachmentId: "ATT_BATCH_VIDEO", orgId: "RXDH", purpose: "UTILITY_TEMPLATE_ASSET", mimeType: "video/mp4" })
    },
    store: {
      getMany: vi.fn().mockResolvedValue(orders),
      get: vi.fn().mockImplementation(async (collection) => collection === "contactPhoneKeys" && options.phoneMatchContactId
        ? { orgId: "RXDH", contactId: options.phoneMatchContactId }
        : null),
      update: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(async (collection) => ({
        items: collection === "contacts"
          ? [
              { contactId: "CON_1001", orgId: "RXDH", relationshipType: "EXISTING_CLIENT", companyName: "Alpha Pharma" },
              { contactId: "CON_PROSPECT", orgId: "RXDH", relationshipType: "PROSPECT", companyName: "Prospect Pharma" }
            ]
          : collection === "messages" ? (options.messages || []) : orders,
        pagination: { nextCursor: null, hasMore: false }
      }))
    },
    contacts: {
      get: vi.fn().mockImplementation(async (_orgId, contactId) => ({
        contactId,
        relationshipType: "EXISTING_CLIENT",
        companyName: contactId === "CON_1001" ? "Alpha Pharma" : "Beta Pharma",
        primaryPhone: contactId === "CON_1001" ? "9876500101" : "9876500102"
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
  return { app, smartSend, store: container.store };
}

describe("verified order Utility batch route", () => {
  it("lists every existing client independently of order eligibility", async () => {
    const { app } = testApp();
    const response = await request(app).get("/events/order-confirmed/batch/clients?limit=1000");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ contactId: "CON_1001", relationshipType: "EXISTING_CLIENT" })
    ]);
  });

  it("lists active orders used to enable eligible client rows", async () => {
    const { app } = testApp();
    const response = await request(app).get("/events/order-confirmed/batch/orders?limit=1000");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ orderId: "ORD_1001", contactId: "CON_1001", status: "CONFIRMED" })
    ]);
  });

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

  it("skips utility orders already sent while allowing a confirmed failure to retry", async () => {
    const orders = [
      { orderId: "ORD_1001", orgId: "RXDH", contactId: "CON_1001", orderNumber: "1001", status: "CONFIRMED" },
      { orderId: "ORD_1003", orgId: "RXDH", contactId: "CON_1003", orderNumber: "1003", status: "CONFIRMED" }
    ];
    const messages = [
      { messageId: "MSG_OLD_SENT", orgId: "RXDH", contactId: "CON_1001", direction: "OUTBOUND", status: "DELIVERED", submissionState: "accepted", metadata: { templateCategory: "UTILITY", templateKey: "order_confirmation", orderId: "ORD_1001" } },
      { messageId: "MSG_OLD_FAILED", orgId: "RXDH", contactId: "CON_1003", direction: "OUTBOUND", status: "FAILED", submissionState: "failed", metadata: { templateCategory: "UTILITY", templateKey: "order_confirmation", orderId: "ORD_1003" } }
    ];
    const { app, smartSend } = testApp({ orders, messages });
    const response = await request(app).post("/events/order-confirmed/batch").send({
      orderIds: ["ORD_1001", "ORD_1003"],
      templateKey: "order_confirmation",
      templateAttachmentId: "ATT_BATCH_VIDEO",
      confirmTransactionalUse: true
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      requested: 2,
      queued: 1,
      skipped: 1,
      exclusionCounts: { ALREADY_SENT: 1 }
    });
    expect(smartSend).toHaveBeenCalledTimes(1);
    expect(smartSend.mock.calls[0][1].orderId).toBe("ORD_1003");
  });

  it("queues a newly synced Utility template with per-order variable mappings", async () => {
    const { app, smartSend } = testApp();
    const response = await request(app).post("/events/utility/batch").send({
      orderIds: ["ORD_1001"],
      templateKey: "meta:TPL_NEW",
      variableValues: {
        customer_name: "{{customer_name}}",
        variable_2: "{{order_reference}}",
        variable_3: "{{order_status}}"
      },
      confirmTransactionalUse: true
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      templateKey: "meta:TPL_NEW",
      templateName: "new_order_update",
      requested: 1,
      queued: 1,
      skipped: 0,
      failed: 0
    });
    expect(smartSend).toHaveBeenCalledWith("RXDH", expect.objectContaining({
      eventType: "GENERIC_UTILITY_UPDATE",
      orderId: "ORD_1001",
      templateKey: "meta:TPL_NEW",
      templateAttachmentIds: [],
      templateData: {
        customer_name: "Alpha Pharma",
        variable_2: "1001",
        variable_3: "CONFIRMED"
      },
      idempotencyKey: "UTILITY:meta:TPL_NEW:ORD_1001"
    }), expect.any(Object));
  });

  it("auto-links an unlinked active order by its unique phone before Utility sending", async () => {
    const orders = [{
      orderId: "ORD_UNLINKED",
      orgId: "RXDH",
      contactId: null,
      customerPhone: "9876500101",
      orderNumber: "UNLINKED-1",
      status: "CONFIRMED"
    }];
    const { app, smartSend, store } = testApp({ orders, phoneMatchContactId: "CON_1001" });
    const response = await request(app).post("/events/utility/batch").send({
      orderIds: ["ORD_UNLINKED"],
      templateKey: "meta:TPL_NEW",
      variableValues: { customer_name: "{{customer_name}}", variable_2: "{{order_reference}}", variable_3: "{{order_status}}" },
      confirmTransactionalUse: true
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({ requested: 1, queued: 1, skipped: 0, failed: 0 });
    expect(store.update).toHaveBeenCalledWith("orders", "ORD_UNLINKED", expect.objectContaining({
      contactId: "CON_1001",
      utilityAutoLinkedBy: "PHONE"
    }));
    expect(smartSend).toHaveBeenCalledWith("RXDH", expect.objectContaining({
      contactId: "CON_1001",
      orderId: "ORD_UNLINKED"
    }), expect.any(Object));
  });
});
