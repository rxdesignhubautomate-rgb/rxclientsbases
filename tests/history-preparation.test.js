import { describe, it, expect } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { prepareMarketingHistory } from '../src/services/marketing-history-preparation.js';
import { destinationKey } from '../src/services/marketing-safety.service.js';

const actor = { orgId: 'TEST', userId: 'ADMIN', role: 'OWNER' };
function fixture(enabled = false) {
  const store = new MemoryStore();
  return { store, safety: { settings: async () => ({ enabled }) } };
}
describe('admin history preparation', () => {
  it('prepares missing contact exclusions across pages before history and preserves destination STOP', async () => {
    const service = fixture();
    for (let i = 0; i < 101; i++) {
      const contactId = `C${String(i).padStart(3, '0')}`;
      await service.store.create('contacts', contactId, { orgId: 'TEST', contactId, primaryPhone: '+447911123456', ...(i === 0 ? { marketingOptOut: true } : {}) });
    }
    await service.store.create('contacts', 'OTHER', { orgId: 'OTHER', contactId: 'OTHER', primaryPhone: '+447911123457' });
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ phase: 'suppression', scanned: 100, complete: false });
    expect(await service.store.get('systemSettings', 'marketing-history-TEST')).toBeNull();
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ phase: 'suppression', scanned: 101, complete: false });
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ complete: true, ready: true });
    expect(await service.store.get('marketingDestinationState', destinationKey('TEST', '+447911123456'))).toMatchObject({ marketingSuppressed: true });
    expect((await service.store.get('contacts', 'OTHER')).crmV1SuppressionPrepared).toBeUndefined();
    expect((await service.store.get('contacts', 'C000')).marketingOptOut).toBe(true);
    expect(service.store.bucket('outbox').size).toBe(0);
  });
  it('detects newly imported unprepared contacts after an earlier complete run', async () => {
    const service = fixture();
    expect((await prepareMarketingHistory(service, actor)).ready).toBe(true);
    await service.store.create('contacts', 'LATER', { orgId: 'TEST', contactId: 'LATER', primaryPhone: '+447911123456', stopAllCommunications: true });
    expect((await prepareMarketingHistory(service, actor)).phase).toBe('suppression');
    expect((await service.store.get('contacts', 'LATER')).crmV1SuppressionPrepared).toBe(true);
    expect(await service.store.get('marketingDestinationState', destinationKey('TEST', '+447911123456'))).toMatchObject({ stopAll: true, marketingSuppressed: true });
  });
  it('rejects unprivileged users and active sending before writing', async () => {
    await expect(prepareMarketingHistory(fixture(), { ...actor, role: 'SALES' })).rejects.toThrow();
    const service = fixture(true);
    await expect(prepareMarketingHistory(service, actor)).rejects.toThrow('Pause sending');
    expect(await service.store.get('systemSettings', 'marketing-history-TEST')).toBeNull();
  });
  it('prepares empty history without enabling sending or creating outbox entries', async () => {
    const service = fixture();
    const result = await prepareMarketingHistory(service, actor);
    expect(result).toMatchObject({ orgId: 'TEST', ready: true, complete: true, scanned: 0 });
    expect(service.store.bucket('outbox').size).toBe(0);
    expect(await service.store.get('systemSettings', 'marketing-safety-TEST')).toBeNull();
  });
  it('scans only this organization and keeps uncertain messages held', async () => {
    const service = fixture();
    await service.store.create('messages', 'M1', { messageId: 'M1', orgId: 'TEST', direction: 'OUTBOUND', status: 'DELIVERY_UNKNOWN', metadata: { campaignId: 'C1' } });
    await service.store.create('messages', 'M2', { messageId: 'M2', orgId: 'OTHER', direction: 'OUTBOUND', status: 'SENT', metadata: { campaignId: 'C1' } });
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ ready: false, held: 1, scanned: 1 });
    expect((await service.store.get('messages', 'M1')).status).toBe('DELIVERY_UNKNOWN');
  });
  it('resumes bounded pages and refreshes a completed checkpoint on a new scan', async () => {
    const service = fixture();
    for (let i = 0; i < 101; i++) await service.store.create('messages', `M${String(i).padStart(3, '0')}`, { orgId: 'TEST', direction: 'OUTBOUND', status: 'QUEUED' });
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ scanned: 100, complete: false });
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ scanned: 101, complete: true, ready: true });
    expect(await prepareMarketingHistory(service, actor)).toMatchObject({ scanned: 100, complete: false });
  });
});
