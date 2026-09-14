import { describe, it, expect, vi } from 'vitest';
import { createPreparationPlan, applyPreparationPlan, digest, decodeFields, PREPARATION_FIELDS } from '../src/migrations/live-directory-preparation.js';

const database = 'projects/demo-directory/databases/(default)', orgId = 'RXDH';
const doc = (id, fields = {}) => ({ name: `${database}/documents/contacts/${id}`, updateTime: '2026-09-14T01:00:00.000000Z', fields: {
  orgId: { stringValue: orgId }, companyName: { stringValue: 'Synthetic Company' }, primaryPhone: { stringValue: '+447911123456' },
  relationshipType: { stringValue: 'EXISTING_CLIENT' }, stopAllCommunications: { booleanValue: true }, ...fields
} });
function setup(documents) {
  const plan = createPreparationPlan({ database, orgId, documents });
  const current = new Map(documents.map(d => [d.name, structuredClone(d)]));
  const journal = vi.fn(async () => {});
  const commit = vi.fn(async writes => {
    if (writes.some(w => current.get(w.update.name)?.updateTime !== w.currentDocument.updateTime)) throw new Error('Concurrent write');
    for (const w of writes) { const d = current.get(w.update.name); Object.assign(d.fields, w.update.fields); d.updateTime = '2026-09-14T02:00:00.000000Z'; }
    return { commitTime: '2026-09-14T02:00:00Z' };
  });
  const options = { plan, documents, approval: { approvedDatabase: database, approvedOrgId: orgId, approvedDigest: digest(plan) },
    readMany: async names => names.map(n => current.get(n)).filter(Boolean), commit, journal };
  return { options, current, commit, journal, run: () => applyPreparationPlan(options) };
}
describe('reviewed live directory preparation', () => {
  it('plans without writes, retaining customer classification and explicit suppression', () => {
    const { options, commit } = setup([doc('A')]);
    expect(options.plan.summary).toMatchObject({ toPrepare: 1, relationships: { customer: 1 } });
    expect(decodeFields(options.plan.entries[0].fields)).toMatchObject({ crmV1Relationship: 'customer', crmV1LastMeaningfulAtMs: -1 });
    expect(Object.keys(options.plan.entries[0].fields)).toEqual(PREPARATION_FIELDS);
    expect(commit).not.toHaveBeenCalled();
  });
  it('only patches the eight directory fields and resumes without duplicate changes', async () => {
    const { options, current, commit, run } = setup([doc('A')]);
    expect(await run()).toMatchObject({ prepared: 1, complete: true });
    expect(commit.mock.calls[0][0][0].updateMask.fieldPaths).toEqual(PREPARATION_FIELDS);
    expect(current.get(options.documents[0].name).fields.stopAllCommunications).toEqual({ booleanValue: true });
    expect(await run()).toMatchObject({ prepared: 0, alreadyApplied: 1, complete: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('refuses foreign, duplicated and unversioned documents', () => {
    for (const documents of [[doc('A', { orgId: { stringValue: 'OTHER' } })], [doc('A'), doc('A')], [{ ...doc('A'), updateTime: null }]]) {
      expect(() => createPreparationPlan({ database, orgId, documents })).toThrow();
    }
  });
  it('rejects wrong approval, tampered fields and changed backup before reads or writes', async () => {
    for (const mutation of [s => { s.options.approval.approvedOrgId = 'OTHER'; }, s => { s.options.plan.entries[0].fields.stopAllCommunications = { booleanValue: false }; s.options.approval.approvedDigest = digest(s.options.plan); }, s => { s.options.documents[0].fields.companyName.stringValue = 'Changed'; }]) {
      const s = setup([doc('A')]); mutation(s);
      s.options.readMany = vi.fn();
      await expect(s.run()).rejects.toThrow();
      expect(s.options.readMany).not.toHaveBeenCalled(); expect(s.commit).not.toHaveBeenCalled();
    }
  });
  it('skips deleted or concurrently edited contacts for review', async () => {
    const s = setup([doc('A'), doc('B'), doc('C')]);
    s.current.delete(doc('A').name);
    s.current.get(doc('B').name).updateTime = 'newer';
    expect(await s.run()).toMatchObject({ prepared: 1, conflicts: 2, complete: false });
  });
  it('caps atomic writes at 100 and journals intent before every commit', async () => {
    const s = setup(Array.from({ length: 251 }, (_, i) => doc(String(i))));
    await s.run();
    expect(s.commit.mock.calls.map(c => c[0].length)).toEqual([100, 100, 51]);
    expect(s.journal.mock.invocationCallOrder[0]).toBeLessThan(s.commit.mock.invocationCallOrder[0]);
  });
  it('recovers an uncertain commit without resending writes', async () => {
    const s = setup([doc('A')]); const commit = s.options.commit;
    s.options.commit = async writes => { await commit(writes); throw new Error('Response lost'); };
    await expect(s.run()).rejects.toThrow('Response lost');
    expect(await s.run()).toMatchObject({ prepared: 0, alreadyApplied: 1, complete: true });
    expect(s.commit).toHaveBeenCalledTimes(1);
  });
  it('does not write when the intent journal cannot be saved', async () => {
    const s = setup([doc('A')]); s.options.journal = async () => { throw new Error('Disk full'); };
    await expect(s.run()).rejects.toThrow('Disk full'); expect(s.commit).not.toHaveBeenCalled();
  });
  it('preserves already prepared and future-version contacts', async () => {
    const s = setup([doc('A', { crmV1Version: { integerValue: '1' } }), doc('B', { crmV1Version: { integerValue: '2' } })]);
    expect(s.options.plan.summary.alreadyPrepared).toBe(2);
    expect(await s.run()).toMatchObject({ prepared: 0, complete: true });
  });
});
