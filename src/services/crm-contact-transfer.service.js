import { z } from 'zod';
import { sha256 } from '../utils/hashing.js';
import { assertPermission, canonicalDestination, permissionRecordSchema, destinationKey } from './marketing-safety.service.js';
import { inspectDestination, classificationProjection } from './client-classification.js';
import { ConflictError } from '../utils/errors.js';

const editableFields = ['companyName', 'contactPerson', 'city'];
const baseRowSchema = z.object({ companyName: z.string().max(200), contactPerson: z.string().max(160).default(''), phone: z.string().max(50), countryCode: z.string().regex(/^[A-Z]{2}$/).optional(), city: z.string().max(120).default(''), relationship: z.enum(['unclassified', 'prospect', 'customer']).default('unclassified'), contactId: z.string().regex(/^[\w-]+$/).max(150).optional(), updateFields: z.array(z.enum(editableFields)).max(3).default([]) }).strict();
const rowSchema = baseRowSchema.extend({ evidence: permissionRecordSchema.omit({ expectedVersion: true }).optional() }).strict();
const inputSchema = z.object({ sourceName: z.string().min(1).max(150), rows: z.array(z.unknown()).min(1).max(100) }).strict();
const snapshot = contact => sha256(JSON.stringify([contact.contactId || contact.id, ...editableFields.map(f => contact[f] ?? ''), contact.primaryPhone, contact.updatedAt, contact.crmV1Revision || 0]));

export class CrmContactTransferService {
  constructor({ store, directory, workspace }) { Object.assign(this, { store, directory, workspace }); }
  async preview(actor, raw) {
    assertPermission(actor, 'contacts.import');
    const input = inputSchema.parse(raw), batchId = sha256(`${actor.orgId}:${JSON.stringify(input)}`), rows = [], seen = new Set();
    for (let index = 0; index < input.rows.length; index += 1) {
      const parsed = rowSchema.safeParse(input.rows[index]);
      if (!parsed.success) { rows.push({ index, status: 'ERROR', reason: 'Invalid mapping, phone must remain text', errors: parsed.error.issues.map(i => i.path.join('.')) }); continue; }
      const row = parsed.data, phone = inspectDestination(row.phone, row.countryCode);
      if (!phone.e164) { rows.push({ index, status: 'ERROR', reason: phone.reason, originalPhone: row.phone }); continue; }
      const key = sha256(`${actor.orgId}:PHONE:${phone.e164.slice(1)}`);
      const [phoneKey, imported] = await Promise.all([this.store.get('contactPhoneKeys', key), this.store.get('importKeys', `${batchId}-${index}`)]);
      let existing = phoneKey;
      // Older imports may predate contactPhoneKeys. A missing key is not proof of a new client.
      if (!existing) {
        const matches = await this.store.find('contacts', { filters: [['orgId', '==', actor.orgId], ['primaryPhone', 'in', [phone.e164, phone.e164.slice(1)]]], limit: 2 });
        if (matches.items.length) existing = { orgId: actor.orgId, contactId: matches.items.length === 1 ? matches.items[0].contactId || matches.items[0].id : null, legacy: true };
      }
      const contact = { orgId: actor.orgId, assignedTo: actor.userId, relationshipType: { unclassified: 'OTHER', prospect: 'PROSPECT', customer: 'EXISTING_CLIENT' }[row.relationship] };
      let reason = existing ? 'PHONE_ALREADY_EXISTS_REVIEW_COMPANY_ASSOCIATION' : null;
      let matched = null, changes = null, expectedSnapshot = null;
      if (existing?.contactId) {
        try { matched = await this.directory.checkedContact(actor, existing.contactId); } catch { /* A duplicate outside scope must not disclose a client. */ }
      }
      if (row.contactId || row.updateFields.length) {
        assertPermission(actor, 'contacts.write');
        if (!row.contactId || (!row.updateFields.length && !row.evidence)) reason = 'SELECT_EXISTING_CLIENT_AND_FIELDS';
        else {
          const target = await this.directory.checkedContact(actor, row.contactId);
          if (canonicalDestination(target.primaryPhone, target.phoneCountryCode) !== phone.e164 || existing?.contactId !== row.contactId) reason = 'PHONE_AND_SELECTED_CLIENT_DO_NOT_MATCH';
          else { matched = target; reason = null; expectedSnapshot = snapshot(target); changes = Object.fromEntries([...new Set(row.updateFields)].map(field => [field, { before: target[field] || '', after: row[field] }])); }
        }
      }
      if (seen.has(phone.e164)) reason = 'DUPLICATE_WITHIN_UPLOAD';
      seen.add(phone.e164);
      try { this.directory.assertRecordScope(actor, contact); } catch { reason = 'OUTSIDE_YOUR_CLIENT_SCOPE'; }
      rows.push({ index, status: imported ? 'IMPORTED' : reason ? 'REVIEW' : changes ? Object.keys(changes).length ? 'UPDATE' : 'PERMISSION' : 'NEW', reason, companyName: row.companyName, originalPhone: row.phone, e164: phone.e164, permission: 'unchanged', ...(matched ? { matchedContactId: matched.contactId || matched.id, matchedCompanyName: matched.companyName || '' } : {}), ...(changes ? { changes, expectedSnapshot } : {}) });
    }
    for (const result of rows) {
      const row = rowSchema.safeParse(input.rows[result.index]);
      if (!row.success || !row.data.evidence || result.status === 'ERROR') continue;
      assertPermission(actor, 'marketing.consent');
      const permission = await this.store.get('marketingPermissions', destinationKey(actor.orgId, result.e164));
      result.permissionEvidence = row.data.evidence; result.permissionVersion = permission?.version || 0;
    }
    return { batchId, reviewToken: sha256(JSON.stringify(rows)), sourceName: input.sourceName, rows, newRecords: rows.filter(r => r.status === 'NEW').length, updates: rows.filter(r => r.status === 'UPDATE').length, evidenceRecords: rows.filter(r => r.permissionEvidence && ['NEW', 'UPDATE', 'PERMISSION', 'IMPORTED'].includes(r.status)).length, review: rows.filter(r => r.status === 'REVIEW').length, errors: rows.filter(r => r.status === 'ERROR').length, total: rows.length };
  }
  async commit(actor, raw) {
    const input = z.object({ payload: inputSchema, expectedBatchId: z.string().length(64), reviewToken: z.string().length(64).optional() }).strict().parse(raw);
    const preview = await this.preview(actor, input.payload);
    if (preview.batchId !== input.expectedBatchId) throw new ConflictError('Import changed; run preview again');
    if ((preview.updates || preview.evidenceRecords) && input.reviewToken !== preview.reviewToken) throw new ConflictError('Existing client data changed; preview the updates again');
    let created = 0, updated = 0, skipped = 0;
    for (const result of preview.rows) {
      if (result.status === 'UPDATE') {
        const row = rowSchema.parse(input.payload.rows[result.index]), importKey = `${preview.batchId}-${result.index}`;
        const changed = await this.store.runTransaction(async tx => {
          const [current, receipt] = await Promise.all([tx.get('contacts', row.contactId), tx.get('importKeys', importKey)]);
          if (receipt) return false;
          this.directory.assertRecordScope(actor, current);
          if (snapshot(current) !== result.expectedSnapshot) throw new ConflictError('A client changed during import; preview again');
          const patch = Object.fromEntries(row.updateFields.map(f => [f, row[f]]));
          Object.assign(patch, classificationProjection({ ...current, ...patch }), { updatedAt: new Date(), crmV1Revision: (current.crmV1Revision || 0) + 1 });
          tx.update('contacts', row.contactId, patch);
          tx.create('importKeys', importKey, { orgId: actor.orgId, contactId: row.contactId, batchId: preview.batchId, status: 'DONE', action: 'UPDATED', createdBy: actor.userId, createdAt: new Date() });
          tx.create('auditLogs', `IMPORT_${importKey}`, { orgId: actor.orgId, actorId: actor.userId, action: 'CONTACT_IMPORT_FIELDS_UPDATED', entityId: row.contactId, changes: result.changes, sourceName: input.payload.sourceName, createdAt: new Date() });
          return true;
        });
        if (changed) updated++; else skipped++;
        continue;
      }
      if (result.status !== 'NEW') { skipped += 1; continue; }
      const row = rowSchema.parse(input.payload.rows[result.index]), importKey = `${preview.batchId}-${result.index}`;
      const contactId = `CNT_${sha256(importKey).slice(0, 32)}`, phoneKey = sha256(`${actor.orgId}:PHONE:${result.e164.slice(1)}`);
      const changed = await this.store.runTransaction(async tx => {
        const [key, old] = await Promise.all([tx.get('contactPhoneKeys', phoneKey), tx.get('importKeys', importKey)]);
        if (key || old) return false;
        const date = new Date(), contact = { contactId, orgId: actor.orgId, companyName: row.companyName, contactPerson: row.contactPerson, primaryPhone: result.e164.slice(1), phones: [result.e164.slice(1)],
          originalPhone: row.phone, phoneCountryCode: row.countryCode || inspectDestination(result.e164).country || '', city: row.city, status: 'ACTIVE', assignedTo: actor.userId,
          relationshipType: { unclassified: 'OTHER', prospect: 'PROSPECT', customer: 'EXISTING_CLIENT' }[row.relationship], source: 'CSV_REVIEWED', importBatchId: preview.batchId, createdAt: date, updatedAt: date };
        this.directory.assertRecordScope(actor, contact);
        Object.assign(contact, classificationProjection(contact));
        tx.create('contacts', contactId, contact);
        tx.create('contactPhoneKeys', phoneKey, { orgId: actor.orgId, contactId, phone: result.e164.slice(1), createdAt: date });
        tx.create('importKeys', importKey, { orgId: actor.orgId, contactId, batchId: preview.batchId, status: 'DONE', createdBy: actor.userId, createdAt: date });
        return true;
      });
      if (changed) created += 1; else skipped += 1;
    }
    let permissionRecorded = 0, permissionGranted = 0; const permissionErrors = [];
    for (const result of preview.rows) {
      if (!result.permissionEvidence || !['NEW', 'UPDATE', 'PERMISSION', 'IMPORTED'].includes(result.status)) continue;
      const row = rowSchema.parse(input.payload.rows[result.index]), importKey = `${preview.batchId}-${result.index}`;
      const receipt = await this.store.get('importKeys', importKey), contactId = row.contactId || receipt?.contactId;
      if (!contactId) { permissionErrors.push({ index: result.index, reason: 'CONTACT_IMPORT_NOT_COMPLETED' }); continue; }
      try {
        const contact = await this.directory.checkedContact(actor, contactId);
        if (canonicalDestination(contact.primaryPhone, contact.phoneCountryCode) !== result.e164) throw new ConflictError('Contact phone changed; review evidence again');
        const outcome = await this.workspace.safety.record(actor, contactId, { ...result.permissionEvidence, expectedVersion: result.permissionVersion }, { requestKey: `contact-import:${importKey}` });
        if (outcome.recorded) { permissionRecorded++; if (result.permissionEvidence.state === 'granted') permissionGranted++; }
      } catch (error) { permissionErrors.push({ index: result.index, reason: error.message }); }
    }
    return { batchId: preview.batchId, created, updated, skipped, total: preview.total, permissionRecorded, permissionGranted, permissionErrors };
  }
  async exportAudiencePage(actor, audienceId, query) {
    assertPermission(actor, 'contacts.export');
    const preview = await this.workspace.previewAudience(actor, audienceId, query);
    const fields = ['companyName', 'contactPerson', 'primaryPhone', 'city', 'relationship', 'tier'];
    const csv = [fields.join(','), ...preview.items.map(item => fields.map(field => csvCell(item[field])).join(','))].join('\r\n');
    await this.store.create('auditLogs', `EXPORT_${sha256(`${actor.orgId}:${actor.userId}:${Date.now()}:${Math.random()}`)}`, { orgId: actor.orgId, actorId: actor.userId, action: 'CONTACT_PAGE_EXPORTED', entityId: audienceId, count: preview.items.length, createdAt: new Date() });
    return { csv, pagination: preview.pagination, count: preview.items.length, note: 'This download contains the current authorised page only.' };
  }
}
export function csvCell(value) { const text = String(value ?? ''); return `"${(/^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`; }
