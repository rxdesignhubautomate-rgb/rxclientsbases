import { z } from 'zod';
import { sha256 } from '../utils/hashing.js';
import { createId } from '../utils/ids.js';
import { decodeCursor } from '../utils/pagination.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { assertPermission } from './marketing-safety.service.js';
import { classificationProjection } from './client-classification.js';
import { querySchema } from './client-directory.service.js';

const id = z.string().regex(/^[\w-]+$/).max(150);
const fingerprint = contact => sha256(JSON.stringify([contact.companyName || '', contact.assignedTo || null, contact.tags || [], contact.crmV1Tier || 'standard', contact.crmV1Revision || 0]));
const permission = action => action === 'tier' ? 'contacts.tier' : 'contacts.write';
export class CrmBulkClientsService {
  constructor({ store, directory, clock = () => Date.now() }) { Object.assign(this, { store, directory, clock }); }
  async create(actor, raw) {
    const input = z.object({ contactIds: z.array(id).min(1).max(500).optional(), filters: querySchema.omit({ limit: true, cursor: true }).optional(), action: z.enum(['tier', 'assign', 'tag_add', 'tag_remove']), value: z.string().trim().min(1).max(150), reason: z.string().trim().min(5).max(500) }).strict().parse(raw);
    assertPermission(actor, permission(input.action)); this.directory.ensureEnabled();
    if (Boolean(input.contactIds) === Boolean(input.filters)) throw new ConflictError('Choose selected clients or all matching filters');
    if (input.action === 'tier' && !['standard', 'premium', 'vip'].includes(input.value)) throw new ConflictError('Invalid tier');
    if (input.action === 'assign' && !['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role)) throw new ConflictError('A manager must approve bulk reassignment');
    if (input.action.startsWith('tag_') && input.value.length > 60) throw new ConflictError('Tag is too long');
    if (input.contactIds) { input.contactIds = [...new Set(input.contactIds)]; for (const contactId of input.contactIds) await this.directory.checkedContact(actor, contactId); }
    if (input.action === 'assign') { const owner = await this.store.get('users', input.value); if (owner?.orgId !== actor.orgId || !owner.active) throw new ConflictError('Choose an active owner'); }
    const now = new Date(this.clock()), bulkId = `BULK_${createId('auditLog')}`;
    const job = { bulkId, ...input, orgId: actor.orgId, createdBy: actor.userId, createdAt: now, expiresAt: new Date(+now + 86400000), status: 'PREPARING', cursor: null, revision: 0, selected: 0, scanned: 0, changed: 0, conflicts: 0, digest: sha256(JSON.stringify(input)), preparedAtMs: +now };
    await this.store.create('crmBulkJobs', bulkId, job); return job;
  }
  async get(actor, bulkId) {
    this.directory.ensureEnabled();
    const job = await this.store.get('crmBulkJobs', bulkId);
    if (!job || job.orgId !== actor.orgId || job.createdBy !== actor.userId) throw new NotFoundError('Bulk review');
    assertPermission(actor, permission(job.action)); this.directory.scope(actor);
    if (job.action === 'assign' && !['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role)) throw new ConflictError('Bulk assignment requires current manager access');
    if (this.clock() > job.preparedAtMs + 86400000) throw new ConflictError('Bulk review expired; prepare a fresh selection');
    return job;
  }
  async list(actor) {
    this.directory.ensureEnabled(); this.directory.scope(actor);
    const page = await this.store.find('crmBulkJobs', { filters: [['orgId', '==', actor.orgId], ['createdBy', '==', actor.userId]], orderBy: ['createdAt', 'desc'], limit: 50 });
    return { ...page, items: page.items.filter(j => {
      try { assertPermission(actor, permission(j.action)); } catch { return false; }
      return this.clock() <= j.preparedAtMs + 86400000 && (j.action !== 'assign' || ['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role));
    }) };
  }
  async members(actor, bulkId, raw = {}) {
    await this.get(actor, bulkId); const q = z.object({ cursor: z.string().max(1024).optional() }).strict().parse(raw), cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid bulk cursor');
    if (cursor) { const member = await this.store.get('crmBulkMembers', cursor); if (member?.bulkId !== bulkId || member.orgId !== actor.orgId) throw new ConflictError('Invalid bulk cursor'); }
    const page = await this.store.find('crmBulkMembers', { filters: [['orgId', '==', actor.orgId], ['bulkId', '==', bulkId]], orderBy: ['__name__', 'asc'], limit: 50, cursor });
    const current = new Map((await this.store.getMany('contacts', page.items.map(m => m.contactId))).map(c => [c.contactId || c.id, c]));
    return { ...page, items: page.items.filter(m => { try { this.directory.assertRecordScope(actor, current.get(m.contactId)); return true; } catch { return false; } }) };
  }
  async action(actor, bulkId, raw) {
    const input = z.object({ action: z.enum(['approve', 'cancel', 'advance']), expectedRevision: z.number().int().min(0), expectedDigest: z.string().length(64).optional() }).strict().parse(raw);
    const before = await this.get(actor, bulkId);
    if (before.revision !== input.expectedRevision) throw new ConflictError('Bulk review changed; reload');
    if (input.action === 'advance') return before.status === 'PREPARING' ? this.prepare(actor, before) : before.status === 'APPLYING' ? this.apply(actor, before) : before;
    await this.store.runTransaction(async tx => {
      const current = await tx.get('crmBulkJobs', bulkId);
      if (current.revision !== input.expectedRevision) throw new ConflictError('Bulk review changed; reload');
      if (input.action === 'approve' && (current.status !== 'REVIEW' || input.expectedDigest !== current.digest)) throw new ConflictError('Review the complete frozen selection first');
      if (['COMPLETE', 'CANCELLED'].includes(current.status)) throw new ConflictError('Bulk action already ended');
      tx.update('crmBulkJobs', bulkId, { status: input.action === 'approve' ? 'APPLYING' : 'CANCELLED', revision: current.revision + 1, approvedAt: new Date(this.clock()) });
      tx.create('auditLogs', `${bulkId}-${current.revision}`, { orgId: actor.orgId, actorId: actor.userId, entityId: bulkId, action: `BULK_${input.action.toUpperCase()}`, selected: current.selected, reason: current.reason, createdAt: new Date(this.clock()) });
    });
    return this.get(actor, bulkId);
  }
  async prepare(actor, job) {
    let items, hasMore, cursor;
    if (job.contactIds) { const offset = Number(job.cursor || 0); items = await this.store.getMany('contacts', job.contactIds.slice(offset, offset + 100)); hasMore = offset + 100 < job.contactIds.length; cursor = hasMore ? String(offset + 100) : null; }
    else {
      const filters = this.directory.filters(actor, job.filters, job.preparedAtMs);
      const page = await this.store.findWhere('contacts', { where: { and: filters.map(([field, op, value]) => ({ field, op, value })) }, limit: 100, cursor: decodeCursor(job.cursor) });
      items = page.items; hasMore = page.pagination.hasMore; cursor = page.pagination.nextCursor;
    }
    items = items.filter(c => { try { this.directory.assertRecordScope(actor, c); return true; } catch { return false; } }).map(c => ({ ...c, contactId: c.contactId || c.id }));
    if (job.selected + items.length > 50000) throw new ConflictError('Selection exceeds 50,000 contacts; narrow the filters');
    await this.store.runTransaction(async tx => {
      const current = await tx.get('crmBulkJobs', job.bulkId); if (current.revision !== job.revision || current.status !== 'PREPARING') throw new ConflictError('Bulk review changed; reload');
      const existing = await Promise.all(items.map(c => tx.get('crmBulkMembers', `${job.bulkId}-${c.contactId}`)));
      let selected = job.selected, digest = job.digest;
      for (const [index, contact] of items.entries()) if (!existing[index]) {
        const member = { orgId: actor.orgId, bulkId: job.bulkId, contactId: contact.contactId, companyName: contact.companyName || '', fingerprint: fingerprint(contact), before: job.action === 'tier' ? contact.crmV1Tier || 'standard' : job.action === 'assign' ? contact.assignedTo || null : contact.tags || [], after: job.value, status: 'READY', expiresAt: job.expiresAt };
        tx.create('crmBulkMembers', `${job.bulkId}-${contact.contactId}`, member); selected++; digest = sha256(`${digest}:${contact.contactId}:${member.fingerprint}`);
      }
      tx.update('crmBulkJobs', job.bulkId, { selected, digest, scanned: job.scanned + items.length, cursor, revision: job.revision + 1, status: hasMore ? 'PREPARING' : 'REVIEW' });
    });
    return this.get(actor, job.bulkId);
  }
  async apply(actor, job) {
    const page = await this.store.find('crmBulkMembers', { filters: [['orgId', '==', actor.orgId], ['bulkId', '==', job.bulkId], ['status', '==', 'READY']], orderBy: ['__name__', 'asc'], limit: 50 });
    await this.store.runTransaction(async tx => {
      const current = await tx.get('crmBulkJobs', job.bulkId);
      if (current.revision !== job.revision || current.status !== 'APPLYING') throw new ConflictError('Bulk action changed; reload');
      const owner = job.action === 'assign' ? await tx.get('users', job.value) : null;
      if (job.action === 'assign' && (!owner?.active || owner.orgId !== actor.orgId)) throw new ConflictError('Selected owner is no longer active');
      const contacts = await Promise.all(page.items.map(m => tx.get('contacts', m.contactId)));
      let changed = job.changed, conflicts = job.conflicts;
      for (const [index, member] of page.items.entries()) {
        const contact = contacts[index]; let failure = null;
        try { this.directory.assertRecordScope(actor, contact); if (fingerprint(contact) !== member.fingerprint) failure = 'CLIENT_CHANGED_AFTER_PREVIEW'; } catch { failure = 'CLIENT_NO_LONGER_IN_SCOPE'; }
        if (failure) { conflicts++; tx.update('crmBulkMembers', member.id, { status: 'CONFLICT', error: failure }); continue; }
        const patch = job.action === 'tier' ? { crmV1Tier: job.value } : job.action === 'assign' ? { assignedTo: job.value } : { tags: job.action === 'tag_add' ? [...new Set([...(contact.tags || []), job.value])] : (contact.tags || []).filter(t => t !== job.value) };
        if (patch.tags?.length > 50) { conflicts++; tx.update('crmBulkMembers', member.id, { status: 'CONFLICT', error: 'TAG_LIMIT' }); continue; }
        Object.assign(patch, classificationProjection({ ...contact, ...patch }), { crmV1Revision: (contact.crmV1Revision || 0) + 1, updatedAt: new Date(this.clock()) });
        tx.update('contacts', member.contactId, patch); tx.update('crmBulkMembers', member.id, { status: 'APPLIED' }); changed++;
        tx.create('auditLogs', member.id, { orgId: actor.orgId, actorId: actor.userId, entityId: member.contactId, action: `BULK_CLIENT_${job.action.toUpperCase()}`, before: member.before, after: job.value, reason: job.reason, bulkId: job.bulkId, createdAt: new Date(this.clock()) });
      }
      tx.update('crmBulkJobs', job.bulkId, { changed, conflicts, revision: job.revision + 1, status: page.pagination.hasMore ? 'APPLYING' : 'COMPLETE' });
    });
    return this.get(actor, job.bulkId);
  }
}
