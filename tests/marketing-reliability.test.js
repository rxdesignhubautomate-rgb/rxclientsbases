import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { makeCore, seedConversation } from './helpers/core.js';
import { OutboundWorker } from '../src/workers/outbound.worker.js';
import { WhatsAppMetaAdapter } from '../src/channels/whatsapp/whatsapp.adapter.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { CrmContactTransferService, csvCell } from '../src/services/crm-contact-transfer.service.js';
import { CrmMarketingWorkspaceService, moneyMinor } from '../src/services/crm-marketing-workspace.service.js';
import { MarketingSafetyService } from '../src/services/marketing-safety.service.js';
import { classificationProjection } from '../src/services/client-classification.js';
import { compileAudienceFilter } from '../src/services/audience-filter.js';
import { backfillMarketingSuppressionPage } from '../src/migrations/marketing-suppression-backfill.js';

const actor = { orgId: 'DEMO', userId: 'U1', role: 'OWNER', active: true };
const fixture = () => {
  const contact = { orgId: 'DEMO', contactId: 'C1', companyName: 'Existing history', primaryPhone: '+447911123456', relationshipType: 'PROSPECT' };
  const store = new MemoryStore({ contacts: { C1: { ...contact, ...classificationProjection(contact) } }, users: { U1: actor } });
  const directory = new ClientDirectoryService({ store, enabled: true });
  const safety = new MarketingSafetyService({ store, directory });
  const service = new CrmMarketingWorkspaceService({ store, directory, safety });
  return { store, directory, safety, service, transfer: new CrmContactTransferService({ store, directory, workspace: service }) };
};

describe('provider boundaries and reconciliation', () => {
  it('blocks real development transport before any fetch including media', async () => {
    const adapter = new WhatsAppMetaAdapter({ accessToken: 'not-a-real-token' });
    await expect(adapter.request('/fake', { method: 'GET' })).rejects.toMatchObject({ code: 'DEVELOPMENT_TRANSPORT_BLOCKED' });
    await expect(adapter.uploadMedia({ account: {}, buffer: Buffer.from('test') })).rejects.toMatchObject({ code: 'DEVELOPMENT_TRANSPORT_BLOCKED' });
  });
  it('holds the actual Meta adapter timeout code without blind retries', async () => {
    const core = makeCore(), { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: 'RXDH', conversationId: conversation.conversationId, text: 'Synthetic' });
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('request timed out'), { code: 'META_TIMEOUT', retryable: true }));
    const worker = new OutboundWorker({ store: core.store, channelManager: { send }, channelAccounts: core.channelAccounts, media: { prepareForSend: async () => [] }, notifications: core.notifications, retryDelays: [0], maxAttempts: 5, workerId: 'TEST', logger: { warn() {} } });
    await worker.processOne(queued.outbox); await worker.processOne(queued.outbox);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await core.store.get('outbox', queued.outbox.outboxId)).status).toBe('DELIVERY_UNKNOWN');
  });
  it('replays an early callback and preserves READ across duplicates and older statuses', async () => {
    const core = makeCore(), { conversation } = await seedConversation(core);
    const queued = await core.messages.queueOutbound({ orgId: 'RXDH', conversationId: conversation.conversationId, text: 'Synthetic' });
    expect(await core.messages.updateProviderStatus('RXDH', 'wamid.synthetic', 'READ')).toBeNull();
    expect(core.store.bucket('providerStatusReceipts').size).toBe(1);
    await core.store.update('messages', queued.message.messageId, { providerMessageId: 'wamid.synthetic', status: 'SENT' });
    await core.messages.reconcileProviderStatus('RXDH', 'wamid.synthetic');
    await core.messages.updateProviderStatus('RXDH', 'wamid.synthetic', 'DELIVERED');
    await core.messages.updateProviderStatus('RXDH', 'wamid.synthetic', 'READ');
    await core.messages.updateProviderStatus('RXDH', 'wamid.synthetic', 'FAILED', { code: 'late-failure' });
    expect((await core.messages.get('RXDH', queued.message.messageId)).status).toBe('READ');
    expect([...core.store.bucket('providerStatusReceipts').values()].every(r => r.applied)).toBe(true);
    expect(await core.messages.updateProviderStatus('OTHER', 'wamid.synthetic', 'FAILED')).toBeNull();
    expect((await core.messages.get('RXDH', queued.message.messageId)).status).toBe('READ');
  });
});

describe('reviewed transfers and follow-ups', () => {
  it('prepares shared legacy stops conservatively without granting permission or merging contacts', async () => {
    const { store, safety } = fixture(); safety.dispatchEnabled = true;
    await store.create('contacts', 'C2', { orgId: 'DEMO', contactId: 'C2', primaryPhone: '+447911123456', marketingOptOut: true });
    await expect(safety.setEnabled(actor, true, 'Test activation')).rejects.toThrow(/backfill/);
    await backfillMarketingSuppressionPage(store, { orgId: 'DEMO' });
    expect(store.bucket('marketingDestinationState').size).toBe(0);
    const report = await backfillMarketingSuppressionPage(store, { orgId: 'DEMO', commit: true });
    expect(report.suppressed).toBe(1); expect(store.bucket('contacts').size).toBe(2); expect(store.bucket('marketingPermissions').size).toBe(0);
    expect((await safety.inspect('DEMO', await store.get('contacts', 'C1'))).eligible).toBe(false);
    expect((await backfillMarketingSuppressionPage(store, { orgId: 'DEMO', commit: true })).skipped).toBe(2);
  });
  it('calculates decimal currency amounts without binary addition or invented prices', () => {
    expect(moneyMinor('0.10') + moneyMinor('0.20')).toBe(30n);
    expect(moneyMinor('12.345')).toBe(1235n); expect(moneyMinor('1e9')).toBeNull(); expect(moneyMinor(null)).toBeNull();
  });
  it('reports payment and refund sources separately and preserves primary attribution', async () => {
    const { store, service } = fixture();
    await store.create('marketingCampaigns', 'MC1', { campaignId: 'MC1', orgId: 'DEMO', crmUpgrade: true, createdBy: 'U1' });
    await store.create('orders', 'O1', { orderId: 'O1', orgId: 'DEMO', contactId: 'C1', primaryCampaignId: 'MC1', status: 'CONFIRMED', totalAmount: '100.25', currency: 'INR', createdAt: new Date() });
    await store.create('payments', 'P1', { paymentId: 'P1', orgId: 'DEMO', orderId: 'O1', contactId: 'C1', status: 'RECEIVED', amount: '80.10', currency: 'INR' });
    await store.create('payments', 'P2', { paymentId: 'P2', orgId: 'DEMO', orderId: 'O1', contactId: 'C1', status: 'REFUNDED', amount: '10.05', currency: 'INR' });
    const result = await service.financePage(actor, 'MC1');
    expect(result.byCurrency.INR).toEqual({ booked: '100.25', collected: '80.10', refunds: '10.05', netCollected: '70.05' });
    expect(result.actualProviderCost).toBeNull(); expect(result.complete).toBe(true);
    await expect(service.financePage({ ...actor, role: 'SALES', permissions: ['marketing.read', 'contacts.read'] }, 'MC1')).rejects.toThrow();
  });
  it('previews country-aware text phones and refuses lossy/scientific/numeric cells', async () => {
    const { transfer } = fixture();
    const result = await transfer.preview(actor, { sourceName: 'test.csv', rows: [
      { companyName: 'A', phone: '07911123456', countryCode: 'GB' },
      { companyName: 'B', phone: '7.911123456E9', countryCode: 'GB' },
      { companyName: 'C', phone: 7911123456, countryCode: 'GB' },
      { companyName: 'D', phone: '07911123456' }
    ] });
    expect(result.rows[0].originalPhone).toBe('07911123456'); expect(result.rows[0].e164).toBe('+447911123456');
    expect(result.errors).toBe(3);
  });
  it('resumes the same import without duplicates, consent grants or history edits', async () => {
    const { transfer, store } = fixture();
    await store.create('orders', 'O1', { orgId: 'DEMO', orderId: 'O1', contactId: 'C1' });
    const payload = { sourceName: 'test.csv', rows: [{ companyName: 'Import demo', phone: '+12025550101' }, { companyName: 'Shared phone', phone: '+12025550101' }] };
    const preview = await transfer.preview(actor, payload);
    expect(preview.review).toBe(1);
    const first = await transfer.commit(actor, { payload, expectedBatchId: preview.batchId });
    const second = await transfer.commit(actor, { payload, expectedBatchId: preview.batchId });
    expect(first.created).toBe(1); expect(second.created).toBe(0);
    expect((await store.get('orders', 'O1')).contactId).toBe('C1');
    expect(store.bucket('marketingPermissions').size).toBe(0);
    expect(store.bucket('contacts').size).toBe(2);
    await expect(transfer.commit(actor, { payload: { ...payload, sourceName: 'changed' }, expectedBatchId: preview.batchId })).rejects.toThrow(/changed/);
  });
  it('escapes formula starts and embedded quotes on export', () => {
    expect(csvCell('=1+1')).toBe('"\'=1+1"'); expect(csvCell('a"b')).toBe('"a""b"'); expect(csvCell('00123')).toBe('"00123"');
  });
  it('creates one task and audits reschedule, completion and assignment restrictions', async () => {
    const { service, store } = fixture();
    const input = { contactId: 'C1', assignedTo: 'U1', reason: 'Review quotation', dueAt: new Date().toISOString(), dedupeKey: 'quote:Q1' };
    const first = await service.task(actor, input); await service.task(actor, input);
    expect(store.bucket('followUps').size).toBe(1);
    await service.updateTask(actor, first.followUpId, { action: 'reschedule', outcome: 'Client requested next week', dueAt: '2026-10-01T04:00:00Z' });
    await expect(service.updateTask(actor, first.followUpId, { action: 'reassign', outcome: 'Move owner', assignedTo: 'MISSING' })).rejects.toThrow();
    await service.updateTask(actor, first.followUpId, { action: 'complete', outcome: 'Quotation requested' });
    expect((await store.get('followUps', first.followUpId)).status).toBe('COMPLETED'); expect(store.bucket('auditLogs').size).toBe(2);
    await expect(service.dailyTasks({ ...actor, orgId: 'OTHER', role: 'SALES', permissions: [] })).rejects.toThrow();
  });
  it('stores company links without merging records or historical joins', async () => {
    const { service, store } = fixture();
    await store.create('contacts', 'C2', { orgId: 'DEMO', contactId: 'C2', companyName: 'Another account', primaryPhone: '+447911123456', relationshipType: 'PROSPECT' });
    await service.linkCompany(actor, 'C1', { companyId: 'C2', preferred: true, reason: 'Confirmed company association' });
    expect(store.bucket('contacts').size).toBe(2); expect((await store.get('contacts', 'C1')).crmCompanyIds).toEqual(['C2']); expect((await store.get('contacts', 'C2')).crmPreferredContactId).toBe('C1');
  });
  it('keeps review rules task-only, deduplicates scans and stops acquisition tasks after reply', async () => {
    const { store, service } = fixture();
    await store.update('contacts', 'C1', { crmV1LastMeaningfulAtMs: Date.now() - 100 * 86400000 });
    await service.processReviewRules(); expect(store.bucket('followUps').size).toBe(0);
    await service.rules(actor, { expectedVersion: 0, rules: [{ key: 'reactivation', enabled: true, delayHours: 24, assignedTo: 'U1', mode: 'task_only' }] });
    await service.processReviewRules(); await service.processReviewRules();
    expect(store.bucket('followUps').size).toBe(1); expect(store.bucket('outbox').size).toBe(0);
    await service.stopTaskSequences('DEMO', 'C1', 'Client replied; review');
    expect([...store.bucket('followUps').values()][0].status).toBe('CANCELLED');
  });
});

describe('bounded directory at 50k records', () => {
  it('returns 50 rows and consistent aggregate counts without materialising all contacts in the API response', async () => {
    const { store, directory } = fixture();
    const values = store.bucket('contacts'); values.clear();
    for (let i = 0; i < 50000; i++) { const contact = { contactId: `C${String(i).padStart(5, '0')}`, orgId: i < 40000 ? 'DEMO' : 'OTHER', companyName: `Company ${String(i).padStart(5, '0')}`, primaryPhone: '+12025550101', relationshipType: 'EXISTING_CLIENT', crmV1Tier: i % 10 === 0 ? 'premium' : 'standard' }; values.set(contact.contactId, { ...contact, ...classificationProjection(contact) }); }
    const at = Date.now(), page = await directory.list(actor, { view: 'premium', limit: 50 });
    expect(page.items).toHaveLength(50); expect(page.count).toBe(4000); expect(page.pagination.hasMore).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThan(100000); expect(Date.now() - at).toBeLessThan(5000);
    const where = { and: [{ field: 'orgId', op: '==', value: 'DEMO' }, compileAudienceFilter({ version: 1, rule: { op: 'or', rules: [{ field: 'tier', op: 'eq', value: 'premium' }, { field: 'relationship', op: 'eq', value: 'customer' }] } })] };
    expect(await store.countWhere('contacts', where)).toBe(40000); expect((await store.findWhere('contacts', { where, limit: 50 })).items).toHaveLength(50);
  }, 15000);
});
