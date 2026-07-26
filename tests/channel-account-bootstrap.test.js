import { describe, expect, it } from "vitest";
import { ensureWhatsAppChannelAccount } from "../src/bootstrap/whatsapp-channel-account.js";
import { AuditService } from "../src/services/audit.service.js";
import { ChannelAccountService } from "../src/services/channel-account.service.js";
import { MemoryStore } from "./helpers/memory-store.js";

function createTestContainer(seed = {}) {
  const store = new MemoryStore(seed);
  const audit = new AuditService(store);
  return {
    store,
    channelAccounts: new ChannelAccountService({ store, audit }),
    env: {
      ORG_ID: "RXDH",
      ORG_TIMEZONE: "Asia/Kolkata",
      ORG_CURRENCY: "INR",
      DEFAULT_CHANNEL_ACCOUNT_ID: "WA_RX_01",
      META_PHONE_NUMBER_ID: "phone-123",
      META_WHATSAPP_BUSINESS_ACCOUNT_ID: "waba-123"
    }
  };
}

describe("WhatsApp channel account bootstrap", () => {
  it("creates an active default account from server configuration", async () => {
    const container = createTestContainer();

    const result = await ensureWhatsAppChannelAccount(container);

    expect(result.changed).toBe(true);
    expect(result.account).toMatchObject({
      channelAccountId: "WA_RX_01",
      orgId: "RXDH",
      channel: "WHATSAPP",
      provider: "META_CLOUD_API",
      phoneNumberId: "phone-123",
      businessAccountId: "waba-123",
      status: "ACTIVE",
      sendEnabled: true,
      receiveEnabled: true,
      isDefault: true
    });
    await expect(container.channelAccounts.resolveForSend("RXDH", "WHATSAPP")).resolves.toMatchObject({
      channelAccountId: "WA_RX_01"
    });
  });

  it("preserves an already working default account", async () => {
    const container = createTestContainer({
      channelAccounts: {
        WA_MANUAL: {
          channelAccountId: "WA_MANUAL",
          orgId: "RXDH",
          channel: "WHATSAPP",
          provider: "META_CLOUD_API",
          phoneNumberId: "manual-phone",
          businessAccountId: "manual-waba",
          status: "ACTIVE",
          sendEnabled: true,
          receiveEnabled: true,
          isDefault: true,
          createdAt: new Date()
        }
      }
    });

    const result = await ensureWhatsAppChannelAccount(container);

    expect(result.changed).toBe(false);
    expect(result.account.phoneNumberId).toBe("manual-phone");
    expect(await container.store.get("channelAccounts", "WA_RX_01")).toBeNull();
  });
});
