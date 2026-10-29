// Unit tests for frontend/js/agreement-persons.js: per-person positions derived from an agreement's
// abstract parcel parties and an ownership rights snapshot — land co-owned at each person's share,
// cash split per parcel into whole cents by largest remainder, totals by person equal to totals by party.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Persons = require('../../frontend/js/agreement-persons.js');
const Record = require('../../frontend/js/agreement-record.js');
const Cid = require('../../frontend/js/cid.js');
const PlanRecord = require('../../frontend/js/plan-record.js');

const DESIGN_CID = Cid.cidOfObject({ schema: 'design/v1', goal: 'parcel-layout', title: 'Three-parcel layout' });
const PLAN_CONTENT = PlanRecord.create('Three parcels', [DESIGN_CID], { at: '45.8,15.96,16', mode: '2d' });
function rect(x0, y0, x1, y1) {
    const at = (x, y) => [15.96 + x * 1e-3, 45.8 + y * 1e-3];
    return { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}
const piece = (pieceId, geometry, areaM2, fromParcelIds, extra = {}) => ({
    hash: Record.outputHash(geometry), pieceId, areaM2, fromParcelIds, producedBy: 'layout-1', role: 'plot', geometry, ...extra
});
const party = id => Record.partyKey(id);

// Three people over three parcels with uneven shares; k1 and k3 hold in several parcels.
const RIGHTS = {
    schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'test' },
    parcels: [
        { parcelId: 'A', complete: true, areaM2: null, owners: [{ ownerId: 'k1', share: '1/3' }, { ownerId: 'k2', share: '1/3' }, { ownerId: 'k3', share: '1/3' }] },
        { parcelId: 'B', complete: true, areaM2: null, owners: [{ ownerId: 'k1', share: '2/7' }, { ownerId: 'k3', share: '5/7' }] },
        { parcelId: 'C', complete: true, areaM2: null, owners: [{ ownerId: 'k2', share: '3/11' }, { ownerId: 'k3', share: '8/11' }] }
    ]
};

// A settled owners' agreement: A keeps less than it put in, B receives more, C keeps a piece, a road
// goes to the public; an odd rate makes every party's cash an uneven number of cents.
function agreement(rights = RIGHTS) {
    const outputs = [
        piece('a1', rect(0, 0, 1, 1), 900.25, ['A']),
        piece('b1', rect(1, 0, 2, 1), 800.5, ['B', 'C']),
        piece('c1', rect(2, 0, 3, 1), 233.75, ['C']),
        piece('road', rect(0, 1, 3, 1.2), 100.1, ['A', 'B'], { role: 'corridor' })
    ];
    return Record.settle({
        schema: 'agreement/v1', id: 'ag-persons', title: 'Three parcels', city: 'test-city', createdAt: null, updatedAt: null,
        plan: { cid: Cid.cidOfObject(PLAN_CONTENT), content: PLAN_CONTENT },
        designs: [{ proposalId: 'layout-1', title: 'Three-parcel layout', goal: 'parcel-layout', cid: DESIGN_CID }],
        inputs: { parcels: [{ parcelId: 'A', areaM2: 1000.6 }, { parcelId: 'B', areaM2: 700 }, { parcelId: 'C', areaM2: 334 }], openGroundM2: 0 },
        outputs,
        allocations: [
            { output: outputs[0].hash, to: { kind: 'party', ownerKey: party('A') } },
            { output: outputs[1].hash, to: { kind: 'party', ownerKey: party('B') } },
            { output: outputs[2].hash, to: { kind: 'party', ownerKey: party('C') } },
            { output: outputs[3].hash, to: { kind: 'public' } }
        ],
        money: { currency: 'EUR', lines: [] },
        rule: { electorate: 'owners', binding: true, lens: ['lens-member-1'], settlement: { method: 'area', rateCentsPerM2: 137, contributionBasisPoints: 0 },
            approvalConfig: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } } },
        deadline: null
    });
}
const fraction = text => { const [n, d] = text.split('/').map(Number); return n / d; };

describe('splitCents', () => {
    it('splits exactly: floors, then the leftover cents to the largest remainders, ties by owner id', () => {
        const thirds = [{ ownerId: 'k2', share: '1/3' }, { ownerId: 'k1', share: '1/3' }, { ownerId: 'k3', share: '1/3' }];
        expect(Object.fromEntries(Persons.splitCents(100, thirds))).toEqual({ k1: 34, k2: 33, k3: 33 });
        expect(Object.fromEntries(Persons.splitCents(101, thirds))).toEqual({ k1: 34, k2: 34, k3: 33 });
        // 10 × 2/7 = 2.857…, 10 × 5/7 = 7.142…: the larger remainder (6/7) takes the odd cent.
        expect(Object.fromEntries(Persons.splitCents(10, [{ ownerId: 'k3', share: '5/7' }, { ownerId: 'k1', share: '2/7' }]))).toEqual({ k1: 3, k3: 7 });
        // Remainders compared exactly across different denominators: 1/2 beats 1/3 and 1/6.
        expect(Object.fromEntries(Persons.splitCents(1, [{ ownerId: 'a', share: '1/6' }, { ownerId: 'b', share: '1/3' }, { ownerId: 'c', share: '1/2' }]))).toEqual({ a: 0, b: 0, c: 1 });
    });

    it('splits what a parcel pays the same way, and keeps the total exact', () => {
        const thirds = [{ ownerId: 'k1', share: '1/3' }, { ownerId: 'k2', share: '1/3' }, { ownerId: 'k3', share: '1/3' }];
        expect(Object.fromEntries(Persons.splitCents(-100, thirds))).toEqual({ k1: -34, k2: -33, k3: -33 });
        for (const cents of [0, 1, 2, 99, 12345, -98765, 9007199254]) {
            const split = [...Persons.splitCents(cents, RIGHTS.parcels[2].owners).values()];
            expect(split.reduce((sum, value) => sum + value, 0)).toBe(cents);
        }
        expect(() => Persons.splitCents(1.5, thirds)).toThrow(TypeError);
    });
});

describe('personPositions', () => {
    it('co-owns each party output at the person\'s share, and sums land per person', () => {
        const value = agreement();
        const result = Persons.personPositions(value, value.rule.approvalConfig.rights);
        expect(result.resolved).toBe(true);
        expect(result.unresolved).toEqual([]);
        const byId = Object.fromEntries(result.persons.map(person => [person.personId, person]));
        expect(Object.keys(byId)).toEqual(['k1', 'k2', 'k3']);
        const [a1, b1, c1] = value.outputs;
        expect(byId.k1.outputs).toEqual([
            { output: a1.hash, pieceId: 'a1', parcelId: 'A', share: '1/3', areaM2: 900.25 / 3 },
            { output: b1.hash, pieceId: 'b1', parcelId: 'B', share: '2/7', areaM2: 800.5 * 2 / 7 }
        ]);
        expect(byId.k2.outputs.map(row => [row.pieceId, row.share])).toEqual([['a1', '1/3'], ['c1', '3/11']]);
        // k3 holds in all three parcels: a third of a1, 5/7 of b1 and 8/11 of c1.
        expect(byId.k3.landM2).toBeCloseTo(900.25 / 3 + 800.5 * 5 / 7 + 233.75 * 8 / 11, 9);
        expect(byId.k3.parcels.map(row => [row.parcelId, row.share])).toEqual([['A', '1/3'], ['B', '5/7'], ['C', '8/11']]);
        expect(byId.k3.contributedM2).toBeCloseTo(1000.6 / 3 + 700 * 5 / 7 + 334 * 8 / 11, 9);
        expect(result.totals.partyLandM2).toBeCloseTo(900.25 + 800.5 + 233.75, 9);
        expect(result.totals.personLandM2).toBeCloseTo(result.totals.partyLandM2, 9);
        expect(result.totals.balanced).toBe(true);
    });

    it('splits each party\'s cash into whole cents that sum exactly to it, each within a cent of the exact share', () => {
        const value = agreement();
        const cashOf = new Map(value.money.lines.map(line => [line.ownerKey, line.amountCents]));
        // The rate makes uneven cents (area settlement, 137 cents/m²): A receives 13748 (not a multiple
        // of 3), B pays 13768 (not of 7), C receives 13734 (not of 11), so every split has remainders.
        expect(Object.fromEntries(cashOf)).toEqual({ [party('A')]: 13748, [party('B')]: -13768, [party('C')]: 13734 });
        const result = Persons.personPositions(value, RIGHTS);
        const byId = Object.fromEntries(result.persons.map(person => [person.personId, person]));
        // Per parcel the split is exact and each person is within one cent of the exact amount.
        for (const row of RIGHTS.parcels) {
            const cents = cashOf.get(party(row.parcelId));
            const split = Persons.splitCents(cents, row.owners);
            expect([...split.values()].reduce((sum, value) => sum + value, 0)).toBe(cents);
            row.owners.forEach(owner => expect(Math.abs(split.get(owner.ownerId) - cents * fraction(owner.share))).toBeLessThan(1));
        }
        // A person in several parcels receives the sum of their per-parcel splits.
        const expected = id => RIGHTS.parcels.reduce((sum, row) => sum + (Persons.splitCents(cashOf.get(party(row.parcelId)), row.owners).get(id) || 0), 0);
        expect(byId.k1.cashCents).toBe(expected('k1'));
        expect(byId.k2.cashCents).toBe(expected('k2'));
        expect(byId.k3.cashCents).toBe(expected('k3'));
        const partyCash = value.money.lines.reduce((sum, line) => sum + line.amountCents, 0);
        expect(result.totals).toMatchObject({ partyCashCents: partyCash, personCashCents: partyCash, balanced: true });
        expect(byId.k1.cashCents + byId.k2.cashCents + byId.k3.cashCents).toBe(partyCash);
        result.persons.forEach(person => expect(Number.isSafeInteger(person.cashCents)).toBe(true));
    });

    it('reads the published object the same way as the local record', () => {
        const value = agreement();
        const published = Record.published(value);
        expect(Persons.personPositions(published, RIGHTS).persons.map(({ personId, cashCents, landM2 }) => ({ personId, cashCents, landM2 })))
            .toEqual(Persons.personPositions(value, RIGHTS).persons.map(({ personId, cashCents, landM2 }) => ({ personId, cashCents, landM2 })));
        expect(Persons.personPositions(published, RIGHTS).persons[0].outputs[0].pieceId).toBeNull();
    });

    it('keeps a parcel without complete, named rights as one unresolved party, out of the person totals', () => {
        const partial = structuredClone(RIGHTS);
        partial.parcels[1] = { parcelId: 'B', complete: false, areaM2: null, owners: [{ ownerId: 'k1', share: '2/7' }] };
        // The default local snapshot names the abstract party itself; that is not a person.
        partial.parcels[2] = { parcelId: 'C', complete: false, areaM2: null, owners: [{ ownerId: party('C'), share: '1/1' }] };
        const value = agreement();
        const result = Persons.personPositions(value, partial);
        expect(result.resolved).toBe(false);
        expect(result.unresolved).toEqual([{ ownerKey: party('B'), parcelId: 'B' }, { ownerKey: party('C'), parcelId: 'C' }]);
        expect(result.persons.map(person => person.personId)).toEqual(['k1', 'k2', 'k3']);
        expect(result.persons.every(person => person.outputs.every(row => row.parcelId === 'A'))).toBe(true);
        const aCash = value.money.lines.find(line => line.ownerKey === party('A')).amountCents;
        expect(result.totals).toMatchObject({ partyCashCents: aCash, personCashCents: aCash, balanced: true });
        expect(result.totals.partyLandM2).toBeCloseTo(900.25, 9);

        const missing = Persons.personPositions(value, { ...RIGHTS, parcels: [RIGHTS.parcels[0]] });
        expect(missing.unresolved.map(row => row.parcelId)).toEqual(['B', 'C']);
        expect(Persons.personPositions(value, null)).toMatchObject({ persons: [], resolved: false });
    });

    it('refuses a rights snapshot the approval engine refuses', () => {
        const bad = structuredClone(RIGHTS);
        bad.parcels[0].owners[0].share = '2/3';
        expect(() => Persons.personPositions(agreement(), bad)).toThrow(/sum to 1\/1/);
    });

    it('leaves proposer and public land to nobody', () => {
        const value = agreement();
        value.allocations[2] = { output: value.allocations[2].output, to: { kind: 'proposer' } };
        const result = Persons.personPositions(Record.settle(value), RIGHTS);
        expect(result.persons.flatMap(person => person.outputs).some(row => row.pieceId === 'c1')).toBe(false);
        expect(result.totals.partyLandM2).toBeCloseTo(900.25 + 800.5, 9);
        expect(result.totals.balanced).toBe(true);
    });
});
