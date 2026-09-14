import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classificationProjection, CLASSIFICATION_VERSION } from '../services/client-classification.js';

// No credentials, environment loading, server startup or provider imports.
export const PREPARATION_FIELDS = Object.freeze([
  'crmV1Version', 'crmV1Revision', 'crmV1Relationship', 'crmV1Tier',
  'crmV1LastMeaningfulAtMs', 'crmV1LastMarketingAtMs', 'crmV1SearchName', 'crmV1NeedsReview'
]);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function decodeFields(fields = {}) {
  const decode = value => {
    if ('nullValue' in value) return null;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return value.doubleValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('timestampValue' in value) return value.timestampValue;
    if ('mapValue' in value) return decodeFields(value.mapValue.fields);
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
    return value;
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));
}
function encodeProjection(patch) {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key,
    typeof value === 'boolean' ? { booleanValue: value }
      : typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value }
  ]));
}
function assertScope(database, orgId, document) {
  if (!/^projects\/[a-z0-9-]+\/databases\/\(default\)$/.test(database) || !/^[\w-]+$/.test(orgId)) throw new Error('Invalid preparation scope');
  const prefix = `${database}/documents/contacts/`;
  if (!document?.name?.startsWith(prefix) || document.name.slice(prefix.length).includes('/') || !document.name.slice(prefix.length)
    || document.fields?.orgId?.stringValue !== orgId || !document.updateTime) throw new Error('Document outside preparation scope or missing version');
}
export function createPreparationPlan({ database, orgId, documents, capturedAt = new Date().toISOString() }) {
  const seen = new Set(), entries = [];
  const summary = { scanned: documents.length, toPrepare: 0, alreadyPrepared: 0, needsReview: 0, relationships: {}, tiers: {} };
  for (const doc of documents) {
    assertScope(database, orgId, doc);
    if (seen.has(doc.name)) throw new Error('Duplicate document in snapshot');
    seen.add(doc.name);
    const contact = decodeFields(doc.fields);
    if (contact.crmV1Version >= CLASSIFICATION_VERSION) { summary.alreadyPrepared++; continue; }
    const patch = classificationProjection(contact);
    entries.push({ name: doc.name, updateTime: doc.updateTime, fields: encodeProjection(patch) });
    summary.toPrepare++;
    if (patch.crmV1NeedsReview) summary.needsReview++;
    for (const [metric, value] of [['relationships', patch.crmV1Relationship], ['tiers', patch.crmV1Tier]]) summary[metric][value] = (summary[metric][value] || 0) + 1;
  }
  return { kind: 'directory-preparation-v1', database, orgId, capturedAt, snapshotDigest: digest(documents), summary, entries };
}
export function validatePreparationPlan(plan, documents, { approvedDatabase, approvedOrgId, approvedDigest }) {
  if (plan.database !== approvedDatabase || plan.orgId !== approvedOrgId || digest(plan) !== approvedDigest) throw new Error('Explicit approval must match the reviewed plan and scope');
  const rebuilt = createPreparationPlan({ database: plan.database, orgId: plan.orgId, documents, capturedAt: plan.capturedAt });
  if (!isDeepStrictEqual(plan, rebuilt)) throw new Error('Plan or backup changed; prepare a fresh review');
}
export async function applyPreparationPlan({ plan, documents, approval, readMany, commit, journal, onProgress = () => {} }) {
  validatePreparationPlan(plan, documents, approval);
  if (typeof journal !== 'function') throw new Error('Durable journal required');
  const stats = { planned: plan.entries.length, prepared: 0, alreadyApplied: 0, conflicts: 0, processed: 0 };
  for (let offset = 0; offset < plan.entries.length; offset += 100) {
    const entries = plan.entries.slice(offset, offset + 100);
    const current = new Map((await readMany(entries.map(e => e.name))).map(d => [d.name, d]));
    const writes = [], conflicts = [];
    for (const entry of entries) {
      const doc = current.get(entry.name);
      if (!doc || doc.fields?.orgId?.stringValue !== plan.orgId) { conflicts.push(entry.name); continue; }
      if (Object.entries(entry.fields).every(([key, value]) => isDeepStrictEqual(doc.fields[key], value))) { stats.alreadyApplied++; continue; }
      if (doc.updateTime !== entry.updateTime) { conflicts.push(entry.name); continue; }
      writes.push({ update: { name: entry.name, fields: entry.fields }, updateMask: { fieldPaths: PREPARATION_FIELDS }, currentDocument: { updateTime: entry.updateTime } });
    }
    // Persist intent before the atomic request. On timeout, re-run this SAME plan:
    // matching fields are skipped, and concurrent edits retain their current data.
    await journal({ stage: 'intent', offset, names: writes.map(w => w.update.name), conflicts });
    if (writes.length) {
      const result = await commit(writes);
      await journal({ stage: 'committed', offset, result });
      stats.prepared += writes.length;
    }
    stats.conflicts += conflicts.length;
    stats.processed += entries.length;
    onProgress({ ...stats });
  }
  return { ...stats, complete: stats.conflicts === 0 };
}
