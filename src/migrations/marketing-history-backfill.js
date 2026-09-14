import { canonicalDestination, destinationKey } from '../services/marketing-safety.service.js';
import { timestampMs } from '../services/client-classification.js';
import { decodeCursor } from '../utils/pagination.js';
import { sha256 } from '../utils/hashing.js';

// The executable wrapper accepts only a loopback demo emulator. Accepted history
// is evidence of an earlier attempt, never evidence of marketing permission.
export async function backfillMarketingHistoryPage(store, { orgId, cursor = null, limit = 100, commit = false, restart = false, nowMs = Date.now() } = {}) {
  if (!orgId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Provide business and bounded page size');
  const decoded = decodeCursor(cursor), checkpointId = `marketing-history-${orgId}`;
  if (cursor && !decoded) throw new Error('Invalid history cursor');
  if (decoded && (await store.get('messages', decoded))?.orgId !== orgId) throw new Error('Cursor outside business');
  let checkpoint = await store.get('systemSettings', checkpointId);
  if (restart) {
    if (!commit || cursor) throw new Error('Restart requires --commit and no cursor; it resets only the history scan checkpoint');
    await store.runTransaction(async tx => {
      const old = await tx.get('systemSettings', checkpointId);
      tx.set('systemSettings', checkpointId, { orgId, ready: false, complete: false, nextCursor: null, scanned: 0, accepted: 0, held: 0 });
      tx.create('auditLogs', `HISTORY_RESCAN_${sha256(`${orgId}:${nowMs}`)}`, { orgId, actorType: 'SYSTEM', action: 'MARKETING_HISTORY_RESCAN', entityId: checkpointId, metadata: { previousScanned: old?.scanned || 0, previousHeld: old?.held || 0 }, createdAt: new Date(nowMs) });
    });
    checkpoint = null;
  }
  if (commit && checkpoint?.complete) return checkpoint;
  if (commit && (checkpoint?.nextCursor || null) !== cursor) throw new Error('Resume from the recorded nextCursor');
  const page = await store.find('messages', { filters: [['orgId', '==', orgId], ['direction', '==', 'OUTBOUND']], orderBy: ['__name__', 'asc'], cursor: decoded, limit });
  const registry = new Map();
  let accepted = 0, held = 0;
  for (const message of page.items) {
    let marketing = Boolean(message.metadata?.marketingPurpose || message.metadata?.isPromotional || message.metadata?.campaignId);
    if (!marketing && message.type === 'TEMPLATE') {
      const name = message.metadata?.template?.name || '', language = message.metadata?.template?.language?.code;
      if (!registry.has(name)) registry.set(name, (await store.find('templateRegistry', { filters: [['orgId', '==', orgId], ['name', '==', name]], limit: 100 })).items);
      marketing = !registry.get(name).some(t => t.language === language && ['UTILITY', 'AUTHENTICATION'].includes(t.category));
    }
    if (!marketing) continue;
    const isAccepted = message.submissionState === 'accepted' || ['SENT', 'DELIVERED', 'READ'].includes(message.status);
    const uncertain = ['SENDING', 'DELIVERY_UNKNOWN'].includes(message.status) || message.submissionState === 'submission_unknown';
    if (!isAccepted && !uncertain) continue;
    const e164 = canonicalDestination(message.recipientId);
    const dates = [message.acceptedAt, message.sentAt, message.providerStatusSeen?.SENT, message.updatedAt, message.createdAt].map(timestampMs).filter(v => v !== null);
    const at = dates.length ? Math.max(...dates) : null;
    const needsReview = uncertain || !e164 || at === null || at > nowMs;
    if (needsReview) held++; else accepted++;
    if (!commit || !e164) continue;
    const key = destinationKey(orgId, e164);
    await store.runTransaction(async tx => {
      const [state, contact] = await Promise.all([tx.get('marketingDestinationState', key), tx.get('contacts', message.contactId)]);
      const slots = (state?.slots || []).filter(s => s.messageId !== message.messageId);
      if (needsReview || nowMs - at < 30 * 86400000) slots.push({ messageId: message.messageId, at: at ?? nowMs, state: needsReview ? 'submission_unknown' : 'accepted', contentId: message.metadata?.contentVersionId || null });
      tx.set('marketingDestinationState', key, { ...state, orgId, e164, slots, ...(needsReview ? { reviewRequired: true } : { lastAcceptedAt: new Date(Math.max(timestampMs(state?.lastAcceptedAt) || 0, at)) }) });
      if (!needsReview && contact?.orgId === orgId) tx.update('contacts', message.contactId, { crmV1LastMarketingAtMs: Math.max(timestampMs(contact.crmV1LastMarketingAtMs) || 0, at) });
      if (!needsReview && message.metadata?.contentVersionId) tx.set('marketingContentReceipts', sha256(`${key}:${message.metadata.contentVersionId}`), { orgId, destinationKey: key, contentVersionId: message.metadata.contentVersionId, messageId: message.messageId, acceptedAt: new Date(at), source: 'LEGACY_ACCEPTANCE_BACKFILL' });
    });
  }
  const result = { orgId, scanned: (checkpoint?.scanned || 0) + page.items.length, accepted: (checkpoint?.accepted || 0) + accepted, held: (checkpoint?.held || 0) + held, nextCursor: page.pagination.nextCursor, complete: !page.pagination.hasMore, ready: !page.pagination.hasMore && !(checkpoint?.held || held), preparedAt: new Date(nowMs), committed: commit };
  if (commit) await store.runTransaction(async tx => {
    const current = await tx.get('systemSettings', checkpointId);
    if ((current?.nextCursor || null) !== cursor || current?.complete) throw new Error('History preparation advanced; reload checkpoint');
    tx.set('systemSettings', checkpointId, result);
  });
  return result;
}
