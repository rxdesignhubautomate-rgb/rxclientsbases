import { describe, expect, it } from "vitest";
import { MemoryStore } from "./helpers/memory-store.js";
import { TemplateRegistryService } from "../src/services/template-registry.service.js";

describe("Meta template registry", () => {
  it("syncs Meta status and permits only APPROVED templates", async () => {
    const store = new MemoryStore();
    const service = new TemplateRegistryService({
      store,
      businessAccountId: "WABA_1",
      whatsappAdapter: {
        listMessageTemplates: async () => [
          { id: "T1", name: "rx_order_confirmation", language: "en", category: "UTILITY", status: "APPROVED" },
          { id: "T2", name: "lead_reengagement_v1", language: "en", category: "MARKETING", status: "PAUSED" }
        ]
      }
    });
    expect(await service.syncFromMeta("RXDH")).toMatchObject({ synced: 2 });
    await expect(service.assertApproved("RXDH", "order_confirmation")).resolves.toMatchObject({ status: "APPROVED" });
    await expect(service.assertApproved("RXDH", "LEAD_REENGAGEMENT")).rejects.toThrow(/PAUSED/);
  });
});
