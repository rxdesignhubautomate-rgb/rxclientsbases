import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppMetaAdapter } from "../src/channels/whatsapp/whatsapp.adapter.js";

describe("WhatsApp adapter webhook verification", () => {
  it("accepts a valid Meta HMAC and rejects an invalid signature", async () => {
    const secret = "test-app-secret";
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    const adapter = new WhatsAppMetaAdapter({ accessToken: "test", appSecret: secret, fetchImpl: async () => null });
    await expect(adapter.verifyWebhook({ rawBody: body, signature })).resolves.toBe(true);
    await expect(adapter.verifyWebhook({ rawBody: body, signature: "sha256=bad" })).resolves.toBe(false);
  });

  it("uploads media bytes as multipart form data and returns the Meta media id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-media-1" })
    });
    const adapter = new WhatsAppMetaAdapter({
      accessToken: "test-token",
      appSecret: "secret",
      graphApiVersion: "v25.0",
      fetchImpl
    });

    const mediaId = await adapter.uploadMedia({
      account: { phoneNumberId: "phone-id" },
      buffer: Buffer.from("image-bytes"),
      mimeType: "image/jpeg",
      filename: "sample.jpg"
    });

    expect(mediaId).toBe("meta-media-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/phone-id/media");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(options.headers["Content-Type"]).toBeUndefined();
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get("messaging_product")).toBe("whatsapp");
    expect(options.body.get("type")).toBe("image/jpeg");
    expect(await options.body.get("file").text()).toBe("image-bytes");
  });

  it("rejects a successful upload response that has no media id", async () => {
    const adapter = new WhatsAppMetaAdapter({
      accessToken: "test-token",
      appSecret: "secret",
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    });

    await expect(adapter.uploadMedia({
      account: { phoneNumberId: "phone-id" },
      buffer: Buffer.from("file"),
      mimeType: "application/pdf",
      filename: "sample.pdf"
    })).rejects.toMatchObject({ code: "MEDIA_UPLOAD_NO_ID", retryable: true });
  });

  it("sends media by id when available and keeps signed-link fallback", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.${requests.length}` }] }) };
    });
    const adapter = new WhatsAppMetaAdapter({
      accessToken: "test-token",
      appSecret: "secret",
      fetchImpl
    });
    const account = {
      phoneNumberId: "phone-id",
      status: "ACTIVE",
      sendEnabled: true
    };
    const message = {
      recipientId: "919876543210",
      type: "IMAGE",
      text: "Sample image"
    };

    await adapter.sendMessage({
      account,
      message,
      attachments: [{ providerMediaId: "meta-media-4", signedUrl: "https://storage.test/image.jpg" }]
    });
    await adapter.sendMessage({
      account,
      message,
      attachments: [{ signedUrl: "https://storage.test/image.jpg" }]
    });

    expect(requests[0].image).toMatchObject({ id: "meta-media-4", caption: "Sample image" });
    expect(requests[0].image.link).toBeUndefined();
    expect(requests[1].image).toMatchObject({
      link: "https://storage.test/image.jpg",
      caption: "Sample image"
    });
  });
});
