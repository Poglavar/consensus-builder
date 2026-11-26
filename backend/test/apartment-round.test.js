// Covers the apartment round model (frontend/js/apartment-round.js): the display state of each offered
// apartment from its chain listing, the round's counts, reserved deposits against the target, the
// per-floor breakdown, the strongest state per X-ray unit across rounds, and the unit search.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { model } = require('../../frontend/js/apartment-round.js');

const TOWER = 'new_york::buildings::tower-1';
const ANNEX = 'new_york::buildings::annex-2';
const unit = (unitId, locator, deposit, building = TOWER) => ({ unitId, label: `Apartment ${unitId.toUpperCase()}`, xrayBuilding: building,
    unit: locator, at: '40.7143,-74.0085,18', priceUsdcAtomic: String(BigInt(deposit) * 20n), depositUsdcAtomic: deposit });
const funding = {
    targetUsdcAtomic: '30000000',
    apartments: { projectId: 'garden-court', units: [
        unit('a-101', '1::A-101', '12500000'), unit('a-102', '1::A-102', '12500000'),
        unit('b-201', '2::B-201::0123456789abcdef01234567', '10000000'), unit('b-202', '2::B-202', '10000000')
    ] }
};
const row = (unitId, status, buyer = null) => ({ unitId, status, buyer });
const inventory = [row('a-101', 'reserved', 'Buyer1111'), row('a-102', 'available'), row('b-201', 'unlisted'), row('b-202', 'unavailable')];

describe('ApartmentRound model', () => {
    it('reads each chain listing as reserved, available or not available with its reason', () => {
        expect(model.unitState('reserved', true)).toEqual({ state: 'reserved', reason: null });
        expect(model.unitState('reserved', false)).toEqual({ state: 'reserved', reason: null });
        expect(model.unitState('available', true)).toEqual({ state: 'available', reason: null });
        expect(model.unitState('available', false)).toEqual({ state: 'unavailable', reason: 'closed' });
        expect(model.unitState('unavailable', true)).toEqual({ state: 'unavailable', reason: 'heldElsewhere' });
        expect(model.unitState('unlisted', true)).toEqual({ state: 'unavailable', reason: 'unlisted' });
        expect(model.unitState(undefined, true)).toEqual({ state: 'unavailable', reason: 'unlisted' });
    });

    it('takes the storey level from the X-ray unit address', () => {
        expect(model.levelOf('2::B-201::0123456789abcdef01234567')).toBe(2);
        expect(model.levelOf('-1::G-01')).toBe(-1);
        expect(model.levelOf('0::S')).toBe(0);
        expect(model.levelOf('x::S')).toBeNull();
    });

    it('counts a round by state, sums only reserved deposits against the target and breaks it down by floor', () => {
        const view = model.roundView({ cid: 'bafk', title: 'Courtyard', funding, inventory, accepting: true });
        expect(view.read).toBe(true);
        expect(view.counts).toEqual({ offered: 4, reserved: 1, available: 1, unavailable: 2 });
        expect(view.reservedDeposits).toBe(12500000n);
        expect(view.target).toBe(30000000n);
        expect(view.percent).toBe(41);
        expect(view.floors).toEqual([
            { building: 1, level: 1, offered: 2, reserved: 1, available: 1, unavailable: 0 },
            { building: 1, level: 2, offered: 2, reserved: 0, available: 0, unavailable: 2 }
        ]);
        expect(view.units.map(item => [item.unitId, item.state, item.reason, item.buyer, item.level])).toEqual([
            ['a-101', 'reserved', null, 'Buyer1111', 1], ['a-102', 'available', null, null, 1],
            ['b-201', 'unavailable', 'unlisted', null, 2], ['b-202', 'unavailable', 'heldElsewhere', null, 2]
        ]);
    });

    it('closes available units once the round stops accepting, keeping reservations', () => {
        const view = model.roundView({ funding, inventory, accepting: false });
        expect(view.counts).toEqual({ offered: 4, reserved: 1, available: 0, unavailable: 3 });
        expect(view.units[1]).toMatchObject({ state: 'unavailable', reason: 'closed' });
        expect(view.reservedDeposits).toBe(12500000n);
    });

    it('reports deposits above the target as more than 100 percent', () => {
        const all = funding.apartments.units.map(item => row(item.unitId, 'reserved', 'Buyer'));
        const view = model.roundView({ funding, inventory: all, accepting: true });
        expect(view.reservedDeposits).toBe(45000000n);
        expect(view.percent).toBe(150);
    });

    it('gives an unread round no states and counts its units only as offered', () => {
        const view = model.roundView({ funding, inventory: null });
        expect(view.read).toBe(false);
        expect(view.counts).toEqual({ offered: 4, reserved: 0, available: 0, unavailable: 0 });
        expect(view.units.every(item => item.state === null && item.buyer === null)).toBe(true);
        expect(view.reservedDeposits).toBe(0n);
    });

    it('keeps floors of different buildings apart', () => {
        const mixed = { ...funding, apartments: { ...funding.apartments, units: [unit('a-101', '1::A-101', '12500000'), unit('c-101', '1::C-101', '20000000', ANNEX)] } };
        const view = model.roundView({ funding: mixed, inventory: [row('a-101', 'available'), row('c-101', 'reserved', 'B')], accepting: true });
        expect(view.buildings).toBe(2);
        expect(view.floors.map(floor => [floor.building, floor.level, floor.offered])).toEqual([[1, 1, 1], [2, 1, 1]]);
    });

    it('gives each unit of one building its strongest state across rounds and leaves unoffered units out', () => {
        const first = model.roundView({ cid: 'old', funding, inventory: [row('a-101', 'available'), row('a-102', 'unlisted'), row('b-201', 'unlisted'), row('b-202', 'unlisted')], accepting: true });
        const second = model.roundView({ cid: 'new', funding, inventory, accepting: true });
        const states = model.buildingStates([first, second], TOWER);
        expect(states.get('1::A-101')).toMatchObject({ state: 'reserved', round: { cid: 'new' } });
        expect(states.get('1::A-102')).toMatchObject({ state: 'available', round: { cid: 'new' } });
        // A tie keeps the earlier round: the index lists the newest first.
        expect(states.get('2::B-202')).toMatchObject({ state: 'unavailable', reason: 'unlisted', round: { cid: 'old' } });
        expect(states.has('3::C-301')).toBe(false);
        expect(model.buildingStates([second], ANNEX).size).toBe(0);
        expect(model.buildingStates([model.roundView({ funding, inventory: null })], TOWER).size).toBe(0);
    });

    it('finds units whose words contain the query from a word start, case-insensitively', () => {
        const items = [{ text: 'Tower 2 · 101 t2-101 Floor 1 Reserved' }, { text: 'Tower 2 · 201 t2-201 Floor 2 Available' },
            { text: 'Tower 2 · 302 t2-302 Floor 3 Reserved in another round' }];
        expect(model.filterUnits(items, '', item => item.text)).toEqual(items);
        expect(model.filterUnits(items, 'floor 2', item => item.text)).toEqual([items[1]]);
        expect(model.filterUnits(items, 'floor 1', item => item.text)).toEqual([items[0]]);
        expect(model.filterUnits(items, '3', item => item.text)).toEqual([items[2]]);
        expect(model.filterUnits(items, '01', item => item.text)).toEqual([]);
        expect(model.filterUnits(items, 'T2-1', item => item.text)).toEqual([items[0]]);
        expect(model.filterUnits(items, 'reserved', item => item.text)).toEqual([items[0], items[2]]);
        expect(model.filterUnits(items, 'Tower 2 · 302', item => item.text)).toEqual([items[2]]);
        expect(model.filterUnits(items, 'garage', item => item.text)).toEqual([]);
    });
});
