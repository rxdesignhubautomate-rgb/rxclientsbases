import { describe, expect, it } from "vitest";
import { makeCore } from "./helpers/core.js";
import { OrderRegisterImportService } from "../src/services/order-register-import.service.js";

const headers = [
  "ORDER DATE",
  "ASSIGNED DATE",
  "STATUS",
  "SALES PERSON",
  "PARTY NAME",
  "Number",
  "CITY",
  "",
  "ORDER",
  "RATE",
  "ADVANCE",
  "FINAL PAYMENT DATE",
  "FINAL",
  "TOTAL"
];

describe("OrderRegisterImportService", () => {
  it("previews the legacy register without importing phantom rows", () => {
    const core = makeCore();
    const service = new OrderRegisterImportService({ ...core, audit: core.audit });
    const preview = service.preview({
      sourceName: "sample.tsv",
      headers,
      rows: [
        ["1-Apr-2026", "13-Apr-2026", "DISPATCHED", "PRIYA", "FITKAM", "9262547154", "8 days mail", "SAUMYA", "12 PG 5 VA", "visual 5*500", "2000", "30-Apr-2026", "1150", "3550"],
        ["2-Mar-2026", "9-May-2026", "", "", "", "", "", "", "", "", "", "9-Jan-2026", "", ""]
      ]
    });

    expect(preview.summary).toMatchObject({
      sourceRows: 2,
      usableRows: 1,
      skippedBlankRows: 1,
      totalOrderValue: 3550
    });
    expect(preview.rows[0]).toMatchObject({
      partyName: "FITKAM",
      phone: "919262547154",
      advanceAmount: 2000,
      finalPaymentAmount: 1150,
      status: "DISPATCHED"
    });
  });

  it("creates an existing client, order and payments idempotently", async () => {
    const core = makeCore();
    const service = new OrderRegisterImportService({ ...core, audit: core.audit });
    const input = {
      sourceName: "sample.tsv",
      headers,
      rows: [["1-Apr-2026", "13-Apr-2026", "DISPATCHED", "PRIYA", "FITKAM", "9262547154", "8 days mail", "SAUMYA", "12 PG 5 VA", "visual 5*500", "2000", "30-Apr-2026", "1150", "3550"]]
    };

    const first = await service.commit("RXDH", input, { userId: "USR_ADMIN" });
    expect(first.result).toMatchObject({
      createdClients: 1,
      createdOrders: 1,
      createdPayments: 2,
      failed: 0
    });
    const contacts = await core.store.find("contacts", { limit: 10 });
    const overview = await core.contacts.overview("RXDH", contacts.items[0].contactId);
    expect(overview.contact.relationshipType).toBe("EXISTING_CLIENT");
    expect(overview.summary).toMatchObject({ totalOrders: 1, totalValue: 3550, paidAmount: 3150, outstandingAmount: 400 });

    const second = await service.commit("RXDH", input, { userId: "USR_ADMIN" });
    expect(second.result).toMatchObject({ createdClients: 0, createdOrders: 0, skippedExisting: 1, failed: 0 });
  });
});
