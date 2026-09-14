import { describe, it, expect } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { CrmClientWorkspaceService } from '../src/services/crm-client-workspace.service.js';
import { CrmMarketingWorkspaceService } from '../src/services/crm-marketing-workspace.service.js';
import { MarketingSafetyService } from '../src/services/marketing-safety.service.js';
const actor = { orgId: 'DEMO', userId: 'U1', role: 'OWNER', active: true };
function setup() {
  const store = new MemoryStore({ contacts: { C1: { contactId: 'C1', orgId: 'DEMO', companyName: 'Example', assignedTo: 'U1', primaryPhone: '+12025550101' } }, users: { U1: actor } });
  const directory = new ClientDirectoryService({ store, enabled: true });
  const safety = new MarketingSafetyService({ store, directory });
  const workspace = new CrmMarketingWorkspaceService({ store, directory, safety });
  const clients = new CrmClientWorkspaceService({ store, directory, workspace });
  return { store, directory, safety, workspace, clients };
}
describe('client workspace', () => {
  it('paginates merged source history without dropping tied records or leaking unauthorised sections', async () => {
    const { store, clients } = setup(), at = new Date('2026-09-01');
    for (const collection of ['messages', 'orders', 'payments', 'followUps']) for (let i = 0; i < 4; i++) await store.create(collection, `R${i}`, { orgId: 'DEMO', contactId: 'C1', createdAt: at, text: `Text ${i}` });
    const ids = []; let cursor;
    do { const page = await clients.timeline(actor, 'C1', { limit: 3, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(i => i.id)); cursor = page.pagination.nextCursor; } while (cursor);
    expect(ids).toHaveLength(16); expect(new Set(ids).size).toBe(16);
    const restricted = await clients.timeline({ ...actor, role: 'STAFF', permissions: ['contacts.read', 'conversations.read'] }, 'C1');
    expect(restricted.items.every(i => i.kind === 'messages')).toBe(true);
    await expect(clients.timeline(actor, 'C1', { cursor: 'bad' })).rejects.toThrow(/cursor/);
  });
  it('holds marketing until all complaints are resolved and does not decrement on duplicate completion', async () => {
    const { store, safety, workspace, clients } = setup();
    const input = { reason: 'Review quality complaint', assignedTo: 'U1', dueAt: '2026-10-01T10:00:00Z', requestId: 'request1' };
    const first = await clients.complaint(actor, 'C1', input); await clients.complaint(actor, 'C1', input);
    const second = await clients.complaint(actor, 'C1', { ...input, requestId: 'request2' });
    expect((await store.get('contacts', 'C1')).crmOpenComplaintCount).toBe(2);
    await workspace.updateTask(actor, first.followUpId, { action: 'complete', outcome: 'Resolved with client' });
    expect(safety.purposeReason(await store.get('contacts', 'C1'), { crmUpgrade: true })).toBe('ACCOUNT_CONCERN_REVIEW_REQUIRED');
    await expect(workspace.updateTask(actor, first.followUpId, { action: 'complete', outcome: 'Repeated completion' })).rejects.toThrow(/already/);
    await workspace.updateTask(actor, second.followUpId, { action: 'complete', outcome: 'Resolved with client' });
    expect((await store.get('contacts', 'C1')).crmOpenComplaintCount).toBe(0);
    expect(store.bucket('marketingPermissions').size).toBe(0);
  });
  it('shares audience access explicitly and revokes it without changing client permissions', async () => {
    const { store, workspace } = setup();
    const member = { orgId: 'DEMO', userId: 'U2', role: 'STAFF', active: true, permissions: ['marketing.read', 'marketing.audiences', 'contacts.read_assigned'] };
    await store.create('users', 'U2', member);
    const audience = await workspace.save(actor, 'audiences', { name: 'Selected clients', kind: 'static', contactIds: ['C1'] });
    await expect(workspace.get(member, 'audiences', audience.audienceId)).rejects.toThrow();
    await workspace.shareAudience(actor, audience.audienceId, { sharedWith: ['U2'], expectedRevision: 0 });
    expect((await workspace.list(member, 'audiences')).items).toHaveLength(1);
    expect((await workspace.previewAudience(member, audience.audienceId)).items).toHaveLength(0);
    await expect(workspace.shareAudience(member, audience.audienceId, { sharedWith: [], expectedRevision: 1 })).rejects.toThrow(/owner/);
    await workspace.shareAudience(actor, audience.audienceId, { sharedWith: [], expectedRevision: 1 });
    expect((await workspace.list(member, 'audiences')).items).toHaveLength(0);
    expect((await store.get('contacts', 'C1')).assignedTo).toBe('U1');
  });
});
