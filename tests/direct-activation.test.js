import { describe, it, expect } from 'vitest';
import { MarketingSafetyService } from '../src/services/marketing-safety.service.js';
import { MemoryStore } from './helpers/memory-store.js';
const actor = { orgId: 'TEST', userId: 'OWNER', role: 'OWNER' };
function fixture() {
  const store = new MemoryStore({ systemSettings: { 'marketing-history-TEST': { orgId: 'TEST', ready: true, preparedAt: new Date() } } });
  return { store, safety: new MarketingSafetyService({ store, dispatchEnabled: true }) };
}
describe('explicit direct admin activation', () => {
  it('activates full delivery without fabricating pilot evidence and records the admin decision', async () => {
    const { store, safety } = fixture();
    expect(await safety.setEnabled(actor, true, 'Start approved batches', { directActivation: true })).toMatchObject({ enabled: true, rolloutStage: 'FULL', activationMode: 'ADMIN_DIRECT', directActivationBy: 'OWNER' });
    const saved = await safety.settings('TEST');
    expect(saved.previousStageReviewReference).toBeUndefined();
    expect([...store.bucket('auditLogs').values()][0].action).toBe('MARKETING_DIRECT_ACTIVATION');
  });
  it('retains the existing staged route unless direct activation was explicitly requested', async () => {
    await expect(fixture().safety.setEnabled(actor, true, 'Enable staged sending')).rejects.toThrow('internal-test');
  });
  it('rejects non-admin direct activation even with marketing settings permission', async () => {
    await expect(fixture().safety.setEnabled({ ...actor, role: 'SALES', permissions: ['marketing.settings'] }, true, 'Start approved batches', { directActivation: true })).rejects.toThrow('administrator');
  });
  it('keeps history, suppression preparation and deployment checks', async () => {
    const { store, safety } = fixture();
    await store.create('contacts', 'C1', { orgId: 'TEST', contactId: 'C1' });
    await expect(safety.setEnabled(actor, true, 'Start approved batches', { directActivation: true })).rejects.toThrow('destination-suppression');
    await store.update('contacts', 'C1', { crmV1SuppressionPrepared: true });
    await store.update('systemSettings', 'marketing-history-TEST', { ready: false });
    await expect(safety.setEnabled(actor, true, 'Start approved batches', { directActivation: true })).rejects.toThrow('history');
    safety.dispatchEnabled = false;
    await expect(safety.setEnabled(actor, true, 'Start approved batches', { directActivation: true })).rejects.toThrow('Deployment');
  });
});
