import { describe, it, expect, vi } from "vitest";
import { MemoryStore } from "./helpers/memory-store.js";
import { marketingOverview } from "../src/services/marketing-overview.js";
import { MarketingService } from "../src/services/marketing.service.js";
import { MarketingTemplateService } from "../src/services/marketing-template.service.js";

describe("simple marketing overview", () => {
  it("counts beyond one page, deduplicates replies and separates opt-out from generic suppression", async () => {
    const contacts = Object.fromEntries(Array.from({ length: 1005 }, (_, i) => [`C${i}`, { orgId: "RXDH", contactId: `C${i}`, relationshipType: "EXISTING_CLIENT", assignedTo: "A" }]));
    contacts.C0.marketingOptOut = true;
    contacts.C0.marketingConsent = { status: "OPTED_OUT" };
    contacts.C1.optInStatus = "OPTED_OUT";
    contacts.C2.marketingConsent = { status: "OPTED_OUT" };
    contacts.C3.suppressed = true;
    contacts.foreign = { orgId: "OTHER", marketingOptOut: true };
    const store = new MemoryStore({ contacts, marketingProspects: {
      R1: { orgId: "RXDH", contactId: "C1004" }, R2: { orgId: "RXDH", contactId: "C1004" },
      R3: { orgId: "RXDH", contactId: "deleted" }, R4: { orgId: "OTHER", contactId: "C0" }
    } });
    expect(await marketingOverview(store, "RXDH", { role: "ADMIN" })).toEqual({ totalContacts: 1005, replied: 1, optedOut: 3 });
    expect(await marketingOverview(store, "RXDH", { role: "SALES", clientScope: "PROSPECT" })).toEqual({ totalContacts: 0, replied: 0, optedOut: 0 });
    expect(await marketingOverview(store, "RXDH", { role: "SALES", clientScope: "ASSIGNED", userId: "B" })).toEqual({ totalContacts: 0, replied: 0, optedOut: 0 });
  });
});

function previewService({ smart = true, mode = "AUTO" } = {}) {
  const store = new MemoryStore({ marketingCampaigns: { B1: {
    campaignId: "B1", orgId: "RXDH", name: "Batch 01", relationshipType: "EXISTING_CLIENT", createdBy: "A",
    status: "DRAFT", audienceId: "A1", templateId: "interest_followup", interestLabel: "Visual aids",
    deliveryMode: mode, templateHeaderAttachmentId: "VIDEO", steps: [{ position: 1, delayMinutes: 0, messageLine: "Our visual aid service.", attachmentIds: [] }]
  } }, marketingAudiences: { A1: { orgId: "RXDH", audienceId: "A1", relationshipType: "EXISTING_CLIENT", contactCount: 500 } } });
  const service = new MarketingService({ store, templates: new MarketingTemplateService(), smartMessages: smart ? {} : null });
  return { store, service };
}

describe("read-only batch preview", () => {
  it("uses the send template renderer and exposes the distinct open-window message without writing", async () => {
    const { store, service } = previewService();
    const set = vi.spyOn(store, "set"), update = vi.spyOn(store, "update"), tx = vi.spyOn(store, "runTransaction");
    const result = await service.previewCampaign("RXDH", "B1", { role: "ADMIN" });
    expect(result.contactCount).toBe(500);
    const [template, recentReply] = result.steps[0].variants;
    expect(template.templateName).toBe("1_marketing");
    expect(template.text).toBe(service.templates.prepare("interest_followup", { customer_name: "Customer" }).text);
    expect(template.attachmentIds).toEqual(["VIDEO"]);
    expect(recentReply.text).toBe("Our visual aid service.");
    expect(recentReply.attachmentIds).toEqual([]);
    expect(set).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(tx).not.toHaveBeenCalled();
  });
  it("respects delivery mode and backend capabilities", async () => {
    const open = previewService({ mode: "OPEN_WINDOW_ONLY" });
    expect((await open.service.previewCampaign("RXDH", "B1")).steps[0].variants).toHaveLength(1);
    expect((await open.service.previewCampaign("RXDH", "B1")).steps[0].variants[0].text).toBe("Our visual aid service.");
    const legacy = previewService({ smart: false });
    expect((await legacy.service.previewCampaign("RXDH", "B1")).steps[0].variants).toHaveLength(1);
  });
  it("rejects another organization, segment and assigned salesperson", async () => {
    const { service } = previewService();
    await expect(service.previewCampaign("OTHER", "B1", { role: "ADMIN" })).rejects.toThrow();
    await expect(service.previewCampaign("RXDH", "B1", { role: "SALES", clientScope: "PROSPECT" })).rejects.toThrow();
    await expect(service.previewCampaign("RXDH", "B1", { role: "SALES", clientScope: "ASSIGNED", userId: "B" })).rejects.toThrow();
  });
});
