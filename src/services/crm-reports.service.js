import { z } from 'zod';
import { createId } from '../utils/ids.js';
import { sha256 } from '../utils/hashing.js';
import { decodeCursor } from '../utils/pagination.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { assertPermission } from './marketing-safety.service.js';
import { qualifyingOrder, timestampMs } from './client-classification.js';
import { moneyMinor, formatMinor } from './crm-marketing-workspace.service.js';

const inputSchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), ownerId: z.string().max(150).optional(), service: z.string().max(150).optional(), city: z.string().max(120).optional(), campaignId: z.string().regex(/^[\w-]+$/).max(150).optional() }).strict();
const scopeKey = (directory, actor) => sha256(JSON.stringify([directory.scope(actor), actor.role, [...(actor.permissions || [])].sort()]));
const kinds = ['orders', 'payments', 'leads'];

export class CrmReportsService {
  constructor({ store, directory, workspace, clock = () => Date.now() }) { Object.assign(this, { store, directory, workspace, clock }); }
  check(actor) { for (const p of ['orders.read', 'payments.read', 'leads.read']) assertPermission(actor, p); this.directory.scope(actor); }
  async create(actor, raw) {
    this.check(actor); const filters = inputSchema.parse(raw);
    if (filters.from && filters.to && filters.from > filters.to) throw new ConflictError('End date must follow start date');
    if (filters.campaignId) await this.workspace.get(actor, 'campaigns', filters.campaignId);
    const reportId = `REPORT_${createId('auditLog')}`, now = new Date(this.clock());
    const report = { reportId, orgId: actor.orgId, createdBy: actor.userId, scopeKey: scopeKey(this.directory, actor), filters, createdAt: now, startedAt: now, updatedAt: now, expiresAt: new Date(+now + 7 * 86400000), status: 'BUILDING', phase: 0, cursor: null, revision: 0, scanned: 0,
      counts: { qualifyingOrders: 0, clientsWithOrders: 0, clientsWithRepeatOrders: 0, receivedPayments: 0, refunds: 0, opportunities: 0, unknownDates: 0, invalidAmounts: 0, missingContacts: 0, excludedTestRecords: 0 }, byCurrency: {}, byOwner: {}, byService: {}, byCity: {}, stages: {} };
    await this.store.create('crmReports', reportId, report); return this.present(report);
  }
  async checked(actor, reportId) {
    this.check(actor); const report = await this.store.get('crmReports', reportId);
    if (!report || report.orgId !== actor.orgId || report.createdBy !== actor.userId) throw new NotFoundError('Report');
    if (report.scopeKey !== scopeKey(this.directory, actor)) throw new ConflictError('Your access changed. Build a fresh report.');
    if (timestampMs(report.expiresAt) < this.clock()) throw new ConflictError('Report expired. Build a fresh report.');
    return report;
  }
  async list(actor) {
    this.check(actor);
    const page = await this.store.find('crmReports', { filters: [['orgId', '==', actor.orgId], ['createdBy', '==', actor.userId]], orderBy: ['createdAt', 'desc'], limit: 50 });
    return { ...page, items: page.items.filter(r => r.scopeKey === scopeKey(this.directory, actor) && timestampMs(r.expiresAt) >= this.clock()).map(r => this.present(r)) };
  }
  async get(actor, reportId) { return this.present(await this.checked(actor, reportId)); }
  async advance(actor, reportId, raw) {
    const { expectedRevision } = z.object({ expectedRevision: z.number().int().min(0) }).strict().parse(raw);
    const before = await this.checked(actor, reportId);
    if (before.status === 'COMPLETE') return this.present(before);
    if (before.revision !== expectedRevision) return this.present(before);
    const kind = kinds[before.phase];
    const page = await this.store.find(kind, { filters: [['orgId', '==', actor.orgId]], orderBy: ['__name__', 'asc'], limit: 100, cursor: decodeCursor(before.cursor) });
    const linkedOrders = kind === 'payments' ? await this.store.getMany('orders', page.items.map(p => p.orderId)) : [];
    const orders = new Map(linkedOrders.filter(o => o.orgId === actor.orgId).map(o => [o.orderId || o.id, o]));
    const contacts = new Map((await this.store.getMany('contacts', page.items.map(row => row.contactId || orders.get(row.orderId)?.contactId))).map(c => [c.contactId || c.id, c]));
    const next = { ...before, ...structuredClone(Object.fromEntries(['counts', 'byCurrency', 'byOwner', 'byService', 'byCity', 'stages'].map(key => [key, before[key]]))) }, orderClients = new Map();
    const bump = (group, key) => { const name = String(key || 'Unknown').slice(0, 150); const bucket = sha256(name); if (!next[group][bucket] && Object.keys(next[group]).length >= 200) { next[group].other ||= { label: 'Other values (combined)', count: 0 }; next[group].other.count++; } else { next[group][bucket] ||= { label: name, count: 0 }; next[group][bucket].count++; } };
    const addMoney = (currency, amount, field) => {
      if (!/^[A-Z]{3}$/.test(currency || '')) { next.counts.invalidAmounts++; return; }
      const scale = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits, minor = moneyMinor(amount, scale);
      if (minor === null) { next.counts.invalidAmounts++; return; }
      next.byCurrency[currency] ||= { scale, booked: '0', collected: '0', refunds: '0' };
      next.byCurrency[currency][field] = String(BigInt(next.byCurrency[currency][field]) + minor);
    };
    let visibleScanned = 0;
    for (const row of page.items) {
      const order = kind === 'orders' ? row : orders.get(row.orderId), contact = contacts.get(row.contactId || order?.contactId);
      if (!contact) { if (this.directory.scope(actor).length === 1) next.counts.missingContacts++; continue; }
      try { this.directory.assertRecordScope(actor, contact); } catch { continue; }
      visibleScanned++;
      if (row.isTest || row.testMode || row.isSample || ['TEST', 'DEMO', 'SAMPLE'].includes(String(row.source || '').toUpperCase())) { next.counts.excludedTestRecords++; continue; }
      const contactId = contact.contactId || contact.id;
      if (kind === 'payments' && row.orderId && (!order || order.contactId !== contactId || order.isTest || order.testMode || order.isSample)) continue;
      const owner = row.assignedTo || order?.assignedTo || contact.assignedTo, service = row.serviceInterest || row.service || order?.service || '', city = contact.city;
      if ((before.filters.ownerId && owner !== before.filters.ownerId) || (before.filters.service && service !== before.filters.service) || (before.filters.city && city !== before.filters.city)) continue;
      if (before.filters.campaignId && (order?.primaryCampaignId || row.primaryCampaignId) !== before.filters.campaignId) continue;
      const at = timestampMs(kind === 'orders' ? row.confirmedAt || row.orderDate : kind === 'payments' ? row.receivedAt || row.paymentDate || row.paidAt : row.createdAt);
      if (at === null) { next.counts.unknownDates++; if (before.filters.from || before.filters.to) continue; }
      if (at !== null && ((before.filters.from && at < Date.parse(before.filters.from)) || (before.filters.to && at > Date.parse(before.filters.to)) || at > timestampMs(before.startedAt))) continue;
      // Do not include records created after this scan began, even with a backdated business date.
      if ((timestampMs(row.createdAt) || 0) > timestampMs(before.startedAt)) continue;
      if (kind === 'orders' && qualifyingOrder(row)) {
        next.counts.qualifyingOrders++; addMoney(row.currency, row.totalAmount, 'booked'); bump('byOwner', owner); bump('byService', service); bump('byCity', city);
        orderClients.set(contactId, (orderClients.get(contactId) || 0) + 1);
      }
      if (kind === 'payments' && ['RECEIVED', 'REFUNDED'].includes(row.status)) { const refund = row.status === 'REFUNDED'; next.counts[refund ? 'refunds' : 'receivedPayments']++; addMoney(row.currency, row.amount, refund ? 'refunds' : 'collected'); }
      if (kind === 'leads') { next.counts.opportunities++; bump('stages', row.leadStatus); }
    }
    await this.store.runTransaction(async tx => {
      const current = await tx.get('crmReports', reportId);
      if (current.revision !== expectedRevision) return;
      const members = await Promise.all([...orderClients.keys()].map(contactId => tx.get('crmReportMembers', `${reportId}-${contactId}`)));
      for (const [index, [contactId, count]] of [...orderClients].entries()) {
        const oldCount = members[index]?.orders || 0, total = oldCount + count;
        if (!oldCount) next.counts.clientsWithOrders++;
        if (oldCount < 2 && total >= 2) next.counts.clientsWithRepeatOrders++;
        tx.set('crmReportMembers', `${reportId}-${contactId}`, { orgId: actor.orgId, reportId, contactId, orders: total, expiresAt: before.expiresAt });
      }
      next.phase += page.pagination.hasMore ? 0 : 1; next.cursor = page.pagination.hasMore ? page.pagination.nextCursor : null;
      next.status = next.phase >= kinds.length ? 'COMPLETE' : 'BUILDING'; next.scanned += visibleScanned; next.revision++; next.updatedAt = new Date(this.clock());
      if (next.status === 'COMPLETE') next.completedAt = next.updatedAt;
      delete next.id; tx.set('crmReports', reportId, next);
    });
    return this.get(actor, reportId);
  }
  present(report) {
    const result = { ...report }; delete result.scopeKey;
    result.byCurrency = Object.fromEntries(Object.entries(report.byCurrency).map(([currency, v]) => [currency, { booked: formatMinor(BigInt(v.booked), v.scale), collected: formatMinor(BigInt(v.collected), v.scale), refunds: formatMinor(BigInt(v.refunds), v.scale), netCollected: formatMinor(BigInt(v.collected) - BigInt(v.refunds), v.scale) }]));
    result.actualProviderCost = null;
    result.note = 'All source pages are scanned in bounded steps. Amounts remain separate by currency. Repeat clients means two or more qualifying orders in the selected period. Unknown business dates are excluded when dates are selected. This is an operational scan, not an accounting close: source changes during scanning require a fresh report. Service uses recorded service fields; missing values stay Unknown.';
    return result;
  }
}
