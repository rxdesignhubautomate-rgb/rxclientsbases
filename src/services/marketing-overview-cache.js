import { marketingOverview } from './marketing-overview.js';

// Display-only counts. Sending, consent, authorization and campaign actions never use this cache.
const stores = new WeakMap();
const TTL_MS = 30_000;
const MAX_ENTRIES = 100;

export async function cachedMarketingOverview(store, orgId, actor = {}) {
  let cache = stores.get(store);
  if (!cache) { cache = new Map(); stores.set(store, cache); }
  const key = JSON.stringify([orgId, actor.role, actor.userId, actor.clientScope, actor.email, actor.permissions]);
  const hit = cache.get(key);
  if (hit && (hit.pending || hit.expiresAt > Date.now())) return hit.value;
  const entry = { pending: true, expiresAt: 0 };
  entry.value = marketingOverview(store, orgId, actor).then(value => {
    entry.pending = false;
    entry.expiresAt = Date.now() + TTL_MS;
    return Object.freeze({...value, calculatedAt: new Date().toISOString()});
  }).catch(error => {
    if(cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.delete(key); cache.set(key, entry);
  while(cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return entry.value;
}
