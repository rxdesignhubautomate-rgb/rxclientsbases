import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { MemoryStore } from "./helpers/memory-store.js";
import { ClientDirectoryService } from "../src/services/client-directory.service.js";
import { activityOf, classificationProjection, inspectDestination, permissionVisibility, qualifyingOrder } from "../src/services/client-classification.js";
import { backfillClassificationPage, assertLocalMigrationEnvironment } from "../src/migrations/client-classification-backfill.js";
import { clientDirectoryRoutes } from "../src/routes/client-directory.routes.js";
import { MarketingService } from "../src/services/marketing.service.js";
import { makeCore } from "./helpers/core.js";
import { contactCreateSchema } from "../src/validators/schemas.js";

const owner = { orgId: "RXDH", userId: "OWNER1", role: "OWNER" };
const clock = Date.parse("2026-09-14T12:00:00Z");
function contact(id, patch = {}) {
  const value = { contactId: id, orgId: "RXDH", companyName: `Client ${id}`, relationshipType: "PROSPECT", primaryPhone: "+447911123456", ...patch };
  return { ...value, ...classificationProjection(value) };
}
function setup(seed = {}) {
  const store = new MemoryStore(seed);
  return { store, service: new ClientDirectoryService({ store, enabled: true, clock: () => clock }) };
}

describe("additive client classification", () => {
  it('offers active owner names without disclosing other organizations or private user fields', async () => {
    const { service } = setup({ users: { U1: { orgId: 'RXDH', active: true, name: 'Alice', email: 'private@example.test', passwordHash: 'private' }, U2: { orgId: 'OTHER', active: true, name: 'Another' }, U3: { orgId: 'RXDH', active: false, name: 'Archived' } } });
    expect(await service.owners(owner, { search: 'A' })).toEqual({ items: [{ value: 'U1', label: 'Alice' }], hasMore: false });
  });
  it("keeps omitted classification unknown even after HTTP schema validation", async () => {
    const core = makeCore();
    core.contacts.classificationEnabled = true;
    const created = await core.contacts.create("RXDH", contactCreateSchema.parse({ companyName: "Unreviewed record" }));
    expect(created.crmV1Relationship).toBe("unclassified");
    expect(created.crmV1NeedsReview).toBe(true);
    expect(created.marketingConsent).toMatchObject({ status: 'OPTED_IN', source: 'BUSINESS_OPT_IN_POLICY' });
  });

  it("preserves a reviewed tier and suppression through legacy contact edits", async () => {
    const core = makeCore();
    core.contacts.classificationEnabled = true;
    const c = await core.contacts.create("RXDH", { companyName: "Alpha", primaryPhone: "+447911123456", relationshipType: "PROSPECT" });
    const directory = new ClientDirectoryService({ store: core.store, enabled: true });
    await directory.review(owner, c.contactId, { relationship: "prospect", tier: "premium", expectedRevision: 0, reason: "Owner verified tier" });
    await core.store.update("contacts", c.contactId, { marketingConsent: { status: "OPTED_OUT" } });
    await core.contacts.update("RXDH", c.contactId, { companyName: "Beta", phones: ["+12133734253"] });
    const current = await core.contacts.get("RXDH", c.contactId);
    expect(current).toMatchObject({ crmV1Tier: "premium", crmV1SearchName: "beta", marketingConsent: { status: "OPTED_OUT" } });
  });

  it("stops the existing marketing conversion path from promoting cancelled, foreign or missing orders", async () => {
    const { store } = setup({ contacts: { a: contact("a") }, orders: {
      cancelled: { orderId: "cancelled", contactId: "a", orgId: "RXDH", status: "CANCELLED" },
      foreign: { orderId: "foreign", contactId: "a", orgId: "OTHER", status: "CONFIRMED" }
    } });
    const marketing = new MarketingService({ store });
    marketing.stopContactEnrollments = vi.fn();
    for (const id of ["cancelled", "foreign", "missing"]) {
      expect(await marketing.attributeOrder("RXDH", "a", id)).toMatchObject({ ignored: true, convertedCampaigns: 0 });
    }
    expect(marketing.stopContactEnrollments).not.toHaveBeenCalled();
    expect((await store.get("contacts", "a")).relationshipType).toBe("PROSPECT");
  });
  it("keeps premium customer inactive without conflating dimensions", () => {
    const c = contact("a", { relationshipType: "EXISTING_CLIENT", crmV1Tier: "premium", crmV1LastMeaningfulAtMs: clock - 100 * 86400000 });
    expect(c.crmV1Relationship).toBe("customer");
    expect(c.crmV1Tier).toBe("premium");
    expect(activityOf(c, { nowMs: clock })).toBe("inactive");
    expect(activityOf({ lastInteractionAt: new Date(clock), lastMarketingAt: new Date(clock) })).toBe("unknown");
    expect(activityOf({ crmV1LastMeaningfulAtMs: clock + 1 }, { nowMs: clock })).toBe("unknown");
  });

  it("does not treat unknown legacy types or consent as classified or sendable", () => {
    expect(classificationProjection({}).crmV1Relationship).toBe("unclassified");
    expect(permissionVisibility({ marketingConsent: { status: "OPTED_IN", source: "IMPORT" } })).toMatchObject({ state: "granted", eligible: true });
    expect(permissionVisibility({ marketingConsent: { status: "OPTED_OUT" } })).toMatchObject({ state: "suppressed", eligible: false });
    expect(permissionVisibility({ doNotMarket: true }).state).toBe("suppressed");
  });

  it("parses explicit countries and preserves text, without a default +91", () => {
    expect(inspectDestination("07911 123456", "GB")).toMatchObject({ original: "07911 123456", e164: "+447911123456" });
    expect(inspectDestination("9876543210").reason).toBe("COUNTRY_REQUIRED");
    expect(inspectDestination("9876543210", "IN").e164).toBe("+919876543210");
    expect(inspectDestination("001 213 373 4253").e164).toBe("+12133734253");
    expect(inspectDestination("=SUM(1,2)").e164).toBeNull();
    expect(inspectDestination("9.1987654321E+11").e164).toBeNull();
    expect(inspectDestination(919876543210).reason).toBe("PHONE_MUST_BE_TEXT");
  });

  it("requires a real qualifying order and preserves first order evidence after cancellation", async () => {
    const { store, service } = setup({ contacts: { a: contact("a") }, orders: { one: { orgId: "RXDH", orderId: "one", contactId: "a", status: "DRAFT" } } });
    expect(await service.recordQualifyingOrder("RXDH", "one")).toBe(false);
    await store.update("orders", "one", { status: "CONFIRMED", isTest: true });
    expect(await service.recordQualifyingOrder("RXDH", "one")).toBe(false);
    await store.update("orders", "one", { isTest: false, orderDate: new Date(clock) });
    expect(await service.recordQualifyingOrder("RXDH", "one")).toBe(true);
    expect(await service.recordQualifyingOrder("RXDH", "one")).toBe(false);
    await store.update("orders", "one", { status: "CANCELLED" });
    expect(await service.recordQualifyingOrder("RXDH", "one")).toBe(false);
    expect(await store.get("contacts", "a")).toMatchObject({ crmV1Relationship: "customer", crmV1FirstOrderId: "one", crmV1Revision: 1 });
    expect(qualifyingOrder({ quotationId: "q", contactId: "a", status: "CONFIRMED" })).toBe(false);
  });

  it("does not manufacture order dates or cross tenant links", async () => {
    const { store, service } = setup({ contacts: { a: contact("a") }, orders: { x: { orderId: "x", orgId: "OTHER", contactId: "a", status: "CONFIRMED" }, y: { orderId: "y", orgId: "RXDH", contactId: "a", status: "CONFIRMED" } } });
    expect(await service.recordQualifyingOrder("RXDH", "x")).toBe(false);
    await service.recordQualifyingOrder("RXDH", "y");
    expect(activityOf(await store.get("contacts", "a"))).toBe("unknown");
  });
});

describe("directory permissions and bounded queries", () => {
  it("uses identical search/view filters for rows and counts and reports overlap", async () => {
    const { service } = setup({ contacts: {
      a: contact("a", { companyName: "Alpha", crmV1Tier: "premium", relationshipType: "EXISTING_CLIENT", crmV1LastMeaningfulAtMs: clock - 100 * 86400000 }),
      b: contact("b", { companyName: "Beta" }), foreign: contact("foreign", { orgId: "OTHER" })
    } });
    const result = await service.list(owner, { search: "AL", view: "premium" });
    expect(result.count).toBe(1);
    expect(result.items.map(v => v.contactId)).toEqual(["a"]);
    const { counts, overlapping } = await service.counts(owner, "Al");
    expect(counts).toMatchObject({ all: 1, existing: 1, premium: 1, inactive: 1, future: 0 });
    expect(overlapping).toBe(true);
  });

  it("paginates without downloading the directory; shared destinations do not merge records", async () => {
    const contacts = Object.fromEntries(Array.from({ length: 151 }, (_, i) => [`c${i}`, contact(`c${i}`)]));
    const { store, service } = setup({ contacts });
    const find = vi.spyOn(store, "find");
    const first = await service.list(owner, { limit: 50 });
    const second = await service.list(owner, { limit: 50, cursor: first.pagination.nextCursor });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(50);
    expect(new Set([...first.items, ...second.items].map(v => v.contactId)).size).toBe(100);
    expect(first.count).toBe(151);
    expect(find.mock.calls.every(([, q]) => q.limit === 50 && !q.search)).toBe(true);
    expect(store.bucket("contacts").size).toBe(151);
    await expect(service.list(owner, { limit: 10000 })).rejects.toThrow();
    await expect(service.list(owner, { arbitrarySql: "1=1" })).rejects.toThrow();
  });

  it("restricts scope, cursors, records and capabilities consistently", async () => {
    const sales = { ...owner, role: "SALES", userId: "S1", clientScope: "ASSIGNED", permissions: ["contacts.read_assigned", "contacts.classify"] };
    const { service } = setup({ contacts: { a: contact("a", { assignedTo: "S1" }), b: contact("b", { assignedTo: "S2" }), c: contact("c", { orgId: "OTHER" }) } });
    expect((await service.capabilities(sales)).totalRecords).toBe(1);
    expect((await service.list(sales)).count).toBe(1);
    await expect(service.profile(sales, "b")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.profile(owner, "c")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.list(sales, { cursor: Buffer.from(JSON.stringify({ id: "b" })).toString("base64url") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.list({ ...sales, permissions: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires separate tier rights, a reason and an optimistic revision; preserves all history", async () => {
    const { store, service } = setup({ contacts: { a: contact("a", { assignedTo: "S1", notes: "preserved", marketingConsent: { status: "OPTED_OUT" } }) }, orders: { old: { contactId: "a", orgId: "RXDH" } } });
    const body = { relationship: "prospect", tier: "premium", expectedRevision: 0, reason: "Reviewed account relationship" };
    const sales = { ...owner, role: "SALES", userId: "S1", permissions: ["contacts.read_assigned", "contacts.classify"] };
    await expect(service.review(sales, "a", body)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const value = await service.review(owner, "a", body);
    expect(value).toMatchObject({ tier: "premium", revision: 1, permission: { state: "suppressed", eligible: false } });
    expect(await store.get("contacts", "a")).toMatchObject({ notes: "preserved", marketingConsent: { status: "OPTED_OUT" } });
    expect(store.bucket("auditLogs").size).toBe(1);
    expect(await store.get("orders", "old")).toMatchObject({ contactId: "a" });
    await expect(service.review(owner, "a", body)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.bucket("auditLogs").size).toBe(1);
  });

  it("does not imply full preparation or unique company/sendable counts", async () => {
    const { service } = setup({ contacts: { a: contact("a"), b: { orgId: "RXDH", contactId: "b" } } });
    expect(await service.capabilities(owner)).toMatchObject({ totalRecords: 2, preparedRecords: 1, pendingPreparation: 1, companyCount: null, uniqueSendableDestinations: null, outboundEnabled: false });
  });
});

describe("safe migration and HTTP boundary", () => {
  it("is dry-run by default, resumable, idempotent and additive", async () => {
    const { store } = setup({ contacts: { a: { orgId: "RXDH", notes: "keep", primaryPhone: "01234", marketingConsent: { status: "OPTED_OUT" } }, b: { orgId: "RXDH", relationshipType: "EXISTING_CLIENT" } } });
    const dry = await backfillClassificationPage(store, { orgId: "RXDH", limit: 1 });
    expect(dry).toMatchObject({ scanned: 1, prepared: 1, committed: false });
    expect((await store.get("contacts", "a")).crmV1Version).toBeUndefined();
    const first = await backfillClassificationPage(store, { orgId: "RXDH", limit: 1, commit: true });
    await backfillClassificationPage(store, { orgId: "RXDH", cursor: first.nextCursor, commit: true });
    const repeated = await backfillClassificationPage(store, { orgId: "RXDH", commit: true });
    expect(repeated).toMatchObject({ prepared: 0, skipped: 2 });
    expect(await store.get("contacts", "a")).toMatchObject({ notes: "keep", primaryPhone: "01234", marketingConsent: { status: "OPTED_OUT" }, crmV1Relationship: "unclassified" });
  });

  it("refuses production, remote emulators and credentials before Firebase initialisation", () => {
    const local = { GCLOUD_PROJECT: "demo-rx-crm", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };
    expect(() => assertLocalMigrationEnvironment(local)).not.toThrow();
    for (const patch of [{ GCLOUD_PROJECT: "clientdatabase-10e9b" }, { NODE_ENV: "production" }, { FIRESTORE_EMULATOR_HOST: "remote.example:8080" }, { GOOGLE_APPLICATION_CREDENTIALS: "key.json" }, { FIREBASE_PRIVATE_KEY: "key" }]) {
      expect(() => assertLocalMigrationEnvironment({ ...local, ...patch })).toThrow(/refused/);
    }
  });

  it("routes deny disabled feature and reject ungranted edits", async () => {
    const { store, service } = setup({ contacts: { a: contact("a") } });
    let actor = { ...owner, role: "SALES", permissions: ["contacts.read_assigned"] };
    const app = express();
    app.use(express.json(), (req, _res, next) => { req.auth = actor; next(); });
    app.use("/client-directory", clientDirectoryRoutes(service));
    app.use((error, _req, res, _next) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ code: error.code }));
    expect((await request(app).patch("/client-directory/a/classification").send({})).status).toBe(403);
    actor = owner;
    expect((await request(app).get("/client-directory?limit=50000")).status).toBe(400);
    service.enabled = false;
    expect((await request(app).get("/client-directory")).status).toBe(404);
    expect((await request(app).get("/client-directory/capabilities")).body.data.outboundEnabled).toBe(false);
    expect(store.bucket("outbox").size).toBe(0);
  });
});
