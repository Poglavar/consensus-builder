// Affected parcels: neighbours who give a right (light, a garden limit) and no land, as parties of an
// owners' agreement. Covers the record (shape, consideration, cash lines, validation, published
// object), the approval engine (a waiver needs its owners' approval whatever the tests count), the
// derived persons, the HTTP publication check and the lens member's check of a waiver's rights.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { validateAgreementContent } from '../routes/agreements.js';
import { createApprovalAttester, fileRegistry } from '../lens/approval.js';

const require = createRequire(import.meta.url);
const record = require('../../frontend/js/agreement-record.js');
const approval = require('../../frontend/js/proposals/approval.js');
const persons = require('../../frontend/js/agreement-persons.js');
const Cid = require('../../frontend/js/cid.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const LensCore = require('../../frontend/js/lens-core.js');

const LAYOUT_CID = Cid.cidOfObject({ schema: 'design/v1', goal: 'building', title: 'Raise the terrace' });
const PLAN_CONTENT = PlanRecord.create('Terrace', [LAYOUT_CID], { at: '51.5,-0.12,18', mode: '2d' });
const PLAN = { cid: Cid.cidOfObject(PLAN_CONTENT), content: PLAN_CONTENT };
const MEMBER = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
const PARCEL = { type: 'Polygon', coordinates: [[[-0.12, 51.5], [-0.1198, 51.5], [-0.1198, 51.5002], [-0.12, 51.5002], [-0.12, 51.5]]] };
const HOME = 'parcel-owner:t1', NEXT_DOOR = 'parcel-owner:t2', BEHIND = 'parcel-owner:t3';
const RIGHTS = {
    schema: 'parcel-rights/v1', source: { provider: 'upload' },
    parcels: [
        { parcelId: 't1', complete: true, areaM2: 200, owners: [{ ownerId: 'ana', share: '1/1' }] },
        { parcelId: 't2', complete: true, areaM2: null, owners: [{ ownerId: 'ben', share: '1/2' }, { ownerId: 'cleo', share: '1/2' }] },
        { parcelId: 't3', complete: true, areaM2: null, owners: [{ ownerId: 'dan', share: '1/1' }] }
    ]
};
const reading = { kind: 'sky', before: 31.2, after: 22.4, guide: 27, grade: 'fail' };

// One terrace house raised on its own plot (t1), its neighbour next door (t2) waiving daylight for
// £5,000, and the house behind (t3) compensated for a £10,000 loss in market value.
function agreement({ affected, neighbourCompensation, settlement = { method: 'none', rateCentsPerM2: 0, contributionBasisPoints: 0 } } = {}) {
    const output = { hash: record.outputHash(PARCEL), pieceId: 't1#1', areaM2: 200, fromParcelIds: ['t1'], producedBy: 'design-1', role: 'parcel', geometry: PARCEL };
    return record.settle({
        schema: 'agreement/v1', id: 'ag-terrace', title: 'Terrace mansard', city: 'london', createdAt: '2026-11-27T10:00:00.000Z', updatedAt: null,
        plan: { cid: PLAN.cid, content: JSON.parse(JSON.stringify(PLAN_CONTENT)) },
        designs: [{ proposalId: 'design-1', title: 'Raise the terrace', goal: 'building', cid: LAYOUT_CID }],
        inputs: { parcels: [{ parcelId: 't1', areaM2: 200 }], openGroundM2: 0 },
        outputs: [output],
        allocations: [{ output: output.hash, to: { kind: 'party', ownerKey: HOME } }],
        money: { currency: 'GBP', lines: [] },
        valuation: null,
        affected: affected ?? [
            { parcelId: 't2', effect: 'waiver', rights: ['daylight'], readings: [reading], considerationCents: 500000 },
            { parcelId: 't3', effect: 'compensation', rights: ['sunlight', 'garden'], loss: { amountCents: 1000000, statedBy: 'valuer', valuerRef: 'RICS 0001' } }
        ],
        rule: { electorate: 'owners', binding: true, lens: [MEMBER], settlement,
            ...(neighbourCompensation ? { neighbourCompensation } : {}),
            approvalConfig: { schema: 'proposal-approval/v1', rights: RIGHTS, policy: { type: 'unanimous' } } },
        deadline: null
    });
}
const STRONG_SUBURBS = { multipleBasisPoints: 15000, preset: { id: 'gb-strong-suburbs', version: '2026-11-27' } };
const codes = list => list.map(row => row.code);

describe('affected parcels in the agreement record', () => {
    it('pays each affected party its consideration from the sponsor: a waiver its stated amount, compensation its stated loss', () => {
        const settled = agreement();
        expect(settled.money.lines).toEqual([{ ownerKey: NEXT_DOOR, amountCents: 500000 }, { ownerKey: BEHIND, amountCents: 1000000 }]);
        expect(record.validate(settled)).toMatchObject({ valid: true, errors: [] });
        const ledger = record.ledger(settled);
        expect(ledger.parties.filter(party => party.affected).map(party => [party.ownerKey, party.contributedM2, party.assignedM2, party.cashCents]))
            .toEqual([[NEXT_DOOR, 0, 0, 500000], [BEHIND, 0, 0, 1000000]]);
        expect(ledger.parties.find(party => party.ownerKey === NEXT_DOOR).displayName).toBe('Owner(s) of parcel t2');
        // The sponsor funds both payments.
        expect(ledger.money.sponsorCents).toBe(-1500000);
    });

    it('compensates a multiple of the stated loss under the rule, and needs a stated loss when the multiple is not 1×', () => {
        const settled = agreement({ neighbourCompensation: STRONG_SUBURBS });
        expect(settled.affected.find(entry => entry.parcelId === 't3').considerationCents).toBe(1500000);
        expect(settled.money.lines.find(line => line.ownerKey === BEHIND).amountCents).toBe(1500000);
        expect(record.validate(settled).valid).toBe(true);
        const unstated = agreement({ neighbourCompensation: STRONG_SUBURBS, affected: [{ parcelId: 't3', effect: 'compensation', rights: ['garden'], considerationCents: 900000 }] });
        expect(codes(record.validate(unstated).errors)).toContain('affected-loss-required');
        // Under 1× (none set) compensation may state its amount without a loss.
        expect(record.validate(agreement({ affected: [{ parcelId: 't3', effect: 'compensation', rights: ['garden'], considerationCents: 900000 }] })).valid).toBe(true);
    });

    it('refuses a preset whose multiple differs, an unknown preset and a multiple that is not positive', () => {
        expect(codes(record.affectedIssues(agreement({ neighbourCompensation: { ...STRONG_SUBURBS, multipleBasisPoints: 20000 } })))).toEqual(['neighbour-multiple']);
        expect(codes(record.affectedIssues(agreement({ neighbourCompensation: { multipleBasisPoints: 15000, preset: { id: 'nowhere', version: '1' } } })))).toEqual(['neighbour-multiple']);
        expect(codes(record.affectedIssues(agreement({ neighbourCompensation: { multipleBasisPoints: 0 } })))).toEqual(['neighbour-multiple']);
        expect(record.NEIGHBOUR_PRESETS.find(preset => preset.id === 'gb-strong-suburbs')).toMatchObject({ multipleBasisPoints: 15000, verified: false });
    });

    it('refuses an affected parcel that is an input, unknown rights or effects, other without a note, negative amounts and bad readings', () => {
        const issues = raw => codes(record.validate(agreement({ affected: [raw] })).errors);
        expect(issues({ parcelId: 't1', effect: 'waiver', rights: ['daylight'] })).toContain('affected-input');
        expect(issues({ parcelId: 't2', effect: 'gift', rights: ['daylight'] })).toContain('affected-effect');
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: ['view'] })).toContain('affected-rights');
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: [] })).toContain('affected-rights');
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: ['other'] })).toContain('affected-note');
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: ['other'], note: 'Right to light over the yard' })).toEqual([]);
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: ['daylight'], considerationCents: -100 })).toContain('affected-amount');
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: ['daylight'], considerationCents: 10.5 })).toContain('affected-amount');
        expect(issues({ parcelId: 't3', effect: 'compensation', rights: ['garden'], loss: { amountCents: -1, statedBy: 'sponsor' } })).toContain('affected-amount');
        expect(issues({ parcelId: 't3', effect: 'compensation', rights: ['garden'], loss: { amountCents: 100, statedBy: 'the app' } })).toContain('affected-amount');
        expect(issues({ parcelId: 't2', effect: 'waiver', rights: ['daylight'], readings: [{ ...reading, kind: 'noise' }] })).toContain('affected-reading');
        expect(() => record.normalize({ ...agreement(), affected: [{ parcelId: 't2', effect: 'waiver', rights: ['daylight'] }, { parcelId: 't2', effect: 'waiver', rights: ['daylight'] }] }))
            .toThrow(/listed twice/);
    });

    it('refuses stored cash or a stored compensation that differ from the derived ones', () => {
        const settled = agreement({ neighbourCompensation: STRONG_SUBURBS });
        const raised = JSON.parse(JSON.stringify(settled));
        raised.money.lines.find(line => line.ownerKey === NEXT_DOOR).amountCents = 600000;
        expect(codes(record.validate(raised).errors)).toContain('money-unbalanced');
        const lowered = JSON.parse(JSON.stringify(settled));
        lowered.affected.find(entry => entry.parcelId === 't3').considerationCents = 1000000;
        expect(codes(record.validate(lowered).errors)).toContain('affected-consideration');
    });

    it('is for owners\' agreements only', () => {
        const community = { ...agreement(), rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, allocations: [], money: { currency: 'GBP', lines: [] }, consultation: null };
        expect(codes(record.validate(community).errors)).toContain('affected-electorate');
    });

    it('publishes the affected parcels only when there are any, so other agreements keep their bytes', () => {
        const object = record.published(agreement({ neighbourCompensation: STRONG_SUBURBS }), null, { requireSponsor: false });
        expect(object.affected.map(entry => [entry.parcelId, entry.effect, entry.considerationCents])).toEqual([['t2', 'waiver', 500000], ['t3', 'compensation', 1500000]]);
        expect(object.affected[0].readings).toEqual([reading]);
        expect(object.rule.neighbourCompensation).toEqual(STRONG_SUBURBS);
        const plain = record.published(agreement({ affected: [] }), null, { requireSponsor: false });
        expect(plain).not.toHaveProperty('affected');
        expect(plain.rule).not.toHaveProperty('neighbourCompensation');
    });

    it('puts the affected parcels into the default rights snapshot with no area, and only waivers into the approval subject', () => {
        const settled = agreement();
        expect(record.approvalSubject(settled)).toMatchObject({ cadastreParcelIds: ['t1'], waiverParcelIds: ['t2'] });
        expect(record.approvalSubject(agreement({ affected: [] }))).not.toHaveProperty('waiverParcelIds');
        const rights = record.rightsFromInputs(settled.inputs, () => [], settled.affected);
        expect(rights.parcels.map(row => [row.parcelId, row.areaM2, row.complete])).toEqual([['t1', 200, false], ['t2', null, false], ['t3', null, false]]);
    });
});

describe('a waiver in the approval engine', () => {
    const subject = () => record.approvalSubject(agreement());

    it('makes the waiving neighbour\'s owners parties that no test counts', () => {
        const state = approval.inspect(subject());
        expect(state).toMatchObject({ ready: true, ownerIds: ['ana'], waiverIds: ['ben', 'cleo'] });
        expect(state.partyIds).toEqual(['ana', 'ben', 'cleo']);
        expect(approval.partyLabel('ben', state)).toBe('Neighbour A');
        // The compensated neighbour is no party to the decision.
        expect(state.partyIds).not.toContain('dan');
    });

    it('passes only once every owner of the waiver parcel approved, whatever the area tally', () => {
        expect(approval.tally(subject(), ['ana'])).toMatchObject({ supportMet: true, waiverMet: false, passed: false, waivers: [{ parcelId: 't2', approved: false }] });
        expect(approval.tally(subject(), ['ana', 'ben'])).toMatchObject({ waiverMet: false, passed: false });
        expect(approval.tally(subject(), ['ana', 'ben', 'cleo'])).toMatchObject({ waiverMet: true, passed: true });
        // The neighbours' approval never counts towards the owners' tests.
        expect(approval.tally(subject(), ['ben', 'cleo'])).toMatchObject({ supportMet: false, passed: false });
    });

    it('is not ready while the waiver parcel\'s owners are unknown, and changes the context hash', () => {
        const unknown = JSON.parse(JSON.stringify(subject()));
        unknown.approvalConfig.rights.parcels[1] = { parcelId: 't2', complete: false, areaM2: null, owners: [] };
        expect(approval.inspect(unknown)).toMatchObject({ ready: false, reason: 'incomplete-rights', missingParcelIds: ['t2'] });
        const { waiverParcelIds, ...without } = subject();
        expect(waiverParcelIds).toEqual(['t2']);
        expect(approval.contextHash(subject())).not.toBe(approval.contextHash(without));
        expect(approval.contextContent(without)).not.toHaveProperty('waiverParcelIds');
        expect(() => approval.contextContent({ ...without, waiverParcelIds: ['t1'] })).toThrow(/input parcel/);
    });
});

describe('persons behind affected parties', () => {
    it('splits a neighbour party\'s consideration over its owners, who put in no land', () => {
        const derived = persons.personPositions(agreement(), RIGHTS);
        const byId = new Map(derived.persons.map(person => [person.personId, person]));
        expect(byId.get('ben')).toMatchObject({ contributedM2: 0, landM2: 0, cashCents: 250000 });
        expect(byId.get('cleo')).toMatchObject({ cashCents: 250000 });
        expect(byId.get('dan')).toMatchObject({ cashCents: 1000000 });
        expect(derived.totals.balanced).toBe(true);
    });
});

describe('HTTP publication check', () => {
    const NOW_MS = Date.parse('2026-11-27T12:00:00.000Z');
    const content = raw => record.published(raw, null, { requireSponsor: false });

    it('accepts an owners\' agreement with affected parcels and refuses the cases the record refuses', () => {
        expect(validateAgreementContent(content(agreement({ neighbourCompensation: STRONG_SUBURBS })), { now: NOW_MS })).toMatchObject({ ok: true });
        const unstated = content(agreement({ affected: [{ parcelId: 't3', effect: 'compensation', rights: ['garden'], considerationCents: 1 }] }));
        unstated.rule.neighbourCompensation = STRONG_SUBURBS;
        expect(validateAgreementContent(unstated, { now: NOW_MS })).toMatchObject({ ok: false, section: 'neighbours', error: expect.stringMatching(/stated loss/) });
        const input = content(agreement());
        input.affected[0].parcelId = 't1';
        input.money.lines[0].ownerKey = HOME;
        expect(validateAgreementContent(input, { now: NOW_MS })).toMatchObject({ ok: false, section: 'neighbours' });
        const stranger = content(agreement());
        stranger.money.lines.push({ ownerKey: 'parcel-owner:t9', amountCents: 1 });
        expect(validateAgreementContent(stranger, { now: NOW_MS })).toMatchObject({ ok: false, section: 'money' });
        const twice = content(agreement());
        twice.affected.push({ ...twice.affected[0] });
        expect(validateAgreementContent(twice, { now: NOW_MS })).toMatchObject({ ok: false, section: 'neighbours', error: expect.stringMatching(/listed twice/) });
    });
});

describe('the agreement editor\'s Neighbours tab (pure parts)', () => {
    const Dialog = require('../../frontend/js/agreement-dialog.js');
    const lot = (id, status) => ({ id, status, sky: { status, before: 31.2, after: 22.4 } });

    it('builds the record with the affected parcels and the multiple, deriving each payment', () => {
        const settled = agreement({ neighbourCompensation: STRONG_SUBURBS });
        const state = { id: 'ag-terrace', plan: settled.plan, designs: [{ proposalId: 'design-1', title: 'Raise the terrace', goal: 'building' }],
            fingerprints: new Map([['design-1', LAYOUT_CID]]), land: { inputs: settled.inputs, outputs: settled.outputs },
            approvalConfig: settled.rule.approvalConfig, lens: [MEMBER], currency: 'GBP', city: 'london' };
        const values = { electorate: 'owners', binding: true, allocations: { [settled.outputs[0].hash]: `party:${HOME}` }, settlement: settled.rule.settlement,
            affected: [{ parcelId: 't3', effect: 'compensation', rights: ['garden'], note: null, readings: [], loss: { amountCents: 200000, statedBy: 'sponsor', valuerRef: null }, considerationCents: 0 }],
            neighbourCompensation: STRONG_SUBURBS };
        const built = Dialog.recordFromForm(state, values);
        expect(built.affected[0].considerationCents).toBe(300000);
        expect(built.money.lines).toEqual([{ ownerKey: BEHIND, amountCents: 300000 }]);
        expect(built.rule.neighbourCompensation).toEqual(STRONG_SUBURBS);
        expect(record.validate(built).valid).toBe(true);
        // A community agreement carries none, whatever the form still holds.
        expect(Dialog.recordFromForm(state, { ...values, electorate: 'community' }).affected).toEqual([]);
    });

    it('ticks the plots beyond a guide, disables those already added or among the inputs, and adds snapshots as waivers', () => {
        const html = Dialog.candidatesHtml({ lots: [lot('t2', 'fail'), lot('t4', 'below'), lot('t1', 'fail')] },
            { ticked: new Set(['t2', 't1']), addedIds: new Set(), inputIds: new Set(['t1']) });
        expect(html).toMatch(/data-agreement-neighbour-candidate="t2" checked/);
        expect(html).not.toMatch(/data-agreement-neighbour-candidate="t4" checked/);
        expect(html).toMatch(/data-agreement-neighbour-candidate="t1" disabled/);
        expect(html).toMatch(/Add ticked plots \(1\)/);
        expect(Dialog.affectedEntry({ parcelId: 't2', rights: ['daylight'], readings: [reading] }))
            .toEqual({ parcelId: 't2', effect: 'waiver', rights: ['daylight'], note: null, readings: [reading], loss: null, considerationCents: 0 });
    });

    it('shows a compensation\'s payment as read-only when it follows a stated loss, and its readings in words', () => {
        const derived = Dialog.affectedRowHtml({ parcelId: 't3', effect: 'compensation', rights: ['garden'], readings: [reading], loss: { amountCents: 100000, statedBy: 'valuer', valuerRef: 'R1' }, considerationCents: 150000 },
            { currency: 'GBP', multiple: 15000 });
        expect(derived).toMatch(/data-affected-field="consideration" value="1500" readonly/);
        expect(derived).toMatch(/1\.5× the stated loss/);
        expect(derived).toMatch(/data-affected-right="garden" checked/);
        expect(Dialog.readingText(reading)).toBe('Sky: 31.2% → 22.4% (guide 27%), beyond a guide');
        const waiver = Dialog.affectedRowHtml({ parcelId: 't2', effect: 'waiver', rights: [], readings: [], loss: null, considerationCents: 500000 }, { currency: 'GBP' });
        expect(waiver).not.toMatch(/readonly/);
        expect(Dialog.neighboursHtml({ electorate: 'community' })).toMatch(/owners’ agreement only/);
        expect(Dialog.neighbourCompensationHtml(STRONG_SUBURBS)).toMatch(/value="gb-strong-suburbs@2026-11-27" selected/);
        expect(Dialog.neighbourCompensationHtml(null)).toMatch(/<option value="" selected>/);
    });
});

describe('a lens member and a waiver', () => {
    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });
    const NOW = 1790000000;
    const memberKeypair = Keypair.generate();
    const wallet = () => {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const address = LensCore.base58Encode(new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')));
        return { address, signText: text => LensCore.base58Encode(new Uint8Array(sign(null, Buffer.from(text, 'utf8'), privateKey))) };
    };
    const owner = wallet(), neighbour = wallet();
    const parcel = (parcelId, who) => ({ parcelId, complete: true, areaM2: null, owners: [{ ownerId: who.address, share: '1/1' }] });
    const context = (registryNeighbour = neighbour) => ({
        subject: { cadastreParcelIds: ['t1'], waiverParcelIds: ['t2'], lens: [memberKeypair.publicKey.toBase58()],
            approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' },
                rights: { schema: 'parcel-rights/v1', source: { provider: 'lens-devnet-owners' }, parcels: [parcel('t1', owner), parcel('t2', neighbour)] } } },
        registry: fileRegistry({ schema: 'lens-rights-registry/v1', parcels: [parcel('t1', owner), parcel('t2', registryNeighbour)].map(({ complete, ...row }) => row),
            signers: [{ ownerId: owner.address, wallet: owner.address }, { ownerId: registryNeighbour.address, wallet: registryNeighbour.address }] })
    });

    it('attests the waiving neighbour\'s authority, and refuses a snapshot whose neighbour owners differ from its registry', async () => {
        const { subject, registry } = context();
        const attester = createApprovalAttester({ keypair: memberKeypair, registry, clock: { nowSeconds: () => NOW } });
        const challenged = attester.issueChallenge({ wallet: neighbour.address, contextHash: approval.contextHash(subject) });
        const facts = await attester.attestAuthority({ wallet: neighbour.address, challenge: challenged.challenge, signature: neighbour.signText(challenged.message), ...subject });
        expect(facts.authority.map(fact => fact.ownerId)).toEqual([neighbour.address]);
        const other = context(wallet());
        const strict = createApprovalAttester({ keypair: memberKeypair, registry: other.registry, clock: { nowSeconds: () => NOW } });
        await expect(strict.attestRights(subject)).rejects.toMatchObject({ code: 'rights_mismatch' });
    });
});
