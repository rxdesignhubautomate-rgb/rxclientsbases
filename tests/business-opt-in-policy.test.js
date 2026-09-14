import { describe, it, expect } from 'vitest';
import { businessOptedIn } from '../src/services/business-opt-in-policy.js';
import { MarketingSafetyService, destinationKey } from '../src/services/marketing-safety.service.js';
import { MemoryStore } from './helpers/memory-store.js';
import { makeCore } from './helpers/core.js';

describe('owner-confirmed opt-in policy', () => {
  const contact = { orgId: 'TEST', contactId: 'C1', primaryPhone: '+447911123456' };
  it('allows existing contacts without adding fictitious individual evidence', async () => {
    const store = new MemoryStore();
    const safety = new MarketingSafetyService({ store });
    expect(await safety.inspect('TEST', contact)).toMatchObject({ eligible: true, state: 'granted', source: 'BUSINESS_OPT_IN_POLICY' });
    expect(store.bucket('marketingPermissions').size).toBe(0);
  });
  it.each([{ marketingOptOut: true }, { marketingConsent: { status: 'OPTED_OUT' } }, { optInStatus: 'OPTED_OUT' }, { suppressed: true }, { doNotMarket: true }, { stopAllCommunications: true }, { status: 'BLOCKED' }])('explicit stop overrides opted-in flags: %j', stop => {
    const record = { ...contact, marketingOptIn: true, ...stop };
    const safety = new MarketingSafetyService({});
    expect(businessOptedIn(record)).toBe(false);
    expect(safety.permissionReason(record, null, null)).not.toBeNull();
  });
  it('destination STOP and revoked permission block duplicated contacts', async () => {
    const key = destinationKey('TEST', contact.primaryPhone);
    const store = new MemoryStore({ marketingDestinationState: { [key]: { orgId: 'TEST', marketingSuppressed: true } } });
    const safety = new MarketingSafetyService({ store });
    expect((await safety.inspect('TEST', { ...contact, contactId: 'DUPLICATE' })).eligible).toBe(false);
    expect(safety.permissionReason(contact, { orgId: 'TEST', state: 'revoked' }, null)).toBe('SUPPRESSED');
  });
  it('new contacts default to opted in; explicit new-contact stops are preserved', async () => {
    const { contacts } = makeCore();
    expect(await contacts.create('TEST', { primaryPhone: '+447911123456' })).toMatchObject({ marketingOptIn: true, optInStatus: 'OPTED_IN' });
    expect(await contacts.create('TEST', { primaryPhone: '+447911123457', marketingOptOut: true })).toMatchObject({ marketingOptIn: false, marketingOptOut: true, optInStatus: 'OPTED_OUT' });
  });
});
