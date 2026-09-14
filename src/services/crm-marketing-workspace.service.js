import { z } from 'zod';
import { createId } from '../utils/ids.js';
import { sha256 } from '../utils/hashing.js';
import { decodeCursor } from '../utils/pagination.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { compileAudienceFilter, filterSchema } from './audience-filter.js';
import { assertPermission, canonicalDestination, destinationKey, templateFingerprint } from './marketing-safety.service.js';
import { timestampMs, qualifyingOrder } from './client-classification.js';

const id = z.string().min(1).max(150).regex(/^[\w-]+$/);
const title = z.string().trim().min(2).max(160);
export const audienceInput = z.object({ name: title, kind: z.enum(['dynamic', 'static']), filter: filterSchema.optional(), contactIds: z.array(id).max(500).optional() }).strict();
export const contentInput = z.object({ name: title, service: title, body: z.string().trim().min(1).max(4000), templateKey: z.string().min(1).max(100),
  attachmentIds: z.array(id).max(1).default([]), rightsConfirmed: z.boolean(), confidential: z.boolean().default(false), expiresAt: z.string().datetime(),
  variables: z.record(z.string().max(500)).default({}), language: z.string().min(2).max(12).default('en') }).strict();
export const campaignInput = z.object({ name: title, audienceId: id, contentVersionId: id, objective: z.enum(['design_update', 'reactivation', 'premium_preview']),
  mode: z.enum(['standard', 'internal_test']).default('standard'),
  maxRecipients: z.number().int().min(1).max(500).default(500),
  resendReview: z.object({ reason: z.string().trim().min(5).max(500), evidenceReference: z.string().trim().min(5).max(500) }).strict().optional(),
  multipleCompanyRecipientsReview: z.object({ reason: z.string().trim().min(5).max(500) }).strict().optional(),
  timezone: z.string().max(80).default('Asia/Kolkata'), businessHourStart: z.number().int().min(0).max(23).default(9), businessHourEnd: z.number().int().min(1).max(24).default(18) }).strict();
const queryInput = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(1024).optional() }).strict();
const stages = ['NEW_LEAD', 'QUALIFYING', 'SAMPLE_SENT', 'QUOTATION_SENT', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST', 'ON_HOLD'];
const table = { audiences: 'marketingAudiences', content: 'marketingContentVersions', campaigns: 'marketingCampaigns' };

export class CrmMarketingWorkspaceService {
  constructor({ store, directory, safety, templateRegistry, contacts, conversations, channelAccounts, messages, domain, clock = () => Date.now() }) {
    Object.assign(this, { store, directory, safety, templateRegistry, contacts, conversations, channelAccounts, messages, domain, clock });
  }
  async overview(actor) {
    assertPermission(actor, 'marketing.read');
    const filters = this.directory.scope(actor);
    const [directory, totalContacts, repliedContacts, optedOutNumbers] = await Promise.all([
      this.directory.counts(actor), this.store.count('contacts', { filters }), this.store.count('contacts', { filters: [...filters, ['crmHasMarketingReply', '==', true]] }),
      ['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role) ? this.store.countWhere('marketingDestinationState', { and: [{ field: 'orgId', op: '==', value: actor.orgId }, { or: [{ field: 'marketingSuppressed', op: '==', value: true }, { field: 'stopAll', op: '==', value: true }] }] }) : null
    ]);
    return { totalContacts, preparedCounts: directory.counts, repliedContacts, optedOutNumbers, overlapping: true, note: 'Classification views overlap. Reply and destination opt-out counts cover the prepared upgrade records; review legacy history before comparing with older totals.' };
  }
  async get(actor, kind, recordId, permission = 'marketing.read') {
    assertPermission(actor, permission);
    const value = await this.store.get(table[kind], recordId);
    if (!value || value.orgId !== actor.orgId || !value.crmUpgrade) throw new NotFoundError(kind);
    if (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role) && value.createdBy !== actor.userId && !(kind === 'audiences' && value.sharedWith?.includes(actor.userId))) throw new NotFoundError(kind);
    return value;
  }
  async list(actor, kind, raw = {}) {
    assertPermission(actor, 'marketing.read');
    const q = queryInput.parse(raw), filters = [['orgId', '==', actor.orgId], ['crmUpgrade', '==', true]];
    if (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role)) filters.push(['createdBy', '==', actor.userId]);
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid cursor');
    if (cursor) await this.get(actor, kind, cursor);
    if (kind === 'audiences' && !['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role)) {
      return this.store.findWhere(table.audiences, { where: { and: [{ field: 'orgId', op: '==', value: actor.orgId }, { field: 'crmUpgrade', op: '==', value: true }, { or: [{ field: 'createdBy', op: '==', value: actor.userId }, { field: 'sharedWith', op: 'array-contains', value: actor.userId }] }] }, limit: q.limit, cursor, orderBy: ['createdAt', 'desc'] });
    }
    return this.store.find(table[kind], { filters, limit: q.limit, cursor, orderBy: ['createdAt', 'desc'] });
  }
  async save(actor, kind, raw, recordId = null) {
    assertPermission(actor, kind === 'audiences' ? 'marketing.audiences' : 'marketing.content');
    const input = (kind === 'audiences' ? audienceInput : contentInput).parse(raw);
    const before = recordId ? await this.get(actor, kind, recordId) : null;
    if (kind === 'audiences') {
      if (input.kind === 'dynamic') compileAudienceFilter(input.filter);
      else {
        if (!input.contactIds?.length) throw new ConflictError('Select contacts for a static audience');
        for (const contactId of new Set(input.contactIds)) await this.directory.checkedContact(actor, contactId);
        input.contactIds = [...new Set(input.contactIds)];
      }
    } else {
      if (!input.rightsConfirmed || input.confidential) throw new ConflictError('Only approved non-confidential material with sharing rights can be used');
      if (Date.parse(input.expiresAt) <= this.clock()) throw new ConflictError('Content must expire in the future');
      this.templateRegistry.resolve(input.templateKey, 'MARKETING');
      const attachments = await this.store.getMany('attachments', input.attachmentIds);
      if (attachments.length !== input.attachmentIds.length || attachments.some(a => a.orgId !== actor.orgId)) throw new ConflictError('Content attachment is unavailable');
    }
    const recordIdNew = kind === 'audiences' ? createId('marketingAudience') : `CONTENT_${createId('attachment')}`;
    const document = { ...input, orgId: actor.orgId, crmUpgrade: true, createdBy: actor.userId, createdAt: new Date(this.clock()),
      version: (before?.version || 0) + 1, previousVersionId: recordId, status: 'DRAFT', [kind === 'audiences' ? 'audienceId' : 'contentVersionId']: recordIdNew };
    await this.store.create(table[kind], recordIdNew, document);
    return document;
  }
  async shareAudience(actor, recordId, raw) {
    assertPermission(actor, 'marketing.audiences');
    const input = z.object({ sharedWith: z.array(id).max(25), expectedRevision: z.number().int().min(0) }).strict().parse(raw);
    const before = await this.get(actor, 'audiences', recordId);
    if (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role) && before.createdBy !== actor.userId) throw new ConflictError('Only the group owner or a manager can change sharing');
    await this.store.runTransaction(async tx => {
      const current = await tx.get(table.audiences, recordId);
      const users = await Promise.all([...new Set(input.sharedWith)].map(userId => tx.get('users', userId)));
      if (users.some(u => !u?.active || u.orgId !== actor.orgId)) throw new ConflictError('Choose active team members in this business');
      if ((current.sharingRevision || 0) !== input.expectedRevision) throw new ConflictError('Sharing changed; reload');
      tx.update(table.audiences, recordId, { sharedWith: [...new Set(input.sharedWith)], sharingRevision: input.expectedRevision + 1 });
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, entityId: recordId, action: 'AUDIENCE_SHARING_REVIEWED', before: current.sharedWith || [], after: input.sharedWith, createdAt: new Date(this.clock()) });
    });
    return this.get(actor, 'audiences', recordId);
  }
  async archive(actor, kind, recordId, raw) {
    if (!['audiences', 'content'].includes(kind)) throw new ConflictError('Unsupported record');
    assertPermission(actor, kind === 'audiences' ? 'marketing.audiences' : 'marketing.content');
    const input = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(5).max(500) }).strict().parse(raw);
    await this.get(actor, kind, recordId);
    await this.store.runTransaction(async tx => {
      const record = await tx.get(table[kind], recordId);
      if (record.orgId !== actor.orgId || (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role) && record.createdBy !== actor.userId)) throw new NotFoundError(kind);
      if (record.version !== input.expectedVersion) throw new ConflictError('Version changed; reload');
      tx.update(table[kind], recordId, { status: 'ARCHIVED', archivedAt: new Date(this.clock()), archivedBy: actor.userId });
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: `${kind.toUpperCase()}_ARCHIVED`, entityId: recordId, metadata: { reason: input.reason }, createdAt: new Date(this.clock()) });
    });
    return this.get(actor, kind, recordId);
  }
  async approveContent(actor, contentVersionId) {
    assertPermission(actor, 'marketing.content.approve');
    const content = await this.get(actor, 'content', contentVersionId);
    const template = await this.checkContent(actor.orgId, content, false);
    await this.store.update(table.content, contentVersionId, { status: 'APPROVED', providerLanguage: template.approvedLanguage, providerTemplateFingerprint: template.fingerprint, providerComponents: template.providerComponents, approvedBy: actor.userId, approvedAt: new Date(this.clock()) });
    return this.get(actor, 'content', contentVersionId);
  }
  async checkContent(orgId, content, requireApproval = true) {
    if (content.status === 'ARCHIVED') throw new ConflictError('Content was archived; create and approve a new version');
    if (content.orgId !== orgId || !content.rightsConfirmed || content.confidential || Date.parse(content.expiresAt) <= this.clock() || (requireApproval && content.status !== 'APPROVED')) throw new ConflictError('Content needs approval or has expired');
    const template = this.templateRegistry.resolve(content.templateKey, 'MARKETING');
    const status = await this.templateRegistry.getStatus(orgId, template.name, template.language);
    if (!status || status.status !== 'APPROVED' || status.category !== 'MARKETING') throw new ConflictError('Sync an approved Meta marketing template before reviewing this content');
    const fingerprint = templateFingerprint(status);
    if (!fingerprint) throw new ConflictError('Sync the provider template components before approval; preview text cannot be verified');
    const providerComponents = JSON.parse(status.componentsJson), body = providerComponents.find(c => c.type?.toUpperCase() === 'BODY')?.text;
    const header = providerComponents.find(c => c.type?.toUpperCase() === 'HEADER');
    if (header?.format === 'TEXT' && /\{\{/.test(header.text || '')) throw new ConflictError('Dynamic text headers need a supported template mapping');
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header?.format) && template.header?.type !== header.format) throw new ConflictError('Provider media header differs from the configured template');
    const buttons = providerComponents.find(c => c.type?.toUpperCase() === 'BUTTONS')?.buttons || [];
    if (buttons.some(b => !['URL', 'PHONE_NUMBER', 'QUICK_REPLY'].includes(b.type) || /\{\{/.test(b.url || ''))) throw new ConflictError('This template requires unsupported dynamic button parameters');
    const normalized = value => String(value || '').replace(/\r\n/g, '\n').trim();
    if (!body || normalized(body) !== normalized(template.body)) throw new ConflictError('Configured preview text differs from the approved provider template; update the template mapping and review a new version');
    if (content.providerTemplateFingerprint && content.providerTemplateFingerprint !== fingerprint) throw new ConflictError('Provider template changed; review a new content version');
    const attachments = await this.store.getMany('attachments', content.attachmentIds);
    if (attachments.length !== content.attachmentIds.length || attachments.some(a => a.orgId !== orgId || a.purpose !== 'MARKETING_ASSET')) throw new ConflictError('Use a shared approved marketing asset');
    if (template.header?.required && attachments.length !== 1) throw new ConflictError('Template media header is required');
    if (!template.header?.type && attachments.length) throw new ConflictError('This template does not accept media');
    if (attachments.length && !attachments[0].mimeType?.startsWith(({ VIDEO: 'video/', IMAGE: 'image/', DOCUMENT: 'application/' })[template.header?.type] || 'INVALID/')) throw new ConflictError('Attachment does not match the approved header');
    if (content.providerLanguage && content.providerLanguage !== (status.language || template.language)) throw new ConflictError('Template language changed; review a new content version');
    return { ...template, approvedLanguage: status.language || template.language, fingerprint, providerComponents };
  }
  prepareMessage(content, contact) {
    const variables = { ...content.variables };
    const values = { company: contact.companyName || '', person: contact.contactPerson || '', city: contact.city || '', content: content.body };
    for (const [key, value] of Object.entries(variables)) variables[key] = value.replace(/\{\{(company|person|city|content)\}\}/g, (_, field) => values[field]);
    const result = this.templateRegistry.prepare(content.templateKey, variables, 'MARKETING');
    if (/\{\{[^}]+\}\}/.test(result.text || '')) throw new ConflictError('Unresolved template variables');
    if (content.providerLanguage && result.metadata?.template) result.metadata.template.language = { code: content.providerLanguage };
    const template = this.templateRegistry.resolve(content.templateKey, 'MARKETING');
    if (template.header?.type) result.metadata.templateHeader = template.header;
    return { ...result, attachmentIds: content.attachmentIds, metadata: { ...result.metadata, providerComponents: content.providerComponents || [], contentVersionId: content.contentVersionId, marketingPurpose: true } };
  }
  where(actor, audience, at) {
    const base = this.directory.scope(actor).map(([field, op, value]) => ({ field, op, value }));
    base.push({ field: 'crmV1Version', op: '==', value: 1 });
    if (audience.kind !== 'dynamic') throw new ConflictError('Static audience uses reference pagination');
    return { and: [...base, compileAudienceFilter(audience.filter, at)] };
  }
  async audiencePage(actor, audience, raw = {}, at = this.clock()) {
    const q = queryInput.parse(raw);
    if (audience.kind === 'static') {
      const offset = q.cursor ? Number(q.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > audience.contactIds.length) throw new ConflictError('Invalid static audience cursor');
      const items = await this.store.getMany('contacts', audience.contactIds.slice(offset, offset + q.limit));
      const visible = items.filter(c => { try { this.directory.assertRecordScope(actor, c); return true; } catch { return false; } });
      const all = await this.store.getMany('contacts', audience.contactIds);
      const count = all.filter(c => { try { this.directory.assertRecordScope(actor, c); return true; } catch { return false; } }).length;
      return { items: visible, count, pagination: { hasMore: offset + q.limit < audience.contactIds.length, nextCursor: offset + q.limit < audience.contactIds.length ? String(offset + q.limit) : null } };
    }
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid audience cursor');
    if (cursor) await this.directory.checkedContact(actor, cursor);
    const where = this.where(actor, audience, at);
    const [page, count] = await Promise.all([this.store.findWhere('contacts', { where, cursor, limit: q.limit }), this.store.countWhere('contacts', where)]);
    return { ...page, count };
  }
  async previewAudience(actor, audienceId, q = {}) {
    const audience = await this.get(actor, 'audiences', audienceId), at = this.clock();
    const page = await this.audiencePage(actor, audience, q, at);
    const permissions = await this.safety.inspectMany(actor.orgId, page.items);
    const items = page.items.map((c, index) => ({ ...this.directory.present(c), permission: permissions[index] }));
    return { ...page, items, metric: 'contact_records', evaluatedAt: new Date(at), eligibleOnThisPage: items.filter(i => i.permission.eligible).length };
  }
  async createCampaign(actor, raw) {
    assertPermission(actor, 'marketing.create');
    const input = campaignInput.parse(raw);
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); } catch { throw new ConflictError('Invalid timezone'); }
    if (input.businessHourEnd <= input.businessHourStart) throw new ConflictError('Business hours must start before they end');
    const [audience, content] = await Promise.all([this.get(actor, 'audiences', input.audienceId), this.get(actor, 'content', input.contentVersionId)]);
    await this.checkContent(actor.orgId, content);
    if (audience.status === 'ARCHIVED') throw new ConflictError('Choose an active client group');
    if (input.resendReview || input.multipleCompanyRecipientsReview) {
      if (audience.kind !== 'static') throw new ConflictError('These exceptions require a group of individually selected contacts');
      assertPermission(actor, 'marketing.exceptions');
      if (!audience.contactIds.length) throw new ConflictError('Select recipients first');
    }
    const campaignId = createId('marketingCampaign');
    const value = { ...input, campaignId, orgId: actor.orgId, crmUpgrade: true, createdBy: actor.userId, createdAt: new Date(this.clock()),
      status: 'PREPARING', revision: 1, audienceSnapshot: audience, contentSnapshot: content, preparedAt: this.clock(), preparationCursor: null,
      preparationComplete: false, recipients: 0, exclusions: 0, scanned: 0, snapshotDigest: sha256(JSON.stringify({ input, audience, content })) };
    await this.store.runTransaction(async tx => {
      tx.create(table.campaigns, campaignId, value);
      if (input.resendReview || input.multipleCompanyRecipientsReview) tx.create('auditLogs', `EXCEPTIONS_${campaignId}`, { orgId: actor.orgId, actorId: actor.userId, entityId: campaignId, action: 'CAMPAIGN_EXCEPTIONS_REVIEWED', resendReview: input.resendReview || null, multipleCompanyRecipientsReview: input.multipleCompanyRecipientsReview || null, selectedContactIds: audience.contactIds, createdAt: new Date(this.clock()) });
    });
    return value;
  }
  async prepareCampaignPage(actor, campaignId) {
    assertPermission(actor, 'marketing.create');
    const campaign = await this.get(actor, 'campaigns', campaignId);
    if (campaign.status !== 'PREPARING') return campaign;
    const page = await this.audiencePage(actor, campaign.audienceSnapshot, { limit: 50, ...(campaign.preparationCursor ? { cursor: campaign.preparationCursor } : {}) }, campaign.preparedAt);
    const inspected = await Promise.all(page.items.map(async contact => {
      const permission = await this.safety.inspect(actor.orgId, contact);
      let reason = permission.reason || this.safety.purposeReason(contact, campaign);
      if (!campaign.resendReview && permission.destinationKey && await this.store.get('marketingContentReceipts', sha256(`${permission.destinationKey}:${campaign.contentVersionId}`))) reason = 'CONTENT_ALREADY_SENT';
      if ((contact.crmCompanyIds || []).length > 1) reason = 'MULTIPLE_COMPANIES_REQUIRE_SELECTION';
      const companyId = contact.crmCompanyIds?.[0] || contact.contactId || contact.id;
      const company = companyId === contact.contactId ? contact : await this.store.get('contacts', companyId);
      if (!campaign.multipleCompanyRecipientsReview && company?.crmPreferredContactId && company.crmPreferredContactId !== contact.contactId) reason = 'NOT_PREFERRED_COMPANY_CONTACT';
      let prepared = null;
      try { prepared = this.prepareMessage(campaign.contentSnapshot, contact); } catch { reason = 'MISSING_PERSONALISATION'; }
      return { contactId: contact.contactId || contact.id, companyId, permission, reason, prepared };
    }));
    await this.store.runTransaction(async tx => {
      const current = await tx.get(table.campaigns, campaignId);
      if (current.status !== 'PREPARING' || current.preparationCursor !== campaign.preparationCursor) throw new ConflictError('Preparation advanced; reload');
      const keys = inspected.map(i => ({ recipient: sha256(`${campaignId}:${i.permission.e164 || i.contactId}`), company: sha256(`${campaignId}:company:${i.companyId}`) }));
      const previous = await Promise.all(keys.map(async key => ({ recipient: await tx.get('campaignEnrollments', key.recipient), company: await tx.get('idempotencyKeys', key.company) })));
      const seenDestinations = new Set(), seenCompanies = new Set();
      let recipients = current.recipients, exclusions = current.exclusions, digest = current.snapshotDigest;
      inspected.forEach((item, index) => {
        const key = keys[index];
        const duplicate = previous[index].recipient || seenDestinations.has(key.recipient) || (!campaign.multipleCompanyRecipientsReview && (previous[index].company || seenCompanies.has(key.company)));
        let reason = item.reason || (duplicate ? 'DUPLICATE_COMPANY_OR_DESTINATION' : null);
        if (!reason && recipients >= (campaign.maxRecipients || 500)) reason = 'BATCH_LIMIT';
        if (previous[index].recipient || seenDestinations.has(key.recipient)) reason = reason || 'DUPLICATE_DESTINATION';
        const recordId = reason ? sha256(`${campaignId}:excluded:${item.contactId}`) : key.recipient;
        tx.set('campaignEnrollments', recordId, { campaignEnrollmentId: recordId, campaignId, orgId: actor.orgId, crmUpgrade: true,
          contactId: item.contactId, companyId: item.companyId, destination: item.permission.e164 || null, permissionVersion: item.permission.version,
          status: reason ? 'EXCLUDED' : 'SNAPSHOT_READY', suppressionReason: reason, preparedMessage: item.prepared, createdAt: new Date(this.clock()), approvalVersion: 1 });
        if (reason) exclusions += 1;
        else { recipients += 1; seenDestinations.add(key.recipient); seenCompanies.add(key.company); tx.set('idempotencyKeys', key.company, { orgId: actor.orgId, campaignId, contactId: item.contactId }); }
        digest = sha256(`${digest}:${recordId}:${reason || 'eligible'}`);
      });
      const complete = !page.pagination.hasMore || recipients >= (campaign.maxRecipients || 500);
      tx.update(table.campaigns, campaignId, { recipients, exclusions, scanned: current.scanned + page.items.length, snapshotDigest: digest,
        preparationCursor: page.pagination.nextCursor, preparationComplete: complete, audienceRecordsAtPreparation: page.count, status: complete ? 'REVIEW' : 'PREPARING' });
    });
    return this.get(actor, 'campaigns', campaignId);
  }
  async campaignRecipients(actor, campaignId, raw = {}) {
    await this.get(actor, 'campaigns', campaignId);
    const q = queryInput.parse(raw), cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid cursor');
    if (cursor) { const row = await this.store.get('campaignEnrollments', cursor); if (row?.orgId !== actor.orgId || row.campaignId !== campaignId) throw new ConflictError('Cursor belongs to another campaign'); }
    const page = await this.store.find('campaignEnrollments', { filters: [['orgId', '==', actor.orgId], ['campaignId', '==', campaignId]], orderBy: ['createdAt', 'asc'], limit: q.limit, cursor });
    const visibleContacts = new Set();
    for (const contact of await this.store.getMany('contacts', page.items.map(r => r.contactId))) {
      try { this.directory.assertRecordScope(actor, contact); visibleContacts.add(contact.contactId || contact.id); } catch { /* Current scope takes precedence over an old snapshot. */ }
    }
    const messages = new Map((await this.store.getMany('messages', page.items.map(r => r.messageId))).filter(m => m.orgId === actor.orgId).map(m => [m.messageId || m.id, m]));
    return { ...page, items: page.items.filter(r => visibleContacts.has(r.contactId)).map(r => { const candidate = messages.get(r.messageId), m = candidate?.contactId === r.contactId ? candidate : null; return { ...r, deliveryState: m?.status || null, submissionState: m?.submissionState || null, providerMessageId: m?.providerMessageId || null, errorCode: m?.errorCode || null, errorMessage: m?.errorMessage || null }; }) };
  }
  async campaignAction(actor, campaignId, raw) {
    const input = z.object({ action: z.enum(['approve', 'start', 'pause', 'cancel']), expectedDigest: z.string().max(100), startAt: z.string().datetime().optional() }).strict().parse(raw);
    assertPermission(actor, input.action === 'approve' ? 'marketing.approve' : 'marketing.send');
    const before = await this.get(actor, 'campaigns', campaignId);
    if (['approve', 'start'].includes(input.action)) await this.checkContent(actor.orgId, before.contentSnapshot);
    const actionStates = { approve: ['REVIEW'], start: ['APPROVED', 'PAUSED'], pause: ['UPGRADE_RUNNING', 'COMPLETED'], cancel: ['PREPARING', 'PREPARATION_HELD', 'REVIEW', 'APPROVED', 'UPGRADE_RUNNING', 'PAUSED', 'COMPLETED'] };
    if (input.action === 'start' && (!this.safety.dispatchEnabled || !(await this.safety.settings(actor.orgId)).enabled)) throw new ConflictError('Marketing activation is disabled');
    await this.store.runTransaction(async tx => {
      const campaign = await tx.get(table.campaigns, campaignId);
      if (campaign.snapshotDigest !== input.expectedDigest || !actionStates[input.action].includes(campaign.status)) throw new ConflictError('Campaign changed; reopen the review');
      const timestamp = new Date(this.clock()), patch = { updatedAt: timestamp };
      if (input.action === 'approve') {
        if (!campaign.recipients || !campaign.preparationComplete) throw new ConflictError('Prepare at least one eligible recipient');
        Object.assign(patch, { status: 'APPROVED', approvedBy: actor.userId, approvedAt: timestamp, approvalVersion: campaign.revision, approvalExpiresAt: new Date(this.clock() + 7 * 86400000) });
      } else if (input.action === 'start') {
        if (timestampMs(campaign.approvalExpiresAt) <= this.clock()) throw new ConflictError('Approval expired; create a fresh reviewed campaign');
        Object.assign(patch, { status: 'UPGRADE_RUNNING', startedBy: actor.userId, startAt: input.startAt ? new Date(input.startAt) : timestamp });
      } else patch.status = input.action === 'pause' ? 'PAUSED' : 'CANCELLED';
      tx.update(table.campaigns, campaignId, patch);
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: `CAMPAIGN_${input.action.toUpperCase()}`, entityId: campaignId, metadata: { digest: campaign.snapshotDigest }, createdAt: timestamp });
    });
    if (['start', 'cancel'].includes(input.action)) {
      const queued = await this.store.find('outbox', { filters: [['orgId', '==', actor.orgId], ['campaignId', '==', campaignId], ['status', 'in', ['PENDING', 'RETRY']]], limit: 500 });
      for (const item of queued.items) await this.store.runTransaction(async tx => {
        const current = await tx.get('outbox', item.outboxId || item.id);
        if (!current || !['PENDING', 'RETRY'].includes(current.status)) return;
        if (input.action === 'cancel') {
          tx.update('outbox', item.outboxId || item.id, { status: 'CANCELLED', updatedAt: new Date(this.clock()) });
          tx.update('messages', current.messageId, { status: 'CANCELLED', errorCode: 'CAMPAIGN_CANCELLED', updatedAt: new Date(this.clock()) });
        } else if (current.lastError?.code === 'CAMPAIGN_PAUSED') tx.update('outbox', item.outboxId || item.id, { nextAttemptAt: new Date(this.clock()) });
      });
    }
    return this.get(actor, 'campaigns', campaignId);
  }
  async processDue(limit = 10) {
    await this.processClassificationJobs();
    await this.processTaskEvents();
    await this.processReviewRules();
    const preparing = await this.store.find(table.campaigns, { filters: [['crmUpgrade', '==', true], ['status', '==', 'PREPARING']], limit: Math.min(limit, 10) });
    for (const campaign of preparing.items) {
      const actor = await this.store.get('users', campaign.createdBy);
      if (!actor?.active || actor.orgId !== campaign.orgId) { await this.store.update(table.campaigns, campaign.campaignId, { status: 'PREPARATION_HELD', preparationError: 'CREATOR_UNAVAILABLE' }); continue; }
      try { await this.prepareCampaignPage({ ...actor, userId: campaign.createdBy }, campaign.campaignId); }
      catch (error) { await this.store.runTransaction(async tx => { const current = await tx.get(table.campaigns, campaign.campaignId); if (current?.status === 'PREPARING') tx.update(table.campaigns, campaign.campaignId, { status: 'PREPARATION_HELD', preparationError: error.code || 'PREPARATION_NEEDS_REVIEW' }); }); }
    }
    if (!this.safety.dispatchEnabled) return;
    const campaigns = await this.store.find(table.campaigns, { filters: [['crmUpgrade', '==', true], ['status', '==', 'UPGRADE_RUNNING']], limit: Math.min(limit, 10) });
    for (const campaign of campaigns.items) {
      try {
      if (!(await this.safety.settings(campaign.orgId)).enabled || timestampMs(campaign.startAt) > this.clock()) continue;
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: campaign.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(this.clock())));
      if (hour < campaign.businessHourStart || hour >= campaign.businessHourEnd) continue;
      const sender = await this.store.get('users', campaign.startedBy);
      if (!sender?.active || sender.orgId !== campaign.orgId || (!['OWNER', 'ADMIN'].includes(sender.role) && !sender.permissions?.some(p => ['*', 'marketing.send'].includes(p)))) { await this.store.update(table.campaigns, campaign.campaignId, { status: 'PAUSED', pauseReason: 'SENDER_PERMISSION_REVOKED' }); continue; }
      const page = await this.store.find('campaignEnrollments', { filters: [['orgId', '==', campaign.orgId], ['campaignId', '==', campaign.campaignId], ['status', '==', 'SNAPSHOT_READY']], limit: 25 });
      for (const enrollment of page.items) {
        const contact = await this.contacts.get(campaign.orgId, enrollment.contactId);
        const eligibility = await this.safety.inspect(campaign.orgId, contact);
        if (!eligibility.eligible || eligibility.e164 !== enrollment.destination) { await this.store.update('campaignEnrollments', enrollment.campaignEnrollmentId, { status: 'EXCLUDED', suppressionReason: eligibility.reason || 'DESTINATION_CHANGED' }); continue; }
        await this.checkContent(campaign.orgId, campaign.contentSnapshot);
        const account = await this.channelAccounts.resolveForSend(campaign.orgId, 'WHATSAPP', null);
        await this.contacts.addIdentity(campaign.orgId, contact.contactId, { channel: 'WHATSAPP', externalUserId: enrollment.destination, channelAccountId: account.channelAccountId, active: true });
        const conversation = await this.conversations.findOrCreate({ orgId: campaign.orgId, contactId: contact.contactId, channel: 'WHATSAPP', channelAccountId: account.channelAccountId, assignedTo: contact.assignedTo, contactRelationshipType: contact.relationshipType });
        const queued = await this.messages.queueOutbound({ orgId: campaign.orgId, conversationId: conversation.conversationId, ...enrollment.preparedMessage,
          senderType: 'AGENT', senderId: campaign.startedBy, idempotencyKey: `crm-reviewed:${enrollment.campaignEnrollmentId}`,
          metadata: { ...enrollment.preparedMessage.metadata, internalTest: campaign.mode === 'internal_test', campaignId: campaign.campaignId, campaignEnrollmentId: enrollment.campaignEnrollmentId, approvalVersion: campaign.approvalVersion } });
        await this.store.runTransaction(async tx => {
          const latest = await tx.get('campaignEnrollments', enrollment.campaignEnrollmentId);
          if (latest?.status === 'SNAPSHOT_READY') tx.update('campaignEnrollments', enrollment.campaignEnrollmentId, { status: 'QUEUED', messageId: queued.message.messageId, queuedAt: new Date(this.clock()) });
        });
      }
      if (!page.pagination.hasMore) await this.store.runTransaction(async tx => {
        const latest = await tx.get(table.campaigns, campaign.campaignId);
        if (latest?.status === 'UPGRADE_RUNNING') tx.update(table.campaigns, campaign.campaignId, { status: 'COMPLETED', completedAt: new Date(this.clock()) });
      });
      } catch (error) {
        await this.store.runTransaction(async tx => {
          const latest = await tx.get(table.campaigns, campaign.campaignId);
          if (latest?.status === 'UPGRADE_RUNNING') tx.update(table.campaigns, campaign.campaignId, { status: 'PAUSED', pauseReason: error.code || 'CAMPAIGN_REVIEW_REQUIRED' });
        });
      }
    }
  }

  async processClassificationJobs() { return this.directory.processClassificationJobs(); }

  async acceptedMessage(message, transaction = null) {
    const kind = message.metadata?.quotationId ? 'quotation_sent' : message.metadata?.contentVersionId ? 'sample_sent' : null;
    if (!kind) return;
    const eventId = `crm-event-${message.messageId}`;
    const persist = async tx => {
      if (await tx.get('automationJobs', eventId)) return;
      tx.create('automationJobs', eventId, { orgId: message.orgId, kind: 'CRM_TASK_EVENT', trigger: kind, eventId: message.messageId, contactId: message.contactId, actorId: message.senderId, status: 'PENDING', createdAt: new Date(this.clock()) });
    };
    if (transaction) await persist(transaction);
    else await this.store.runTransaction(persist);
  }

  async processTaskEvents() {
    const jobs = await this.store.find('automationJobs', { filters: [['kind', '==', 'CRM_TASK_EVENT'], ['status', '==', 'PENDING']], limit: 25 });
    for (const job of jobs.items) {
      const actor = await this.store.get('users', job.actorId);
      if (!actor?.active || actor.orgId !== job.orgId) { await this.store.update('automationJobs', job.id, { status: 'HELD', reason: 'ACTOR_UNAVAILABLE' }); continue; }
      try {
        const result = await this.businessEvent({ ...actor, userId: job.actorId }, { eventId: job.eventId, contactId: job.contactId, kind: job.trigger });
        await this.store.update('automationJobs', job.id, { status: result.taskCreated ? 'DONE' : 'SKIPPED', completedAt: new Date(this.clock()) });
      } catch (error) { await this.store.update('automationJobs', job.id, { status: 'HELD', reason: error.code || 'REVIEW_REQUIRED' }); }
    }
  }

  async processReviewRules() {
    const settings = await this.store.find('systemSettings', { filters: [['kind', '==', 'CRM_TASK_RULES']], orderBy: ['__name__', 'asc'], cursor: this.rulesCursor || null, limit: 10 });
    this.rulesCursor = decodeCursor(settings.pagination.nextCursor);
    for (const setting of settings.items) {
      const actor = await this.store.get('users', setting.updatedBy);
      if (!actor?.active || actor.orgId !== setting.orgId) continue;
      const staff = { ...actor, userId: setting.updatedBy };
      try { assertPermission(staff, 'followups.write'); this.directory.scope(staff); } catch { continue; }
      for (const rule of setting.rules.filter(r => r.enabled && ['premium_review', 'reactivation'].includes(r.key))) {
        const day = new Date(this.clock()).toISOString().slice(0, 10), jobId = sha256(`${setting.orgId}:${setting.version}:${rule.key}:${day}`);
        const checkpoint = await this.store.get('automationJobs', jobId); if (checkpoint?.status === 'DONE') continue;
        const where = { and: [...this.directory.scope(staff).map(([field, op, value]) => ({ field, op, value })), { field: 'crmV1Version', op: '==', value: 1 },
          ...(rule.key === 'premium_review' ? [{ field: 'crmV1Tier', op: 'in', value: ['premium', 'vip'] }, { field: 'crmPremiumReviewAtMs', op: '>=', value: 0 }, { field: 'crmPremiumReviewAtMs', op: '<=', value: this.clock() }]
            : [{ field: 'crmV1LastMeaningfulAtMs', op: '>=', value: 0 }, { field: 'crmV1LastMeaningfulAtMs', op: '<=', value: this.clock() - this.directory.inactivityDays * 86400000 }]) ] };
        const page = await this.store.findWhere('contacts', { where, cursor: decodeCursor(checkpoint?.cursor), limit: 50 });
        for (const contact of page.items) {
          const period = rule.key === 'premium_review' ? contact.crmPremiumReviewAtMs : contact.crmV1LastMeaningfulAtMs;
          try { await this.businessEvent(staff, { eventId: sha256(`${contact.contactId}:${rule.key}:${period}`), contactId: contact.contactId, kind: rule.key }); } catch { /* Revoked owner/scope is retried after staff correct the rule. */ }
        }
        await this.store.set('automationJobs', jobId, { orgId: setting.orgId, kind: 'CRM_RULE_SCAN', rule: rule.key, cursor: page.pagination.nextCursor, status: page.pagination.hasMore ? 'PENDING' : 'DONE', updatedAt: new Date(this.clock()) });
      }
    }
  }

  async stopTaskSequences(orgId, contactId, reason) {
    const page = await this.store.find('followUps', { filters: [['orgId', '==', orgId], ['contactId', '==', contactId], ['status', '==', 'SCHEDULED'], ['source', '==', 'TASK_RULE']], limit: 100 });
    for (const task of page.items) if (['sample_sent', 'quotation_sent', 'reactivation'].includes(task.ruleKey)) await this.store.update('followUps', task.followUpId || task.id, { status: 'CANCELLED', outcome: reason, updatedAt: new Date(this.clock()) });
  }

  async linkCompany(actor, contactId, raw) {
    assertPermission(actor, 'contacts.classify');
    const input = z.object({ companyId: id, preferred: z.boolean().default(false), reason: z.string().min(5).max(500) }).strict().parse(raw);
    await this.directory.checkedContact(actor, contactId);
    await this.directory.checkedContact(actor, input.companyId);
    await this.store.runTransaction(async tx => {
      const [contact, company] = await Promise.all([tx.get('contacts', contactId), tx.get('contacts', input.companyId)]);
      this.directory.assertRecordScope(actor, contact); this.directory.assertRecordScope(actor, company);
      const links = [...new Set([...(contact.crmCompanyIds || []), input.companyId])];
      if (links.length > 20) throw new ConflictError('Review company associations before adding more');
      tx.update('contacts', contactId, { crmCompanyIds: links });
      tx.update('contacts', input.companyId, { crmCompanyRecord: true, ...(input.preferred ? { crmPreferredContactId: contactId } : {}) });
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: 'CONTACT_COMPANY_LINKED', entityId: contactId, metadata: input, createdAt: new Date(this.clock()) });
    });
    return { contactId, companyId: input.companyId, preferred: input.preferred };
  }

  async dailyTasks(actor, raw = {}) {
    assertPermission(actor, 'followups.read');
    const q = queryInput.parse(raw), filters = [['orgId', '==', actor.orgId], ['status', '==', 'SCHEDULED']];
    if (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role)) filters.push(['assignedTo', '==', actor.userId]);
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid task cursor');
    if (cursor) { const c = await this.store.get('followUps', cursor); if (!c || c.orgId !== actor.orgId) throw new ConflictError('Invalid task cursor'); }
    const page = await this.store.find('followUps', { filters, orderBy: ['dueAt', 'asc'], limit: q.limit, cursor });
    const contacts = await this.store.getMany('contacts', page.items.map(t => t.contactId)), allowed = new Map();
    for (const c of contacts) { try { this.directory.assertRecordScope(actor, c); allowed.set(c.contactId, c); } catch { /* Hide records outside the same client scope. */ } }
    return { ...page, items: page.items.filter(t => allowed.has(t.contactId)).map(t => ({ ...t, companyName: allowed.get(t.contactId).companyName || '', overdue: timestampMs(t.dueAt) < this.clock() })) };
  }

  async linkOrder(actor, campaignId, orderId) {
    assertPermission(actor, 'orders.write');
    const campaign = await this.get(actor, 'campaigns', campaignId);
    if (campaign.mode === 'internal_test') throw new ConflictError('Internal tests cannot receive business order attribution');
    const order = await this.domain.get('orders', actor.orgId, orderId);
    await this.directory.checkedContact(actor, order.contactId);
    if (!qualifyingOrder(order)) throw new ConflictError('Only a qualifying order can be attributed');
    const touch = await this.store.find('campaignEnrollments', { filters: [['orgId', '==', actor.orgId], ['campaignId', '==', campaignId], ['contactId', '==', order.contactId]], limit: 1 });
    if (!touch.items.length || touch.items[0].status === 'EXCLUDED') throw new ConflictError('This order contact is not in the campaign snapshot');
    await this.store.runTransaction(async tx => {
      const current = await tx.get('orders', orderId);
      if (!current || current.orgId !== actor.orgId || current.contactId !== order.contactId || !qualifyingOrder(current)) throw new ConflictError('Order changed during attribution; reload');
      if (current.primaryCampaignId && current.primaryCampaignId !== campaignId) throw new ConflictError('Order already has a primary campaign; use an audited attribution correction');
      tx.update('orders', orderId, { primaryCampaignId: campaignId, attributionMethod: 'staff_confirmed', attributionBy: actor.userId, attributionAt: new Date(this.clock()) });
    });
    return { orderId, campaignId, attributionMethod: 'staff_confirmed' };
  }

  async report(actor, campaignId) {
    const campaign = await this.get(actor, 'campaigns', campaignId);
    const base = [['orgId', '==', actor.orgId], ['metadata.campaignId', '==', campaignId]];
    // Aggregate only known provider milestones; no inferred reads or fabricated costs.
    const stats = {};
    for (const status of ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'DELIVERY_UNKNOWN', 'CANCELLED']) stats[status] = await this.store.count('messages', { filters: [...base, ['status', '==', status]] });
    const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
    const [accepted, confirmedSent, replies] = await Promise.all([
      this.store.count('messages', { filters: [...base, ['submissionState', '==', 'accepted']] }),
      this.store.count('messages', { filters: [...base, ['providerStatusSeen.SENT', '>=', new Date(0)]] }),
      this.store.count('marketingReplyContacts', { filters: [['orgId', '==', actor.orgId], ['campaignId', '==', campaignId]] })
    ]);
    return { internalTest: campaign.mode === 'internal_test', totalLogicalMessages: total, currentStates: stats,
      accepted, confirmedSent, uniqueReplyContacts: replies, confirmedDelivered: stats.DELIVERED + stats.READ, confirmedRead: stats.READ,
      readUnavailableOrUnconfirmed: Math.max(0, total - stats.READ), actualProviderCost: null, estimatedProviderCost: null,
      note: 'Accepted is not delivery. Read status absent means unknown. Counts use logical messages, not retry attempts. Financial reporting requires finance access and linked orders.' };
  }

  async financePage(actor, campaignId, raw = {}) {
    assertPermission(actor, 'payments.read'); assertPermission(actor, 'orders.read');
    await this.get(actor, 'campaigns', campaignId);
    const q = queryInput.parse(raw), cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid report cursor');
    if (cursor) { const order = await this.store.get('orders', cursor); if (order?.orgId !== actor.orgId || order.primaryCampaignId !== campaignId) throw new ConflictError('Invalid report cursor'); }
    const filters = [['orgId', '==', actor.orgId], ['primaryCampaignId', '==', campaignId]];
    const [page, totalLinkedOrders] = await Promise.all([this.store.find('orders', { filters, orderBy: ['createdAt', 'asc'], limit: q.limit, cursor }), this.store.count('orders', { filters })]);
    const contacts = new Map((await this.store.getMany('contacts', page.items.map(o => o.contactId))).map(c => [c.contactId || c.id, c]));
    const orders = page.items.filter(o => { try { this.directory.assertRecordScope(actor, contacts.get(o.contactId)); return true; } catch { return false; } });
    const totals = {}, eligibleOrders = orders.filter(qualifyingOrder); let paymentsTruncated = false, unpricedRecords = 0;
    const add = (currency, amount, field) => {
      if (!/^[A-Z]{3}$/.test(currency || '')) { unpricedRecords++; return; }
      const scale = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
      const minor = moneyMinor(amount, scale); if (minor === null) { unpricedRecords++; return; }
      totals[currency] ||= { booked: 0n, collected: 0n, refunds: 0n, scale };
      totals[currency][field] += minor;
    };
    for (const order of eligibleOrders) add(order.currency, order.totalAmount, 'booked');
    for (let start = 0; start < orders.length; start += 15) {
      const ids = orders.slice(start, start + 15).map(o => o.orderId || o.id);
      if (!ids.length) continue;
      const payments = await this.store.find('payments', { filters: [['orgId', '==', actor.orgId], ['orderId', 'in', ids], ['status', 'in', ['RECEIVED', 'REFUNDED']]], limit: 100 });
      if (payments.pagination.hasMore) paymentsTruncated = true;
      for (const payment of payments.items) if (!payment.isTest) add(payment.currency, payment.amount, payment.status === 'REFUNDED' ? 'refunds' : 'collected');
    }
    const byCurrency = Object.fromEntries(Object.entries(totals).map(([currency, v]) => [currency, { booked: formatMinor(v.booked, v.scale), collected: formatMinor(v.collected, v.scale), refunds: formatMinor(v.refunds, v.scale), netCollected: formatMinor(v.collected - v.refunds, v.scale) }]));
    return { orders: orders.map(o => ({ orderId: o.orderId, contactId: o.contactId, status: o.status, currency: o.currency || null, totalAmount: o.totalAmount ?? null, qualifying: qualifyingOrder(o) })), totalLinkedOrders: ['OWNER', 'ADMIN'].includes(actor.role) ? totalLinkedOrders : null, pagination: page.pagination, byCurrency,
      complete: !cursor && !page.pagination.hasMore && !paymentsTruncated && !unpricedRecords && orders.length === page.items.length,
      pageOnly: true, paymentsTruncated, unpricedRecords, actualProviderCost: null, estimatedProviderCost: null,
      note: 'Amounts cover this authorised order page only. Currency totals remain separate. Refunds require explicit REFUNDED payment records. Costs and ROI are unavailable.' };
  }

  async rules(actor, raw = null) {
    assertPermission(actor, raw ? 'marketing.settings' : 'marketing.read');
    const key = `crm-task-rules-${actor.orgId}`;
    if (raw) {
      const input = z.object({ expectedVersion: z.number().int().min(0), rules: z.array(z.object({ key: z.enum(['sample_sent', 'quotation_sent', 'interested_reply', 'premium_review', 'reactivation']), enabled: z.boolean(), delayHours: z.number().int().min(0).max(8760), assignedTo: id, mode: z.literal('task_only') }).strict()).max(5) }).strict().parse(raw);
      if (new Set(input.rules.map(r => r.key)).size !== input.rules.length) throw new ConflictError('Each rule may appear once');
      await this.store.runTransaction(async tx => {
        const before = await tx.get('systemSettings', key);
        if ((before?.version || 0) !== input.expectedVersion) throw new ConflictError('Rules changed; reload');
        tx.set('systemSettings', key, { orgId: actor.orgId, kind: 'CRM_TASK_RULES', rules: input.rules, version: input.expectedVersion + 1, updatedBy: actor.userId, updatedAt: new Date(this.clock()) });
      });
    }
    return await this.store.get('systemSettings', key) || { version: 0, rules: ['sample_sent', 'quotation_sent', 'interested_reply', 'premium_review', 'reactivation'].map(key => ({ key, enabled: false, delayHours: 24, mode: 'task_only', assignedTo: actor.userId })) };
  }

  async businessEvent(actor, raw) {
    const input = z.object({ eventId: id, contactId: id, kind: z.enum(['sample_sent', 'quotation_sent', 'interested_reply', 'premium_review', 'reactivation']) }).strict().parse(raw);
    assertPermission(actor, 'followups.write');
    const contact = await this.directory.checkedContact(actor, input.contactId);
    const permission = await this.safety.inspect(actor.orgId, contact);
    if (permission.state === 'suppressed' || ['SUPPRESSED', 'LEGACY_OPT_OUT_REQUIRES_FRESH_EVIDENCE'].includes(permission.reason)) return { taskCreated: false, reason: 'CONTACT_SUPPRESSED' };
    if (['sample_sent', 'quotation_sent'].includes(input.kind)) {
      const trigger = await this.store.get('messages', input.eventId);
      if (trigger?.orgId !== actor.orgId || trigger.contactId !== input.contactId || (timestampMs(contact.crmV1LastMeaningfulAtMs) || 0) > (timestampMs(trigger.createdAt) || 0)) return { taskCreated: false, reason: 'REPLY_OR_ORDER_REQUIRES_REVIEW' };
    }
    const settings = await this.rules(actor), rule = settings.rules.find(r => r.key === input.kind && r.enabled);
    if (!rule) return { taskCreated: false, reason: 'RULE_DISABLED' };
    const task = await this.task(actor, { contactId: input.contactId, reason: input.kind.replaceAll('_', ' '), dueAt: new Date(this.clock() + rule.delayHours * 3600000).toISOString(), assignedTo: rule.assignedTo, priority: 'NORMAL', source: 'TASK_RULE', ruleKey: rule.key, dedupeKey: `rule:${rule.key}:${input.eventId}` });
    return { taskCreated: true, task };
  }

  async task(actor, raw) {
    assertPermission(actor, 'followups.write');
    const input = z.object({ contactId: id, leadId: id.optional(), reason: title, dueAt: z.string().datetime(), assignedTo: id, priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'), source: z.enum(['MANUAL', 'TASK_RULE']).default('MANUAL'), ruleKey: z.string().max(60).optional(), dedupeKey: z.string().min(4).max(180) }).strict().parse(raw);
    await this.directory.checkedContact(actor, input.contactId);
    if (input.leadId) { const lead = await this.store.get('leads', input.leadId); if (lead?.orgId !== actor.orgId || lead.contactId !== input.contactId) throw new ConflictError('Opportunity belongs to another contact'); }
    const owner = await this.store.get('users', input.assignedTo);
    if (!owner?.active || owner.orgId !== actor.orgId) throw new ConflictError('Choose an active team member');
    const taskId = `FUP_${sha256(`${actor.orgId}:${input.contactId}:${input.dedupeKey}`)}`;
    await this.store.runTransaction(async tx => {
      if (await tx.get('followUps', taskId)) return;
      tx.create('followUps', taskId, { ...input, orgId: actor.orgId, followUpId: taskId, status: 'SCHEDULED', dueAt: new Date(input.dueAt), createdAt: new Date(this.clock()), createdBy: actor.userId });
    });
    return this.store.get('followUps', taskId);
  }
  async updateTask(actor, taskId, raw) {
    assertPermission(actor, 'followups.write');
    const input = z.object({ action: z.enum(['complete', 'reschedule', 'reassign']), outcome: z.string().min(3).max(500), assignedTo: id.optional(), dueAt: z.string().datetime().optional() }).strict().parse(raw);
    await this.store.runTransaction(async tx => {
      const task = await tx.get('followUps', taskId);
      if (!task || task.orgId !== actor.orgId) throw new NotFoundError('Task');
      const contact = await tx.get('contacts', task.contactId);
      this.directory.assertRecordScope(actor, contact);
      if (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role) && task.assignedTo !== actor.userId) throw new ConflictError('Only the task owner can update this follow-up');
      const patch = { updatedAt: new Date(this.clock()), updatedBy: actor.userId, outcome: input.outcome };
      if (task.source === 'COMPLAINT' && input.action === 'complete') {
        if (task.status !== 'SCHEDULED') throw new ConflictError('This complaint is already resolved');
        tx.update('contacts', task.contactId, { crmOpenComplaintCount: Math.max(0, (contact.crmOpenComplaintCount || 0) - 1) });
      }
      if (input.action === 'complete') Object.assign(patch, { status: 'COMPLETED', completedAt: new Date(this.clock()) });
      if (input.action === 'reschedule') { if (!input.dueAt) throw new ConflictError('Choose a new due date'); patch.dueAt = new Date(input.dueAt); }
      if (input.action === 'reassign') {
        const owner = input.assignedTo && await tx.get('users', input.assignedTo);
        if (!owner?.active || owner.orgId !== actor.orgId) throw new ConflictError('Choose an active team member');
        patch.assignedTo = input.assignedTo;
      }
      tx.update('followUps', taskId, patch);
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: `FOLLOWUP_${input.action.toUpperCase()}`, entityId: taskId, before: { dueAt: task.dueAt, assignedTo: task.assignedTo, status: task.status }, after: patch, createdAt: new Date(this.clock()) });
    });
    return this.store.get('followUps', taskId);
  }

  async profileHistory(actor, contactId, kind, raw = {}) {
    if (['contacts', 'activity'].includes(kind)) {
      const contact = await this.directory.checkedContact(actor, contactId), q = queryInput.parse(raw), cursor = decodeCursor(q.cursor);
      if (q.cursor && !cursor) throw new ConflictError('Invalid history cursor');
      if (kind === 'activity') {
        if (cursor) { const old = await this.store.get('auditLogs', cursor); if (old?.orgId !== actor.orgId || old.entityId !== contactId) throw new NotFoundError('Activity'); }
        const page = await this.store.find('auditLogs', { filters: [['orgId', '==', actor.orgId], ['entityId', '==', contactId]], orderBy: ['createdAt', 'desc'], limit: q.limit, cursor });
        return { ...page, items: page.items.map(e => ({ id: e.auditLogId || e.id, title: e.action, createdAt: e.createdAt, status: 'RECORDED_CLIENT_EVENT' })) };
      }
      if (cursor) await this.directory.checkedContact(actor, cursor);
      const page = await this.store.find('contacts', { filters: [...this.directory.scope(actor), ['crmCompanyIds', 'array-contains', contactId]], orderBy: ['__name__', 'asc'], limit: q.limit, cursor });
      const parents = cursor ? [] : await this.store.getMany('contacts', contact.crmCompanyIds || []);
      const unique = new Map([...parents, ...page.items].map(c => [c.contactId || c.id, c]));
      return { ...page, items: [...unique.values()].flatMap(c => { try { this.directory.assertRecordScope(actor, c); } catch { return []; } return [{ id: c.contactId || c.id, contactId: c.contactId || c.id, title: c.companyName || c.contactPerson || c.contactId, status: 'LINKED_RECORD', createdAt: c.createdAt, preferred: contact.crmPreferredContactId === c.contactId }]; }) };
    }
    const sections = { opportunities: ['leads', 'leads.read'], orders: ['orders', 'orders.read'], payments: ['payments', 'payments.read'], conversations: ['conversations', 'conversations.read'], marketing: ['campaignEnrollments', 'marketing.read'], tasks: ['followUps', 'followups.read'], quotations: ['quotations', 'quotations.read'] };
    if (!sections[kind]) throw new NotFoundError('Profile section');
    const [collection, permission] = sections[kind]; assertPermission(actor, permission);
    await this.directory.checkedContact(actor, contactId);
    const q = queryInput.parse(raw), cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid history cursor');
    if (cursor) { const last = await this.store.get(collection, cursor); if (last?.orgId !== actor.orgId || last.contactId !== contactId) throw new ConflictError('Invalid history cursor'); }
    return this.store.find(collection, { filters: [['orgId', '==', actor.orgId], ['contactId', '==', contactId]], orderBy: ['createdAt', 'desc'], cursor, limit: q.limit });
  }

  // Read-only lookup so an admin can jump straight to the handful of messages
  // history-preparation is holding for review, instead of hunting through every
  // campaign's recipient list. Never mutates anything.
  async unresolvedMessages(actor) {
    assertPermission(actor, 'marketing.reconcile');
    const page = await this.store.find('messages', { filters: [['orgId', '==', actor.orgId], ['status', '==', 'DELIVERY_UNKNOWN']], orderBy: ['createdAt', 'desc'], limit: 50 });
    const contacts = new Map((await this.store.getMany('contacts', page.items.map(m => m.contactId))).map(c => [c.contactId || c.id, c]));
    return { items: page.items.flatMap(m => {
      const contact = contacts.get(m.contactId);
      try { if (contact) this.directory.assertRecordScope(actor, contact); } catch { return []; }
      return [{ messageId: m.messageId || m.id, contactId: m.contactId, campaignId: m.metadata?.campaignId || null,
        companyName: contact?.companyName || contact?.contactPerson || m.contactId,
        destination: canonicalDestination(m.recipientId) || m.recipientId, createdAt: m.createdAt }];
    }) };
  }
  async replies(actor, raw = {}) {
    assertPermission(actor, 'marketing.read');
    const q = queryInput.parse(raw), cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new ConflictError('Invalid reply cursor');
    const filters = [['orgId', '==', actor.orgId], ['outcome', '==', 'NEEDS_REVIEW']];
    if (!['OWNER', 'ADMIN', 'SALES_MANAGER'].includes(actor.role)) filters.push(['assignedTo', '==', actor.userId]);
    if (cursor) { const old = await this.store.get('marketingReplyReceipts', cursor); if (old?.orgId !== actor.orgId) throw new NotFoundError('Reply'); await this.directory.checkedContact(actor, old.contactId); }
    const page = await this.store.find('marketingReplyReceipts', { filters, orderBy: ['createdAt', 'desc'], limit: q.limit, cursor });
    const contacts = new Map((await this.store.getMany('contacts', page.items.map(r => r.contactId))).map(c => [c.contactId || c.id, c]));
    const messages = new Map((await this.store.getMany('messages', page.items.map(r => r.messageId))).map(m => [m.messageId || m.id, m]));
    return { ...page, items: page.items.flatMap(r => {
      const contact = contacts.get(r.contactId); try { this.directory.assertRecordScope(actor, contact); } catch { return []; }
      const message = messages.get(r.messageId);
      return [{ ...r, companyName: contact.companyName || contact.contactPerson || r.contactId, text: message?.orgId === actor.orgId && message.contactId === r.contactId ? message.text : '', conversationId: message?.orgId === actor.orgId && message.contactId === r.contactId ? message.conversationId : null }];
    }) };
  }

  async reconcileUnknown(actor, messageId, raw) {
    assertPermission(actor, 'marketing.reconcile');
    const input = z.object({ outcome: z.enum(['ACCEPTED', 'NOT_ACCEPTED']), providerMessageId: z.string().trim().min(5).max(500).optional(), evidenceReference: z.string().trim().min(5).max(500), reason: z.string().trim().min(5).max(500) }).strict().parse(raw);
    const message = await this.messages.get(actor.orgId, messageId);
    await this.directory.checkedContact(actor, message.contactId);
    if (!message.metadata?.campaignId) throw new ConflictError('Review this message in its original workflow');
    await this.get(actor, 'campaigns', message.metadata.campaignId);
    if (input.outcome === 'ACCEPTED' && !input.providerMessageId) throw new ConflictError('Confirmed provider acceptance needs its message ID');
    if (input.providerMessageId) {
      const matches = await this.store.find('messages', { filters: [['orgId', '==', actor.orgId], ['providerMessageId', '==', input.providerMessageId]], limit: 2 });
      if (matches.items.some(m => m.messageId !== messageId)) throw new ConflictError('Provider ID belongs to another message');
    }
    const e164 = canonicalDestination(message.recipientId), key = e164 && destinationKey(actor.orgId, e164);
    if (!key) throw new ConflictError('Message destination is unavailable');
    const boxes = await this.store.find('outbox', { filters: [['orgId', '==', actor.orgId], ['messageId', '==', messageId]], limit: 2 });
    if (boxes.items.length !== 1) throw new ConflictError('Outbox needs technical reconciliation');
    const boxId = boxes.items[0].outboxId || boxes.items[0].id;
    await this.store.runTransaction(async tx => {
      const [current, box, state, contact] = await Promise.all([tx.get('messages', messageId), tx.get('outbox', boxId), tx.get('marketingDestinationState', key), tx.get('contacts', message.contactId)]);
      this.directory.assertRecordScope(actor, contact);
      if (current?.orgId !== actor.orgId || box?.orgId !== actor.orgId || current.status !== 'DELIVERY_UNKNOWN' || box.status !== 'DELIVERY_UNKNOWN') throw new ConflictError('Message already changed; reload before reviewing');
      const providerKey = input.providerMessageId ? sha256(`${actor.orgId}:reviewed-provider:${input.providerMessageId}`) : null;
      const previousProvider = providerKey ? await tx.get('providerMessageKeys', providerKey) : null;
      if (previousProvider && previousProvider.messageId !== messageId) throw new ConflictError('Provider ID was reconciled to another message');
      const accepted = input.outcome === 'ACCEPTED', date = new Date(this.clock());
      // No automatic resend follows either decision. Unknown keeps its reservation
      // until the reviewer supplies evidence of acceptance or definitive rejection.
      const slots = (state?.slots || []).filter(s => s.messageId !== messageId);
      if (accepted) slots.push({ messageId, at: this.clock(), state: 'accepted', contentId: message.metadata.contentVersionId || null });
      if (accepted) await this.acceptedMessage(message, tx);
      if (accepted) tx.set('providerMessageKeys', providerKey, { orgId: actor.orgId, messageId, kind: 'REVIEWED_PROVIDER_ACCEPTANCE', createdAt: date });
      tx.set('marketingDestinationState', key, { ...state, orgId: actor.orgId, e164, slots, ...(accepted ? { lastAcceptedAt: date } : {}) });
      tx.update('messages', messageId, { status: accepted ? 'SENT' : 'CANCELLED', submissionState: accepted ? 'accepted' : 'confirmed_not_accepted', providerMessageId: accepted ? input.providerMessageId : null, errorCode: null, errorMessage: null, reconciliationSource: 'STAFF_PROVIDER_EVIDENCE', reconciledBy: actor.userId, updatedAt: date });
      tx.update('outbox', boxId, { status: accepted ? 'SENT' : 'CANCELLED', lockedAt: null, lockedBy: null, updatedAt: date });
      if (accepted) tx.update('contacts', message.contactId, { crmV1LastMarketingAtMs: this.clock() });
      if (accepted && message.metadata.contentVersionId) tx.set('marketingContentReceipts', sha256(`${key}:${message.metadata.contentVersionId}`), { orgId: actor.orgId, destinationKey: key, contentVersionId: message.metadata.contentVersionId, messageId, acceptedAt: date });
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: 'UNKNOWN_SUBMISSION_RECONCILED', entityId: messageId, metadata: input, createdAt: date });
    });
    if (input.outcome === 'ACCEPTED') await this.messages.reconcileProviderStatus(actor.orgId, input.providerMessageId);
    return { messageId, outcome: input.outcome, automaticallyRetried: false };
  }

  async reviewReply(actor, messageId, raw) {
    assertPermission(actor, 'leads.write');
    const input = z.object({ outcome: z.enum(['SAMPLE_REQUESTED', 'QUOTATION_REQUESTED', 'MEETING_REQUESTED', 'FOLLOWUP_SCHEDULED', 'SERVICE_REPLY', 'NOT_INTERESTED', 'WRONG_CONTACT', 'OPT_OUT']), reason: z.string().min(3).max(500) }).strict().parse(raw);
    const reply = await this.store.get('marketingReplyReceipts', messageId);
    if (reply?.orgId !== actor.orgId) throw new NotFoundError('Reply');
    const contact = await this.directory.checkedContact(actor, reply.contactId);
    if (input.outcome === 'OPT_OUT') { assertPermission(actor, 'marketing.consent'); await this.safety.suppressInbound(actor.orgId, reply.contactId, { messageId, senderId: contact.primaryPhone }); }
    await this.store.runTransaction(async tx => {
      const current = await tx.get('marketingReplyReceipts', messageId);
      if (current.orgId !== actor.orgId) throw new NotFoundError('Reply');
      if (current.outcome !== 'NEEDS_REVIEW') throw new ConflictError('Reply was already reviewed; reload');
      tx.update('marketingReplyReceipts', messageId, { ...input, reviewedBy: actor.userId, reviewedAt: new Date(this.clock()) });
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, entityId: messageId, action: 'MARKETING_REPLY_REVIEWED', after: input, createdAt: new Date(this.clock()) });
    });
    if (['SAMPLE_REQUESTED', 'QUOTATION_REQUESTED', 'MEETING_REQUESTED', 'FOLLOWUP_SCHEDULED'].includes(input.outcome)) await this.businessEvent(actor, { eventId: messageId, contactId: reply.contactId, kind: 'interested_reply' });
    return { messageId, outcome: input.outcome };
  }
  async stage(actor, leadId, raw) {
    assertPermission(actor, 'leads.write');
    const input = z.object({ stage: z.enum(stages), reason: z.string().min(3).max(500), expectedStage: z.string(), expectedRevision: z.number().int().min(0).optional(), assignedTo: id.optional(), orderId: id.optional(), expectedValue: z.string().regex(/^\d+(\.\d{1,2})?$/).max(18).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), serviceInterest: z.string().max(200).optional(), nextAction: z.string().max(500).optional(), nextActionAt: z.string().datetime().optional(), quotationId: id.optional() }).strict().parse(raw);
    const lead = await this.domain.get('leads', actor.orgId, leadId);
    await this.directory.checkedContact(actor, lead.contactId);
    if (input.stage === 'CLOSED_WON') { const order = await this.store.get('orders', input.orderId || 'missing'); if (!qualifyingOrder(order) || order.orgId !== actor.orgId || order.contactId !== lead.contactId) throw new ConflictError('Link a qualifying confirmed order to mark Won'); }
    if (input.quotationId) { const quote = await this.store.get('quotations', input.quotationId); if (quote?.orgId !== actor.orgId || quote.contactId !== lead.contactId) throw new ConflictError('Quotation belongs to another client'); }
    await this.store.runTransaction(async tx => {
      const current = await tx.get('leads', leadId);
      this.directory.assertRecordScope(actor, await tx.get('contacts', current.contactId));
      if (current.leadStatus !== input.expectedStage) throw new ConflictError('Opportunity changed; reload');
      if (input.expectedRevision !== undefined && (current.crmRevision || 0) !== input.expectedRevision) throw new ConflictError('Opportunity changed; reload');
      if (input.assignedTo) { const owner = await tx.get('users', input.assignedTo); if (!owner?.active || owner.orgId !== actor.orgId) throw new ConflictError('Choose an active owner'); }
      if (input.stage === 'CLOSED_WON') { const order = await tx.get('orders', input.orderId || 'missing'); if (!qualifyingOrder(order) || order.orgId !== actor.orgId || order.contactId !== current.contactId) throw new ConflictError('The linked order changed; review again'); }
      if (input.quotationId) { const quote = await tx.get('quotations', input.quotationId); if (quote?.orgId !== actor.orgId || quote.contactId !== current.contactId) throw new ConflictError('The quotation changed; review again'); }
      if (input.expectedValue && !(input.currency || current.currency)) throw new ConflictError('Record a currency for the expected value');

      const fields = { ...input }; delete fields.stage; delete fields.expectedStage; delete fields.expectedRevision; delete fields.reason;
      tx.update('leads', leadId, { ...fields, crmRevision: (current.crmRevision || 0) + 1, leadStatus: input.stage, ...(input.stage === 'CLOSED_LOST' ? { lossReason: input.reason } : {}), updatedAt: new Date(this.clock()) });
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: 'OPPORTUNITY_STAGE_CHANGED', entityId: leadId, before: { stage: current.leadStatus }, after: input, createdAt: new Date(this.clock()) });
    });
    return this.domain.get('leads', actor.orgId, leadId);
  }

  async accountReview(actor, contactId, raw) {
    assertPermission(actor, 'contacts.classify');
    const input = z.object({ preferredServices: z.string().max(1000), styleNotes: z.string().max(1000), concerns: z.string().max(1000), reviewAt: z.string().datetime().nullable(), reason: z.string().min(5).max(500), expectedRevision: z.number().int().min(0) }).strict().parse(raw);
    await this.directory.checkedContact(actor, contactId);
    await this.store.runTransaction(async tx => {
      const contact = await tx.get('contacts', contactId); this.directory.assertRecordScope(actor, contact);
      if ((contact.crmAccountRevision || 0) !== input.expectedRevision) throw new ConflictError('Account review changed; reload');
      const patch = { crmPreferredServices: input.preferredServices, crmStyleNotes: input.styleNotes, crmOpenConcerns: input.concerns, crmPremiumReviewAtMs: input.reviewAt ? Date.parse(input.reviewAt) : -1, crmAccountRevision: input.expectedRevision + 1, crmAccountReviewedBy: actor.userId };
      tx.update('contacts', contactId, patch);
      tx.create('auditLogs', createId('auditLog'), { orgId: actor.orgId, actorId: actor.userId, action: 'ACCOUNT_REVIEWED', entityId: contactId, metadata: { reason: input.reason }, createdAt: new Date(this.clock()) });
    });
    return { saved: true };
  }
}

export function moneyMinor(value, scale = 2) {
  const text = String(value ?? '');
  if (!/^\d{1,16}(\.\d{1,12})?$/.test(text) || scale < 0 || scale > 4) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction.slice(0, scale).padEnd(scale, '0')) || '0') + (Number(fraction[scale] || '0') >= 5 ? 1n : 0n);
}
export function formatMinor(value, scale) { const sign = value < 0n ? '-' : '', digits = String(value < 0n ? -value : value).padStart(scale + 1, '0'); return sign + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits); }
