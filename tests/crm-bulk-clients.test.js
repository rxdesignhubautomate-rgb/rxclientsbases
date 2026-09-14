import { describe, expect, it } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { CrmBulkClientsService } from '../src/services/crm-bulk-clients.service.js';
import { classificationProjection } from '../src/services/client-classification.js';
const actor = { orgId: 'DEMO', userId: 'U1', role: 'OWNER' };
function setup() {
  const contacts = Object.fromEntries(Array.from({ length: 125 }, (_, i) => { const contactId = `C${String(i).padStart(3, '0')}`, contact = { contactId, orgId: 'DEMO', companyName: `Name ${i}`, primaryPhone: '+12025550101', relationshipType: 'EXISTING_CLIENT', assignedTo: 'U1', marketingOptOut: true }; return [contactId, { ...contact, ...classificationProjection(contact) }]; }));
  const store = new MemoryStore({ contacts }); const directory = new ClientDirectoryService({ store, enabled: true });
  return { store, service: new CrmBulkClientsService({ store, directory }) };
}
describe('frozen bulk client changes', () => {
  it('previews all matching pages before mutation, holds concurrent edits and preserves opt-outs', async () => {
    const { store, service } = setup(); let job = await service.create(actor, { filters: { view: 'existing' }, action: 'tier', value: 'premium', reason: 'Reviewed priority client tier' });
    while (job.status === 'PREPARING') job = await service.action(actor, job.bulkId, { action: 'advance', expectedRevision: job.revision });
    expect(job.selected).toBe(125); expect((await store.get('contacts', 'C001')).crmV1Tier).toBe('standard');
    await expect(service.action(actor, job.bulkId, { action: 'approve', expectedRevision: job.revision, expectedDigest: '0'.repeat(64) })).rejects.toThrow(/frozen/);
    await store.update('contacts', 'C001', { crmV1Revision: 1, companyName: 'New edit' });
    job = await service.action(actor, job.bulkId, { action: 'approve', expectedRevision: job.revision, expectedDigest: job.digest });
    while (job.status === 'APPLYING') job = await service.action(actor, job.bulkId, { action: 'advance', expectedRevision: job.revision });
    expect(job).toMatchObject({ changed: 124, conflicts: 1, status: 'COMPLETE' });
    expect((await store.get('contacts', 'C001')).crmV1Tier).toBe('standard');
    expect(await store.get('contacts', 'C002')).toMatchObject({ crmV1Tier: 'premium', marketingOptOut: true, relationshipType: 'EXISTING_CLIENT' });
    expect(store.bucket('marketingPermissions').size).toBe(0);
  });
  it('cancels before apply and rejects another actor or stale step', async () => {
    const { store, service } = setup(); let job = await service.create(actor, { contactIds: ['C001'], action: 'tag_add', value: 'Design', reason: 'Reviewed service interest' });
    const revision = job.revision; job = await service.action(actor, job.bulkId, { action: 'advance', expectedRevision: revision });
    await expect(service.action(actor, job.bulkId, { action: 'advance', expectedRevision: revision })).rejects.toThrow(/changed/);
    await expect(service.get({ ...actor, userId: 'U2' }, job.bulkId)).rejects.toThrow();
    job = await service.action(actor, job.bulkId, { action: 'cancel', expectedRevision: job.revision });
    expect(job.status).toBe('CANCELLED'); expect((await store.get('contacts', 'C001')).tags).toBeUndefined();
  });
});
