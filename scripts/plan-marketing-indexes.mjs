import fs from 'node:fs/promises';
// Generates a reviewable file only. Never connects to Firebase or deploys indexes.
const main = JSON.parse(await fs.readFile(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));
const indexes = [...main.indexes], known = new Set(indexes.map(i => JSON.stringify(i)));
function add(collectionGroup, names) {
  const seen = new Set(), fields = names.filter(([name]) => !seen.has(name) && seen.add(name)).map(([fieldPath, order = 'ASCENDING']) => order === 'CONTAINS' ? { fieldPath, arrayConfig: 'CONTAINS' } : { fieldPath, order });
  const index = { collectionGroup, queryScope: 'COLLECTION', fields };
  const key = JSON.stringify(index); if (fields.length > 1 && !known.has(key)) { indexes.push(index); known.add(key); }
}
const fields = ['crmV1Relationship', 'crmV1Tier', 'city', 'assignedTo', 'tags', 'crmV1NeedsReview', 'crmV1LastMeaningfulAtMs', 'crmV1LastMarketingAtMs'];
for (const scope of [[], [['relationshipType']], [['assignedTo']]]) {
  for (let mask = 1; mask < 2 ** fields.length; mask++) {
    const chosen = fields.filter((_, i) => mask & (1 << i)); if (chosen.length > 3) continue;
    const ranges = chosen.filter(f => f.endsWith('AtMs')).sort(), equals = chosen.filter(f => !ranges.includes(f) && f !== 'tags').sort();
    add('contacts', [['orgId'], ['crmV1Version'], ...scope, ...equals.map(f => [f]), ...(chosen.includes('tags') ? [['tags', 'CONTAINS']] : []), ...ranges.map(f => [f])]);
  }
  add('contacts', [['orgId'], ['crmV1Version'], ...scope, ['crmV1Tier'], ['crmPremiumReviewAtMs']]);
}
for (const collection of ['marketingAudiences', 'marketingContentVersions', 'marketingCampaigns']) {
  add(collection, [['orgId'], ['crmUpgrade'], ['createdAt', 'DESCENDING']]);
  add(collection, [['orgId'], ['crmUpgrade'], ['createdBy'], ['createdAt', 'DESCENDING']]);
}
for (const collection of ['leads', 'quotations', 'orders', 'payments', 'conversations', 'campaignEnrollments', 'followUps']) add(collection, [['orgId'], ['contactId'], ['createdAt', 'DESCENDING']]);
add('campaignEnrollments', [['orgId'], ['campaignId'], ['createdAt']]);
add('campaignEnrollments', [['orgId'], ['campaignId'], ['status']]);
add('campaignEnrollments', [['orgId'], ['campaignId'], ['contactId']]);
add('outbox', [['orgId'], ['marketingDestinationKey'], ['status']]);
add('marketingCampaigns', [['crmUpgrade'], ['status']]);
add('automationJobs', [['kind'], ['status']]);
add('followUps', [['orgId'], ['status'], ['dueAt']]);
add('followUps', [['orgId'], ['status'], ['assignedTo'], ['dueAt']]);
add('followUps', [['orgId'], ['contactId'], ['status'], ['source']]);
add('orders', [['orgId'], ['primaryCampaignId'], ['createdAt']]);
add('payments', [['orgId'], ['orderId'], ['status']]);
add('auditLogs', [['orgId'], ['entityId'], ['createdAt', 'DESCENDING']]);
for (const scope of [[], [['relationshipType']], [['assignedTo']]]) add('contacts', [['orgId'], ...scope, ['crmCompanyIds', 'CONTAINS']]);
add('outbox', [['orgId'], ['messageId']]);
add('outbox', [['orgId'], ['campaignId'], ['status']]);
add('marketingReplyReceipts', [['orgId'], ['outcome'], ['createdAt', 'DESCENDING']]);
add('marketingReplyReceipts', [['orgId'], ['outcome'], ['assignedTo'], ['createdAt', 'DESCENDING']]);
add('marketingReplyContacts', [['orgId'], ['campaignId']]);
add('messages', [['orgId'], ['contactId'], ['direction'], ['createdAt', 'DESCENDING']]);
for (const scope of [[], [['relationshipType']], [['assignedTo']]]) add('contacts', [['orgId'], ...scope, ['crmHasMarketingReply']]);
for (const field of ['marketingSuppressed', 'stopAll']) add('marketingDestinationState', [['orgId'], [field]]);
for (const field of ['status', 'submissionState', 'providerStatusSeen.SENT']) add('messages', [['orgId'], ['metadata.campaignId'], [field]]);
// Directory controls combine equality filters with either the name prefix or activity range.
const directoryEquals = ['crmV1Relationship', 'crmV1Tier', 'city', 'assignedTo', 'crmV1NeedsReview'];
for (const scope of [[], [['relationshipType']], [['assignedTo']]]) {
  for (let mask = 0; mask < 2 ** directoryEquals.length; mask++) {
    const equal = directoryEquals.filter((_, index) => mask & (1 << index)).map(field => [field]);
    add('contacts', [['orgId'], ['crmV1Version'], ...scope, ...equal, ['crmV1SearchName']]);
    add('contacts', [['orgId'], ['crmV1Version'], ...scope, ...equal, ['crmV1LastMeaningfulAtMs'], ['crmV1SearchName']]);
    add('contacts', [['orgId'], ['crmV1Version'], ...scope, ...equal, ['crmV1SearchName'], ['crmV1LastMeaningfulAtMs']]);
    add('contacts', [['orgId'], ['crmV1Version'], ...scope, ...equal, ['crmV1LastMeaningfulAtMs']]);
  }
}
for (const collection of ['crmReports', 'crmBulkJobs']) add(collection, [['orgId'], ['createdBy'], ['createdAt', 'DESCENDING']]);
add('crmBulkMembers', [['orgId'], ['bulkId'], ['status']]);
add('crmBulkMembers', [['orgId'], ['bulkId']]);
add('users', [['orgId'], ['active'], ['name']]);
add('marketingAudiences', [['orgId'], ['crmUpgrade'], ['sharedWith', 'CONTAINS'], ['createdAt', 'DESCENDING']]);
add('messages', [['orgId'], ['contactId'], ['createdAt', 'DESCENDING']]);
add('leads', [['orgId'], ['leadStatus'], ['createdAt', 'DESCENDING']]);
await fs.writeFile(new URL('../firestore.marketing-upgrade.indexes.json', import.meta.url), JSON.stringify({ indexes, fieldOverrides: main.fieldOverrides || [] }, null, 2) + '\n');
console.log(`Wrote ${indexes.length} candidate indexes; ${indexes.length - main.indexes.length} additive. Review project quota and query plans before any authorised deployment.`);
