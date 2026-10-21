// Unit tests for frontend/js/agreement-record.js: the agreement record's output hash, canonical
// form and validation codes, the per-party ledger, the default rights snapshot and the subject the
// approval engine counts.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const record = require('../../frontend/js/agreement-record.js');
const approval = require('../../frontend/js/proposals/approval.js');

const sha256 = text => createHash('sha256').update(text).digest('hex');
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
        designs: [
            { proposalId: 'layout-1', title: 'Lay out block seven', goal: 'parcel-layout', fingerprint: 'c2-layout' },
            { proposalId: 'road-1', title: 'Draw road', goal: 'road', fingerprint: 'c2-road' }
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
            electorate: 'owners', binding: true, lens: [],
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
        raw.money = {
            currency: 'USD',
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
        communityWithConfig.rule = { ...communityWithConfig.rule, electorate: 'community', binding: false };
        expect(codes(record.validate(communityWithConfig).errors)).toEqual(['rule-invalid']);

        const bindingVote = fixture();
        bindingVote.rule = { electorate: 'community', binding: true, approvalConfig: null, lens: [] };
        expect(record.validate(bindingVote).errors).toEqual([expect.objectContaining({ code: 'rule-community-binding', section: 'rule' })]);

        const vote = fixture();
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
        expect(subject.lens).toEqual([]);
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
