import { canonicalDestination, destinationKey } from '../services/marketing-safety.service.js';
import { decodeCursor } from '../utils/pagination.js';
import { timestampMs } from '../services/client-classification.js';

// Used by the emulator command and authenticated admin preparation. Never grants permission.
export async function backfillMarketingSuppressionPage(store, { orgId, cursor, limit = 100, commit = false } = {}) {
  if (!orgId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Provide business and bounded page size');
  const decoded = decodeCursor(cursor);
  if (cursor && !decoded) throw new Error('Invalid cursor');
  if (decoded && (await store.get('contacts', decoded))?.orgId !== orgId) throw new Error('Cursor outside business');
  const page = await store.find('contacts', { filters: [['orgId', '==', orgId]], orderBy: ['__name__', 'asc'], cursor: decoded, limit });
  const result = { scanned: page.items.length, prepared: 0, suppressed: 0, phoneReview: 0, skipped: 0, committed: commit, nextCursor: page.pagination.nextCursor };
  for (const item of page.items) {
    // Most contacts were already prepared. Avoid a separate transaction/read
    // for each one while locating a few newly imported records.
    if (item.crmV1SuppressionPrepared === true) { result.skipped++; continue; }
    const outcome = await store.runTransaction(async tx => {
      const contact = await tx.get('contacts', item.contactId || item.id);
      if (!contact || contact.orgId !== orgId || contact.crmV1SuppressionPrepared) return 'skipped';
      const e164 = canonicalDestination(contact.primaryPhone, contact.phoneCountryCode);
      if (!e164) { if (commit) tx.update('contacts', contact.contactId || item.id, { crmV1SuppressionPrepared: true, crmV1NeedsReview: true }); return 'phoneReview'; }
      const key = destinationKey(orgId, e164), state = await tx.get('marketingDestinationState', key), permission = await tx.get('marketingPermissions', key);
      const legacyStop = contact.suppressed || contact.marketingOptOut || contact.marketingConsent?.status === 'OPTED_OUT' || contact.optInStatus === 'OPTED_OUT' || contact.doNotMarket || contact.stopAllCommunications || contact.status === 'BLOCKED';
      const stopAt = timestampMs(contact.marketingConsent?.optedOutAt || contact.marketingConsent?.recordedAt || contact.marketingOptOutAt);
      const reviewedRestore = permission?.state === 'granted' && permission.restoresOptOut && stopAt !== null && timestampMs(permission.obtainedAt) > stopAt;
      if (commit) {
        tx.update('contacts', contact.contactId || item.id, { crmV1DestinationKey: key, crmV1SuppressionPrepared: true });
        if (legacyStop && !reviewedRestore) tx.set('marketingDestinationState', key, { ...state, orgId, e164, marketingSuppressed: true, stopAll: Boolean(state?.stopAll || contact.stopAllCommunications || contact.status === 'BLOCKED'), suppressedAt: stopAt === null ? new Date() : new Date(stopAt), source: 'LEGACY_STOP_BACKFILL' });
      }
      return legacyStop && !reviewedRestore ? 'suppressed' : 'prepared';
    });
    result[outcome]++;
  }
  return result;
}
