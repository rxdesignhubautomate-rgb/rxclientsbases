import { describe, it, expect } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { CrmReportsService } from '../src/services/crm-reports.service.js';
const actor = { orgId: 'DEMO', userId: 'U1', role: 'OWNER' }, now = Date.parse('2026-09-14T10:00:00Z');
function setup() {
  const store = new MemoryStore({ contacts: { C1: { orgId: 'DEMO', contactId: 'C1', assignedTo: 'U1', city: 'Delhi' } } });
  const reports = new CrmReportsService({ store, directory: new ClientDirectoryService({ store, enabled: true }), clock: () => now });
  return { store, reports };
}
async function finish(reports, report) { while (report.status !== 'COMPLETE') report = await reports.advance(actor, report.reportId, { expectedRevision: report.revision }); return report; }
describe('full source-page financial reports', () => {
  it('does not count inaccessible test records or orphan records for assigned staff', async () => {
    const { store, reports } = setup();
    const staff = { ...actor, role: 'SALES', permissions: ['orders.read', 'payments.read', 'leads.read', 'contacts.read_assigned'] };
    await store.create('contacts', 'C2', { orgId: 'DEMO', assignedTo: 'OTHER' });
    await store.create('orders', 'O1', { orgId: 'DEMO', contactId: 'C2', isTest: true });
    await store.create('orders', 'O2', { orgId: 'DEMO', contactId: 'MISSING' });
    await store.create('orders', 'O3', { orgId: 'DEMO', contactId: 'C1', isTest: true });
    let report = await reports.create(staff, {});
    while (report.status !== 'COMPLETE') report = await reports.advance(staff, report.reportId, { expectedRevision: report.revision });
    expect(report.scanned).toBe(1); expect(report.counts.missingContacts).toBe(0); expect(report.counts.excludedTestRecords).toBe(1);
  });
  it('covers multiple pages, deduplicates concurrent advances, and separates refunds/currencies/cohorts', async () => {
    const { store, reports } = setup();
    for (let i = 0; i < 121; i++) await store.create('orders', `O${String(i).padStart(3, '0')}`, { orgId: 'DEMO', orderId: `O${String(i).padStart(3, '0')}`, contactId: 'C1', orderDate: new Date(now - 1000), status: 'CONFIRMED', totalAmount: '0.10', currency: 'INR' });
    await store.create('payments', 'P1', { orgId: 'DEMO', contactId: 'C1', orderId: 'O000', receivedAt: new Date(now - 1000), status: 'RECEIVED', amount: '1.20', currency: 'INR' });
    await store.create('payments', 'P2', { orgId: 'DEMO', contactId: 'C1', receivedAt: new Date(now - 1000), status: 'REFUNDED', amount: '0.20', currency: 'INR' });
    await store.create('payments', 'P3', { orgId: 'DEMO', contactId: 'C1', status: 'RECEIVED', amount: '3.10', currency: 'USD' });
    let report = await reports.create(actor, {});
    await Promise.all([reports.advance(actor, report.reportId, { expectedRevision: 0 }), reports.advance(actor, report.reportId, { expectedRevision: 0 })]);
    report = await finish(reports, await reports.get(actor, report.reportId));
    expect(report.counts).toMatchObject({ qualifyingOrders: 121, clientsWithOrders: 1, clientsWithRepeatOrders: 1, unknownDates: 1 });
    expect(report.byCurrency.INR).toEqual({ booked: '12.10', collected: '1.20', refunds: '0.20', netCollected: '1.00' });
    expect(report.byCurrency.USD.collected).toBe('3.10'); expect(report.actualProviderCost).toBeNull();
  });
  it('excludes unknown business dates from date filters and rejects report access after permission changes', async () => {
    const { store, reports } = setup();
    await store.create('orders', 'O1', { orgId: 'DEMO', orderId: 'O1', contactId: 'C1', status: 'CONFIRMED', totalAmount: '999', currency: 'INR' });
    const report = await finish(reports, await reports.create(actor, { from: '2026-09-01T00:00:00Z' }));
    expect(report.counts.qualifyingOrders).toBe(0); expect(report.counts.unknownDates).toBe(1);
    await expect(reports.get({ ...actor, userId: 'OTHER' }, report.reportId)).rejects.toThrow();
    await expect(reports.get({ ...actor, role: 'SALES', permissions: ['orders.read', 'payments.read', 'contacts.read', 'leads.read'] }, report.reportId)).rejects.toThrow(/access changed/);
  });
});
