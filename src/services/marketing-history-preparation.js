import { assertPermission } from './marketing-safety.service.js';
import { backfillMarketingHistoryPage } from '../migrations/marketing-history-backfill.js';
import { backfillMarketingSuppressionPage } from '../migrations/marketing-suppression-backfill.js';
import { ConflictError } from '../utils/errors.js';

// Runs one bounded page using the signed-in administrator's organization.
// This records earlier attempts; it never queues messages or enables sending.
export async function prepareMarketingHistory(service, actor) {
  assertPermission(actor, 'marketing.settings');
  if ((await service.safety.settings(actor.orgId)).enabled) throw new ConflictError('Pause sending before reconciling history');
  const filters = [['orgId', '==', actor.orgId]];
  const [total, prepared] = await Promise.all([
    service.store.count('contacts', { filters }),
    service.store.count('contacts', { filters: [...filters, ['crmV1SuppressionPrepared', '==', true]] })
  ]);
  if (total !== prepared) {
    const id = `marketing-suppression-preparation-${actor.orgId}`;
    const previous = await service.store.get('systemSettings', id);
    const cursor = previous?.nextCursor || null;
    const page = await backfillMarketingSuppressionPage(service.store, { orgId: actor.orgId, cursor, limit: 100, commit: true });
    await service.store.runTransaction(async tx => {
      const current = await tx.get('systemSettings', id);
      if ((current?.version || 0) !== (previous?.version || 0)) throw new ConflictError('Another preparation advanced. Click Reconcile again to continue.');
      tx.set('systemSettings', id, { orgId: actor.orgId, nextCursor: page.nextCursor || null,
        version: (previous?.version || 0) + 1, updatedBy: actor.userId, updatedAt: new Date() });
    });
    return { phase: 'suppression', orgId: actor.orgId, scanned: prepared + page.prepared + page.suppressed + page.phoneReview,
      totalContacts: total, complete: false, ready: false, held: 0 };
  }
  const checkpoint = await service.store.get('systemSettings', `marketing-history-${actor.orgId}`);
  return backfillMarketingHistoryPage(service.store, {
    orgId: actor.orgId, limit: 100, commit: true,
    restart: checkpoint?.complete === true,
    cursor: checkpoint?.complete ? null : checkpoint?.nextCursor || null
  });
}
