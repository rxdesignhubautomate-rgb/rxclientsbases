import { describe, expect, it, vi } from 'vitest';
import { makeCore, seedConversation } from './helpers/core.js';
import { ClientDirectoryService } from '../src/services/client-directory.service.js';
import { MarketingSafetyService, destinationKey } from '../src/services/marketing-safety.service.js';
import { sha256 } from '../src/utils/hashing.js';
import { CrmMarketingWorkspaceService } from '../src/services/crm-marketing-workspace.service.js';
import { MarketingService } from '../src/services/marketing.service.js';
import { OutboundWorker } from '../src/workers/outbound.worker.js';
import { classificationProjection } from '../src/services/client-classification.js';

async function prepared(overrides = {}) {
  const core = makeCore(), { contact } = await seedConversation(core);
  const actor = { orgId: 'RXDH', userId: 'TEST_OWNER', role: 'OWNER', active: true };
  const clock = () => Date.parse('2026-09-15T06:00:00Z');
  await core.store.create('users', actor.userId, actor);
  await core.store.update('contacts', contact.contactId, classificationProjection(contact));
  await core.store.create('systemSettings', 'marketing-safety-RXDH', { orgId: 'RXDH', enabled: true, rolloutStage: 'FULL' });
  await core.store.create('templateRegistry', 'T1', { orgId: 'RXDH', name: 'design_update', language: 'en', status: 'APPROVED', category: 'MARKETING', componentsJson: JSON.stringify([{ type: 'BODY', text: 'Reviewed design update' }]) });
  const directory = new ClientDirectoryService({ store: core.store, enabled: true, clock });
  const safety = new MarketingSafetyService({ store: core.store, directory, clock, dispatchEnabled: true });
  core.messages.marketingSafety = safety;
  const templateRegistry = { resolve: () => ({ name: 'design_update', language: 'en', body: 'Reviewed design update' }), getStatus: async () => ({ status: 'APPROVED', category: 'MARKETING', language: 'en', componentsJson: JSON.stringify([{ type: 'BODY', text: 'Reviewed design update' }]) }), prepare: () => ({ type: 'TEMPLATE', text: 'Reviewed design update', metadata: { template: { name: 'design_update', language: { code: 'en' }, components: [] } } }) };
  const workspace = new CrmMarketingWorkspaceService({ ...core, directory, safety, templateRegistry, clock });
  await safety.record(actor, contact.contactId, { state: 'granted', source: 'SIGNED_FORM', evidenceReference: 'SYNTHETIC-FORM', obtainedAt: new Date(clock() - 1000).toISOString(), expectedVersion: 0, reason: 'Synthetic test evidence' });
  const audience = await workspace.save(actor, 'audiences', { name: 'Test audience', kind: 'static', contactIds: [contact.contactId] });
  const content = await workspace.save(actor, 'content', { name: 'Test content', service: 'Designs', body: 'Reviewed design update', templateKey: 'design', rightsConfirmed: true, expiresAt: '2027-01-01T00:00:00Z' });
  await workspace.approveContent(actor, content.contentVersionId);
  let campaign = await workspace.createCampaign(actor, { name: 'Test reviewed batch', audienceId: audience.audienceId, contentVersionId: content.contentVersionId, objective: 'design_update', ...overrides });
  campaign = await workspace.prepareCampaignPage(actor, campaign.campaignId);
  await workspace.campaignAction(actor, campaign.campaignId, { action: 'approve', expectedDigest: campaign.snapshotDigest });
  await workspace.campaignAction(actor, campaign.campaignId, { action: 'start', expectedDigest: campaign.snapshotDigest });
  await workspace.processDue(); await workspace.processDue();
  const outbox = [...core.store.bucket('outbox').values()][0];
  expect(outbox).toBeTruthy(); expect(core.store.bucket('outbox').size).toBe(1);
  const message = await core.store.get('messages', outbox.messageId);
  return { ...core, actor, safety, workspace, campaign, message, outbox };
}

describe('reviewed campaign through the real queue and worker', () => {
  it('audits selected-content resend exceptions while retaining cooldown and opt-out checks', async () => {
    const core = await prepared({ resendReview: { reason: 'Client requested the same sample again', evidenceReference: 'Client request message 001' } });
    const key = destinationKey(core.actor.orgId, '+919876543210');
    await core.store.create('marketingContentReceipts', sha256(`${key}:${core.message.metadata.contentVersionId}`), { orgId: core.actor.orgId, contentVersionId: core.message.metadata.contentVersionId });
    expect(core.store.bucket('auditLogs').has(`EXCEPTIONS_${core.campaign.campaignId}`)).toBe(true);
    await core.store.update('marketingDestinationState', key, { slots: [{ messageId: 'OLDER_MESSAGE', at: core.safety.clock() - 3600000, state: 'accepted' }] });
    await expect(core.safety.reserve(core.message)).rejects.toMatchObject({ code: 'MARKETING_COOLDOWN' });
    await core.store.update('marketingDestinationState', key, { slots: [] });
    await expect(core.safety.reserve(core.message)).resolves.toBe(key);
    await core.safety.suppressInbound(core.actor.orgId, core.message.contactId, { messageId: 'STOP_REQUEST', senderId: '+919876543210' });
    await expect(core.safety.reserve(core.message, { recheck: true })).rejects.toMatchObject({ code: 'SUPPRESSED' });
  });
  it('invalidates a snapshot when the preferred company recipient changes', async () => {
    const core = await prepared();
    await core.store.update('contacts', core.message.contactId, { crmPreferredContactId: 'SOME_OTHER_CONTACT' });
    await expect(core.safety.reserve(core.message)).rejects.toMatchObject({ code: 'COMPANY_RECIPIENT_CHANGED' });
  });
  it('sends exactly the approved snapshot once and atomically persists its follow-up event', async () => {
    const core = await prepared();
    const send = vi.fn().mockResolvedValue({ providerMessageId: 'wamid.synthetic.reviewed' });
    const worker = new OutboundWorker({ ...core, channelManager: { send }, media: { prepareForSend: async () => [] }, workerId: 'TEST', retryDelays: [0], maxAttempts: 3 });
    worker.marketingSafety = core.safety;
    worker.onAccepted = (message, tx) => core.workspace.acceptedMessage(message, tx);
    await worker.processOne(core.outbox); await worker.processOne(core.outbox);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].message.text).toBe('Reviewed design update');
    expect((await core.store.get('messages', core.message.messageId)).submissionState).toBe('accepted');
    expect([...core.store.bucket('automationJobs').values()].filter(j => j.kind === 'CRM_TASK_EVENT')).toHaveLength(1);
  });
  it('rejects forged text, omitted approval, another logical message and revoked approver', async () => {
    const { safety, message, store, actor } = await prepared();
    await expect(safety.reserve({ ...message, text: 'Unreviewed promotion' })).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
    await expect(safety.reserve({ ...message, messageId: 'NOT_IN_SNAPSHOT' })).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
    await expect(safety.reserve({ ...message, metadata: { ...message.metadata, approvalVersion: null } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await store.update('users', actor.userId, { active: false });
    await expect(safety.reserve(message)).rejects.toMatchObject({ code: 'SENDER_PERMISSION_REVOKED' });
    expect(store.bucket('marketingContentReceipts').size).toBe(0);
  });
  it('does not attribute an ordinary reply to a merely queued campaign', async () => {
    const core = await prepared(); const marketing = new MarketingService({ store: core.store }); marketing.safety = core.safety;
    expect(await marketing.findContactCampaignContext(core.actor.orgId, core.message.contactId)).toBeNull();
    await core.store.update('messages', core.message.messageId, { submissionState: 'accepted' });
    expect((await marketing.findContactCampaignContext(core.actor.orgId, core.message.contactId)).campaignId).toBe(core.campaign.campaignId);
  });
  it('rechecks purpose and restricts internal tests to the explicit allowlist', async () => {
    const core = await prepared();
    await core.store.update('marketingCampaigns', core.campaign.campaignId, { objective: 'premium_preview' });
    await expect(core.safety.reserve(core.message)).rejects.toMatchObject({ code: 'PURPOSE_NO_LONGER_APPLIES' });
    await core.store.update('marketingCampaigns', core.campaign.campaignId, { objective: 'design_update' });
    await core.store.update('systemSettings', 'marketing-safety-RXDH', { rolloutStage: 'INTERNAL_TEST', allowedDestinations: ['+12025550101'] });
    await expect(core.safety.reserve(core.message)).rejects.toMatchObject({ code: 'RECIPIENT_OUTSIDE_ROLLOUT_ALLOWLIST' });
    await core.store.update('systemSettings', 'marketing-safety-RXDH', { allowedDestinations: ['+919876543210'] });
    await expect(core.safety.reserve(core.message)).rejects.toMatchObject({ code: 'INTERNAL_TEST_REQUIRED' });
  });
  it('invalidates an approved snapshot when the synced provider template body changes', async () => {
    const core = await prepared();
    await core.store.update('templateRegistry', 'T1', { componentsJson: JSON.stringify([{ type: 'BODY', text: 'Different promotion' }]) });
    await expect(core.safety.reserve(core.message)).rejects.toMatchObject({ code: 'TEMPLATE_CHANGED_REVIEW_REQUIRED' });
    expect(core.store.bucket('marketingContentReceipts').size).toBe(0);
  });
  it('requires sequential rollout review and always pauses on a settings change', async () => {
    const core = await prepared();
    const config = { expectedVersion: 0, contactIds: [core.message.contactId], providerReviewReference: 'SYNTHETIC-ACCOUNT-REVIEW', reason: 'Synthetic rollout review' };
    await expect(core.safety.configureRollout(core.actor, { ...config, stage: 'FULL' })).rejects.toThrow(/pilot/);
    const internal = await core.safety.configureRollout(core.actor, { ...config, stage: 'INTERNAL_TEST' });
    expect(internal.enabled).toBe(false);
    await expect(core.safety.configureRollout(core.actor, { ...config, expectedVersion: 1, stage: 'PILOT' })).rejects.toThrow(/internal/);
    const pilot = await core.safety.configureRollout(core.actor, { ...config, expectedVersion: 1, stage: 'PILOT', previousStageReviewReference: 'SYNTHETIC-INTERNAL-RESULT' });
    expect(pilot.rolloutStage).toBe('PILOT'); expect(pilot.enabled).toBe(false);
  });
  it('reconciles a held result with evidence without retrying and replays its early receipt', async () => {
    const core = await prepared();
    await core.safety.reserve(core.message);
    await core.store.update('messages', core.message.messageId, { status: 'DELIVERY_UNKNOWN' });
    await core.store.update('outbox', core.outbox.outboxId, { status: 'DELIVERY_UNKNOWN' });
    await core.messages.updateProviderStatus(core.actor.orgId, 'wamid.reviewed.result', 'READ');
    const result = await core.workspace.reconcileUnknown(core.actor, core.message.messageId, { outcome: 'ACCEPTED', providerMessageId: 'wamid.reviewed.result', evidenceReference: 'PROVIDER-RECORD-TEST', reason: 'Checked synthetic provider receipt' });
    expect(result.automaticallyRetried).toBe(false);
    expect((await core.messages.get(core.actor.orgId, core.message.messageId)).status).toBe('READ');
    expect(core.store.bucket('outbox').size).toBe(1);
    await expect(core.workspace.reconcileUnknown(core.actor, core.message.messageId, { outcome: 'NOT_ACCEPTED', evidenceReference: 'REVIEW-AGAIN', reason: 'Second conflicting attempt' })).rejects.toThrow(/changed/);
  });
  it('holds ambiguous stops without granting or fabricating an opt-out and preserves reviewed replies', async () => {
    const core = await prepared();
    const marketing = new MarketingService({ store: core.store }); marketing.safety = core.safety;
    const inbound = { messageId: 'IN_SYNTHETIC', text: 'nahi chahiye', senderId: '919876543210' };
    await marketing.handleInbound({ orgId: core.actor.orgId, contactId: core.message.contactId, message: inbound });
    expect((await core.safety.inspect(core.actor.orgId, await core.contacts.get(core.actor.orgId, core.message.contactId))).reason).toBe('RECIPIENT_REQUEST_NEEDS_REVIEW');
    await core.workspace.reviewReply(core.actor, inbound.messageId, { outcome: 'SERVICE_REPLY', reason: 'Staff reviewed the actual request' });
    await marketing.handleInbound({ orgId: core.actor.orgId, contactId: core.message.contactId, message: inbound });
    expect((await core.store.get('marketingReplyReceipts', inbound.messageId)).outcome).toBe('SERVICE_REPLY');
    expect((await core.workspace.replies(core.actor)).items).toHaveLength(0);
  });
});
