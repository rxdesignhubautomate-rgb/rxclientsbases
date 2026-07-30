import { describe, expect, it } from "vitest";
import { MemoryStore } from "./helpers/memory-store.js";
import { TemplateRegistryService } from "../src/services/template-registry.service.js";
import { ChannelError } from "../src/channels/base-channel.adapter.js";

describe("Meta template registry", () => {
  it("syncs Meta status and permits only APPROVED templates", async () => {
    const store = new MemoryStore();
    const service = new TemplateRegistryService({
      store,
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en", category: "UTILITY", status: "APPROVED" },
          { id: "T2", name: "lead_reengagement_v1", language: "en", category: "MARKETING", status: "PAUSED" }
        ]
      }
    });
    expect(await service.syncFromMeta("RXDH")).toMatchObject({
      synced: 2,
      matched: 2,
      approved: 1,
      missing: 4
    });
    await expect(service.assertApproved("RXDH", "order_confirmation")).resolves.toMatchObject({ status: "APPROVED" });
    await expect(service.assertApproved("RXDH", "LEAD_REENGAGEMENT")).rejects.toThrow(/PAUSED/);
  });

  it("removes stale registry rows after a successful full Meta sync", async () => {
    const store = new MemoryStore();
    const service = new TemplateRegistryService({
      store,
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en", category: "UTILITY", status: "APPROVED" }
        ]
      }
    });
    await store.set("templateRegistry", "stale", {
      orgId: "RXDH",
      name: "old_template",
      language: "en",
      status: "APPROVED"
    });

    const result = await service.syncFromMeta("RXDH");

    expect(result).toMatchObject({ synced: 1, removed: 1, matched: 1, approved: 1 });
    expect(await store.get("templateRegistry", "stale")).toBeNull();
  });

  it("reports an actionable error when the Meta token is expired", async () => {
    const service = new TemplateRegistryService({
      store: new MemoryStore(),
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => {
          throw new ChannelError("Session has expired", {
            status: 401,
            code: "190",
            retryable: false,
            details: { errorSubcode: 463, type: "OAuthException", traceId: "trace-1" }
          });
        }
      }
    });

    await expect(service.syncFromMeta("RXDH")).rejects.toMatchObject({
      code: "META_TEMPLATE_SYNC_FAILED",
      status: 424,
      message: expect.stringMatching(/token is invalid or expired/i),
      details: {
        providerCode: "190",
        providerStatus: 401,
        errorSubcode: 463,
        type: "OAuthException",
        traceId: "trace-1",
        wabaIdEnding: "2345"
      }
    });
  });

  it("reports configured template language mismatches when nothing can be matched", async () => {
    const service = new TemplateRegistryService({
      store: new MemoryStore(),
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en_US", category: "UTILITY", status: "APPROVED" }
        ]
      }
    });

    let caught;
    try {
      await service.syncFromMeta("RXDH");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "META_TEMPLATES_NOT_MATCHED",
      status: 424,
      details: {
        wabaIdEnding: "2345",
        remoteTemplateCount: 1,
        expectedTemplates: expect.any(Array),
        receivedTemplates: [
          { name: "rx_order_confirmation", language: "en_US", status: "APPROVED" }
        ]
      }
    });
    expect(caught.message).toMatch(/expects en, but Meta has en_US/);
    expect(caught.details.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/expects en, but Meta has en_US/)
    ]));
  });
});
