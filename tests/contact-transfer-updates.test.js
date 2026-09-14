import { describe, it, expect } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { CrmContactTransferService } from '../src/services/crm-contact-transfer.service.js';
import { sha256 } from '../src/utils/hashing.js';
import { MarketingSafetyService } from '../src/services/marketing-safety.service.js';

const actor = { orgId: 'DEMO', userId: 'U1', role: 'OWNER' };
function setup() {
  const store = new MemoryStore({ contacts: { C1: { contactId: 'C1', orgId: 'DEMO', companyName: 'Original', contactPerson: 'Person', city: 'Old city', primaryPhone: '12025550101', relationshipType: 'EXISTING_CLIENT', crmV1FirstOrderId: 'O1', marketingOptOut: true } }, contactPhoneKeys: { [sha256('DEMO:PHONE:12025550101')]: { orgId: 'DEMO', contactId: 'C1' } } });
  const directory = new ClientDirectoryService({ store, enabled: true }), safety = new MarketingSafetyService({ store, directory });
  const transfer = new CrmContactTransferService({ store, directory, workspace: { safety } });
  const payload = { sourceName: 'review.xlsx', rows: [{ companyName: 'New name', city: 'New city', phone: '+12025550101', contactId: 'C1', updateFields: ['city'] }] };
  return { store, transfer, payload, safety };
}
describe('reviewed existing-contact import', () => {
  it('updates only selected fields, preserving identity, consent and customer history', async () => {
    const { store, transfer, payload } = setup();
    const preview = await transfer.preview(actor, payload);
    expect(preview.updates).toBe(1); expect(preview.rows[0].changes.city).toEqual({ before: 'Old city', after: 'New city' });
    const result = await transfer.commit(actor, { payload, expectedBatchId: preview.batchId, reviewToken: preview.reviewToken });
    expect(result.updated).toBe(1);
    expect(await store.get('contacts', 'C1')).toMatchObject({ city: 'New city', companyName: 'Original', contactPerson: 'Person', marketingOptOut: true, crmV1FirstOrderId: 'O1', crmV1Relationship: 'customer' });
    expect((await transfer.commit(actor, { payload, expectedBatchId: preview.batchId, reviewToken: preview.reviewToken })).updated).toBe(0);
    expect(store.bucket('auditLogs').size).toBe(1);
  });
  it('rejects stale previews and omitted review tokens', async () => {
    const { store, transfer, payload } = setup(); const preview = await transfer.preview(actor, payload);
    await expect(transfer.commit(actor, { payload, expectedBatchId: preview.batchId })).rejects.toThrow(/preview/);
    await store.update('contacts', 'C1', { city: 'Concurrent edit' });
    await expect(transfer.commit(actor, { payload, expectedBatchId: preview.batchId, reviewToken: preview.reviewToken })).rejects.toThrow(/changed/);
    expect((await store.get('contacts', 'C1')).city).toBe('Concurrent edit');
  });
  it('requires write access and never edits by phone mismatch', async () => {
    const { transfer, payload } = setup();
    await expect(transfer.preview({ ...actor, role: 'STAFF', permissions: ['contacts.import', 'contacts.read'] }, payload)).rejects.toThrow(/contacts.write/);
    payload.rows[0].phone = '+12025550102';
    expect((await transfer.preview(actor, payload)).rows[0].status).toBe('REVIEW');
  });
  it('holds a legacy duplicate even when its phone key was never prepared', async () => {
    const { store, transfer } = setup(); store.bucket('contactPhoneKeys').clear();
    const payload = { sourceName: 'legacy.csv', rows: [{ companyName: 'Same client', phone: '+12025550101' }] };
    const preview = await transfer.preview(actor, payload);
    expect(preview.rows[0].status).toBe('REVIEW');
    expect((await transfer.commit(actor, { payload, expectedBatchId: preview.batchId })).created).toBe(0);
    expect(store.bucket('contacts').size).toBe(1);
  });
  it('imports explicit evidence and cannot regrant it by replaying after a stop', async () => {
    const { store, transfer, safety } = setup();
    const payload = { sourceName: 'evidence.csv', rows: [{ companyName: 'New client', phone: '+12025550102', evidence: { state: 'granted', source: 'SIGNED_FORM', evidenceReference: 'Signed form 001', obtainedAt: new Date(Date.now() - 10000).toISOString(), reason: 'Reviewed actual signed record' } }] };
    let preview = await transfer.preview(actor, payload);
    expect(preview.evidenceRecords).toBe(1);
    let result = await transfer.commit(actor, { payload, expectedBatchId: preview.batchId, reviewToken: preview.reviewToken });
    expect(result.permissionRecorded).toBe(1); expect(result.permissionErrors).toHaveLength(0);
    const contact = [...store.bucket('contacts').values()].find(c => c.primaryPhone === '12025550102');
    await safety.suppressInbound(actor.orgId, contact.contactId, { senderId: '+12025550102', messageId: 'STOP_TEST' });
    preview = await transfer.preview(actor, payload);
    result = await transfer.commit(actor, { payload, expectedBatchId: preview.batchId, reviewToken: preview.reviewToken });
    expect(result.permissionRecorded).toBe(0); expect((await safety.inspect(actor.orgId, contact)).state).toBe('suppressed');
  });
  it('reports rejected restoration separately without changing the opt-out', async () => {
    const { transfer, safety, store } = setup();
    const payload = { sourceName: 'old-evidence.csv', rows: [{ companyName: 'Existing', phone: '+12025550101', contactId: 'C1', evidence: { state: 'granted', source: 'SIGNED_FORM', evidenceReference: 'Old signed form', obtainedAt: '2025-01-01T00:00:00Z', reason: 'Reviewing old permission evidence' } }] };
    const preview = await transfer.preview(actor, payload);
    const result = await transfer.commit(actor, { payload, expectedBatchId: preview.batchId, reviewToken: preview.reviewToken });
    expect(result.permissionRecorded).toBe(0); expect(result.permissionErrors).toHaveLength(1);
    expect((await safety.inspect(actor.orgId, await store.get('contacts', 'C1'))).eligible).toBe(false);
  });
});
