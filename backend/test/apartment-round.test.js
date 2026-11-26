// Covers the apartment round model (frontend/js/apartment-round.js): the display state of each offered
// apartment from its chain listing, the round's counts, reserved deposits against the target, the
// per-floor breakdown, the strongest state per X-ray unit across rounds, and the unit search.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { testI18n } from './helpers/i18n.js';

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

    it('lays a round out as a building overview: top floor first, each floor in round order, units without a floor last', () => {
        const mixed = { ...funding, apartments: { ...funding.apartments, units: [
            unit('b-202', '2::B-202', '10000000'), unit('a-101', '1::A-101', '12500000'), unit('x-1', 'garage::X-1', '1000000'),
            unit('b-201', '2::B-201', '10000000'), unit('a-102', '1::A-102', '12500000')] } };
        const view = model.roundView({ funding: mixed, accepting: true,
            inventory: [row('a-101', 'reserved', 'B'), row('a-102', 'available'), row('b-201', 'unlisted'), row('b-202', 'available'), row('x-1', 'available')] });
        const rows = model.overviewRows({ units: view.units });
        expect(rows.map(item => item.floor)).toEqual([2, 1, null]);
        expect(rows.map(item => item.cells.map(cell => cell.unitId))).toEqual([['b-202', 'b-201'], ['a-101', 'a-102'], ['x-1']]);
        expect(rows[1].cells[0]).toEqual({ key: '1::A-101', unitId: 'a-101', label: 'Apartment A-101', ordinal: null, floor: 1, state: 'reserved', reason: null });
        expect(rows[0].cells[1]).toMatchObject({ state: 'unavailable', reason: 'unlisted' });
        expect(rows.map(item => model.cellText(item.cells[0]))).toEqual(['B-202', 'A-101', 'X-1']);
        expect(model.cellText({ label: 'Tower 2 · 201', ordinal: null })).toBe('201');
    });

    it('gives an empty round no overview rows, and a round over two buildings rows per building', () => {
        expect(model.overviewRows({ units: [] })).toEqual([]);
        expect(model.overviewRows({ apartments: [], states: new Map() })).toEqual([]);
        const mixed = { ...funding, apartments: { ...funding.apartments, units: [unit('c-101', '1::C-101', '1', ANNEX), unit('a-101', '1::A-101', '1'), unit('a-201', '2::A-201', '1')] } };
        const view = model.roundView({ funding: mixed, inventory: [row('c-101', 'available'), row('a-101', 'available'), row('a-201', 'reserved', 'B')], accepting: true });
        // Buildings are numbered in the order the round lists them: the annex comes first here.
        expect(model.overviewRows({ units: view.units }).map(item => [item.building, item.floor, item.cells.length])).toEqual([[1, 1, 1], [2, 2, 1], [2, 1, 1]]);
    });

    it('lays out every X-ray apartment of a building, unoffered ones as not offered, in apartment order', () => {
        const view = model.roundView({ cid: 'new', funding, inventory, accepting: true });
        const states = model.buildingStates([view], TOWER);
        const apartments = [
            { key: '2::B-202', level: 2, ordinal: 4 }, { key: '1::A-102', level: 1, ordinal: 2 }, { key: '1::A-101', level: 1, ordinal: 1 },
            { key: '2::B-203', level: 2, ordinal: 5 }, { key: '3::C-301', level: 3, ordinal: 6 }
        ];
        const rows = model.overviewRows({ apartments, states });
        expect(rows.map(item => item.floor)).toEqual([3, 2, 1]);
        expect(rows.map(item => item.cells.map(cell => [cell.key, cell.state]))).toEqual([
            [['3::C-301', 'not-offered']],
            // B-201 is offered under an address this layout no longer has: it keeps a cell on its floor.
            [['2::B-202', 'unavailable'], ['2::B-203', 'not-offered'], ['2::B-201::0123456789abcdef01234567', 'unavailable']],
            [['1::A-101', 'reserved'], ['1::A-102', 'available']]
        ]);
        expect(rows[2].cells[0]).toEqual({ key: '1::A-101', unitId: 'a-101', label: 'Apartment A-101', ordinal: 1, floor: 1, state: 'reserved', reason: null });
        expect(rows[0].cells[0]).toMatchObject({ unitId: null, label: null, ordinal: 6 });
        expect(model.cellText(rows[2].cells[0])).toBe('1');
        // Before any round is read every apartment is a not-offered cell.
        expect(model.overviewRows({ apartments }).flatMap(item => item.cells).every(cell => cell.state === 'not-offered')).toBe(true);
    });

    it('keeps many apartments of one floor in one row, in order', () => {
        const apartments = Array.from({ length: 48 }, (_, i) => ({ key: `7::U-${i}`, level: 7, ordinal: 48 - i }));
        const rows = model.overviewRows({ apartments, states: new Map() });
        expect(rows).toHaveLength(1);
        expect(rows[0].floor).toBe(7);
        expect(rows[0].cells.map(cell => cell.ordinal)).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
        const tall = Array.from({ length: 20 * 6 }, (_, i) => ({ key: `${Math.floor(i / 6)}::U-${i}`, level: Math.floor(i / 6), ordinal: i + 1 }));
        const floors = model.overviewRows({ apartments: tall });
        expect(floors.map(item => item.floor)).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
        expect(floors.every(item => item.cells.length === 6)).toBe(true);
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

describe('ApartmentRound floor names', () => {
    // The panels' lookup: t(key, fallback, params), the fallback used when the dictionary has no entry.
    const translator = api => (key, fallback, params) => {
        const value = api.t(key, params);
        return value === key ? fallback : value;
    };

    it('names English floors from the ground floor up, basements and unknown floors included', () => {
        const api = testI18n('en'), t = translator(api), convention = api.getStoreyNumbering();
        expect([-1, 0, 1, 3].map(level => model.floorName({ building: 1, level }, 1, t, convention)))
            .toEqual(['Basement 1', 'Ground floor', 'Floor 1', 'Floor 3']);
        expect(model.floorName({ building: 1, level: null }, 1, t, convention)).toBe('Floor unknown');
        expect(model.floorName({ building: 2, level: 1 }, 2, t, convention)).toBe('Building 2 · floor 1');
        expect(model.apartmentPlace(1, 3, t, convention)).toBe('Floor 1 · Apartment 3');
    });

    it('names Russian floors one higher than the level: the storey at street level is floor 1', () => {
        const api = testI18n('ru'), t = translator(api), convention = api.getStoreyNumbering();
        expect(convention).toBe('ground-one');
        const floor = number => api.t('threeMode.controls.floorLevel', { level: number });
        expect([0, 1, 3].map(level => model.floorName({ building: 1, level }, 1, t, convention))).toEqual([floor(1), floor(2), floor(4)]);
        expect(model.floorName({ building: 1, level: -1 }, 1, t, convention)).toBe(api.t('threeMode.controls.floorBasement', { level: 1 }));
        expect(model.floorName({ building: 2, level: 0 }, 2, t, convention))
            .toBe(api.t('agreement.funding.apartments.buildingFloor', { building: 2, level: 1 }));
        expect(model.apartmentPlace(0, 3, t, convention)).toBe(api.t('threeMode.controls.apartmentOption', { level: 1, number: 3 }));
        // Display only: the overview keeps the level itself.
        expect(model.overviewRows({ apartments: [{ key: '0::A-1', level: 0, ordinal: 1 }] })[0].floor).toBe(0);
    });
});
