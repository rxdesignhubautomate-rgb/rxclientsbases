import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
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
});
