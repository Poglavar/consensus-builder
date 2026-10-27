// The plan-first agreement conserves land, assigns single recipients and derives compensation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { validateAgreementContent } from '../routes/agreements.js';
const require = createRequire(import.meta.url);
const Record = require('../../frontend/js/agreement-record.js');
const Dialog = require('../../frontend/js/agreement-dialog.js');
const Plan = require('../../frontend/js/plan-record.js');
const Cid = require('../../frontend/js/cid.js');
const Regimes = require('../../frontend/js/proposals/approval-regimes.js');
const designCid = Cid.cidOfObject({ design: 'layout' });
const content = Plan.create('Saved plan', [designCid], { at: '45.8,15.96,17', mode: '2d' });
function fixture() {
    const outputs = [800, 1200].map((areaM2, i) => {
        const geometry = { type: 'Polygon', coordinates: [[[i, 0], [i + 0.5, 0], [i + 0.5, 1], [i, 1], [i, 0]]] };
        return { hash: Record.outputHash(geometry), pieceId: `out-${i}`, geometry, areaM2, fromParcelIds: ['A', 'B'], role: 'plot', producedBy: 'layout', holders: [] };
    });
    return Record.settle({ schema: 'agreement/v1', id: 'ag-accounting', city: 'zagreb',
        plan: { cid: Cid.cidOfObject(content), content }, designs: [{ proposalId: 'layout', cid: designCid }],
        inputs: { parcels: [{ parcelId: 'A', areaM2: 1000, holders: [] }, { parcelId: 'B', areaM2: 1000, holders: [] }], openGroundM2: 0 },
        outputs, allocations: outputs.map((output, i) => ({ output: output.hash, to: { kind: 'party', ownerKey: `parcel-owner:${i ? 'B' : 'A'}` } })),
        money: { currency: 'EUR', lines: [] }, rule: { electorate: 'owners', binding: false, lens: [], approvalConfig: null,
            settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } } });
}
const codes = raw => Record.validate(raw).errors.map(row => row.code);
describe('plan-first agreement accounting', () => {
    it('supports unnamed owners and balances compensation from gains and losses', () => {
        const record = fixture();
        expect(Record.validate(record).valid).toBe(true);
        expect(record.inputs.parcels[0].holders).toEqual([Record.abstractHolder('A')]);
        expect(record.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: 2000000 }, { ownerKey: 'parcel-owner:B', amountCents: -2000000 }]);
        expect(Record.ledger(record).money.sponsorCents).toBe(0);
        expect(Record.rightsFromInputs(record.inputs).parcels.every(row => !row.complete)).toBe(true);
    });
    it('requires a saved exact plan and never creates one from the form', () => {
        const record = fixture();
        expect(codes({ ...record, plan: null })).toContain('plan-required');
        expect(codes({ ...record, designs: [] })).toContain('plan-membership');
        const raw = Dialog.recordFromForm({ id: 'new', designs: [], land: { inputs: record.inputs, outputs: record.outputs }, currency: 'EUR' }, { allocations: {} });
        expect(raw.plan).toBeNull();
        const html = Dialog.bodyHtml({ plans: [], values: {} });
        expect(html).toContain('Create a plan first'); expect(html).not.toContain('data-agreement-design=');
    });
    it('requires one input party per output, rejects joint and implicit holders', () => {
        const record = fixture();
        expect(codes({ ...record, allocations: [] })).toContain('allocation-required');
        for (const to of [{ kind: 'joint', shares: [] }, { kind: 'holders' }]) expect(() => Record.normalize({ ...record, allocations: [{ output: record.outputs[0].hash, to }] })).toThrow(/one recipient/);
        expect(codes({ ...record, allocations: [{ output: record.outputs[0].hash, to: { kind: 'party', ownerKey: 'outsider' } }] })).toContain('allocation-unknown-party');
    });
    it('rejects land gaps, unknown areas and manually changed payments', () => {
        const record = fixture();
        expect(codes({ ...record, outputs: [record.outputs[0]] })).toContain('land-unbalanced');
        expect(codes({ ...record, inputs: { ...record.inputs, parcels: record.inputs.parcels.map(p => ({ ...p, areaM2: null })) } })).toContain('land-unbalanced');
        expect(codes({ ...record, money: { currency: 'EUR', lines: [] } })).toContain('money-unbalanced');
    });
    it('separates the German public contribution from compensated allocation differences', () => {
        const raw = fixture();
        raw.rule.approvalConfig = { schema: 'proposal-approval/v1', rights: null, regime: { id: 'de-umlegung-new', version: Regimes.CHECKED }, policy: Regimes.policyOf(Regimes.latest('de-umlegung-new'), ['authority-1']) };
        raw.rule.settlement.contributionBasisPoints = 2000; raw.allocations[1].to = { kind: 'public' };
        const record = Record.settle(raw);
        expect(record.money.lines).toEqual([{ ownerKey: 'parcel-owner:B', amountCents: 8000000 }]);
        expect(Record.ledger(record).money.sponsorCents).toBe(-8000000);
        expect(Record.validate(record).valid).toBe(true);
        record.rule.settlement.contributionBasisPoints = 3001;
        expect(codes(record)).toContain('settlement-invalid');
    });
    it('shows cash direction in person rows and omits money when none moves', () => {
        const record = fixture(); const html = Dialog.personsHtml(record);
        expect(html).toContain('Puts in'); expect(html).toContain('Receives'); expect(html).toContain('20000 EUR');
        const none = Record.settle({ ...record, rule: { ...record.rule, settlement: { method: 'none', rateCentsPerM2: 0, contributionBasisPoints: 0 } } });
        expect(none.money.lines).toEqual([]); expect(Dialog.personsHtml(none)).not.toContain('EUR');
    });
    it('uses identical HTTP checks for compensation, conservation and single ownership', () => {
        const raw = fixture(), published = Record.published(raw);
        expect(validateAgreementContent(published, { designCids: [designCid] }).ok).toBe(true);
        expect(validateAgreementContent({ ...published, money: { currency: 'EUR', lines: [] } }).section).toBe('money');
        expect(validateAgreementContent({ ...published, allocations: [{ output: raw.outputs[0].hash, to: { kind: 'joint', shares: [] } }] }).section).toBe('allocation');
    });
});
