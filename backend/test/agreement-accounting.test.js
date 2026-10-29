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
const geometryAt = i => ({ type: 'Polygon', coordinates: [[[i, 0], [i + 0.5, 0], [i + 0.5, 1], [i, 1], [i, 0]]] });
function fixture() {
    const outputs = [800, 1200].map((areaM2, i) => {
        const geometry = geometryAt(i);
        return { hash: Record.outputHash(geometry), pieceId: `out-${i}`, geometry, areaM2, fromParcelIds: ['A', 'B'], role: 'plot', producedBy: 'layout' };
    });
    return Record.settle({ schema: 'agreement/v1', id: 'ag-accounting', city: 'zagreb',
        plan: { cid: Cid.cidOfObject(content), content }, designs: [{ proposalId: 'layout', cid: designCid }],
        inputs: { parcels: [{ parcelId: 'A', areaM2: 1000 }, { parcelId: 'B', areaM2: 1000 }], openGroundM2: 0 },
        outputs, allocations: outputs.map((output, i) => ({ output: output.hash, to: { kind: 'party', ownerKey: `parcel-owner:${i ? 'B' : 'A'}` } })),
        money: { currency: 'EUR', lines: [] }, rule: { electorate: 'owners', binding: false, lens: [], approvalConfig: null,
            settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } } });
}
const codes = raw => Record.validate(raw).errors.map(row => row.code);
describe('plan-first agreement accounting', () => {
    it('supports unnamed owners and balances compensation from gains and losses', () => {
        const record = fixture();
        expect(Record.validate(record).valid).toBe(true);
        expect(record.inputs.parcels[0]).toEqual({ parcelId: 'A', areaM2: 1000 });
        expect(Record.landParties(record)).toEqual(new Set(['parcel-owner:A', 'parcel-owner:B']));
        expect(record.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: 2000000 }, { ownerKey: 'parcel-owner:B', amountCents: -2000000 }]);
        expect(Record.ledger(record).money.sponsorCents).toBe(0);
        expect(Record.rightsFromInputs(record.inputs).parcels.every(row => !row.complete)).toBe(true);
    });
    it('acquires all outputs for a proposer with no input land, funded by the sponsor', () => {
        const raw = fixture();
        raw.allocations = raw.outputs.map(output => ({ output: output.hash, to: { kind: 'proposer' } }));
        const record = Record.settle(raw), ledger = Record.ledger(record);
        expect(Record.validate(record).valid).toBe(true);
        expect(ledger.proposerM2).toBe(2000); expect(ledger.publicM2).toBe(0);
        expect(ledger.parties.every(p => p.assignedM2 === 0)).toBe(true);
        expect(record.money.lines).toEqual([
            { ownerKey: 'parcel-owner:A', amountCents: 10000000 }, { ownerKey: 'parcel-owner:B', amountCents: 10000000 }
        ]);
        expect(ledger.money.sponsorCents).toBe(-20000000);
        expect(Dialog.personsHtml(record)).toContain('Proposer');
        expect(validateAgreementContent(Record.published(record), { designCids: [designCid] }).ok).toBe(true);
        expect(Dialog.termsOf(record).allocations[raw.outputs[0].hash]).toBe('proposer');
    });
    it('supports selective acquisition and the same compensation rules without cash', () => {
        const raw = fixture(); raw.allocations[0].to = { kind: 'proposer' };
        const mixed = Record.settle(raw);
        expect(Record.ledger(mixed).proposerM2).toBe(800);
        expect(Record.ledger(mixed).money.sponsorCents).toBe(-8000000);
        raw.rule.settlement.method = 'none';
        const noCash = Record.settle(raw);
        expect(noCash.money.lines).toEqual([]); expect(Record.ledger(noCash).proposerM2).toBe(800);
        expect(Record.validate(noCash).valid).toBe(true);
    });
    it('keeps bulk assignments explicit and per-parcel controls disabled only in bulk mode', () => {
        const record = fixture(), assignments = Object.fromEntries(record.outputs.map(o => [o.hash, 'proposer']));
        expect(Dialog.allocationMode(assignments)).toBe('proposer');
        expect(Dialog.allocationMode({ ...assignments, [record.outputs[0].hash]: 'public' })).toBe('individual');
        expect(Dialog.allocationMode({})).toBe('individual');
        const html = Dialog.allocationHtml(record, assignments, 'proposer');
        expect(html.match(/data-agreement-allocation="[^" ]+" disabled/g)).toHaveLength(2);
        expect(Dialog.allocationHtml(record, assignments)).not.toContain(' disabled');
        expect(Dialog.keptTerms({ allocations: assignments }, record).allocations).toEqual(assignments);
    });
    it('randomizes the pieces over every person before anyone gets a second, and counts the spread', () => {
        const record = fixture();
        const three = [...record.outputs, { ...record.outputs[0], hash: 'third' }];
        const random = Dialog.randomAllocations(record.inputs, three, () => 0);
        const owners = Object.values(random);
        expect(owners).toHaveLength(3);
        // Both persons receive a piece before the order starts again.
        expect(new Set(owners.slice(0, 2))).toEqual(new Set(['party:parcel-owner:A', 'party:parcel-owner:B']));
        expect(owners[2]).toBe(owners[0]);
        expect(Dialog.randomAllocations({ parcels: [] }, three)).toEqual({});
        expect(Dialog.allocationSpread(record.inputs, random)).toEqual({ persons: 2, without: 0, several: 1 });
        expect(Dialog.allocationSpread(record.inputs, { x: 'proposer' })).toEqual({ persons: 2, without: 2, several: 0 });
        const html = Dialog.allocationHtml(record, { [record.outputs[0].hash]: 'party:parcel-owner:A', [record.outputs[1].hash]: 'party:parcel-owner:A' });
        expect(html).toContain('<option value="random">Randomize</option>');
        expect(html).toMatch(/data-agreement-allocation-summary>Persons without a parcel: 1 · Persons with more than one parcel: 1<\/p><ul/);
        expect(Dialog.allocationSummaryHtml(record, random)).toContain('Persons with more than one parcel: 1');
        expect(Dialog.allocationSummaryHtml(record, Object.fromEntries(record.outputs.map((o, i) => [o.hash, `party:parcel-owner:${i ? 'B' : 'A'}`])))).toContain(' hidden>');
        expect(Dialog.allocationHtml({ inputs: { parcels: [] }, outputs: record.outputs })).toContain('<option value="random" disabled>');
    });
    it('counts input parcels, output parcels and persons on the tabs', () => {
        const record = fixture();
        expect(Dialog.tabCounts(record)).toEqual({ inputs: 2, outputs: 2, persons: 2 });
        expect(Dialog.tabLabel('outputs', { outputs: 5 })).toBe('Output parcels (5)');
        expect(Dialog.tabLabel('rules', { outputs: 5 })).toBe('Rules');
        expect(Dialog.bodyHtml({ plans: [], values: {}, counts: { inputs: 3 } })).toContain('data-agreement-tab="inputs">Input parcels (3)</button>');
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
    it('separates the German public contribution from compensated allocation differences, within the scheme’s cap', () => {
        // A puts in 1000 and keeps 700 (gives up 30%, the cap); 300 go to public; B keeps its 1000.
        const raw = fixture();
        const german = Regimes.latest('de-umlegung-new');
        raw.rule.approvalConfig = { schema: 'proposal-approval/v1', rights: null, regime: { id: german.id, version: german.version }, policy: Regimes.policyOf(german, ['authority-1']) };
        raw.rule.settlement.contributionBasisPoints = 2000;
        raw.outputs = [700, 300, 1000].map((areaM2, i) => ({ ...raw.outputs[0], hash: Record.outputHash(geometryAt(i)), pieceId: `out-${i}`, geometry: geometryAt(i), areaM2 }));
        raw.allocations = [{ output: raw.outputs[0].hash, to: { kind: 'party', ownerKey: 'parcel-owner:A' } }, { output: raw.outputs[1].hash, to: { kind: 'public' } },
            { output: raw.outputs[2].hash, to: { kind: 'party', ownerKey: 'parcel-owner:B' } }];
        const record = Record.settle(raw);
        // Entitlements after the 20% contribution: 800 each. A is 100 short, B 200 over.
        expect(record.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: 1000000 }, { ownerKey: 'parcel-owner:B', amountCents: -2000000 }]);
        expect(Record.ledger(record).money.sponsorCents).toBe(1000000);
        expect(Record.validate(record).valid).toBe(true);
        expect(validateAgreementContent(Record.published(record), { designCids: [designCid] }).ok).toBe(true);
        record.rule.settlement.contributionBasisPoints = 3001;
        expect(codes(record)).toContain('settlement-invalid');
        // The same deal under the scheme for developed land (10%) breaks its cap: the dialog, the
        // index and MCP all refuse it, naming the owner and the cap.
        const developed = Regimes.latest('de-umlegung-developed');
        const tight = Record.settle({ ...raw, rule: { ...raw.rule, settlement: { ...raw.rule.settlement, contributionBasisPoints: 1000 },
            approvalConfig: { ...raw.rule.approvalConfig, regime: { id: developed.id, version: developed.version }, policy: Regimes.policyOf(developed, ['authority-1']) } } });
        const issue = Record.validate(tight).errors.find(row => row.code === 'scheme-cap');
        expect(issue).toMatchObject({ section: 'allocation', ownerKey: 'parcel-owner:A', ownerName: 'Owner(s) of parcel A', scheme: 'de-umlegung-developed', version: developed.version });
        expect(issue.message).toBe('Owner(s) of parcel A gives up 30% of their land; Germany — Umlegung, already developed land allows at most 10%.');
        expect(validateAgreementContent(Record.published(tight), { designCids: [designCid] })).toMatchObject({ ok: false, section: 'allocation', error: issue.message });
        expect(Dialog.issueText(issue)).toBe('Germany — Umlegung, already developed land: Owner(s) of parcel A gives up 30% of their land; the cap is 10%.');
        expect(Record.schemeCheck(tight).check).toMatchObject({ ok: false });
        expect(Record.schemeCheck(tight, german).check.ok).toBe(true);
        expect(Record.schemeCheck({ ...tight, rule: { ...tight.rule, approvalConfig: null } })).toBeNull();
    });
    it('shows cash direction in person rows and omits money when none moves', () => {
        const record = fixture(); const html = Dialog.personsHtml(record);
        expect(html).toContain('Puts in'); expect(html).toContain('Receives'); expect(html).toContain('20000 EUR');
        const none = Record.settle({ ...record, rule: { ...record.rule, settlement: { method: 'none', rateCentsPerM2: 0, contributionBasisPoints: 0 } } });
        expect(none.money.lines).toEqual([]); expect(Dialog.personsHtml(none)).not.toContain('EUR');
    });
    it('lists the parcel parties, and the persons derived from ownership rights only when the rights name people', () => {
        const record = fixture();
        const abstract = Dialog.personsHtml(record);
        expect(abstract).toContain('Owner(s) of parcel A');
        expect(abstract).not.toContain('data-agreement-derived-persons');
        // A pays 2,000,000 cents; B receives it. Ana owns all of A and 1/3 of B, Ben 2/3 of B.
        const rights = { schema: 'parcel-rights/v1', source: { provider: 'upload' }, parcels: [
            { parcelId: 'A', complete: true, areaM2: null, owners: [{ ownerId: 'ana', share: '1/1' }] },
            { parcelId: 'B', complete: true, areaM2: null, owners: [{ ownerId: 'ana', share: '1/3' }, { ownerId: 'ben', share: '2/3' }] }
        ] };
        const named = { ...record, rule: { ...record.rule, approvalConfig: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } } } };
        const html = Dialog.personsHtml(named, new Map([['ana', 'Ana']]));
        expect(html).toContain('Persons by ownership rights');
        expect(html).toMatch(/data-agreement-person="ana"><th scope="row">Ana<\/th>/);
        expect(html).toMatch(/data-agreement-person="ben"><th scope="row">ben<\/th>/);
        // Ben: 2/3 of B's 1200 m² piece and 2/3 of its cash; Ana: A's 800 m² piece plus 1/3 of B's.
        expect(html).toContain('13333.33 EUR');
        expect(html).not.toContain('data-agreement-persons-unresolved');
        const partial = { ...named, rule: { ...named.rule, approvalConfig: { ...named.rule.approvalConfig, rights: { ...rights, parcels: [rights.parcels[0]] } } } };
        expect(Dialog.personsHtml(partial)).toContain('data-agreement-persons-unresolved');
        expect(Dialog.ownersText('B', rights, new Map([['ana', 'Ana']]))).toBe('Ana 33%, ben 67%');
        expect(Dialog.ownersText('B', null)).toBe('Owner(s) of parcel B');
    });
    it('uses identical HTTP checks for compensation, conservation and single ownership', () => {
        const raw = fixture(), published = Record.published(raw);
        expect(validateAgreementContent(published, { designCids: [designCid] }).ok).toBe(true);
        expect(validateAgreementContent({ ...published, money: { currency: 'EUR', lines: [] } }).section).toBe('money');
        expect(validateAgreementContent({ ...published, allocations: [{ output: raw.outputs[0].hash, to: { kind: 'joint', shares: [] } }] }).section).toBe('allocation');
    });
});

// Settlement by value: A puts in 1000 m² at 100 EUR/m², B 1000 m² at 200 EUR/m²; after the designs
// 300 m² go to public, A gets 800 m² and B 900 m², all at 400 EUR/m².
function valued(regime = null, settlement = { method: 'value', rateCentsPerM2: 0, contributionBasisPoints: 0 }) {
    const raw = fixture();
    raw.outputs = [300, 800, 900].map((areaM2, i) => ({ ...raw.outputs[0], hash: Record.outputHash(geometryAt(i)), pieceId: `out-${i}`, geometry: geometryAt(i), areaM2 }));
    raw.allocations = [{ output: raw.outputs[0].hash, to: { kind: 'public' } }, { output: raw.outputs[1].hash, to: { kind: 'party', ownerKey: 'parcel-owner:A' } },
        { output: raw.outputs[2].hash, to: { kind: 'party', ownerKey: 'parcel-owner:B' } }];
    raw.valuation = { inputs: [{ parcelId: 'A', unitValueCents: 10000 }, { parcelId: 'B', unitValueCents: 20000 }], outputs: raw.outputs.map(o => ({ output: o.hash, unitValueCents: 40000 })) };
    raw.rule.settlement = { ...settlement };
    raw.rule.approvalConfig = regime ? { schema: 'proposal-approval/v1', rights: null, regime: { id: regime.id, version: regime.version }, policy: Regimes.policyOf(regime, ['authority-1']) } : null;
    return Record.settle(raw);
}
const http = record => validateAgreementContent(Record.published(record), { designCids: [designCid] });

describe('settlement by value', () => {
    it('shares the distributed value by the value put in and settles the differences in money', () => {
        const record = valued();
        const ledger = Record.ledger(record);
        // 300,000 in; 680,000 distributed to parties (120,000 went to public): A is entitled to a third.
        expect(ledger).toMatchObject({ valued: true, contributedValueCents: 30000000, distributableValueCents: 68000000, publicValueCents: 12000000, proposerValueCents: 0, valueGain: 0 });
        const [a, b] = ledger.parties;
        expect(a).toMatchObject({ contributedValueCents: 10000000, assignedValueCents: 32000000, entitlementValueCents: 22666667 });
        expect(b).toMatchObject({ contributedValueCents: 20000000, assignedValueCents: 36000000, entitlementValueCents: 45333333 });
        expect(record.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: -9333333 }, { ownerKey: 'parcel-owner:B', amountCents: 9333333 }]);
        expect(ledger.money.sponsorCents).toBe(0);
        expect(Record.validate(record).valid).toBe(true);
        expect(http(record).ok).toBe(true);
        expect(Record.published(record).valuation).toEqual(record.valuation);
        const html = Dialog.personsHtml(record);
        expect(html).toContain('320000 EUR'); expect(html).toContain('entitled to 226666.67 EUR'); expect(html).toContain('Value in: 300000 EUR · Value out: 800000 EUR');
    });
    it('settles the whole value gain in money under a German Umlegung and half of it under a Gujarat scheme', () => {
        const german = valued(Regimes.latest('de-umlegung-developed'));
        // Each owner is made whole to the value put in: A got 320,000 for 100,000, B 360,000 for 200,000.
        expect(german.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: -22000000 }, { ownerKey: 'parcel-owner:B', amountCents: -16000000 }]);
        expect(Record.ledger(german).money.sponsorCents).toBe(38000000);
        expect(Record.validate(german).valid).toBe(true);
        expect(Record.schemeCheck(german).check.rules.map(rule => rule.kind)).toEqual(['proposer']);
        const gujarat = valued(Regimes.latest('in-gj-tps'));
        expect(gujarat.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: -15666666 }, { ownerKey: 'parcel-owner:B', amountCents: -3333333 }]);
        expect(Record.validate(gujarat).valid).toBe(true);
        expect(http(gujarat).ok).toBe(true);
        // The 2026-10-11 version of the same scheme settles none of the gain, as it did.
        const earlier = valued(Regimes.get('de-umlegung-developed', '2026-10-11'));
        expect(earlier.money.lines).toEqual(valued().money.lines);
    });
    it('needs a value for every parcel and piece, only by value, and whole cents', () => {
        const record = valued();
        expect(Record.settlementValid({ settlement: { method: 'value', rateCentsPerM2: 100, contributionBasisPoints: 0 } })).toBe(false);
        expect(Record.settlementValid({ settlement: { method: 'value', rateCentsPerM2: 0, contributionBasisPoints: 0 } })).toBe(true);
        const missing = Record.settle({ ...record, valuation: { inputs: record.valuation.inputs, outputs: record.valuation.outputs.slice(1) } });
        expect(missing.money.lines).toEqual([]);
        expect(codes(missing)).toEqual(['valuation-missing']);
        expect(http(missing)).toMatchObject({ ok: false, section: 'money' });
        expect(codes(Record.settle({ ...record, valuation: null }))).toEqual(['valuation-missing']);
        expect(codes(Record.settle({ ...record, valuation: { ...record.valuation, inputs: [...record.valuation.inputs, { parcelId: 'Z', unitValueCents: 1 }] } }))).toContain('valuation-unknown');
        expect(codes(Record.settle({ ...record, valuation: { ...record.valuation, inputs: [{ parcelId: 'A', unitValueCents: 0 }, { parcelId: 'B', unitValueCents: 0 }] } }))).toEqual(['valuation-zero']);
        expect(codes(Record.settle({ ...record, valuation: { ...record.valuation, inputs: [{ parcelId: 'A', unitValueCents: 1.5 }, { parcelId: 'B', unitValueCents: 20000 }] } }))).toContain('valuation-invalid');
        expect(http({ ...record, valuation: { ...record.valuation, inputs: [{ parcelId: 'A', unitValueCents: -1 }, { parcelId: 'B', unitValueCents: 20000 }] } })).toMatchObject({ ok: false, section: 'money' });
        const area = Record.settle({ ...record, rule: { ...record.rule, settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } } });
        expect(codes(area)).toEqual(['valuation-unused']);
        expect(Record.ledger(area).valued).toBe(true);
        expect(Record.ledger(Record.settle({ ...area, valuation: null })).valued).toBe(false);
    });
    it('carries the land values through the dialog’s form values and record', () => {
        const record = valued();
        const terms = Dialog.termsOf(record);
        expect(terms.valuation).toEqual({ inputs: { A: 10000, B: 20000 }, outputs: Object.fromEntries(record.outputs.map(o => [o.hash, 40000])) });
        const state = { id: record.id, plan: record.plan, designs: [{ proposalId: 'layout', title: 'Layout', goal: 'parcelLayout', city: 'zagreb' }], fingerprints: new Map([['layout', designCid]]),
            land: { inputs: record.inputs, outputs: record.outputs }, approvalConfig: null, lens: [], currency: 'EUR' };
        const fromForm = Dialog.recordFromForm(state, { ...terms, electorate: 'owners', settlement: { method: 'value', rateCentsPerM2: 0, contributionBasisPoints: 0 } });
        expect(fromForm.valuation).toEqual(record.valuation);
        expect(fromForm.money.lines).toEqual(record.money.lines);
        // By area the typed values stay in the form but out of the record.
        expect(Dialog.recordFromForm(state, { ...terms, electorate: 'owners', settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } }).valuation).toBeNull();
        expect(Dialog.valuationHtml('inputs', [{ id: 'A', title: 'A', facts: '1000 m²' }], { A: 10000 }, 'EUR')).toContain('data-agreement-value-kind="inputs" data-agreement-value-id="A"');
        expect(Dialog.valuationHtml('outputs', [], {}, 'EUR')).toBe('');
    });
});

describe('scheme distribution rules', () => {
    it('refuses an area deal under a value scheme, too few parties, and a proposer under an authority-led scheme', () => {
        const japan = Regimes.latest('jp-association');
        const areaDeal = valued(japan, { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 });
        const basis = Record.validate({ ...areaDeal, valuation: null }).errors.find(row => row.code === 'scheme-basis');
        expect(basis).toMatchObject({ section: 'rule', message: 'Japan — landowners’ association distributes by land value; this agreement settles by surface area.' });
        expect(http({ ...areaDeal, valuation: null })).toMatchObject({ ok: false, section: 'rule' });
        expect(Dialog.issueText(basis)).toBe('Japan — landowners’ association: The scheme distributes by land value, but this plan distributes by surface area.');
        // No cash at all is not a distribution by value either.
        expect(codes(valued(japan, { method: 'none', rateCentsPerM2: 0, contributionBasisPoints: 0 })).filter(code => code !== 'valuation-unused')).toEqual(['scheme-basis']);

        const exchange = Record.settle({ ...fixture(), rule: { ...fixture().rule, approvalConfig: { schema: 'proposal-approval/v1', rights: null,
            regime: { id: 'nl-kavelruil', version: Regimes.latest('nl-kavelruil').version }, policy: Regimes.policyOf(Regimes.latest('nl-kavelruil'), []) } } });
        const parties = Record.validate(exchange).errors.find(row => row.code === 'scheme-parties');
        expect(parties).toMatchObject({ section: 'land', message: 'Only 2 parties bring land in; Netherlands — voluntary urban land exchange (kavelruil) needs at least 3.' });
        expect(http(exchange)).toMatchObject({ ok: false, section: 'land' });

        const turkey = Regimes.latest('tr-article-18');
        const raw = fixture();
        raw.rule.approvalConfig = { schema: 'proposal-approval/v1', rights: null, regime: { id: turkey.id, version: turkey.version }, policy: Regimes.policyOf(turkey, ['belediye']) };
        raw.allocations[1].to = { kind: 'proposer' };
        const acquisition = Record.settle(raw);
        const proposer = Record.validate(acquisition).errors.find(row => row.code === 'scheme-proposer');
        expect(proposer).toMatchObject({ section: 'allocation', message: 'Turkey — article 18 readjustment is authority-led: land returns to its owners or goes to public use, so a proposer cannot acquire 1200 m².' });
        expect(Dialog.issueText(proposer)).toBe('Turkey — article 18 readjustment: 1200 m² would go to a proposer; under this scheme land returns to its owners or goes to public use.');
        // Without a scheme the same deals are only judged on their arithmetic.
        expect(Record.validate({ ...acquisition, rule: { ...acquisition.rule, approvalConfig: null } }).valid).toBe(true);
    });
});
