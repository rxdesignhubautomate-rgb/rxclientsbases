import { describe, expect, it } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { backfillMarketingHistoryPage } from '../src/migrations/marketing-history-backfill.js';
import { backfillClientActivityPage } from '../src/migrations/client-activity-backfill.js';
import { destinationKey } from '../src/services/marketing-safety.service.js';

const at = Date.parse('2026-09-14T06:00:00Z');
const contact = { orgId: 'DEMO', contactId: 'C1', primaryPhone: '+12025550101', relationshipType: 'PROSPECT', crmV1Tier: 'premium' };
describe('guarded historical source reconciliation', () => {
  it('dry runs, resumes accepted history, and never turns queued messages into sent or grants consent', async () => {
    const store = new MemoryStore({ contacts: { C1: contact }, messages: {
      M1: { orgId: 'DEMO', messageId: 'M1', contactId: 'C1', direction: 'OUTBOUND', type: 'TEMPLATE', recipientId: contact.primaryPhone, status: 'SENT', createdAt: new Date(at - 1000), metadata: { marketingPurpose: true, contentVersionId: 'V1' } },
      M2: { orgId: 'DEMO', messageId: 'M2', contactId: 'C1', direction: 'OUTBOUND', type: 'TEMPLATE', recipientId: contact.primaryPhone, status: 'QUEUED', createdAt: new Date(at), metadata: { marketingPurpose: true } }
    } });
    await backfillMarketingHistoryPage(store, { orgId: 'DEMO', nowMs: at });
    expect(store.bucket('marketingDestinationState').size).toBe(0);
    const first = await backfillMarketingHistoryPage(store, { orgId: 'DEMO', limit: 1, nowMs: at, commit: true });
    expect(first.complete).toBe(false);
    const last = await backfillMarketingHistoryPage(store, { orgId: 'DEMO', limit: 1, cursor: first.nextCursor, nowMs: at, commit: true });
    expect(last.ready).toBe(true); expect(last.accepted).toBe(1);
    await backfillMarketingHistoryPage(store, { orgId: 'DEMO', nowMs: at, commit: true });
    expect((await store.get('marketingDestinationState', destinationKey('DEMO', contact.primaryPhone))).slots).toHaveLength(1);
    expect(store.bucket('marketingPermissions').size).toBe(0);
  });
  it('leaves uncertain historical submissions held and prevents activation readiness', async () => {
    const store = new MemoryStore({ contacts: { C1: contact }, messages: { M: { orgId: 'DEMO', messageId: 'M', contactId: 'C1', direction: 'OUTBOUND', type: 'TEMPLATE', recipientId: contact.primaryPhone, status: 'DELIVERY_UNKNOWN', metadata: { marketingPurpose: true } } } });
    const result = await backfillMarketingHistoryPage(store, { orgId: 'DEMO', nowMs: at, commit: true });
    expect(result.ready).toBe(false); expect(result.held).toBe(1);
    expect((await store.get('marketingDestinationState', destinationKey('DEMO', contact.primaryPhone))).slots[0].state).toBe('submission_unknown');
  });
  it('uses the earliest qualifying source order and never treats import time or cancelled orders as activity', async () => {
    const store = new MemoryStore({ contacts: { C1: contact }, orders: {
      O1: { orgId: 'DEMO', orderId: 'O1', contactId: 'C1', status: 'CONFIRMED', orderDate: '2025-06-01' },
      O2: { orgId: 'DEMO', orderId: 'O2', contactId: 'C1', status: 'CONFIRMED', orderDate: '2024-01-01' },
      O3: { orgId: 'DEMO', orderId: 'O3', contactId: 'C1', status: 'CANCELLED', orderDate: '2026-09-14' }
    } });
    await backfillClientActivityPage(store, { orgId: 'DEMO', nowMs: at, commit: true });
    await backfillClientActivityPage(store, { orgId: 'DEMO', nowMs: at, commit: true });
    expect(await store.get('contacts', 'C1')).toMatchObject({ relationshipType: 'EXISTING_CLIENT', crmV1Tier: 'premium', crmV1FirstOrderId: 'O2', crmV1LastOrderId: 'O1', crmV1QualifyingOrderCount: 2, crmV1LastMeaningfulAtMs: Date.parse('2025-06-01') });
    expect(store.bucket('auditLogs').size).toBe(1);
    await store.create('messages', 'IN', { orgId: 'DEMO', messageId: 'IN', contactId: 'C1', direction: 'INBOUND', type: 'TEXT', createdAt: new Date(at) });
    expect((await backfillClientActivityPage(store, { orgId: 'DEMO', kind: 'messages', nowMs: at, commit: true })).missingVerifiedDate).toBe(1);
    expect((await store.get('contacts', 'C1')).crmV1LastMeaningfulAtMs).toBe(Date.parse('2025-06-01'));
  });
});
