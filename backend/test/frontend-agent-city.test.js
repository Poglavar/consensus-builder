// The Agent city's pure parts without a browser: what a design draws (design-display.js), the local
// agents' building designs (agent-building-design.js), owners' decisions in the simulation
// (simulation-agreements.js) and the executions timeline (agent-city.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const variation = require('../../frontend/js/urban-rule-variation.js');
const Display = require('../../frontend/js/design-display.js');
const BuildingDesign = require('../../frontend/js/agent-building-design.js');
const Agreements = require('../../frontend/js/simulation-agreements.js');
const AgentCity = require('../../frontend/js/agent-city.js');

const LAT = 45.8, LNG = 15.98;
function square(sideM, offset = 0) {
    const dLat = (sideM / 2) / 110540;
    const dLng = (sideM / 2) / (111320 * Math.cos(LAT * Math.PI / 180));
    const lng = LNG + offset;
    return { type: 'Polygon', coordinates: [[[lng - dLng, LAT - dLat], [lng + dLng, LAT - dLat], [lng + dLng, LAT + dLat], [lng - dLng, LAT + dLat], [lng - dLng, LAT - dLat]]] };
}
const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

describe('design display parts', () => {
    it('draws a structure as its kind and a building with its height', () => {
        expect(Display.displayParts({ goal: 'park', structureProposal: { kind: 'park', geometry: square(40) } }).map(p => p.kind)).toEqual(['park']);
        expect(Display.displayParts({ structureProposal: { kind: 'lake', geometry: square(40) } })[0].kind).toBe('lake');
        expect(Display.displayParts({ structureProposal: { kind: 'station', geometry: square(40) } })[0].kind).toBe('ground');
        const building = { type: 'Feature', properties: { floors: 4, height: 12 }, geometry: square(20) };
        const [part] = Display.displayParts({ goal: 'buildings', geometry: { buildings: [building] } });
        expect(part).toMatchObject({ kind: 'building', heightM: 12 });
        expect(Display.buildingHeightM({ floors: 5 })).toBe(15);
        expect(Display.buildingHeightM({})).toBeNull();
    });

    it('draws a published design/v1 content like a local record', () => {
        const content = { schema: 'design/v1', goal: 'buildings', geometry: { buildings: [{ type: 'Feature', properties: { floors: 4, height: 12 }, geometry: square(20) }] } };
        expect(Display.displayParts(content)).toHaveLength(1);
        expect(Display.displayParts(null)).toEqual([]);
    });

    it('draws only the Agent city while it is open, else every layer with each design once', () => {
        const ghosts = [{ key: 'a', opacity: 0.3 }, { key: 'b' }, { key: 'b' }];
        expect(Display.mergeLayers({ ghosts, agentCity: [{ key: 'a', opacity: 1 }] }).map(e => [e.key, e.opacity])).toEqual([['a', 1]]);
        expect(Display.mergeLayers({ ghosts, agentCity: [] })).toEqual([]);
        expect(Display.mergeLayers({ ghosts }).map(e => e.key)).toEqual(['a', 'b']);
    });

    it('puts a fading ghost in one of three strength steps', () => {
        expect([1, 2 / 3, 1 / 3, 0, NaN].map(Display.strengthStep)).toEqual([3, 2, 1, 0, 0]);
    });
});

describe('local agent building design', () => {
    it('stands a building inside the parcel, within its storey ceiling, repeatably', () => {
        const args = { parcelFeature: feature(square(40)), parcelId: '123/4', author: 'Ana', seed: 'a:1:123/4', turf, variation };
        const design = BuildingDesign.buildingDesign(args);
        expect(design.goal).toBe('buildings');
        const [building] = design.geometry.buildings;
        const floors = building.properties.floors;
        expect(floors).toBeGreaterThanOrEqual(1);
        expect(floors).toBeLessThanOrEqual(BuildingDesign.floorCeiling(args.seed));
        expect(turf.area(building)).toBeLessThan(turf.area(feature(square(40))));
        expect(turf.booleanWithin(turf.centroid(building), feature(square(40)))).toBe(true);
        expect(BuildingDesign.buildingDesign(args)).toEqual(design);
    });

    it('builds nothing where the setbacks leave no room', () => {
        expect(BuildingDesign.buildingDesign({ parcelFeature: feature(square(4)), parcelId: 'x', author: 'Ana', seed: 's', turf, variation })).toBeNull();
    });

    it('draws storey ceilings from 2 to 8', () => {
        const ceilings = new Set(Array.from({ length: 200 }, (_, i) => BuildingDesign.floorCeiling(`seed${i}`)));
        expect(Math.min(...ceilings)).toBe(2);
        expect(Math.max(...ceilings)).toBe(8);
    });
});

describe('simulation agreements', () => {
    const owners = { p1: 'ana', p2: 'ben' };
    const ownersOf = id => owners[id] || null;
    const opened = (parcelIds, proposerId = 'ana') => Agreements.open({ proposalId: 'd1', proposerId, parcelIds, ownersOf, turn: 1, at: '2024-01-08T00:00:00Z' });
    const always = value => () => value;

    it('executes at once a design wholly on its proposer\'s land', () => {
        const { agreements, events } = Agreements.decideTurn([opened(['p1'])], { turn: 1, at: 'T1', rng: always(0.99) });
        expect(agreements[0]).toMatchObject({ status: 'executed', closedTurn: 1, closedAt: 'T1' });
        expect(events).toEqual([{ type: 'execute', proposalId: 'd1' }]);
    });

    it('asks every other owner, the city for unowned land, and executes when all approve', () => {
        const agreement = opened(['p1', 'p2', 'p9']);
        expect(agreement.approvals).toEqual({ ana: 'approved', ben: null, city: null });
        const { agreements, events } = Agreements.decideTurn([agreement], { turn: 2, at: 'T2', rng: always(0.1) });
        expect(agreements[0].status).toBe('executed');
        expect(events.map(e => e.type)).toEqual(['approve', 'approve', 'execute']);
    });

    it('closes on a refusal, waits on a user-controlled owner and lapses at the deadline', () => {
        expect(Agreements.decideTurn([opened(['p1', 'p2'])], { turn: 2, at: 'T', rng: always(0.01) }).agreements[0].status).toBe('refused');
        const waiting = Agreements.decideTurn([opened(['p1', 'p2'])], { turn: 2, at: 'T', rng: always(0.1), decides: id => id !== 'ben' });
        expect(waiting.agreements[0].status).toBe('open');
        const late = Agreements.decideTurn([opened(['p1', 'p2'])], { turn: 11, at: 'T', rng: always(0.99) });
        expect(late.agreements[0].status).toBe('expired');
    });

    it('lapses the other open agreements over land a design takes', () => {
        const own = opened(['p1']);
        const rival = { ...Agreements.open({ proposalId: 'd2', proposerId: 'ben', parcelIds: ['p1', 'p2'], ownersOf, turn: 1, at: 'T' }) };
        const { agreements, events } = Agreements.decideTurn([own, rival], { turn: 1, at: 'T1', rng: always(0.99) });
        expect(agreements.map(a => a.status)).toEqual(['executed', 'superseded']);
        expect(events.at(-1)).toEqual({ type: 'supersede', proposalId: 'd2' });
    });
});

describe('agent city timeline', () => {
    const item = (key, executedAt, parcelIds) => ({ key, executedAt, parcelIds, design: {} });

    it('orders executions and steps by day', () => {
        const { items, days } = AgentCity.timeline([item('b', '2026-11-02T10:00:00Z', ['2']), item('a', '2026-11-01T09:00:00Z', ['1']),
            item('c', '2026-11-02T08:00:00Z', ['3']), { key: 'x', executedAt: 'not a date' }]);
        expect(items.map(i => i.key)).toEqual(['a', 'c', 'b']);
        expect(days).toEqual(['2026-11-01', '2026-11-02']);
    });

    it('shows what stands at a day, a later execution on a parcel replacing the earlier one', () => {
        const { items } = AgentCity.timeline([item('a', '2026-11-01T09:00:00Z', ['1']), item('b', '2026-11-02T09:00:00Z', ['2']),
            item('c', '2026-11-03T09:00:00Z', ['1', '3'])]);
        expect(AgentCity.standingAt(items, '2026-11-01').standing.map(i => i.key)).toEqual(['a']);
        const third = AgentCity.standingAt(items, '2026-11-03');
        expect(third.standing.map(i => i.key)).toEqual(['b', 'c']);
        expect([...third.fresh]).toEqual(['c']);
    });

    it('takes an executed index agreement with its design, and nothing else', () => {
        const agreement = { cid: 'bafyA', status: 'executed', title: 'T', author: 'builder-02', inputParcelIds: ['HR-1'], onchain: { executedAt: '2026-11-19T13:30:22.000Z' } };
        expect(AgentCity.serverItem(agreement, { content: { goal: 'buildings' } })).toMatchObject({
            key: 'bafyA', executedAt: '2026-11-19T13:30:22.000Z', parcelIds: ['HR-1'], open: { type: 'agreement', id: 'bafyA' } });
        expect(AgentCity.serverItem({ ...agreement, status: 'active' }, { content: {} })).toBeNull();
        expect(AgentCity.serverItem(agreement, null)).toBeNull();
        expect(AgentCity.simulationItem({ status: 'executed', proposalId: 'p-1', closedAt: '2024-02-05T00:00:00Z', parcelIds: ['1'] }, { title: 'Park' }))
            .toMatchObject({ key: 'p-1', open: { type: 'design', id: 'p-1' } });
    });
});
