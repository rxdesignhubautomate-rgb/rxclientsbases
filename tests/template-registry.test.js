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
      matched: 1,
      approved: 1,
      missing: 5
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

  it("does not block a successful sync when stale cleanup is unavailable", async () => {
    const store = new MemoryStore();
    store.find = async () => {
      throw new Error("cleanup query unavailable");
    };
    const service = new TemplateRegistryService({
      store,
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en", category: "UTILITY", status: "APPROVED" }
        ]
      }
    });

    const result = await service.syncFromMeta("RXDH");

    expect(result).toMatchObject({ synced: 1, matched: 1, approved: 1, removed: 0 });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/stale registry cleanup was skipped/i)
    ]));
  });

  it("returns an actionable error when Firestore cannot save fetched templates", async () => {
    const store = new MemoryStore();
    store.batchUpdate = async () => {
      const error = new Error("7 PERMISSION_DENIED: missing permission");
      error.code = 7;
      throw error;
    };
    const service = new TemplateRegistryService({
      store,
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en", category: "UTILITY", status: "APPROVED" }
        ]
      }
    });

    await expect(service.syncFromMeta("RXDH")).rejects.toMatchObject({
      code: "TEMPLATE_REGISTRY_SAVE_FAILED",
      status: 424,
      details: { provider: "FIRESTORE", providerCode: "7" }
    });
  });

  it("stores Meta component examples without Firestore-invalid nested arrays", async () => {
    const store = new MemoryStore();
    const service = new TemplateRegistryService({
      store,
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          {
            id: "T1",
            name: "rx_order_confirmation",
            language: "en",
            category: "UTILITY",
            status: "APPROVED",
            components: [
              {
                type: "BODY",
                text: "Hello {{1}}, order {{2}} is confirmed.",
                example: { body_text: [["Amit", "ORDER-1"]] }
              }
            ]
          }
        ]
      }
    });

    await service.syncFromMeta("RXDH");
    const saved = await service.getStatus("RXDH", "rx_order_confirmation", "en");

    expect(saved).toMatchObject({
      componentCount: 1,
      componentTypes: ["BODY"]
    });
    expect(saved.components).toBeUndefined();
    expect(saved.componentsJson).toContain('"body_text":[["Amit","ORDER-1"]]');
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

  it("matches a single regional Meta language and returns its provider language for sending", async () => {
    const service = new TemplateRegistryService({
      store: new MemoryStore(),
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en_US", category: "UTILITY", status: "APPROVED" }
        ]
      }
    });

    const result = await service.syncFromMeta("RXDH");

    expect(result).toMatchObject({ synced: 1, matched: 1, approved: 1, missing: 5 });
    expect(result.configured[0]).toMatchObject({
      name: "rx_order_confirmation",
      language: "en",
      providerLanguage: "en_US",
      matched: true,
      status: "APPROVED"
    });
    await expect(service.assertApproved("RXDH", "order_confirmation")).resolves.toMatchObject({
      language: "en_US",
      status: "APPROVED"
    });
  });

  it("automatically refreshes Meta once when an approved template is missing locally", async () => {
    let calls = 0;
    const service = new TemplateRegistryService({
      store: new MemoryStore(),
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => {
          calls += 1;
          return [
            { id: "T1", name: "1_marketing", language: "en_US", category: "MARKETING", status: "APPROVED" }
          ];
        }
      }
    });

    await expect(service.assertApproved("RXDH", "interest_followup")).resolves.toMatchObject({
      name: "1_marketing",
      language: "en_US",
      status: "APPROVED"
    });
    expect(calls).toBe(1);
  });

  it("keeps multiple regional languages ambiguous until an exact override is configured", async () => {
    const service = new TemplateRegistryService({
      store: new MemoryStore(),
      businessAccountId: "123456789012345",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en_US", category: "UTILITY", status: "APPROVED" },
          { id: "T2", name: "rx_order_confirmation", language: "en_GB", category: "UTILITY", status: "APPROVED" }
        ]
      }
    });

    await expect(service.syncFromMeta("RXDH")).rejects.toMatchObject({
      code: "META_TEMPLATES_NOT_MATCHED",
      status: 424
    });
  });
});
