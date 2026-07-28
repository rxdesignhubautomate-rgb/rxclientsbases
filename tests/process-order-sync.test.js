import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./helpers/memory-store.js";
import { AuditService } from "../src/services/audit.service.js";
import { ContactService } from "../src/services/contact.service.js";
import { ProcessOrderSyncService } from "../src/services/process-order-sync.service.js";

function setup(seed = {}) {
  const store = new MemoryStore(seed);
  const audit = new AuditService(store);
  const contacts = new ContactService({
    store,
    audit,
    notifications: { create: vi.fn() }
  });
  const marketing = { attributeOrder: vi.fn().mockResolvedValue({ convertedCampaigns: 0 }) };
  const service = new ProcessOrderSyncService({ store, contacts, marketing, audit });
  return { store, contacts, marketing, service };
}

function payload(overrides = {}) {
  return {
    source: "RX_PROCESS_MANAGEMENT",
    externalOrderId: "RX-2026-001",
    order: {
      partyName: "Example Pharma",
      number: "9876543210",
      city: "Lucknow",
      orderDate: "2026-07-28",
      status: "ORDER RECEIVED",
      salesPerson: "Ankit",
      designer: "Saumya",
      orderDetails: "100 medicine catalogues",
      total: 25000,
      advance: 5000,
      updatedBy: "Admin",
      ...overrides
    }
  };
}

describe("process order sync", () => {
  it("creates a linked client/order and updates the same order on retry", async () => {
    const { store, marketing, service } = setup();

    const first = await service.sync("RXDH", payload());
    const second = await service.sync("RXDH", payload({
      status: "READY FOR DISPATCH",
      orderDetails: "100 revised medicine catalogues"
    }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.orderId).toBe(first.orderId);
    expect(marketing.attributeOrder).toHaveBeenCalledTimes(2);

    const orders = await store.find("orders", { filters: [["orgId", "==", "RXDH"]], limit: 20 });
    const contacts = await store.find("contacts", { filters: [["orgId", "==", "RXDH"]], limit: 20 });
    const items = await store.find("orderItems", { filters: [["orgId", "==", "RXDH"]], limit: 20 });
    expect(orders.items).toHaveLength(1);
    expect(contacts.items).toHaveLength(1);
    expect(items.items).toHaveLength(1);
    expect(orders.items[0]).toMatchObject({
      orderId: first.orderId,
      externalSource: "RX_PROCESS_MANAGEMENT",
      externalOrderId: "RX-2026-001",
      contactId: contacts.items[0].contactId,
      status: "READY_FOR_DISPATCH",
      totalAmount: 25000
    });
    expect(items.items[0].description).toBe("100 revised medicine catalogues");
  });

  it("reuses an existing CRM contact by normalized phone", async () => {
    const { contacts, store, service } = setup();
    const existing = await contacts.create("RXDH", {
      companyName: "Existing Customer",
      primaryPhone: "919876543210",
      relationshipType: "PROSPECT"
    });

    const result = await service.sync("RXDH", payload({ partyName: "Different process spelling" }));

    expect(result.contactId).toBe(existing.contactId);
    const allContacts = await store.find("contacts", { filters: [["orgId", "==", "RXDH"]], limit: 20 });
    expect(allContacts.items).toHaveLength(1);
    expect(allContacts.items[0]).toMatchObject({
      contactId: existing.contactId,
      relationshipType: "EXISTING_CLIENT"
    });
    expect(allContacts.items[0].tags).toContain("PROCESS_ORDER");
  });
});
