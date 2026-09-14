import { z } from 'zod';
import { sha256 } from '../utils/hashing.js';
import { decodeCursor } from '../utils/pagination.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { assertPermission } from './marketing-safety.service.js';
import { timestampMs } from './client-classification.js';

const id = z.string().regex(/^[\w-]+$/).max(150);
export class CrmClientWorkspaceService {
  constructor({ store, directory, workspace, clock = () => Date.now() }) { Object.assign(this, { store, directory, workspace, clock }); }
  async lookup(actor, raw) {
    this.directory.scope(actor);
    const input = z.object({ kind: z.enum(['contacts', 'team', 'orders', 'quotations']), search: z.string().trim().max(100).default(''), contactId: id.optional() }).strict().parse(raw);
    if (input.kind === 'team') {
      const filters = [['orgId', '==', actor.orgId], ['active', '==', true]];
      if (input.search) filters.push(['name', '>=', input.search], ['name', '<=', `${input.search}\uf8ff`]);
      const page = await this.store.find('users', { filters, limit: 100, ...(input.search ? { orderBy: ['name', 'asc'] } : {}) });
      return { items: page.items.map(u => ({ value: u.userId || u.id, label: u.name || u.userId || u.id })), hasMore: page.pagination.hasMore };
    }
    if (input.kind === 'contacts') {
      const page = await this.directory.list(actor, { search: input.search, limit: 30 });
      return { items: page.items.map(c => ({ value: c.contactId, label: `${c.companyName || c.contactPerson} · ${c.primaryPhone}` })), hasMore: page.pagination.hasMore };
    }
    assertPermission(actor, `${input.kind}.read`);
    if (!input.contactId) throw new ConflictError('Choose a client first');
    await this.directory.checkedContact(actor, input.contactId);
    const page = await this.store.find(input.kind, { filters: [['orgId', '==', actor.orgId], ['contactId', '==', input.contactId]], limit: 100, orderBy: ['createdAt', 'desc'] });
    return { items: page.items.map(row => ({ value: row.orderId || row.quotationId || row.id, label: `${row.orderNumber || row.quotationNumber || row.orderId || row.quotationId} · ${row.status || ''}` })), hasMore: page.pagination.hasMore };
  }
  async timeline(actor, contactId, raw = {}) {
    await this.directory.checkedContact(actor, contactId);
    const input = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30), cursor: z.string().max(10000).optional() }).strict().parse(raw);
    const sources = [['auditLogs', null, 'entityId'], ['messages', 'conversations.read', 'contactId'], ['orders', 'orders.read', 'contactId'], ['payments', 'payments.read', 'contactId'], ['quotations', 'quotations.read', 'contactId'], ['leads', 'leads.read', 'contactId'], ['followUps', 'followups.read', 'contactId']].filter(([, permission]) => { try { if (permission) assertPermission(actor, permission); return true; } catch { return false; } });
    let cursors = {};
    if (input.cursor) { try { cursors = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); if (cursors.contactId !== contactId || cursors.orgId !== actor.orgId || !cursors.sources || typeof cursors.sources !== 'object') throw new Error(); cursors = cursors.sources; } catch { throw new ConflictError('Invalid timeline cursor'); } }
    const candidates = [], sourcePages = new Map();
    await Promise.all(sources.map(async ([collection, , field]) => {
      const cursor = cursors[collection];
      if (cursor) { if (typeof cursor !== 'string' || cursor.includes('/')) throw new ConflictError('Invalid timeline cursor'); const row = await this.store.get(collection, cursor); if (row?.orgId !== actor.orgId || row[field] !== contactId) throw new ConflictError('Invalid timeline cursor'); }
      const page = await this.store.find(collection, { filters: [['orgId', '==', actor.orgId], [field, '==', contactId]], orderBy: ['createdAt', 'desc'], cursor, limit: input.limit });
      sourcePages.set(collection, page);
      candidates.push(...page.items.map((row, sourceIndex) => ({ collection, row, sourceIndex })));
    }));
    candidates.sort((a, b) => (timestampMs(b.row.createdAt) || 0) - (timestampMs(a.row.createdAt) || 0) || a.collection.localeCompare(b.collection) || a.sourceIndex - b.sourceIndex);
    const chosen = candidates.slice(0, input.limit), next = { ...cursors };
    for (const item of chosen) next[item.collection] = item.row.id;
    const hasMore = candidates.length > chosen.length || [...sourcePages.values()].some(p => p.pagination.hasMore);
    return { items: chosen.map(({ collection, row }) => ({ id: `${collection}:${row.id}`, title: collection === 'messages' ? `${row.direction || ''} message: ${String(row.text || row.type || '').slice(0, 500)}` : collection === 'auditLogs' ? row.action : row.reason || row.quotationNumber || row.orderNumber || `${collection}: ${row.leadStatus || row.status || ''}`, status: row.leadStatus || row.status || 'RECORDED', createdAt: row.createdAt, kind: collection, conversationId: row.conversationId || null })), pagination: { hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ orgId: actor.orgId, contactId, sources: next })).toString('base64url') : null } };
  }
  async pipeline(actor, raw = {}) {
    assertPermission(actor, 'leads.read');
    const q = z.object({ stage: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(1024).optional() }).strict().parse(raw);
    const filters = [['orgId', '==', actor.orgId]]; if (q.stage) filters.push(['leadStatus', '==', q.stage]);
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid pipeline cursor');
    if (cursor) { const lead = await this.store.get('leads', cursor); if (lead?.orgId !== actor.orgId) throw new NotFoundError('Opportunity'); }
    const page = await this.store.find('leads', { filters, orderBy: ['createdAt', 'desc'], cursor, limit: q.limit });
    const contacts = new Map((await this.store.getMany('contacts', page.items.map(l => l.contactId))).map(c => [c.contactId || c.id, c]));
    return { ...page, items: page.items.flatMap(lead => { const contact = contacts.get(lead.contactId); try { this.directory.assertRecordScope(actor, contact); } catch { return []; } return [{ ...lead, companyName: contact.companyName || contact.contactPerson || '', suggestedOwnerId: contact.assignedTo || null }]; }) };
  }
  async openOpportunity(actor, raw) {
    assertPermission(actor, 'leads.write');
    const input = z.object({ contactId: id }).strict().parse(raw), contact = await this.directory.checkedContact(actor, input.contactId);
    return this.workspace.domain.ensureLead({ orgId: actor.orgId, contact, assignedTo: contact.assignedTo || actor.userId, source: 'CRM_WORKSPACE' });
  }
  async complaint(actor, contactId, raw) {
    assertPermission(actor, 'followups.write');
    const input = z.object({ reason: z.string().trim().min(5).max(1000), assignedTo: id, dueAt: z.string().datetime(), requestId: id }).strict().parse(raw);
    const followUpId = `COMPLAINT_${sha256(`${actor.orgId}:${contactId}:${input.requestId}`)}`;
    await this.store.runTransaction(async tx => {
      const [contact, existing, owner] = await Promise.all([tx.get('contacts', contactId), tx.get('followUps', followUpId), tx.get('users', input.assignedTo)]);
      this.directory.assertRecordScope(actor, contact);
      if (existing) return;
      if (owner?.orgId !== actor.orgId || !owner.active) throw new ConflictError('Choose an active owner');
      const now = new Date(this.clock());
      tx.create('followUps', followUpId, { orgId: actor.orgId, contactId, followUpId, source: 'COMPLAINT', reason: input.reason, assignedTo: input.assignedTo, dueAt: new Date(input.dueAt), status: 'SCHEDULED', priority: 'HIGH', createdBy: actor.userId, createdAt: now });
      tx.update('contacts', contactId, { crmOpenComplaintCount: (contact.crmOpenComplaintCount || 0) + 1 });
      tx.create('auditLogs', followUpId, { orgId: actor.orgId, actorId: actor.userId, entityId: contactId, action: 'COMPLAINT_OPENED', metadata: { followUpId }, createdAt: now });
    });
    return { followUpId, status: 'SCHEDULED', marketingHeld: true };
  }
}
