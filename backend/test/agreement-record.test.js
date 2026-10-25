// Unit tests for frontend/js/agreement-record.js: the agreement record's output hash, canonical
// form and validation codes, the per-party ledger, the default rights snapshot and the subject the
// approval engine counts, the published agreement/v1 object with its CID (M2), and what a proposed
// and minted record keeps on this device: its sponsor and its chain account (M3).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const record = require('../../frontend/js/agreement-record.js');
const approval = require('../../frontend/js/proposals/approval.js');
const Cid = require('../../frontend/js/cid.js');
const PlanRecord = require('../../frontend/js/plan-record.js');

const sha256 = text => createHash('sha256').update(text).digest('hex');
// The designs' CIDs as a published agreement links them, and the lens member that verifies owners.
const LAYOUT_CID = Cid.cidOfObject({ schema: 'design/v1', goal: 'parcel-layout', title: 'Lay out block seven' });
const ROAD_CID = Cid.cidOfObject({ schema: 'design/v1', goal: 'road', title: 'Draw road' });
const MEMBER = 'lens-member-1';
const PLAN_CONTENT = PlanRecord.create('Block seven', [LAYOUT_CID, ROAD_CID], { at: '45.8,15.96,16', mode: '2d' });
const PLAN = { cid: Cid.cidOfObject(PLAN_CONTENT), content: PLAN_CONTENT };
// Rectangles in units of 1e-3 degree from the test origin.
function rect(x0, y0, x1, y1) {
    const LON = 15.96, LAT = 45.8;
    const at = (x, y) => [LON + x * 1e-3, LAT + y * 1e-3];
    return { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}
const ana = (share = 1) => ({ ownerKey: 'agent-ana', displayName: 'Ana', share });
const boris = share => ({ ownerKey: 'agent-boris', displayName: 'Boris', share });
const cyril = share => ({ ownerKey: 'agent-cyril', displayName: 'Cyril', share });
const output = (pieceId, geometry, areaM2, fromParcelIds, holders, extra = {}) => ({
    hash: record.outputHash(geometry), pieceId, areaM2, fromParcelIds, producedBy: 'layout-1', role: 'plot', holders, geometry, ...extra
});

// Two input parcels (k9 of Ana; k10 of Boris 1/4 and Cyril 3/4) and three outputs: a plot Ana
// keeps, a plot the agreement gives to Cyril, and a road body that goes to the public.
function fixture() {
    const inputs = {
        parcels: [
            { parcelId: 'k9', areaM2: 1000, holders: [ana()] },
            { parcelId: 'k10', areaM2: 800, holders: [boris(0.25), cyril(0.75)] }
        ],
        openGroundM2: 0
    };
    const outputs = [
        output('k9-p1', rect(0, 0, 1, 2), 700, ['k9'], [ana()]),
        output('k9-p2', rect(1, 0, 3, 2), 700, ['k9', 'k10'], [ana(0.6), boris(0.1), cyril(0.3)]),
        output('road-1#1', rect(0, 2, 5, 2.2), 400, ['k9', 'k10'], [], { producedBy: 'road-1', role: 'corridor' })
    ];
    return {
        schema: 'agreement/v1', id: 'ag-test', title: 'Block seven', city: 'test-city',
        createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z',
        plan: { cid: PLAN.cid, content: JSON.parse(JSON.stringify(PLAN_CONTENT)) },
        designs: [
            { proposalId: 'layout-1', title: 'Lay out block seven', goal: 'parcel-layout', cid: LAYOUT_CID },
            { proposalId: 'road-1', title: 'Draw road', goal: 'road', cid: ROAD_CID }
        ],
        inputs,
        outputs,
        allocations: [
            { output: outputs[1].hash, to: { kind: 'party', ownerKey: 'agent-cyril' } },
            { output: outputs[2].hash, to: { kind: 'public' } }
        ],
        money: {
            currency: 'EUR',
            lines: [
                { ownerKey: 'agent-ana', amountCents: 30000 },
                { ownerKey: 'agent-boris', amountCents: 20000 },
                { ownerKey: 'agent-cyril', amountCents: -10000 }
            ]
        },
        rule: {
            electorate: 'owners', binding: true, lens: [MEMBER],
            approvalConfig: { schema: 'proposal-approval/v1', rights: record.rightsFromInputs(inputs), policy: { type: 'unanimous' } }
        },
        deadline: null
    };
}
const codes = list => list.map(row => row.code);
const thrownCode = fn => { try { fn(); } catch (error) { return error.code; } return null; };

describe('outputHash', () => {
    it('is the SHA-256 of the type and the coordinates rounded to 7 decimals', () => {
        const geometry = { type: 'Polygon', coordinates: [[[15.96000004, 45.8], [15.961, 45.8], [15.961, 45.80100006], [15.96000004, 45.8]]] };
        const rounded = [[[15.96, 45.8], [15.961, 45.8], [15.961, 45.8010001], [15.96, 45.8]]];
        expect(record.outputHash(geometry)).toBe(`piece1-sha256:${sha256(`{"coordinates":${JSON.stringify(rounded)},"type":"Polygon"}`)}`);
    });

    it('gives a Feature and its geometry, or coordinates equal to 7 decimals, the same hash', () => {
        const plain = record.outputHash(rect(0, 0, 1, 1));
        expect(record.outputHash({ type: 'Feature', properties: { parcelId: 'x' }, geometry: rect(0, 0, 1, 1) })).toBe(plain);
        const jittered = rect(0, 0, 1, 1);
        jittered.coordinates[0][2] = [jittered.coordinates[0][2][0] + 3e-9, jittered.coordinates[0][2][1] - 3e-9];
        jittered.bbox = [0, 0, 1, 1];
        expect(record.outputHash(jittered)).toBe(plain);
    });

    it('changes when a vertex moves or the geometry type changes', () => {
        const plain = record.outputHash(rect(0, 0, 1, 1));
        const moved = rect(0, 0, 1, 1);
        moved.coordinates[0][2] = [moved.coordinates[0][2][0] + 2e-7, moved.coordinates[0][2][1]];
        expect(record.outputHash(moved)).not.toBe(plain);
        expect(record.outputHash({ type: 'MultiPolygon', coordinates: [rect(0, 0, 1, 1).coordinates] })).not.toBe(plain);
    });

    it('refuses geometry that is not a finite polygon', () => {
        expect(() => record.outputHash({ type: 'Point', coordinates: [15.96, 45.8] })).toThrow(/Polygon or MultiPolygon/);
        expect(() => record.outputHash(null)).toThrow(/Polygon or MultiPolygon/);
        const infinite = rect(0, 0, 1, 1);
        infinite.coordinates[0][1] = [Infinity, 45.8];
        expect(() => record.outputHash(infinite)).toThrow(/finite/);
    });
});

describe('newId', () => {
    it('makes distinct local keys with the agreement prefix', () => {
        const ids = new Set(Array.from({ length: 50 }, () => record.newId()));
        expect(ids.size).toBe(50);
        ids.forEach(id => expect(id).toMatch(/^ag-[0-9a-f]{32}$/));
    });
});

describe('normalize', () => {
    it('keeps a valid record and is idempotent', () => {
        const once = record.normalize(fixture());
        expect(once.schema).toBe('agreement/v1');
        expect(once.designs.map(design => design.proposalId)).toEqual(['layout-1', 'road-1']);
        expect(once.plan).toEqual(PLAN);
        expect(once.allocations).toHaveLength(2);
        expect(record.normalize(once)).toEqual(once);
    });

    it('stores the canonical form: no holders or zero-cash lines, trimmed text, ISO dates, rounded geometry', () => {
        const raw = fixture();
        raw.title = '  ';
        raw.deadline = '2026-12-31';
        raw.outputs[0].geometry.coordinates[0][1] = [raw.outputs[0].geometry.coordinates[0][1][0] + 4e-9, raw.outputs[0].geometry.coordinates[0][1][1]];
        raw.outputs[0].hash = record.outputHash(raw.outputs[0].geometry);
        raw.outputs[0].holders = [{ ownerKey: ' agent-ana ', share: 1 }];
        raw.allocations.push({ output: raw.outputs[0].hash, to: { kind: 'holders' } });
        raw.money.lines.push({ ownerKey: 'agent-dora', amountCents: 0 });
        raw.money.currency = 'eur';
        const result = record.normalize(raw);
        expect(result.title).toBeNull();
        expect(result.deadline).toBe('2026-12-31T00:00:00.000Z');
        expect(result.outputs[0].geometry).toEqual(rect(0, 0, 1, 2));
        expect(result.outputs[0].holders).toEqual([{ ownerKey: 'agent-ana', displayName: 'agent-ana', share: 1 }]);
        expect(result.allocations.map(line => line.to.kind)).toEqual(['party', 'public']);
        expect(result.money).toEqual({ currency: 'EUR', lines: fixture().money.lines });
    });

    it('throws invalid-agreement for a record whose shape is unusable', () => {
        const broken = [
            raw => { raw.schema = 'agreement/v0'; },
            raw => { delete raw.id; },
            raw => { raw.designs.push({ proposalId: 'road-1' }); },
            raw => { raw.inputs.parcels[1].holders[0].share = 1.5; },
            raw => { raw.outputs[0].geometry.coordinates[0][1][0] += 1e-5; },
            raw => { raw.outputs[1].role = 'garden'; },
            raw => { raw.allocations.push({ output: raw.outputs[1].hash, to: { kind: 'public' } }); },
            raw => { raw.allocations[0].to = { kind: 'auction' }; },
            raw => { raw.money.lines.push({ ownerKey: 'agent-ana', amountCents: 5 }); },
            raw => { delete raw.rule; },
            raw => { raw.plan.cid = LAYOUT_CID; },
            raw => { raw.plan.content.designCids = [LAYOUT_CID]; },
            raw => { raw.createdAt = 'yesterday'; }
        ];
        broken.forEach(breakIt => {
            const raw = fixture();
            breakIt(raw);
            expect(thrownCode(() => record.normalize(raw))).toBe('invalid-agreement');
        });
        const mismatched = fixture();
        mismatched.outputs[0].geometry.coordinates[0][1][0] += 1e-5;
        expect(() => record.normalize(mismatched)).toThrow(/does not match its geometry/);
    });

    it('accepts a missing plan only on a draft and checks its CID and immutable content', () => {
        const draft = fixture();
        draft.plan = null;
        expect(record.normalize(draft).plan).toBeNull();
        for (const plan of [{ cid: 'c2-nope', content: PLAN_CONTENT },
            { cid: PLAN.cid, content: { ...PLAN_CONTENT, title: 'Changed' } }]) {
            expect(thrownCode(() => record.normalize({ ...fixture(), plan } ) )).toBe('invalid-agreement');
        }
    });
});

describe('validate', () => {
    it('accepts a complete agreement', () => {
        expect(record.validate(fixture())).toEqual({ valid: true, errors: [], warnings: [] });
    });

    it('needs designs, and with designOf/isApplied every one applied', () => {
        const empty = record.validate({ ...fixture(), designs: [] });
        expect(empty.valid).toBe(false);
        expect(empty.errors).toEqual([expect.objectContaining({ code: 'no-designs', section: 'designs' })]);

        const options = {
            designOf: id => id === 'road-1' ? null : { proposalId: id, applied: false },
            isApplied: design => design.applied
        };
        const result = record.validate(fixture(), options);
        expect(result.errors.map(error => [error.code, error.section, error.proposalId])).toEqual([
            ['design-not-applied', 'designs', 'layout-1'],
            ['design-not-applied', 'designs', 'road-1']
        ]);
        expect(record.validate(fixture(), { designOf: id => ({ proposalId: id }), isApplied: () => true }).valid).toBe(true);
    });

    it('needs land, and warns about open ground', () => {
        const bare = { ...fixture(), inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'EUR', lines: [] } };
        const result = record.validate(bare);
        expect(result.errors).toEqual([expect.objectContaining({ code: 'no-inputs', section: 'land' })]);
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'rule-not-ready', section: 'rule', reason: 'missing-parcels' })]);

        const open = record.validate({ ...bare, inputs: { parcels: [], openGroundM2: 250 } });
        expect(codes(open.errors)).toEqual([]);
        expect(codes(open.warnings)).toEqual(['open-ground', 'rule-not-ready']);
        expect(open.warnings[0].section).toBe('land');
    });

    it('checks every allocation against the outputs, the land\'s parties and the joint shares', () => {
        const raw = fixture();
        const [first, second] = raw.outputs;
        raw.allocations = [
            { output: `piece1-sha256:${'0'.repeat(64)}`, to: { kind: 'public' } },
            { output: first.hash, to: { kind: 'party', ownerKey: 'agent-zoran' } },
            { output: second.hash, to: { kind: 'joint', shares: [{ ownerKey: 'agent-ana', share: 0.5 }, { ownerKey: 'agent-zoran', share: 0.5 }] } }
        ];
        const result = record.validate(raw);
        expect(result.errors.map(error => [error.code, error.section, error.ownerKey])).toEqual([
            ['allocation-unknown-output', 'allocation', undefined],
            ['allocation-unknown-party', 'allocation', 'agent-zoran'],
            ['allocation-unknown-party', 'allocation', 'agent-zoran']
        ]);

        const invalidShares = [
            [{ ownerKey: 'agent-ana', share: 0.5 }, { ownerKey: 'agent-cyril', share: 0.4 }],
            [{ ownerKey: 'agent-ana', share: 0.5 }, { ownerKey: 'agent-ana', share: 0.5 }],
            [{ ownerKey: 'agent-ana', share: '0.5' }, { ownerKey: 'agent-cyril', share: 0.5 }],
            []
        ];
        invalidShares.forEach(shares => {
            const joint = fixture();
            joint.allocations[0] = { output: joint.outputs[1].hash, to: { kind: 'joint', shares } };
            expect(codes(record.validate(joint).errors)).toEqual(['allocation-shares-invalid']);
        });
        const valid = fixture();
        valid.allocations[0] = { output: valid.outputs[1].hash, to: { kind: 'joint', shares: [{ ownerKey: 'agent-ana', share: 1 / 3 }, { ownerKey: 'agent-cyril', share: 2 / 3 }] } };
        expect(record.validate(valid).valid).toBe(true);
    });

    it('checks the currency, the parties and the amounts of the cash lines', () => {
        const raw = fixture();
        // A chain token is no city's money; any ISO 4217 currency (the city's) is.
        raw.money = {
            currency: 'SOL',
            lines: [{ ownerKey: 'agent-zoran', amountCents: 500 }, { ownerKey: 'agent-ana', amountCents: 12.5 }, { ownerKey: 'agent-boris', amountCents: '100' }]
        };
        const result = record.validate(raw);
        expect(result.errors.map(error => [error.code, error.section, error.ownerKey])).toEqual([
            ['money-currency', 'money', undefined],
            ['money-party-unknown', 'money', 'agent-zoran'],
            ['money-amount-invalid', 'money', 'agent-ana'],
            ['money-amount-invalid', 'money', 'agent-boris']
        ]);
    });

    it('checks the decision rule with the approval engine', () => {
        const badPolicy = fixture();
        badPolicy.rule.approvalConfig.policy = { type: 'bogus' };
        const invalid = record.validate(badPolicy);
        expect(invalid.errors).toEqual([expect.objectContaining({ code: 'rule-invalid', section: 'rule', message: 'Unknown approval policy.' })]);

        const nobody = fixture();
        nobody.rule.electorate = 'everyone';
        expect(codes(record.validate(nobody).errors)).toEqual(['rule-invalid']);

        const communityWithConfig = fixture();
        communityWithConfig.allocations = [];
        communityWithConfig.money.lines = [];
        communityWithConfig.rule = { ...communityWithConfig.rule, electorate: 'community', binding: false };
        expect(codes(record.validate(communityWithConfig).errors)).toEqual(['rule-invalid']);

        const bindingVote = fixture();
        bindingVote.allocations = [];
        bindingVote.money.lines = [];
        bindingVote.rule = { electorate: 'community', binding: true, approvalConfig: null, lens: [] };
        expect(record.validate(bindingVote).errors).toEqual([expect.objectContaining({ code: 'rule-community-binding', section: 'rule' })]);

        const vote = fixture();
        vote.allocations = [];
        vote.money.lines = [];
        vote.rule = { electorate: 'community', binding: false, approvalConfig: null, lens: [] };
        expect(record.validate(vote)).toEqual({ valid: true, errors: [], warnings: [] });
    });

    it('warns with the engine\'s reason when the owners cannot be counted yet', () => {
        const noRights = fixture();
        noRights.rule.approvalConfig = null;
        const missing = record.validate(noRights);
        expect(missing.valid).toBe(true);
        expect(missing.warnings).toEqual([expect.objectContaining({ code: 'rule-not-ready', section: 'rule', reason: 'missing-rights' })]);

        const partial = fixture();
        partial.rule.approvalConfig.rights.parcels[1] = { parcelId: 'k10', complete: false, areaM2: 800, owners: [] };
        expect(record.validate(partial).warnings.map(warning => warning.reason)).toEqual(['incomplete-rights']);
    });

    it('needs a readable deadline', () => {
        const raw = fixture();
        raw.deadline = 'next friday';
        expect(record.validate(raw).errors).toEqual([expect.objectContaining({ code: 'deadline-invalid', section: 'details' })]);
        expect(record.validate({ ...fixture(), deadline: '2026-12-31T12:00:00Z' }).valid).toBe(true);
    });

    it('throws like normalize for a malformed record', () => {
        expect(thrownCode(() => record.validate({ ...fixture(), outputs: null }))).toBe('invalid-agreement');
    });
});

describe('ledger', () => {
    it('sums land in and out per party, the public share and a balanced money schedule', () => {
        const result = record.ledger(fixture());
        expect(result.parties.map(party => party.displayName)).toEqual(['Ana', 'Boris', 'Cyril']);
        const [anaRow, borisRow, cyrilRow] = result.parties;
        expect(anaRow).toMatchObject({ ownerKey: 'agent-ana', contributedM2: 1000, assignedM2: 700, changeM2: -300, cashCents: 30000, areaUnknown: false });
        expect(borisRow).toMatchObject({ ownerKey: 'agent-boris', contributedM2: 200, assignedM2: 0, changeM2: -200, cashCents: 20000 });
        expect(cyrilRow).toMatchObject({ ownerKey: 'agent-cyril', contributedM2: 600, assignedM2: 700, changeM2: 100, cashCents: -10000 });
        expect(result.publicM2).toBe(400);
        expect(result.money).toEqual({
            currency: 'EUR',
            lines: [
                { party: 'owner', ownerKey: 'agent-ana', amountCents: 30000 },
                { party: 'owner', ownerKey: 'agent-boris', amountCents: 20000 },
                { party: 'owner', ownerKey: 'agent-cyril', amountCents: -10000 },
                { party: 'sponsor', amountCents: -40000 }
            ],
            payOutCents: 50000, payInCents: 10000, sponsorCents: -40000, sponsorFundingCents: 40000, balanced: true
        });
    });

    it('splits a joint allocation by its shares and keeps carried-over holdings by theirs', () => {
        const raw = fixture();
        raw.allocations = [{ output: raw.outputs[0].hash, to: { kind: 'joint', shares: [{ ownerKey: 'agent-ana', share: 1 / 3 }, { ownerKey: 'agent-cyril', share: 2 / 3 }] } }];
        const byKey = Object.fromEntries(record.ledger(raw).parties.map(party => [party.ownerKey, party]));
        expect(byKey['agent-ana'].assignedM2).toBeCloseTo(700 / 3 + 700 * 0.6, 9);
        expect(byKey['agent-boris'].assignedM2).toBeCloseTo(700 * 0.1, 9);
        expect(byKey['agent-cyril'].assignedM2).toBeCloseTo(1400 / 3 + 700 * 0.3, 9);
        expect(record.ledger(raw).publicM2).toBe(0);
    });

    it('flags parties whose input area is unknown instead of counting it as zero land', () => {
        const raw = fixture();
        raw.inputs.parcels[1].areaM2 = null;
        const byKey = Object.fromEntries(record.ledger(raw).parties.map(party => [party.ownerKey, party]));
        expect(byKey['agent-ana']).toMatchObject({ contributedM2: 1000, areaUnknown: false });
        expect(byKey['agent-boris']).toMatchObject({ contributedM2: 0, areaUnknown: true });
        expect(byKey['agent-cyril']).toMatchObject({ contributedM2: 0, areaUnknown: true });
    });

    it('lists every party it meets, named by the first holder entry that names it', () => {
        const raw = fixture();
        raw.outputs[0].holders = [{ ownerKey: 'agent-ana', displayName: 'Ana (plot)', share: 1 }];
        raw.outputs[1].holders[0].displayName = 'Ana (plot)';
        raw.allocations[0] = { output: raw.outputs[1].hash, to: { kind: 'party', ownerKey: 'agent-emil' } };
        raw.money.lines.push({ ownerKey: 'agent-dora', amountCents: 500 });
        const parties = record.ledger(raw).parties;
        expect(parties.map(party => [party.ownerKey, party.displayName])).toEqual([
            ['agent-dora', 'agent-dora'], ['agent-emil', 'agent-emil'], ['agent-ana', 'Ana'], ['agent-boris', 'Boris'], ['agent-cyril', 'Cyril']
        ]);
        expect(parties[1]).toMatchObject({ contributedM2: 0, assignedM2: 700, changeM2: 700 });
        expect(parties[0]).toMatchObject({ cashCents: 500, assignedM2: 0 });
    });

    it('refuses joint shares that do not parse', () => {
        const raw = fixture();
        raw.allocations = [{ output: raw.outputs[0].hash, to: { kind: 'joint', shares: [{ ownerKey: 'agent-ana', share: 0.5 }] } }];
        expect(() => record.ledger(raw)).toThrow(/sum to 100/);
        expect(thrownCode(() => record.ledger(raw))).toBe('invalid-agreement');
    });
});

describe('rightsFromInputs', () => {
    it('writes the local holders as parcel-rights/v1 in basis points that the engine accepts', () => {
        const rights = record.rightsFromInputs({
            parcels: [
                { parcelId: 'k9', areaM2: 1000, holders: [boris(1 / 3), cyril(2 / 3)] },
                { parcelId: 'k10', areaM2: null, holders: [] }
            ],
            openGroundM2: 0
        });
        expect(rights).toEqual({
            schema: 'parcel-rights/v1',
            source: { provider: 'local-owners' },
            parcels: [
                { parcelId: 'k9', complete: true, areaM2: 1000, owners: [{ ownerId: 'agent-boris', share: '3333/10000' }, { ownerId: 'agent-cyril', share: '6667/10000' }] },
                { parcelId: 'k10', complete: false, areaM2: null, owners: [] }
            ]
        });
        const normalized = approval.normalizeRights(rights);
        expect(normalized.parcels.find(parcel => parcel.parcelId === 'k9').owners)
            .toEqual([{ ownerId: 'agent-boris', share: '3333/10000' }, { ownerId: 'agent-cyril', share: '6667/10000' }]);
    });

    it('gives the last holder the remainder, so a complete list sums to exactly 1/1', () => {
        const rights = record.rightsFromInputs({ parcels: [{ parcelId: 'k9', areaM2: 30, holders: [ana(1 / 3), boris(1 / 3), cyril(1 / 3)] }] });
        const owners = rights.parcels[0].owners;
        expect(owners.map(owner => owner.share)).toEqual(['3333/10000', '3333/10000', '3334/10000']);
        expect(owners.reduce((sum, owner) => sum + Number(owner.share.split('/')[0]), 0)).toBe(10000);
        expect(() => approval.normalizeRights(rights)).not.toThrow();
    });

    it('makes a snapshot the engine can count once every input has holders', () => {
        const subject = record.approvalSubject(fixture());
        expect(subject.cadastreParcelIds).toEqual(['k9', 'k10']);
        expect(subject.lens).toEqual([MEMBER]);
        const state = approval.inspect(subject);
        expect(state.ready).toBe(true);
        expect(state.ownerIds).toEqual(['agent-ana', 'agent-boris', 'agent-cyril']);

        const unowned = fixture();
        unowned.inputs.parcels[1].holders = [];
        unowned.rule.approvalConfig.rights = record.rightsFromInputs(unowned.inputs);
        expect(approval.inspect(record.approvalSubject(unowned))).toMatchObject({ ready: false, reason: 'incomplete-rights', missingParcelIds: ['k10'] });
    });
});

describe('stableStringify', () => {
    it('sorts keys at every depth and refuses numbers that are not finite', () => {
        expect(record.stableStringify({ b: [{ d: 1, c: 2 }], a: null, skip: undefined })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
        expect(() => record.stableStringify({ a: NaN })).toThrow(/finite/);
    });
});

describe('the lens of an owners rule', () => {
    it('warns when owners decide and no lens member is named, since no decision could be verified', () => {
        const raw = fixture();
        raw.rule.lens = [];
        const result = record.validate(raw);
        expect(result.valid).toBe(true);
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'rule-lens-missing', section: 'rule' })]);
        delete raw.rule.lens;
        expect(codes(record.validate(raw).warnings)).toEqual(['rule-lens-missing']);
        const vote = fixture();
        vote.allocations = [];
        vote.money.lines = [];
        vote.rule = { electorate: 'community', binding: false, approvalConfig: null, lens: [] };
        expect(record.validate(vote).warnings).toEqual([]);
    });
});

describe('normalize (published records)', () => {
    const PUBLISHED = { cid: Cid.cidOfObject({ schema: 'agreement/v1', title: 'Block seven' }), publishedAt: '2026-10-21T12:00:00Z', apiBase: 'https://api.example.test' };

    it('keeps each design by its CID and drops anything else the entry carries', () => {
        const raw = fixture();
        raw.designs[0].fingerprint = 'c2-layout';
        expect(record.normalize(raw).designs).toEqual([
            { proposalId: 'layout-1', title: 'Lay out block seven', goal: 'parcel-layout', cid: LAYOUT_CID },
            { proposalId: 'road-1', title: 'Draw road', goal: 'road', cid: ROAD_CID }
        ]);
        delete raw.designs[1].cid;
        expect(record.normalize(raw).designs[1].cid).toBeNull();
    });

    it('keeps where a proposed agreement went, and refuses a mark without a CID or an API', () => {
        expect(record.normalize(fixture()).published).toBeNull();
        expect(record.normalize({ ...fixture(), published: PUBLISHED }).published)
            .toEqual({ cid: PUBLISHED.cid, publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test', sponsor: null });
        [{ ...PUBLISHED, cid: 'c2-abc' }, { ...PUBLISHED, apiBase: ' ' }, { ...PUBLISHED, publishedAt: 'noon' }, 'bafy']
            .forEach(published => expect(thrownCode(() => record.normalize({ ...fixture(), published }))).toBe('invalid-agreement'));
    });

    it('keeps the wallet that sponsors a proposed agreement (M3 mints at its address), trimmed, or null', () => {
        const SPONSOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
        expect(record.normalize({ ...fixture(), published: { ...PUBLISHED, sponsor: ` ${SPONSOR} ` } }).published.sponsor).toBe(SPONSOR);
        for (const sponsor of [null, undefined, '', '   ', 42]) {
            expect(record.normalize({ ...fixture(), published: { ...PUBLISHED, sponsor } }).published.sponsor, String(sponsor)).toBeNull();
        }
    });

    it('keeps the chain account of a minted agreement as given, a copy, and refuses one that is not an object', () => {
        expect(record.normalize(fixture()).onchain).toBeNull();
        expect(record.normalize({ ...fixture(), onchain: null }).onchain).toBeNull();
        // The index's pointer carries more than the browser's own; both are kept whole.
        const onchain = { chain: 'solana', cluster: 'devnet', account: 'Acct1111111111111111111111111111111111111111', signature: 'sig-1',
            status: 'active', decision: 'pending', escrowLamports: '0' };
        const raw = { ...fixture(), published: PUBLISHED, onchain };
        const kept = record.normalize(raw).onchain;
        expect(kept).toEqual(onchain);
        expect(kept).not.toBe(onchain);
        kept.status = 'executed';
        expect(raw.onchain.status).toBe('active');
        for (const bad of ['Acct111', ['solana'], 7, true]) {
            expect(thrownCode(() => record.normalize({ ...fixture(), onchain: bad })), JSON.stringify(bad)).toBe('invalid-agreement');
        }
    });

    it('keeps an output known by its hash alone, as an agreement read from its published object has them', () => {
        const raw = fixture();
        const hash = raw.outputs[0].hash;
        raw.outputs[0] = { ...raw.outputs[0], geometry: null };
        const result = record.normalize(raw);
        expect(result.outputs[0]).toMatchObject({ hash, geometry: null, pieceId: 'k9-p1' });
        expect(record.validate(raw).valid).toBe(true);
        raw.outputs[0].hash = 'piece1-sha256:abc';
        expect(thrownCode(() => record.normalize(raw))).toBe('invalid-agreement');
        raw.outputs[0].hash = raw.outputs[1].hash;
        expect(() => record.normalize(raw)).toThrow(/geometry of another output/);
    });
});

describe('published', () => {
    const SPONSOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const local = () => ({
        ...fixture(),
        author: ' Ana ', sponsor: SPONSOR,
        published: { cid: Cid.cidOfObject({ any: 'earlier' }), publishedAt: '2026-10-21T12:00:00Z', apiBase: 'https://api.example.test' }
    });

    it('is the agreement/v1 object: one exact plan CID, inputs with holders, outputs by hash without geometry', () => {
        const raw = local();
        raw.inputs.parcels[0].parcelSourceId = 'zagreb-dgu';
        const object = record.published(raw);
        expect(Object.keys(object).sort()).toEqual(['allocations', 'author', 'city', 'consultation', 'createdAt', 'deadline', 'inputs',
            'money', 'outputs', 'planCid', 'rule', 'schema', 'sponsor', 'title']);
        expect(object).toMatchObject({ schema: 'agreement/v1', title: 'Block seven', author: 'Ana', sponsor: SPONSOR, city: 'test-city',
            createdAt: '2026-10-21T10:00:00.000Z', deadline: null });
        expect(object.planCid).toBe(PLAN.cid);
        expect(object).not.toHaveProperty('designs');
        expect(object.inputs).toEqual({
            parcels: [
                { parcelId: 'k9', parcelSourceId: 'zagreb-dgu', areaM2: 1000, holders: [ana()] },
                { parcelId: 'k10', areaM2: 800, holders: [boris(0.25), cyril(0.75)] }
            ],
            openGroundM2: 0
        });
        expect(object.outputs).toEqual(raw.outputs.map(output => ({
            hash: output.hash, areaM2: output.areaM2, fromParcelIds: output.fromParcelIds, role: output.role,
            producedBy: output.producedBy === 'road-1' ? ROAD_CID : LAYOUT_CID
        })));
        expect(object.allocations).toEqual(fixture().allocations);
        expect(object.money).toEqual(fixture().money);
        expect(object.rule).toEqual(record.normalize(fixture()).rule);
        expect(JSON.stringify(object)).not.toMatch(/ag-test|updatedAt|pieceId|coordinates|apiBase/);
    });

    it('names an output from a design outside the agreement by its hash alone (producedBy null)', () => {
        const raw = local();
        raw.outputs[0].producedBy = 'road-9';
        expect(record.published(raw).outputs[0].producedBy).toBeNull();
        expect(record.published(raw, id => ({ 'layout-1': LAYOUT_CID, 'road-1': ROAD_CID }[id] || null)).outputs[0].producedBy).toBeNull();
    });

    it('takes the designs\' CIDs from designCidOf when given, and refuses a design without one', () => {
        const fresh = { 'layout-1': Cid.cidOfObject({ edited: 'layout' }), 'road-1': ROAD_CID };
        const revised = local();
        revised.plan = { ...PLAN, content: PlanRecord.create('Block seven', Object.values(fresh), PLAN_CONTENT.view) };
        revised.plan.cid = Cid.cidOfObject(revised.plan.content);
        expect(record.published(revised, id => fresh[id]).planCid).toBe(revised.plan.cid);
        const unnamed = local();
        unnamed.designs[1].cid = null;
        expect(thrownCode(() => record.published(unnamed))).toBe('invalid-agreement');
        expect(() => record.published(unnamed)).toThrow(/road-1 has no CID/);
        expect(thrownCode(() => record.published(local(), () => 'c2-road'))).toBe('invalid-agreement');
    });

    it('has null author and sponsor when the object names none', () => {
        const object = record.published(fixture());
        expect(object.author).toBeNull();
        expect(object.sponsor).toBeNull();
    });

    it('requires the selected plan to contain exactly the published design CIDs', () => {
        for (const cids of [[LAYOUT_CID], [LAYOUT_CID, ROAD_CID, Cid.cidOfObject({ other: true })]]) {
            const raw = local();
            raw.plan = { content: PlanRecord.create('Block seven', cids, PLAN_CONTENT.view) };
            raw.plan.cid = Cid.cidOfObject(raw.plan.content);
            expect(() => record.published(raw)).toThrow(/differ from the referenced plan/);
        }
    });

    it('lets separate agreements reuse the same immutable plan revision', () => {
        const next = fixture();
        next.id = 'ag-another';
        next.title = 'A separate agreement';
        expect(record.published(next).planCid).toBe(record.published(fixture()).planCid);
        expect(record.publishedCid(next)).not.toBe(record.publishedCid(fixture()));
    });
});

describe('publishedCid', () => {
    it('is the CID of the published object, unmoved by what stays on this device', () => {
        const cid = record.publishedCid(fixture());
        expect(cid).toBe(Cid.cidOfObject(record.published(fixture())));
        expect(Cid.isCid(cid)).toBe(true);
        const relabelled = fixture();
        // Where it went and where it is minted stay on this device: neither is part of the object.
        Object.assign(relabelled, { id: 'ag-other', updatedAt: '2026-10-22T08:00:00.000Z',
            published: { cid, publishedAt: '2026-10-22T08:00:00.000Z', apiBase: 'https://api.example.test', sponsor: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' },
            onchain: { chain: 'solana', cluster: 'devnet', account: 'Acct1111111111111111111111111111111111111111' } });
        relabelled.outputs[0].pieceId = 'k9-renamed';
        relabelled.outputs[0].holders = [cyril(1)];
        expect(record.publishedCid(relabelled)).toBe(cid);
    });

    it('moves with the designs, land, allocations, money, rule, deadline and sponsor', () => {
        const cid = record.publishedCid(fixture());
        const edits = [
            raw => { raw.plan = { content: PlanRecord.create('A revised plan', [LAYOUT_CID, ROAD_CID], PLAN_CONTENT.view) }; raw.plan.cid = Cid.cidOfObject(raw.plan.content); },
            raw => { raw.designs[0].cid = Cid.cidOfObject({ another: 'layout' }); raw.plan = { content: PlanRecord.create('A revised plan', [raw.designs[0].cid, ROAD_CID], PLAN_CONTENT.view) }; raw.plan.cid = Cid.cidOfObject(raw.plan.content); },
            raw => { raw.inputs.parcels[0].holders = [cyril(1)]; },
            raw => { raw.allocations.pop(); },
            raw => { raw.money.lines[0].amountCents += 1; },
            raw => { raw.rule.binding = false; },
            raw => { raw.rule.lens = ['lens-member-2']; },
            raw => { raw.deadline = '2026-12-31T00:00:00.000Z'; },
            raw => { raw.sponsor = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'; },
            raw => { raw.title = 'Block eight'; }
        ];
        edits.forEach(edit => {
            const raw = fixture();
            edit(raw);
            expect(record.publishedCid(raw), edit.toString()).not.toBe(cid);
        });
    });
});


describe('consultation metadata', () => {
    function community(consultation = null) {
        return { ...fixture(), allocations: [], money: { currency: 'EUR', lines: [] },
            rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, consultation };
    }

    it('canonicalizes website organisers and participation URLs in the local and published record', () => {
        const raw = community({ organiser: ' https://NGO.example/branch ', participationUrl: ' https://NGO.example/join ' });
        const expected = { organiser: 'did:web:ngo.example:branch', participationUrl: 'https://ngo.example/join' };
        expect(record.normalize(raw).consultation).toEqual(expected);
        expect(record.published(raw).consultation).toEqual(expected);
        expect(record.validate(raw).valid).toBe(true);
        expect(record.normalize(community()).consultation).toEqual({ organiser: null, participationUrl: null });
    });

    it('commits organiser and participation information to the agreement CID', () => {
        const raw = community({ organiser: 'did:web:ngo.example', participationUrl: 'https://ngo.example/join' });
        const original = record.publishedCid(raw);
        expect(record.publishedCid({ ...raw, consultation: { ...raw.consultation, organiser: 'did:web:other.example' } })).not.toBe(original);
        expect(record.publishedCid({ ...raw, consultation: { ...raw.consultation, participationUrl: 'https://ngo.example/other' } })).not.toBe(original);
    });

    it('refuses consultation metadata on owners while normalizing absent metadata to null', () => {
        expect(record.normalize(fixture()).consultation).toBeNull();
        expect(record.normalize({ ...fixture(), consultation: null }).consultation).toBeNull();
        expect(() => record.normalize({ ...fixture(), consultation: { organiser: 'did:web:ngo.example' } })).toThrow(/Only a community/);
    });

    it('rejects crafted community allocations and cash, even zero or carried-holder lines', () => {
        const base = community();
        const samples = [
            { ...base, allocations: fixture().allocations },
            { ...base, allocations: [{ output: base.outputs[0].hash, to: { kind: 'holders' } }] },
            { ...base, money: fixture().money },
            { ...base, money: { currency: 'EUR', lines: [{ ownerKey: 'agent-ana', amountCents: 0 }] } }
        ];
        for (const raw of samples) {
            const code = raw.allocations.length ? 'community-allocations' : 'community-money';
            expect(record.validate(raw).errors).toContainEqual(expect.objectContaining({ code, section: code === 'community-allocations' ? 'allocation' : 'money' }));
            expect(() => record.published(raw)).toThrow(/cannot allocate land or include cash/);
        }
    });

    it('rejects unknown consultation metadata rather than silently dropping it', () => {
        const raw = community({ organiser: 'did:web:ngo.example', participationUrl: null, secretTerm: 'hidden' });
        expect(() => record.normalize(raw)).toThrow(/unknown fields/);
        expect(() => record.validate(raw)).toThrow(/unknown fields/);
        expect(() => record.published(raw)).toThrow(/unknown fields/);
        for (const consultation of [{ organiser: 42 }, { participationUrl: 42 }]) {
            expect(() => record.normalize(community(consultation))).toThrow(/text or null/);
        }
    });

    it('reports invalid organiser and participation fields by section', () => {
        for (const organiser of ['not a did', 'http://ngo.example', 'https://user:password@ngo.example', 'did:web:ngo.example:' + 'x'.repeat(2048)]) {
            expect(record.validate(community({ organiser })).errors).toContainEqual(expect.objectContaining({ code: 'consultation-organiser', section: 'consultation' }));
        }
        for (const participationUrl of ['http://ngo.example', 'javascript:alert(1)', '/join', 'https://user:password@ngo.example/join', 'https://ngo.example/' + 'x'.repeat(2048)]) {
            expect(record.validate(community({ participationUrl })).errors).toContainEqual(expect.objectContaining({ code: 'consultation-participation-url', section: 'consultation' }));
        }
    });
});
