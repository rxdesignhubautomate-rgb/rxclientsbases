import { z } from "zod";
import { COLLECTIONS } from "../config/constants.js";
import { ConflictError, ForbiddenError, NotFoundError, AppError } from "../utils/errors.js";
import { decodeCursor } from "../utils/pagination.js";
import { relationshipTypesForScope } from "../utils/client-scope.js";
import { createId } from "../utils/ids.js";
import { CLASSIFICATION_VERSION, DIRECTORY_VIEWS, classificationProjection, relationshipOf, activityOf, inspectDestination, permissionVisibility, qualifyingOrder, timestampMs } from "./client-classification.js";

export const querySchema = z.object({
  view: z.enum(DIRECTORY_VIEWS).default("all"),
  search: z.string().trim().max(100).default(""),
  city: z.string().trim().max(120).optional(),
  owner: z.string().trim().max(150).optional(),
  relationship: z.enum(['unclassified', 'prospect', 'customer']).optional(),
  tier: z.enum(['standard', 'premium', 'vip']).optional(),
  activity: z.enum(['active', 'inactive', 'unknown']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1024).optional()
}).strict();
export const classificationReviewSchema = z.object({
  relationship: z.enum(["unclassified", "prospect", "customer"]),
  tier: z.enum(["standard", "premium", "vip"]),
  reason: z.string().trim().min(5).max(500),
  phoneCountryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  expectedRevision: z.number().int().min(0)
}).strict();

function requirePermission(actor, permission) {
  if (["OWNER", "ADMIN"].includes(actor.role) || actor.permissions?.includes("*") || actor.permissions?.includes(permission)) return;
  throw new ForbiddenError(`Missing permission: ${permission}`);
}

export class ClientDirectoryService {
  constructor({ store, enabled = false, inactivityDays = 90, clock = () => Date.now() }) {
    this.store = store;
    this.enabled = enabled;
    this.inactivityDays = inactivityDays;
    this.clock = clock;
  }

  ensureEnabled() {
    if (!this.enabled) throw new AppError("FEATURE_DISABLED", "Client classification review is not enabled", 404);
  }

  scope(actor) {
    if (!actor?.orgId || !actor.userId) throw new ForbiddenError();
    requirePermission(actor, actor.permissions?.includes("contacts.read_assigned") ? "contacts.read_assigned" : "contacts.read");
    const filters = [["orgId", "==", actor.orgId]];
    if (actor.role === "SALES") {
      const types = relationshipTypesForScope(actor.clientScope);
      if (types.length) filters.push(["relationshipType", types.length === 1 ? "==" : "in", types.length === 1 ? types[0] : types]);
      else filters.push(["assignedTo", "==", actor.userId]);
    } else if (!["OWNER", "ADMIN", "SALES_MANAGER"].includes(actor.role) && !actor.permissions?.includes("contacts.read") && !actor.permissions?.includes("*")) {
      filters.push(["assignedTo", "==", actor.userId]);
    }
    return filters;
  }

  async checkedContact(actor, contactId) {
    this.scope(actor);
    if (typeof contactId !== "string" || !contactId || contactId.length > 150 || contactId.includes("/")) throw new ConflictError("Invalid contact ID");
    const contact = await this.store.get(COLLECTIONS.contacts, contactId);
    if (!contact || contact.orgId !== actor.orgId) throw new NotFoundError("Contact");
    this.assertRecordScope(actor, contact);
    return contact;
  }

  async owners(actor, raw = {}) {
    this.ensureEnabled(); this.scope(actor);
    const { search } = z.object({ search: z.string().trim().max(100).default('') }).strict().parse(raw);
    const filters = [['orgId', '==', actor.orgId], ['active', '==', true]];
    if (search) filters.push(['name', '>=', search], ['name', '<=', `${search}\uf8ff`]);
    const page = await this.store.find('users', { filters, limit: 100, ...(search ? { orderBy: ['name', 'asc'] } : {}) });
    return { items: page.items.map(user => ({ value: user.userId || user.id, label: user.name || 'Unnamed team member' })), hasMore: page.pagination.hasMore };
  }

  assertRecordScope(actor, contact) {
    if (!contact || contact.orgId !== actor.orgId) throw new ForbiddenError();
    if (!this.scope(actor).every(([field, op, value]) => op === "in" ? value.includes(contact[field]) : contact[field] === value)) throw new ForbiddenError();
  }

  filters(actor, options, atMs) {
    const filters = [...this.scope(actor), ["crmV1Version", "==", CLASSIFICATION_VERSION]];
    for (const [key, field] of [['city', 'city'], ['owner', 'assignedTo'], ['relationship', 'crmV1Relationship'], ['tier', 'crmV1Tier']]) if (options[key]) filters.push([field, '==', options[key]]);
    if (options.activity === 'unknown') filters.push(['crmV1LastMeaningfulAtMs', '==', -1]);
    if (options.activity === 'active') filters.push(['crmV1LastMeaningfulAtMs', '>', atMs - this.inactivityDays * 86400000], ['crmV1LastMeaningfulAtMs', '<=', atMs]);
    if (options.activity === 'inactive' && options.view !== 'inactive') filters.push(['crmV1LastMeaningfulAtMs', '>=', 0], ['crmV1LastMeaningfulAtMs', '<=', atMs - this.inactivityDays * 86400000]);
    if (options.view === "existing") filters.push(["crmV1Relationship", "==", "customer"]);
    if (options.view === "future") filters.push(["crmV1Relationship", "==", "prospect"]);
    if (options.view === "premium") filters.push(["crmV1Tier", "in", ["premium", "vip"]]);
    if (options.view === "review") filters.push(["crmV1NeedsReview", "==", true]);
    if (options.view === "inactive") {
      filters.push(["crmV1LastMeaningfulAtMs", ">=", 0], ["crmV1LastMeaningfulAtMs", "<=", atMs - this.inactivityDays * 86400000]);
    }
    if (options.search) {
      const prefix = options.search.normalize("NFKC").toLowerCase();
      filters.push(["crmV1SearchName", ">=", prefix], ["crmV1SearchName", "<=", `${prefix}\uf8ff`]);
    }
    return filters;
  }

  async capabilities(actor) {
    this.scope(actor);
    if (!this.enabled) return { enabled: false, outboundEnabled: false };
    const base = this.scope(actor);
    const [totalRecords, preparedRecords] = await Promise.all([
      this.store.count(COLLECTIONS.contacts, { filters: base }),
      this.store.count(COLLECTIONS.contacts, { filters: [...base, ["crmV1Version", "==", CLASSIFICATION_VERSION]] })
    ]);
    return { enabled: true, outboundEnabled: false, totalRecords, preparedRecords,
      pendingPreparation: totalRecords - preparedRecords, inactivityDays: this.inactivityDays,
      metric: "contact_records", companyCount: null, uniqueSendableDestinations: null,
      canClassify: ["OWNER", "ADMIN"].includes(actor.role) || actor.permissions?.some(p => ["*", "contacts.classify"].includes(p)),
      canChangeTier: ["OWNER", "ADMIN"].includes(actor.role) || actor.permissions?.some(p => ["*", "contacts.tier"].includes(p)) };
  }

  async list(actor, input = {}) {
    this.ensureEnabled();
    const options = querySchema.parse(input);
    const atMs = this.clock();
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && (!cursor || cursor.includes("/"))) throw new ConflictError("Invalid directory cursor");
    if (cursor) await this.checkedContact(actor, cursor);
    const filters = this.filters(actor, options, atMs);
    const [result, count] = await Promise.all([
      this.store.find(COLLECTIONS.contacts, { filters, limit: options.limit, cursor,
        orderBy: [(options.view === "inactive" || ['active', 'inactive'].includes(options.activity)) && !options.search ? "crmV1LastMeaningfulAtMs" : "crmV1SearchName", "asc"],
        select: ["contactId", "orgId", "companyName", "contactPerson", "primaryPhone", "phoneCountryCode", "city", "assignedTo", "salesPersonName", "relationshipType", "crmV1Version", "crmV1Revision", "crmV1Relationship", "crmV1Tier", "crmV1LastMeaningfulAtMs", "crmV1NeedsReview", "crmV1ReviewedAt", "crmV1FirstOrderId", "marketingConsent", "marketingOptOut", "optInStatus", "doNotMarket", "stopAllCommunications", "crmCompanyIds", "status", "crmV1LastMarketingAtMs"] }),
      this.store.count(COLLECTIONS.contacts, { filters })
    ]);
    const permissions = this.marketingSafety ? await this.marketingSafety.inspectMany(actor.orgId, result.items) : null;
    return { ...result, items: result.items.map((item, index) => ({ ...this.present(item, atMs), ...(permissions ? { permission: permissions[index] } : {}) })), count,
      metric: "contact_records", calculatedAt: new Date(atMs).toISOString(), searchMode: "name_prefix" };
  }

  async counts(actor, search = "") {
    this.ensureEnabled();
    const options = querySchema.parse(typeof search === 'object' ? search : { search });
    const atMs = this.clock();
    const entries = await Promise.all(DIRECTORY_VIEWS.map(async view => [view, await this.store.count(COLLECTIONS.contacts, { filters: this.filters(actor, { ...options, view }, atMs) })]));
    return { counts: Object.fromEntries(entries), metric: "contact_records", overlapping: true, calculatedAt: new Date(atMs).toISOString() };
  }

  present(contact, atMs = this.clock()) {
    return { contactId: contact.contactId || contact.id, companyName: contact.companyName || "", contactPerson: contact.contactPerson || "",
      primaryPhone: contact.primaryPhone || "", city: contact.city || "", assignedTo: contact.assignedTo || null, salesPersonName: contact.salesPersonName || "",
      relationship: relationshipOf(contact), tier: classificationProjection(contact).crmV1Tier,
      activity: activityOf(contact, { nowMs: atMs, inactivityDays: this.inactivityDays }),
      lastMeaningfulAt: timestampMs(contact.crmV1LastMeaningfulAtMs), needsReview: classificationProjection(contact).crmV1NeedsReview,
      revision: contact.crmV1Revision || 0, destination: inspectDestination(contact.primaryPhone, contact.phoneCountryCode),
      permission: permissionVisibility(contact) };
  }

  async profile(actor, contactId) {
    this.ensureEnabled();
    return this.present(await this.checkedContact(actor, contactId));
  }

  async review(actor, contactId, raw) {
    this.ensureEnabled();
    requirePermission(actor, "contacts.classify");
    const input = classificationReviewSchema.parse(raw);
    await this.checkedContact(actor, contactId);
    const auditLogId = createId("auditLog");
    await this.store.runTransaction(async tx => {
      const current = await tx.get(COLLECTIONS.contacts, contactId);
      if (!current || current.orgId !== actor.orgId) throw new NotFoundError("Contact");
      this.assertRecordScope(actor, current);
      const before = classificationProjection(current);
      if (before.crmV1Revision !== input.expectedRevision) throw new ConflictError("Classification changed. Reload and review again.");
      if (before.crmV1Tier !== input.tier) requirePermission(actor, "contacts.tier");
      if (before.crmV1Relationship === "customer" && input.relationship !== "customer") throw new ConflictError("Customer history cannot be downgraded in classification review.");
      const timestamp = new Date(this.clock());
      const relationshipType = { unclassified: 'OTHER', prospect: 'PROSPECT', customer: 'EXISTING_CLIENT' }[input.relationship];
      const country = input.phoneCountryCode || current.phoneCountryCode;
      if (input.phoneCountryCode && !inspectDestination(current.primaryPhone, input.phoneCountryCode).e164) throw new ConflictError('The stored phone is not valid for this country; correct the number first');
      const patch = classificationProjection({ ...current, relationshipType, phoneCountryCode: country, crmV1Relationship: input.relationship, crmV1Tier: input.tier, crmV1ReviewedAt: timestamp });
      patch.relationshipType = relationshipType;
      if (country) patch.phoneCountryCode = country;
      Object.assign(patch, { crmV1ReviewedAt: timestamp, crmV1ReviewedBy: actor.userId, crmV1Revision: before.crmV1Revision + 1 });
      tx.update(COLLECTIONS.contacts, contactId, patch);
      if (current.relationshipType !== relationshipType) tx.set('automationJobs', `classification-${contactId}`, { orgId: actor.orgId, kind: 'CLASSIFICATION_FANOUT', contactId, relationshipType, status: 'PENDING', cursor: null, createdAt: timestamp });
      tx.create(COLLECTIONS.auditLogs, auditLogId, { auditLogId, orgId: actor.orgId, actorType: "USER", actorId: actor.userId,
        action: "CLIENT_CLASSIFICATION_REVIEWED", entityType: "CONTACT", entityId: contactId,
        before: { relationship: before.crmV1Relationship, tier: before.crmV1Tier, revision: before.crmV1Revision },
        after: { relationship: input.relationship, tier: input.tier, revision: patch.crmV1Revision }, metadata: { reason: input.reason }, createdAt: timestamp });
    });
    // A successful reclassification can move this record outside the actor's old segment.
    return this.present(await this.store.get(COLLECTIONS.contacts, contactId));
  }

  async recordQualifyingOrder(orgId, orderId) {
    if (!this.enabled) return false;
    return this.store.runTransaction(async tx => {
      const order = await tx.get(COLLECTIONS.orders, orderId);
      if (!order || order.orgId !== orgId || !qualifyingOrder(order)) return false;
      const contact = await tx.get(COLLECTIONS.contacts, order.contactId);
      if (!contact || contact.orgId !== orgId) throw new ConflictError("Order contact is outside this business");
      const sourceAt = timestampMs(order.confirmedAt || order.orderDate);
      const orderAt = sourceAt !== null && sourceAt <= this.clock() ? sourceAt : null;
      // Missing historical order dates stay unknown; never substitute ingestion time.
      const lastAt = Math.max(timestampMs(contact.crmV1LastMeaningfulAtMs) ?? -1, orderAt ?? -1);
      const firstAt = timestampMs(contact.crmV1FirstOrderAt), previousLast = timestampMs(contact.crmV1LastOrderAt);
      const earlier = orderAt !== null && (firstAt === null || orderAt < firstAt);
      const later = orderAt !== null && (previousLast === null || orderAt > previousLast);
      if (order.crmV1QualifyingPrepared && contact.crmV1Relationship === 'customer' && contact.relationshipType === 'EXISTING_CLIENT' && contact.crmV1LastMeaningfulAtMs === lastAt && !earlier && !later) return false;
      const patch = classificationProjection({ ...contact, relationshipType: 'EXISTING_CLIENT', crmV1Relationship: "customer", crmV1LastMeaningfulAtMs: lastAt });
      Object.assign(patch, { relationshipType: 'EXISTING_CLIENT', crmV1FirstOrderId: earlier || !contact.crmV1FirstOrderId ? orderId : contact.crmV1FirstOrderId,
        crmV1FirstOrderAt: earlier ? new Date(orderAt) : contact.crmV1FirstOrderAt || null,
        crmV1LastOrderId: later || !contact.crmV1LastOrderId ? orderId : contact.crmV1LastOrderId,
        crmV1LastOrderAt: later ? new Date(orderAt) : contact.crmV1LastOrderAt || null,
        crmV1QualifyingOrderCount: (contact.crmV1QualifyingOrderCount || 0) + (order.crmV1QualifyingPrepared ? 0 : 1), crmV1Revision: (contact.crmV1Revision || 0) + 1 });
      tx.update(COLLECTIONS.contacts, order.contactId, patch);
      tx.update(COLLECTIONS.orders, orderId, { crmV1QualifyingPrepared: true });
      if (contact.relationshipType !== 'EXISTING_CLIENT') tx.set('automationJobs', `classification-${order.contactId}`, { orgId, kind: 'CLASSIFICATION_FANOUT', contactId: order.contactId, relationshipType: 'EXISTING_CLIENT', status: 'PENDING', cursor: null, createdAt: new Date(this.clock()) });
      if (!contact.crmV1FirstOrderId) tx.create(COLLECTIONS.auditLogs, createId('auditLog'), { orgId, actorType: 'SYSTEM', actorId: 'QUALIFYING_ORDER', action: 'CUSTOMER_CONVERSION_VERIFIED', entityType: 'CONTACT', entityId: order.contactId, metadata: { orderId }, createdAt: new Date(this.clock()) });
      return true;
    });
  }
  async processClassificationJobs() {
    if (!this.enabled) return;
    const jobs = await this.store.find('automationJobs', { filters: [['kind', '==', 'CLASSIFICATION_FANOUT'], ['status', '==', 'PENDING']], limit: 10 });
    for (const job of jobs.items) {
      const contact = await this.store.get('contacts', job.contactId);
      if (!contact || contact.orgId !== job.orgId) continue;
      const page = await this.store.find('conversations', { filters: [['orgId', '==', job.orgId], ['contactId', '==', job.contactId]], orderBy: ['__name__', 'asc'], cursor: decodeCursor(job.cursor), limit: 100 });
      await this.store.batchUpdate('conversations', page.items.map(c => ({ id: c.conversationId || c.id, data: { contactRelationshipType: contact.relationshipType, updatedAt: new Date(this.clock()) } })));
      await this.store.runTransaction(async tx => {
        const latest = await tx.get('automationJobs', job.id);
        if (latest?.relationshipType !== job.relationshipType || latest.cursor !== job.cursor) return;
        tx.update('automationJobs', job.id, { cursor: page.pagination.nextCursor, status: page.pagination.hasMore ? 'PENDING' : 'DONE' });
      });
    }
  }


}
