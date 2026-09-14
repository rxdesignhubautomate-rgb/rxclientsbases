import { ClientDirectoryService } from '../services/client-directory.service.js';
import { qualifyingOrder, timestampMs } from '../services/client-classification.js';
import { decodeCursor } from '../utils/pagination.js';

export async function backfillClientActivityPage(store, { orgId, kind = 'orders', cursor, limit = 100, commit = false, nowMs = Date.now() } = {}) {
  if (!orgId || !['orders', 'messages'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Provide business, source and bounded page size');
  const decoded = decodeCursor(cursor);
  if (cursor && !decoded) throw new Error('Invalid cursor');
  if (decoded && (await store.get(kind, decoded))?.orgId !== orgId) throw new Error('Cursor outside business');
  const page = await store.find(kind, { filters: [['orgId', '==', orgId], ...(kind === 'messages' ? [['direction', '==', 'INBOUND']] : [])], orderBy: ['__name__', 'asc'], cursor: decoded, limit });
  const directory = new ClientDirectoryService({ store, enabled: true, clock: () => nowMs });
  const result = { scanned: page.items.length, qualifying: 0, updated: 0, missingVerifiedDate: 0, missingContact: 0, committed: commit, nextCursor: page.pagination.nextCursor };
  for (const item of page.items) {
    if (kind === 'orders' ? !qualifyingOrder(item) : ['SYSTEM', 'REACTION'].includes(item.type)) continue;
    result.qualifying++;
    const contact = await store.get('contacts', item.contactId);
    if (contact?.orgId !== orgId) { result.missingContact++; continue; }
    const at = timestampMs(kind === 'orders' ? item.confirmedAt || item.orderDate : item.providerTimestamp);
    if (at === null || at > nowMs) result.missingVerifiedDate++;
    if (!commit) continue;
    if (kind === 'orders') { if (await directory.recordQualifyingOrder(orgId, item.orderId || item.id)) result.updated++; }
    else if (at !== null && at <= nowMs) await store.runTransaction(async tx => {
      const current = await tx.get('contacts', item.contactId);
      if (current?.orgId !== orgId || at <= (timestampMs(current.crmV1LastMeaningfulAtMs) ?? -1)) return;
      tx.update('contacts', item.contactId, { crmV1LastMeaningfulAtMs: at }); result.updated++;
    });
  }
  return result;
}
