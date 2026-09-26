import { z } from 'zod';
import { sha256 } from '../utils/hashing.js';
import { ConflictError, ForbiddenError } from '../utils/errors.js';
import { activityOf, inspectDestination, timestampMs } from './client-classification.js';

export const destinationKey = (orgId, e164) => sha256(`${orgId}:WHATSAPP:marketing:${e164}`);
export function templateFingerprint(record) {
  if (!record?.componentsJson) return null;
  try { return sha256(JSON.stringify({ components: JSON.parse(record.componentsJson), language: record.language || 'en', category: record.category })); }
  catch { return null; }
}
export function assertPermission(actor, permission) {
  if (!actor?.orgId || !actor.userId || (!['OWNER', 'ADMIN'].includes(actor.role) && !actor.permissions?.some(p => p === '*' || p === permission))) throw new ForbiddenError(`Permission required: ${permission}`);
}
export function canonicalDestination(value, country) {
  const text = String(value || '');
  // Existing provider identities already use international digits, never national defaults.
  return inspectDestination(/^[1-9]\d{10,14}$/.test(text) ? `+${text}` : text, country).e164;
}
export function stopIntent(text) {
  const t = String(text || '').normalize('NFKC').trim().toLowerCase().replace(/[.!?,]+$/g, '');
  if (/^(stop all|stop everything|sab band karo|sabhi message band karo|सभी संदेश बंद करो)$/.test(t)) return 'all';
  if (/^(stop|unsubscribe|opt out|no more messages|message mat karo|msg mat karo|band karo|messages band karo|मत भेजो|मैसेज मत भेजो|संदेश बंद करो)$/.test(t)) return 'marketing';
  if (/not interested|nahi chahiye|नहीं चाहिए|stop|band|बंद/.test(t)) return 'review';
  return null;
}
export const permissionRecordSchema = z.object({
  state: z.enum(['granted', 'revoked']), source: z.enum(['SIGNED_FORM', 'CUSTOMER_MESSAGE', 'RECORDED_CALL', 'IN_PERSON', 'CUSTOMER_REQUEST']),
  evidenceReference: z.string().trim().min(5).max(500), obtainedAt: z.string().datetime(),
  expectedVersion: z.number().int().min(0), restoresOptOut: z.boolean().default(false),
  reason: z.string().trim().min(5).max(500), stopAll: z.boolean().default(false)
}).strict();

export class MarketingSafetyService {
  constructor({ store, directory, dispatchEnabled = false, clock = () => Date.now(), caps = [1, 3, 8], cooldownHours = 24, failureThreshold = 5 }) {
    Object.assign(this, { store, directory, dispatchEnabled, clock, caps, cooldownHours, failureThreshold });
  }

  async settings(orgId) {
    const state = await this.store.get('systemSettings', `marketing-safety-${orgId}`);
    return state?.orgId === orgId ? state : { orgId, enabled: false, version: 0 };
  }

  purposeReason(contact, campaign) {
    if (!campaign?.crmUpgrade) return null;
    if (contact.crmOpenConcerns?.trim() || contact.crmOpenComplaintCount > 0) return 'ACCOUNT_CONCERN_REVIEW_REQUIRED';
    if (campaign.objective === 'premium_preview' && !['premium', 'vip'].includes(contact.crmV1Tier)) return 'PURPOSE_NO_LONGER_APPLIES';
    if (campaign.objective === 'reactivation' && activityOf(contact, { nowMs: this.clock(), inactivityDays: this.directory.inactivityDays }) !== 'inactive') return 'PURPOSE_NO_LONGER_APPLIES';
    return null;
  }

  async configureRollout(actor, raw) {
    assertPermission(actor, 'marketing.settings');
    const input = z.object({ stage: z.enum(['INTERNAL_TEST', 'PILOT', 'FULL']), expectedVersion: z.number().int().min(0), contactIds: z.array(z.string().regex(/^[\w-]+$/)).max(25).default([]), reason: z.string().trim().min(5).max(500), providerReviewReference: z.string().trim().min(5).max(500), previousStageReviewReference: z.string().trim().min(5).max(500).optional() }).strict().parse(raw);
    if (input.stage !== 'FULL' && (!input.contactIds.length || (input.stage === 'INTERNAL_TEST' && input.contactIds.length > 10))) throw new ConflictError('Select 1–10 internal recipients or 1–25 pilot recipients');
    const destinations = [];
    for (const id of new Set(input.contactIds)) {
      const contact = await this.directory.checkedContact(actor, id), destination = canonicalDestination(contact.primaryPhone, contact.phoneCountryCode);
      if (!destination) throw new ConflictError('An allowlisted contact needs a valid destination');
      destinations.push(destination);
    }
    const key = `marketing-safety-${actor.orgId}`;
    await this.store.runTransaction(async tx => {
      const current = await tx.get('systemSettings', key);
      if ((current?.version || 0) !== input.expectedVersion) throw new ConflictError('Settings changed; reload');
      if (input.stage === 'PILOT' && (!['INTERNAL_TEST', 'PILOT'].includes(current?.rolloutStage) || !input.previousStageReviewReference)) throw new ConflictError('Review the internal test before a pilot');
      if (input.stage === 'FULL' && (current?.rolloutStage !== 'PILOT' || !input.previousStageReviewReference)) throw new ConflictError('Review pilot queue, webhook, exclusions and reporting evidence before full rollout');
      const date = new Date(this.clock());
      tx.set('systemSettings', key, { ...current, orgId: actor.orgId, enabled: false, rolloutStage: input.stage, allowedDestinations: [...new Set(destinations)], version: input.expectedVersion + 1, providerReviewReference: input.providerReviewReference, previousStageReviewReference: input.previousStageReviewReference || null, updatedBy: actor.userId, updatedAt: date });
      tx.create('auditLogs', sha256(`${key}:rollout:${input.expectedVersion + 1}`), { orgId: actor.orgId, actorId: actor.userId, action: 'MARKETING_ROLLOUT_REVIEWED', entityId: key, metadata: { stage: input.stage, recipients: destinations.length, reason: input.reason, providerReviewReference: input.providerReviewReference, previousStageReviewReference: input.previousStageReviewReference || null }, createdAt: date });
    });
    return this.settings(actor.orgId);
  }

  async setEnabled(actor, enabled, reason) {
    assertPermission(actor, 'marketing.settings');
    if (typeof enabled !== 'boolean' || String(reason || '').trim().length < 5) throw new ConflictError('A reason and boolean enabled state are required');
    if (enabled && !this.dispatchEnabled) throw new ConflictError('Deployment activation is disabled; use development previews first');
    if (enabled) {
      const filters = [['orgId', '==', actor.orgId]];
      const [total, prepared] = await Promise.all([this.store.count('contacts', { filters }), this.store.count('contacts', { filters: [...filters, ['crmV1SuppressionPrepared', '==', true]] })]);
      if (total !== prepared) throw new ConflictError('Complete and reconcile the legacy destination-suppression backfill before activating marketing');
      const history = await this.store.get('systemSettings', `marketing-history-${actor.orgId}`);
      if (history?.orgId !== actor.orgId || !history.ready || this.clock() - timestampMs(history.preparedAt) > 86400000) throw new ConflictError('Reconcile accepted and uncertain legacy marketing history before activation');
      if (!(await this.settings(actor.orgId)).rolloutStage) throw new ConflictError('Configure the reviewed internal-test allowlist before activation');
    }
    await this.store.runTransaction(async tx => {
      const id = `marketing-safety-${actor.orgId}`, old = await tx.get('systemSettings', id);
      const version = (old?.version || 0) + 1;
      tx.set('systemSettings', id, { ...old, orgId: actor.orgId, enabled, consecutiveFailures: 0, version, reason, updatedBy: actor.userId, updatedAt: new Date(this.clock()) });
      tx.create('auditLogs', sha256(`${id}:${version}`), { orgId: actor.orgId, actorId: actor.userId, action: enabled ? 'MARKETING_ENABLED' : 'MARKETING_KILL_SWITCH', entityId: id, metadata: { reason }, createdAt: new Date(this.clock()) });
    });
    return this.settings(actor.orgId);
  }

  async inspect(orgId, contact, destination = null) {
    const e164 = destination || canonicalDestination(contact.primaryPhone, contact.phoneCountryCode);
    if (!e164 || contact.orgId !== orgId) return { eligible: false, reason: 'INVALID_DESTINATION', state: 'unknown', version: 0 };
    const key = destinationKey(orgId, e164);
    const [permission, state] = await Promise.all([this.store.get('marketingPermissions', key), this.store.get('marketingDestinationState', key)]);
    const companies = await this.store.getMany('contacts', contact.crmCompanyIds || []);
    const blockedCompany = companies.some(c => c.orgId !== orgId || c.doNotMarket || c.stopAllCommunications || c.status === 'BLOCKED') || companies.length !== (contact.crmCompanyIds || []).length;
    const reason = this.permissionReason(contact, permission, state, blockedCompany);
    return { e164, destinationKey: key, state: state?.marketingSuppressed || state?.stopAll ? 'suppressed' : permission?.state || 'unknown', version: permission?.version || 0,
      source: permission?.source || null, obtainedAt: permission?.obtainedAt || null, eligible: !reason, reason, lastAcceptedAt: state?.lastAcceptedAt || null };
  }

  async inspectMany(orgId, contacts) {
    const destinations = contacts.map(c => canonicalDestination(c.primaryPhone, c.phoneCountryCode));
    const keys = destinations.filter(Boolean).map(e164 => destinationKey(orgId, e164));
    const [permissions, states, companies] = await Promise.all([
      this.store.getMany('marketingPermissions', keys), this.store.getMany('marketingDestinationState', keys), this.store.getMany('contacts', contacts.flatMap(c => c.crmCompanyIds || []))
    ]);
    const permissionMap = new Map(permissions.map(p => [destinationKey(orgId, p.e164), p]));
    const stateMap = new Map(states.map(s => [destinationKey(orgId, s.e164), s]));
    const companyMap = new Map(companies.map(c => [c.contactId || c.id, c]));
    return contacts.map((contact, index) => {
      const e164 = destinations[index];
      if (!e164 || contact.orgId !== orgId) return { eligible: false, reason: 'INVALID_DESTINATION', state: 'unknown', version: 0 };
      const key = destinationKey(orgId, e164), permission = permissionMap.get(key), state = stateMap.get(key);
      const companyBlocked = (contact.crmCompanyIds || []).some(id => { const c = companyMap.get(id); return !c || c.orgId !== orgId || c.doNotMarket || c.stopAllCommunications || c.status === 'BLOCKED'; });
      const reason = this.permissionReason(contact, permission, state, companyBlocked);
      return { e164, destinationKey: key, state: state?.reviewRequired ? 'needs_review' : state?.marketingSuppressed || state?.stopAll ? 'suppressed' : permission?.state || 'unknown', version: permission?.version || 0, eligible: !reason, reason, source: permission?.source || null, obtainedAt: permission?.obtainedAt || null, lastAcceptedAt: state?.lastAcceptedAt || null };
    });
  }

  permissionReason(contact, permission, state, companyBlocked = false) {
    if (state?.reviewRequired) return 'RECIPIENT_REQUEST_NEEDS_REVIEW';
    if (contact.doNotMarket || contact.stopAllCommunications || contact.status === 'BLOCKED' || companyBlocked || state?.stopAll || state?.marketingSuppressed) return 'SUPPRESSED';
    const legacyStop = contact.marketingOptOut || contact.marketingConsent?.status === 'OPTED_OUT' || contact.optInStatus === 'OPTED_OUT';
    if (legacyStop && !permission?.restoresOptOut) return 'LEGACY_OPT_OUT_REQUIRES_FRESH_EVIDENCE';
    if (permission?.orgId !== contact.orgId || permission?.state !== 'granted' || permission.purpose !== 'marketing' || permission.channel !== 'WHATSAPP' || !permission.evidenceReference) return 'PERMISSION_UNKNOWN';
    if ((timestampMs(permission.obtainedAt) ?? Infinity) > this.clock()) return 'INVALID_PERMISSION_DATE';
    return null;
  }

  async record(actor, contactId, raw, { requestKey = null } = {}) {
    assertPermission(actor, 'marketing.consent');
    const input = permissionRecordSchema.parse(raw);
    const contact = await this.directory.checkedContact(actor, contactId);
    const e164 = canonicalDestination(contact.primaryPhone, contact.phoneCountryCode);
    if (!e164) throw new ConflictError('Resolve the phone country and invalid number first');
    if (timestampMs(input.obtainedAt) > this.clock()) throw new ConflictError('Permission cannot be future-dated');
    const key = destinationKey(actor.orgId, e164);
    const receiptId = requestKey ? sha256(`${actor.orgId}:permission-import:${requestKey}`) : null;
    const requestFingerprint = sha256(JSON.stringify({ contactId, ...input, expectedVersion: null }));
    const recorded = await this.store.runTransaction(async tx => {
      if (receiptId) {
        const receipt = await tx.get('idempotencyKeys', receiptId);
        if (receipt) { if (receipt.orgId !== actor.orgId || receipt.requestFingerprint !== requestFingerprint) throw new ConflictError('Permission import receipt does not match'); return false; }
      }
      const [current, state, latestContact] = await Promise.all([tx.get('marketingPermissions', key), tx.get('marketingDestinationState', key), tx.get('contacts', contactId)]);
      if (!latestContact || latestContact.orgId !== actor.orgId || canonicalDestination(latestContact.primaryPhone, latestContact.phoneCountryCode) !== e164) throw new ConflictError('Contact destination changed; reload');
      this.directory.assertRecordScope(actor, latestContact);
      if ((current?.version || 0) !== input.expectedVersion) throw new ConflictError('Permission changed; reload');
      const isRestore = state?.reviewRequired || state?.marketingSuppressed || state?.stopAll || latestContact.marketingOptOut || latestContact.marketingConsent?.status === 'OPTED_OUT' || latestContact.optInStatus === 'OPTED_OUT';
      const stoppedAt = timestampMs(state?.reviewRequired ? state.updatedAt : state?.suppressedAt || latestContact.marketingOptOutAt || latestContact.marketingConsent?.optedOutAt || latestContact.marketingConsent?.recordedAt);
      if (input.state === 'granted' && isRestore && (!input.restoresOptOut || timestampMs(input.obtainedAt) <= (stoppedAt ?? this.clock() - 5 * 60000))) throw new ConflictError('Restoring an opt-out requires fresh evidence after the stop. If its date is unknown, record a new confirmation obtained in the last five minutes.');
      if (input.state === 'granted' && input.stopAll) throw new ConflictError('A stop-all record cannot grant marketing permission');
      const version = (current?.version || 0) + 1, date = new Date(this.clock());
      const record = { orgId: actor.orgId, e164, channel: 'WHATSAPP', purpose: 'marketing', ...input, version, contactId, recordedBy: actor.userId, recordedAt: date };
      delete record.expectedVersion;
      tx.set('marketingPermissions', key, record);
      tx.create('marketingPermissionEvents', `${key}-${version}`, record);
      tx.set('marketingDestinationState', key, { ...state, orgId: actor.orgId, e164, marketingSuppressed: input.state === 'revoked',
        // A marketing grant cannot restore a broader stop-all request.
        stopAll: Boolean(state?.stopAll || input.stopAll), reviewRequired: false, suppressedAt: input.state === 'revoked' ? date : state?.suppressedAt || null, updatedAt: date });
      tx.create('auditLogs', sha256(`${key}:permission:${version}`), { orgId: actor.orgId, actorId: actor.userId, action: 'MARKETING_PERMISSION_RECORDED', entityId: contactId, metadata: { version, state: input.state, source: input.source }, createdAt: date });
      if (receiptId) tx.create('idempotencyKeys', receiptId, { orgId: actor.orgId, requestFingerprint, contactId, permissionVersion: version, createdAt: date, kind: 'PERMISSION_IMPORT' });
      return true;
    });
    if (input.state === 'revoked') await this.cancelPending(actor.orgId, key);
    return { ...await this.inspect(actor.orgId, contact), recorded };
  }

  async suppressInbound(orgId, contactId, message, scope = 'marketing') {
    const e164 = canonicalDestination(message.senderId || (await this.store.get('contacts', contactId))?.primaryPhone);
    if (!e164) return;
    const key = destinationKey(orgId, e164), eventId = sha256(`${key}:stop:${message.messageId}`);
    await this.store.runTransaction(async tx => {
      const [event, state, old] = await Promise.all([tx.get('marketingPermissionEvents', eventId), tx.get('marketingDestinationState', key), tx.get('marketingPermissions', key)]);
      if (event) return;
      const date = new Date(this.clock()), version = (old?.version || 0) + 1;
      const record = { orgId, e164, channel: 'WHATSAPP', purpose: 'marketing', state: 'revoked', source: 'CUSTOMER_MESSAGE', evidenceReference: message.messageId, obtainedAt: date, recordedAt: date, version, contactId };
      tx.set('marketingPermissions', key, record);
      tx.create('marketingPermissionEvents', eventId, record);
      tx.set('marketingDestinationState', key, { ...state, orgId, e164, marketingSuppressed: true, stopAll: scope === 'all' || Boolean(state?.stopAll), suppressedAt: date, updatedAt: date });
    });
    await this.cancelPending(orgId, key);
  }

  async holdForReview(orgId, contactId, message) {
    const contact = await this.store.get('contacts', contactId);
    if (contact?.orgId !== orgId) return;
    const e164 = canonicalDestination(message.senderId || contact.primaryPhone, contact.phoneCountryCode);
    if (!e164) return;
    const key = destinationKey(orgId, e164);
    await this.store.runTransaction(async tx => {
      const state = await tx.get('marketingDestinationState', key);
      tx.set('marketingDestinationState', key, { ...state, orgId, e164, reviewRequired: true, reviewMessageId: message.messageId, updatedAt: new Date(this.clock()) });
    });
    await this.cancelPending(orgId, key);
  }

  async cancelPending(orgId, key) {
    // Bounded cleanup; dispatch checks suppression even if more queued jobs remain.
    const page = await this.store.find('outbox', { filters: [['orgId', '==', orgId], ['marketingDestinationKey', '==', key], ['status', 'in', ['PENDING', 'RETRY']]], limit: 100 });
    for (const row of page.items) await this.store.runTransaction(async tx => {
      const current = await tx.get('outbox', row.outboxId || row.id);
      if (!current || !['PENDING', 'RETRY'].includes(current.status)) return;
      tx.update('outbox', row.outboxId || row.id, { status: 'CANCELLED', lastError: { code: 'SUPPRESSED' }, updatedAt: new Date(this.clock()) });
      tx.update('messages', current.messageId, { status: 'CANCELLED', errorCode: 'SUPPRESSED', updatedAt: new Date(this.clock()) });
    });
    return { cancelled: page.items.length, morePendingCleanup: page.pagination.hasMore };
  }

  async category(message) {
    if (message.metadata?.campaignId || message.metadata?.isPromotional || message.metadata?.marketingPurpose) return 'MARKETING';
    if (message.type !== 'TEMPLATE') return 'SERVICE';
    const name = message.metadata?.template?.name, language = message.metadata?.template?.language?.code;
    const records = await this.store.find('templateRegistry', { filters: [['orgId', '==', message.orgId], ['name', '==', name || '']], limit: 20 });
    const record = records.items.find(t => t.language === language && t.status === 'APPROVED');
    if (!record) return 'MARKETING'; // Unknown templates never bypass consent through a client-supplied category.
    return record.category === 'UTILITY' || record.category === 'AUTHENTICATION' ? 'SERVICE' : 'MARKETING';
  }

  async reserve(message, recheck = false) {
    const contact = await this.store.get('contacts', message.contactId);
    if (!contact || contact.orgId !== message.orgId) throw blocked('CONTACT_UNAVAILABLE');
    const e164 = canonicalDestination(message.recipientId), key = e164 && destinationKey(message.orgId, e164);
    if (!key) throw blocked('INVALID_DESTINATION');
    const marketing = await this.category(message) === 'MARKETING';
    let providerTemplate = null;
    if (message.type === 'TEMPLATE') {
      const records = await this.store.find('templateRegistry', { filters: [['orgId', '==', message.orgId], ['name', '==', message.metadata?.template?.name || '']], limit: 100 });
      providerTemplate = records.items.find(r => r.status === 'APPROVED' && r.language === message.metadata?.template?.language?.code);
      if (!providerTemplate) throw blocked('TEMPLATE_NOT_APPROVED');
    }
    const companyIds = contact.crmCompanyIds || [];
    await this.store.runTransaction(async tx => {
      const [state, permission, settings, current, user, campaign, contentReceipt, ...companies] = await Promise.all([
        tx.get('marketingDestinationState', key), tx.get('marketingPermissions', key), tx.get('systemSettings', `marketing-safety-${message.orgId}`), tx.get('contacts', message.contactId),
        marketing ? tx.get('users', message.senderId || 'UNAUTHORISED') : null,
        message.metadata?.campaignId ? tx.get('marketingCampaigns', message.metadata.campaignId) : null,
        message.metadata?.contentVersionId ? tx.get('marketingContentReceipts', sha256(`${key}:${message.metadata.contentVersionId}`)) : null,
        ...companyIds.map(id => tx.get('contacts', id))
      ]);
      if (!current || current.orgId !== message.orgId || JSON.stringify(current.crmCompanyIds || []) !== JSON.stringify(companyIds)) throw blocked('CONTACT_CHANGED');
      if (state?.stopAll || current.stopAllCommunications || current.status === 'BLOCKED') throw blocked('SUPPRESSED');
      if (!marketing) return;
      if (!this.dispatchEnabled || settings?.enabled !== true || settings.orgId !== message.orgId) throw blocked('MARKETING_PAUSED');
      if (!['INTERNAL_TEST', 'PILOT', 'FULL'].includes(settings.rolloutStage)) throw blocked('ROLLOUT_REVIEW_REQUIRED');
      if (settings.rolloutStage !== 'FULL' && !settings.allowedDestinations?.includes(e164)) throw blocked('RECIPIENT_OUTSIDE_ROLLOUT_ALLOWLIST');
      if (settings.rolloutStage === 'INTERNAL_TEST' && message.metadata?.internalTest !== true) throw blocked('INTERNAL_TEST_REQUIRED');
      if (!user || user.orgId !== message.orgId || user.active !== true || (!['OWNER', 'ADMIN'].includes(user.role) && !user.permissions?.some(p => ['*', 'marketing.send'].includes(p)))) throw blocked('SENDER_PERMISSION_REVOKED');
      this.directory.assertRecordScope({ ...user, userId: user.userId || message.senderId }, current);
      const reason = this.permissionReason(current, permission, state, companies.some(c => !c || c.orgId !== message.orgId || c.doNotMarket || c.stopAllCommunications));
      if (reason) throw blocked(reason);
      if (campaign?.status === 'PAUSED') throw blocked('CAMPAIGN_PAUSED');
      if (campaign && (campaign.orgId !== message.orgId || !['RUNNING', 'ACTIVE', 'UPGRADE_RUNNING', 'COMPLETED'].includes(campaign.status))) throw blocked('CAMPAIGN_STOPPED');
      let reviewedResend = false;
      if (campaign?.crmUpgrade) {
        const purposeReason = this.purposeReason(current, campaign);
        if (purposeReason) throw blocked(purposeReason);
        const [enrollment, approver, content] = await Promise.all([
          tx.get('campaignEnrollments', message.metadata?.campaignEnrollmentId || 'MISSING'),
          tx.get('users', campaign.approvedBy || 'MISSING'),
          tx.get('marketingContentVersions', campaign.contentVersionId)
        ]);
        if (!message.metadata?.approvalVersion || message.metadata.approvalVersion !== campaign.approvalVersion || !approver?.active || approver.orgId !== message.orgId || (!['OWNER', 'ADMIN'].includes(approver.role) && !approver.permissions?.some(p => ['*', 'marketing.approve'].includes(p)))) throw blocked('APPROVAL_REQUIRED');
        if (!content || content.orgId !== message.orgId || content.status !== 'APPROVED' || !content.rightsConfirmed || content.confidential || Date.parse(content.expiresAt) <= this.clock()) throw blocked('CONTENT_EXPIRED_OR_REVOKED');
        if (!content.providerTemplateFingerprint || templateFingerprint(providerTemplate) !== content.providerTemplateFingerprint) throw blocked('TEMPLATE_CHANGED_REVIEW_REQUIRED');
        if (!enrollment || enrollment.orgId !== message.orgId || enrollment.campaignId !== campaign.campaignId || enrollment.contactId !== message.contactId || enrollment.destination !== e164 || message.metadata.contentVersionId !== campaign.contentVersionId) throw blocked('SNAPSHOT_MISMATCH');
        if ((current.crmCompanyIds || []).length > 1 || (enrollment.companyId && enrollment.companyId !== (current.crmCompanyIds?.[0] || current.contactId))) throw blocked('SNAPSHOT_COMPANY_CHANGED');
        const preferred = (companies[0] || current).crmPreferredContactId;
        if (!campaign.multipleCompanyRecipientsReview && preferred && preferred !== current.contactId) throw blocked('COMPANY_RECIPIENT_CHANGED');
        if (campaign.resendReview || campaign.multipleCompanyRecipientsReview) {
          const reviewer = await tx.get('users', campaign.createdBy);
          if (!reviewer?.active || reviewer.orgId !== message.orgId || campaign.audienceSnapshot?.kind !== 'static' || !campaign.audienceSnapshot.contactIds.includes(current.contactId)) throw blocked('EXCEPTION_REVIEW_REQUIRED');
          try { assertPermission({ ...reviewer, userId: campaign.createdBy }, 'marketing.exceptions'); } catch { throw blocked('EXCEPTION_REVIEW_REQUIRED'); }
          reviewedResend = Boolean(campaign.resendReview?.reason && campaign.resendReview?.evidenceReference);
        }
        if (Boolean(message.metadata.internalTest) !== (campaign.mode === 'internal_test')) throw blocked('SNAPSHOT_MISMATCH');
        if (enrollment.status === 'SNAPSHOT_READY' && !enrollment.messageId) throw blocked('ENROLLMENT_NOT_READY');
        if (enrollment.status !== 'QUEUED' || enrollment.messageId !== message.messageId || message.senderId !== campaign.startedBy || message.text !== enrollment.preparedMessage?.text || JSON.stringify(message.attachmentIds || []) !== JSON.stringify(enrollment.preparedMessage?.attachmentIds || [])) throw blocked('SNAPSHOT_MISMATCH');
        const approvedTemplate = enrollment.preparedMessage?.metadata?.template, actualTemplate = message.metadata?.template;
        if (message.type !== 'TEMPLATE' || actualTemplate?.name !== approvedTemplate?.name || actualTemplate?.language?.code !== approvedTemplate?.language?.code || JSON.stringify((actualTemplate?.components || []).filter(c => c.type !== 'header')) !== JSON.stringify((approvedTemplate?.components || []).filter(c => c.type !== 'header'))) throw blocked('SNAPSHOT_MISMATCH');
        const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: campaign.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(this.clock())));
        if (hour < campaign.businessHourStart || hour >= campaign.businessHourEnd || timestampMs(campaign.startAt) > this.clock()) throw blocked('QUIET_HOURS');
        if (Date.parse(campaign.contentSnapshot?.expiresAt) <= this.clock() || campaign.contentSnapshot?.confidential || !campaign.contentSnapshot?.rightsConfirmed) throw blocked('CONTENT_EXPIRED_OR_REVOKED');
      }
      if (message.metadata?.approvalVersion && (campaign?.approvalVersion !== message.metadata.approvalVersion || timestampMs(campaign?.approvalExpiresAt) <= this.clock())) throw blocked('APPROVAL_EXPIRED');
      const at = this.clock(), slots = (state?.slots || []).filter(s => s.at > at - 30 * 86400000 || s.state === 'submission_unknown' || s.state === 'submitting');
      if (slots.some(s => s.messageId === message.messageId)) { if (recheck) return; throw blocked('SUBMISSION_ALREADY_RESERVED'); }
      if (recheck) throw blocked('RESERVATION_MISSING');
      if (slots.some(s => ['submitting', 'submission_unknown'].includes(s.state))) throw blocked('DESTINATION_SUBMISSION_HELD');
      if (slots.some(s => at - s.at < this.cooldownHours * 3600000)) throw blocked('MARKETING_COOLDOWN');
      if ([1, 7, 30].some((days, index) => slots.filter(s => at - s.at < days * 86400000).length >= this.caps[index])) throw blocked('MARKETING_FREQUENCY_CAP');
      const contentId = message.metadata?.contentVersionId;
      if (!reviewedResend && (contentReceipt || (contentId && (state?.contentHistory || []).includes(contentId)))) throw blocked('CONTENT_ALREADY_SENT');
      tx.set('marketingDestinationState', key, { ...state, orgId: message.orgId, e164, slots: [...slots, { messageId: message.messageId, at, state: 'submitting', contentId: contentId || null }] });
    });
    return marketing ? key : null;
  }

  async settle(key, message, state) {
    if (!key) return;
    await this.store.runTransaction(async tx => {
      const current = await tx.get('marketingDestinationState', key);
      if (!current) return;
      const settings = state === 'accepted' ? await tx.get('systemSettings', `marketing-safety-${message.orgId}`) : null;
      const slots = (current.slots || []).flatMap(s => s.messageId !== message.messageId ? [s] : state === 'rejected' ? [] : [{ ...s, state }]);
      const patch = { slots };
      if (state === 'accepted') {
        patch.lastAcceptedAt = new Date(this.clock());
        patch.contentHistory = [...new Set([...(current.contentHistory || []), message.metadata?.contentVersionId].filter(Boolean))].slice(-200);
      }
      tx.update('marketingDestinationState', key, patch);
      if (state === 'accepted') tx.update('contacts', message.contactId, { crmV1LastMarketingAtMs: this.clock() });
      if (state === 'accepted' && message.metadata?.contentVersionId) tx.set('marketingContentReceipts', sha256(`${key}:${message.metadata.contentVersionId}`), { orgId: message.orgId, destinationKey: key, contentVersionId: message.metadata.contentVersionId, messageId: message.messageId, acceptedAt: new Date(this.clock()) });
      if (settings?.orgId === message.orgId && settings.consecutiveFailures) tx.update('systemSettings', `marketing-safety-${message.orgId}`, { consecutiveFailures: 0 });
    });
  }

  async providerFailure(message, error) {
    if (!message) return;
    const id = `marketing-safety-${message.orgId}`;
    await this.store.runTransaction(async tx => {
      const settings = await tx.get('systemSettings', id); if (!settings?.enabled) return;
      const consecutiveFailures = (settings.consecutiveFailures || 0) + 1;
      const pause = [401, 403].includes(error.status) || error.details?.type === 'OAuthException' || consecutiveFailures >= this.failureThreshold;
      tx.update('systemSettings', id, { consecutiveFailures, ...(pause ? { enabled: false, reason: 'Provider failure requires review' } : {}), updatedAt: new Date(this.clock()) });
      if (pause) tx.set('auditLogs', sha256(`${id}:provider-pause:${message.messageId}`), { orgId: message.orgId, action: 'MARKETING_PROVIDER_PAUSE', actorId: 'SYSTEM', entityId: message.messageId, metadata: { code: String(error.code || 'UNKNOWN'), consecutiveFailures }, createdAt: new Date(this.clock()) });
    });
  }
}

function blocked(code) { const error = new ConflictError(code.replaceAll('_', ' ')); error.code = code; error.retryable = false; return error; }
