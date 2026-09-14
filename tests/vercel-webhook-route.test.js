import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { waitUntil } from "@vercel/functions";
import { webhooksRoutes } from "../src/routes/webhooks.routes.js";

describe("Vercel webhook background processing", () => {
  it("wakes the persistent worker only after durable receipt on Render", async () => {
    const wake = vi.fn();
    const container = { env: { WORKERS_ENABLED: true }, webhook: { receiveWhatsApp: vi.fn().mockResolvedValue({ duplicate: false, webhookEventId: 'event' }) }, workers: { inbound: { wake } } };
    const app = express(); app.use(express.json()); app.use(webhooksRoutes(container));
    expect((await request(app).post('/whatsapp').send({})).status).toBe(200);
    expect(wake).toHaveBeenCalledOnce();
    expect(waitUntil).not.toHaveBeenCalled();
    container.webhook.receiveWhatsApp.mockRejectedValueOnce(new Error('storage failed'));
    expect((await request(app).post('/whatsapp').send({})).status).toBe(500);
    expect(wake).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    delete process.env.VERCEL;
    vi.clearAllMocks();
  });

  it("acknowledges Meta and schedules the stored event with waitUntil", async () => {
    process.env.VERCEL = "1";
    const processOne = vi.fn().mockResolvedValue(true);
    const receiveWhatsApp = vi.fn().mockResolvedValue({
      duplicate: false,
      webhookEventId: "WHE_TEST"
    });
    const container = {
      env: { META_VERIFY_TOKEN: "verify" },
      webhook: { receiveWhatsApp },
      workers: { inbound: { processOne } }
    };
    const app = express();
    app.use(express.json());
    app.use(webhooksRoutes(container));

    const response = await request(app)
      .post("/whatsapp")
      .set("x-hub-signature-256", "sha256=test")
      .send({ object: "whatsapp_business_account" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: false });
    expect(processOne).toHaveBeenCalledWith({ webhookEventId: "WHE_TEST" });
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
