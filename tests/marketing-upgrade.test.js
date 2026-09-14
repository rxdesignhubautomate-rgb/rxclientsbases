import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from './helpers/memory-store.js';
import { classificationProjection } from '../src/services/client-classification.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { MarketingSafetyService, destinationKey, stopIntent } from '../src/services/marketing-safety.service.js';
import { CrmMarketingWorkspaceService } from '../src/services/crm-marketing-workspace.service.js';
import { compileAudienceFilter, matchesWhere } from '../src/services/audience-filter.js';
import { MarketingService } from '../src/services/marketing.service.js';

const now = Date.parse('2026-09-15T06:00:00Z');
const actor = { orgId: 'DEMO', userId: 'U1', role: 'OWNER', active: true };
const phone = '+447911123456';
const filter = { version: 1, rule: { field: 'relationship', op: 'eq', value: 'prospect' } };
function setup({ dispatch = true } = {}) {
  const contact = { orgId: 'DEMO', contactId: 'C1', primaryPhone: phone, companyName: 'Example', relationshipType: 'PROSPECT' };
  Object.assign(contact, classificationProjection(contact));
  const store = new MemoryStore({ contacts: { C1: contact }, users: { U1: actor }, templateRegistry: { T1: { orgId: 'DEMO', name: 'design_update', language: 'en', status: 'APPROVED', category: 'MARKETING', componentsJson: JSON.stringify([{ type: 'BODY', text: '{{1}}' }]) } }, systemSettings: { 'marketing-safety-DEMO': { orgId: 'DEMO', enabled: true, rolloutStage: 'FULL' } } });
  const directory = new ClientDirectoryService({ store, enabled: true, clock: () => now });
  const safety = new MarketingSafetyService({ store, directory, dispatchEnabled: dispatch, clock: () => now });
  const registry = { resolve: () => ({ name: 'design_update', language: 'en', category: 'MARKETING', body: '{{1}}' }), getStatus: async () => ({ status: 'APPROVED', category: 'MARKETING', language: 'en', componentsJson: JSON.stringify([{ type: 'BODY', text: '{{1}}' }]) }),
    prepare: (_key, values) => ({ type: 'TEMPLATE', text: values.body || 'Design update', metadata: { templateCategory: 'MARKETING', template: { name: 'design_update', language: { code: 'en' } } } }) };
  const workspace = new CrmMarketingWorkspaceService({ store, directory, safety, templateRegistry: registry, clock: () => now });
  return { store, directory, safety, workspace, contact };
}
const evidence = (overrides = {}) => ({ state: 'granted', source: 'SIGNED_FORM', evidenceReference: 'FORM-1234', obtainedAt: new Date(now - 1000).toISOString(), expectedVersion: 0, reason: 'Customer signed marketing permission', ...overrides });
const message = (id = 'M1', contactId = 'C1') => ({ messageId: id, orgId: 'DEMO', contactId, recipientId: phone, senderId: 'U1', type: 'TEMPLATE', metadata: { marketingPurpose: true, template: { name: 'design_update', language: { code: 'en' } } } });

describe('destination marketing safety', () => {
  it('requires evidence rather than importing legacy opt-in', async () => {
    const { safety, contact } = setup();
    expect((await safety.inspect('DEMO', { ...contact, marketingOptIn: true, marketingConsent: { status: 'OPTED_IN' } })).eligible).toBe(false);
    await expect(safety.record(actor, 'C1', evidence({ evidenceReference: '' }))).rejects.toThrow();
    await safety.record(actor, 'C1', evidence());
    expect((await safety.inspect('DEMO', contact)).eligible).toBe(true);
  });
  it('shares suppression between duplicates and cancels pending marketing work', async () => {
    const { safety, store, contact } = setup();
    await store.create('contacts', 'C2', { ...contact, contactId: 'C2' });
    await safety.record(actor, 'C1', evidence());
    await store.create('messages', 'M1', message());
    await store.create('outbox', 'O1', { outboxId: 'O1', messageId: 'M1', orgId: 'DEMO', marketingDestinationKey: destinationKey('DEMO', phone), status: 'PENDING' });
    await safety.suppressInbound('DEMO', 'C2', { messageId: 'IN1', senderId: phone });
    expect((await safety.inspect('DEMO', contact)).state).toBe('suppressed');
    expect((await store.get('outbox', 'O1')).status).toBe('CANCELLED');
    await expect(safety.reserve(message('M2', 'C2'))).rejects.toMatchObject({ code: 'SUPPRESSED' });
  });
  it('does not infer permission from ordinary positive replies or ambiguous stop text', async () => {
    const { safety, store } = setup();
    const marketing = new MarketingService({ store }); marketing.safety = safety;
    marketing.findContactCampaignContext = vi.fn().mockResolvedValue(null);
    expect((await marketing.handleInbound({ orgId: 'DEMO', contactId: 'C1', message: { text: 'YES', messageId: 'IN1' } })).optedIn).toBe(false);
    expect(stopIntent('मुझे नहीं चाहिए')).toBe('review');
    expect(stopIntent('message mat karo')).toBe('marketing');
    expect(stopIntent('sab band karo')).toBe('all');
    expect(store.bucket('marketingPermissions').size).toBe(0);
  });
  it('requires a fresh post-stop evidence record and optimistic version', async () => {
    const { safety } = setup();
    await safety.record(actor, 'C1', evidence());
    await safety.suppressInbound('DEMO', 'C1', { messageId: 'STOP1', senderId: phone });
    await expect(safety.record(actor, 'C1', evidence({ expectedVersion: 2, restoresOptOut: true }))).rejects.toThrow(/fresh/);
    safety.clock = () => now + 2000;
    expect((await safety.record(actor, 'C1', evidence({ expectedVersion: 2, restoresOptOut: true, obtainedAt: new Date(now + 1000).toISOString() }))).eligible).toBe(true);
    await expect(safety.record(actor, 'C1', evidence({ expectedVersion: 2 }))).rejects.toThrow(/changed/);
  });
  it('serializes two workers and holds unknown submissions without blind retry', async () => {
    const { safety } = setup(); await safety.record(actor, 'C1', evidence());
    const results = await Promise.allSettled([safety.reserve(message('M1')), safety.reserve(message('M2'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await safety.settle(destinationKey('DEMO', phone), message('M1'), 'submission_unknown');
    await expect(safety.reserve(message('M1'))).rejects.toThrow();
    await expect(safety.reserve(message('M3'))).rejects.toMatchObject({ code: 'DESTINATION_SUBMISSION_HELD' });
  });
  it('updates last sent only after acceptance and applies a cross-campaign cooldown', async () => {
    const { safety, store, contact } = setup(); await safety.record(actor, 'C1', evidence());
    const key = await safety.reserve(message());
    expect((await safety.inspect('DEMO', contact)).lastAcceptedAt).toBeNull();
    await safety.settle(key, message(), 'accepted');
    expect((await store.get('contacts', 'C1')).crmV1LastMarketingAtMs).toBe(now);
    await expect(safety.reserve(message('OTHER_CAMPAIGN'))).rejects.toMatchObject({ code: 'MARKETING_COOLDOWN' });
  });
  it('permits service replies after a marketing-only opt-out; stop-all blocks service too', async () => {
    const { safety } = setup();
    await safety.suppressInbound('DEMO', 'C1', { messageId: 'STOP1', senderId: phone });
    const serviceMessage = { ...message(), type: 'TEXT', metadata: {} };
    expect(await safety.reserve(serviceMessage)).toBeNull();
    await safety.suppressInbound('DEMO', 'C1', { messageId: 'STOP2', senderId: phone }, 'all');
    await expect(safety.reserve(serviceMessage)).rejects.toMatchObject({ code: 'SUPPRESSED' });
  });
  it('enforces kill switch, tenant scope and revoked user permissions at dispatch', async () => {
    const { safety, store } = setup(); await safety.record(actor, 'C1', evidence());
    await store.update('users', 'U1', { active: false });
    await expect(safety.reserve(message())).rejects.toMatchObject({ code: 'SENDER_PERMISSION_REVOKED' });
    await store.update('users', 'U1', { active: true });
    await safety.setEnabled(actor, false, 'Pause for review');
    await expect(safety.reserve(message())).rejects.toMatchObject({ code: 'MARKETING_PAUSED' });
    await expect(safety.record({ ...actor, orgId: 'OTHER' }, 'C1', evidence())).rejects.toThrow();
  });
});

describe('audience and approval workflow', () => {
  it('validates nested typed rules and counts OR overlap once', async () => {
    const { workspace } = setup();
    const aud = await workspace.save(actor, 'audiences', { name: 'Interested prospects', kind: 'dynamic', filter: { version: 1, rule: { op: 'or', rules: [filter.rule, filter.rule] } } });
    const page = await workspace.previewAudience(actor, aud.audienceId);
    expect(page.count).toBe(1); expect(page.items).toHaveLength(1);
    expect(() => compileAudienceFilter({ version: 1, rule: { field: 'rawSql', op: 'eq', value: '1=1' } })).toThrow();
    const unknown = compileAudienceFilter({ version: 1, rule: { field: 'lastInteraction', op: 'unknown' } });
    expect(matchesWhere({ crmV1LastMeaningfulAtMs: -1 }, unknown)).toBe(true);
  });
  it('deduplicates companies/destinations and keeps the approved snapshot frozen', async () => {
    const { store, workspace, safety, contact } = setup();
    await store.create('contacts', 'C2', { ...contact, contactId: 'C2', companyName: 'Shared number' });
    await safety.record(actor, 'C1', evidence());
    const aud = await workspace.save(actor, 'audiences', { name: 'Prospects', kind: 'dynamic', filter });
    const content = await workspace.save(actor, 'content', { name: 'New portfolio', service: 'Design', body: 'Our new work', templateKey: 'design', rightsConfirmed: true, expiresAt: '2026-10-01T00:00:00Z', variables: { body: '{{company}}' } });
    await workspace.approveContent(actor, content.contentVersionId);
    let campaign = await workspace.createCampaign(actor, { name: 'Portfolio review', audienceId: aud.audienceId, contentVersionId: content.contentVersionId, objective: 'design_update' });
    campaign = await workspace.prepareCampaignPage(actor, campaign.campaignId);
    expect(campaign).toMatchObject({ status: 'REVIEW', recipients: 1, exclusions: 1 });
    await workspace.campaignAction(actor, campaign.campaignId, { action: 'approve', expectedDigest: campaign.snapshotDigest });
    await store.create('contacts', 'C3', { ...contact, contactId: 'C3', primaryPhone: '+12133734253' });
    expect((await workspace.prepareCampaignPage(actor, campaign.campaignId)).recipients).toBe(1);
    expect((await workspace.campaignRecipients(actor, campaign.campaignId)).items).toHaveLength(2);
    await expect(workspace.campaignAction(actor, campaign.campaignId, { action: 'start', expectedDigest: 'edited' })).rejects.toThrow(/changed/);
  });
  it('keeps new content versions separate and blocks confidential, expired or unapproved media', async () => {
    const { workspace } = setup();
    const content = { name: 'Designs', service: 'Visual aids', body: 'New designs', templateKey: 'design', rightsConfirmed: true, expiresAt: '2026-10-01T00:00:00Z' };
    await expect(workspace.save(actor, 'content', { ...content, confidential: true })).rejects.toThrow();
    await expect(workspace.save(actor, 'content', { ...content, expiresAt: '2020-01-01T00:00:00Z' })).rejects.toThrow();
    const a = await workspace.save(actor, 'content', content), b = await workspace.save(actor, 'content', { ...content, body: 'Revised' }, a.contentVersionId);
    expect(b.contentVersionId).not.toBe(a.contentVersionId); expect(b.version).toBe(2);
    expect((await workspace.get(actor, 'content', a.contentVersionId)).body).toBe('New designs');
  });
  it('keeps sending disabled until explicit deployment activation and deduplicates tasks', async () => {
    const { workspace, safety, store } = setup({ dispatch: false });
    await expect(safety.setEnabled(actor, true, 'Ready for pilot')).rejects.toThrow(/disabled/);
    const task = { contactId: 'C1', reason: 'Quotation follow-up', dueAt: '2026-09-16T06:00:00Z', assignedTo: 'U1', dedupeKey: 'quote-123-followup' };
    await workspace.task(actor, task); await workspace.task(actor, task);
    expect(store.bucket('followUps').size).toBe(1); expect(store.bucket('outbox').size).toBe(0);
  });
});
