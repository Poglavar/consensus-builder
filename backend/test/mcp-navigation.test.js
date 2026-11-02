import { describe, expect, it, vi } from 'vitest';
import { createMcpNavigation } from '../agents/mcp-navigation.js';

const square = (id, west, east) => ({ type: 'Feature', id, properties: { parcelId: id }, geometry: { type: 'Polygon', coordinates: [[[west, 0], [east, 0], [east, 0.001], [west, 0.001], [west, 0]]] } });
const parcels = [square('west', 0, 0.001), square('east', 0.001, 0.002), square('far-east', 0.002, 0.003)];
function readers({ streets = { features: [] }, result = parcels, complete = true, truncated = false } = {}) {
    return {
        parcels: vi.fn(async ({ parcelIds } = {}) => ({ complete, truncated,
            features: parcelIds ? result.filter(f => parcelIds.includes(f.id)) : result })),
        request: vi.fn(async () => ({ complete: true, ...streets }))
    };
}
const road = (id, coordinates, properties = { highway: 'residential' }) => ({ type: 'Feature', id, properties, geometry: { type: 'LineString', coordinates } });

describe('MCP map navigation', () => {
    it('excludes classified road parcels from source blocks and refuses partial classification', async () => {
        const boundaries = { complete: true, features: [road('loop', [
            [-0.001,-0.001], [0.004,-0.001], [0.004,0.002], [-0.001,0.002], [-0.001,-0.001]
        ])] };
        let truncated = false;
        const read = readers();
        read.request = vi.fn(async path => path === '/road-parcels' ? { ids: ['east'], truncated } : boundaries);
        const navigation = createMcpNavigation({ read });
        const args = { city: 'test', parcelSourceId: 'oss-wfs', action: 'block', parcelId: 'west' };
        expect((await navigation.selectParcels(args)).selection.parcelIds).toEqual(['west', 'far-east']);
        expect(read.request).toHaveBeenCalledWith('/road-parcels', { bbox: expect.any(String) });
        await expect(navigation.selectParcels({ ...args, parcelId: 'east' })).rejects.toMatchObject({
            code: 'parcel-block-unproven', message: expect.stringContaining('road or track ground')
        });
        truncated = true;
        await expect(navigation.selectParcels(args)).rejects.toMatchObject({ code: 'parcel-coverage-incomplete' });
    });

    it('updates a runner-injected absolute view while applying center, pan and zoom as absolute state', () => {
        const navigation = createMcpNavigation({ read: readers() });
        const current = { at: '45,16,17', mode: '2d', city: 'test', settings: { language: 'en' } };
        const moved = navigation.mapView({ view: current, center: [17, 46], direction: 'east', distance: 1000, unit: 'm', zoomDelta: 2 });
        const [lat, lng, movedZoom] = moved.view.at.split(',').map(Number);
        expect(lat).toBeCloseTo(46, 4);
        expect(lng).toBeGreaterThan(17.01);
        expect(movedZoom).toBe(19);
        expect(moved.view).toMatchObject({ mode: '2d', city: 'test', settings: { language: 'en' } });
        expect(moved.view).not.toHaveProperty('zoomDelta');
        const threeD = navigation.mapView({ view: { at: '45,16,15', mode: '3d', camera: { targetLat: 45, targetLng: 16, headingDeg: 0, pitchRad: -0.5, range: 1000 } }, direction: 'east', distance: 500, zoomDelta: 1 });
        expect(threeD.view.camera.range).toBe(500);
        expect(threeD.view.camera.targetLng).toBeGreaterThan(16);
        expect(threeD.view.camera.targetLat).toBeCloseTo(45, 5);
        expect(threeD.view.at.split(',')[2]).toBe('16');
        expect(threeD.view).not.toHaveProperty('zoomDelta');
        const absolute3DZoom = navigation.mapView({ view: { at: '45,16,15', mode: '3d', camera: { targetLat: 45, targetLng: 16, headingDeg: 0, pitchRad: -0.5, range: 1000 } }, zoom: 17 });
        expect(absolute3DZoom.view.camera.range).toBe(250);
        const clamped3DZoom = navigation.mapView({ view: { at: '45,16,22', mode: '3d', camera: { targetLat: 45, targetLng: 16, headingDeg: 0, pitchRad: -0.5, range: 1 } }, zoomDelta: 5 });
        expect(clamped3DZoom.view.camera.range).toBe(1);
        expect(() => navigation.mapView({ view: { at: '45,16,15', mode: '3d', camera: { targetLat: 45, targetLng: 16, headingDeg: 0, pitchRad: -0.5, range: 1 } }, zoom: 22 })).toThrow(/at least one metre/i);
        expect(() => navigation.mapView({ view: { at: '85,179,17', mode: '2d' }, direction: 'east', distance: 100000 })).toThrow();
        expect(() => navigation.mapView({ view: { at: '45,16,17', mode: '2d' }, distance: -1, direction: 'east' })).toThrow();
    });

    it('selects exact disconnected source pieces and refuses an ambiguous parent', async () => {
        const source = { ...square('P', 0, 0.001), geometry: { type: 'MultiPolygon', coordinates: [square('P', 0.003, 0.004).geometry.coordinates, square('P', 0, 0.001).geometry.coordinates] } };
        const navigation = createMcpNavigation({ read: readers({ result: [source] }), random: () => 0 });
        await expect(navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', parcelId: 'P' })).rejects.toMatchObject({ code: 'parcel-ambiguous', constraints: { matches: [{ parcelId: 'P#cadastre-1' }, { parcelId: 'P#cadastre-2' }] } });
        const point = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', point: [0.0035, 0.0005] });
        expect(point.selection.parcelIds).toEqual(['P#cadastre-2']);
        const random = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'random', point: [0.0035, 0.0005], radiusM: 50 });
        expect(random.selection.parcelIds).toEqual(['P#cadastre-2']);
    });
    it('selects inactive parcels, moves the cursor separately while active, and supports a full manual selection workflow', async () => {
        const read = readers();
        const navigation = createMcpNavigation({ read });
        const selected = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', parcelId: 'west', selection: { parcelSourceId: 'source', focusParcelId: null, parcelIds: [], active: false } });
        expect(selected.selection).toEqual({ parcelSourceId: 'source', focusParcelId: 'west', parcelIds: ['west'], active: false });
        const stepped = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', selection: selected.selection });
        expect(stepped.selection).toEqual({ parcelSourceId: 'source', focusParcelId: 'east', parcelIds: ['east'], active: false });
        expect(stepped.point).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));

        let selection = (await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'begin', selection: selected.selection })).selection;
        expect(selection).toMatchObject({ focusParcelId: 'west', parcelIds: ['west'], active: true });
        selection = (await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', selection })).selection;
        expect(selection).toMatchObject({ focusParcelId: 'east', parcelIds: ['west'], active: true });
        selection = (await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'add', selection })).selection;
        expect(selection).toMatchObject({ focusParcelId: 'east', parcelIds: ['west', 'east'], active: true });
        selection = (await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', selection })).selection;
        expect(selection).toMatchObject({ focusParcelId: 'far-east', parcelIds: ['west', 'east'], active: true });
        selection = (await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'add', selection })).selection;
        expect(selection.parcelIds).toEqual(['west', 'east', 'far-east']);
        selection = (await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'finish', selection })).selection;
        expect(selection).toMatchObject({ focusParcelId: 'far-east', parcelIds: ['west', 'east', 'far-east'], active: false });
        const movedCursor = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', parcelId: 'west', selection: { ...selection, active: true } });
        expect(movedCursor.selection).toMatchObject({ focusParcelId: 'west', parcelIds: ['west', 'east', 'far-east'], active: true });
        const removed = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'remove', selection });
        expect(removed.selection).toMatchObject({ focusParcelId: 'east', parcelIds: ['west', 'east'], active: false });
    });

    it('steps to the nearest representative around a requested distance in metres or feet', async () => {
        const read = readers();
        const navigation = createMcpNavigation({ read });
        const inMetres = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', distance: 110, unit: 'm', selection: { focusParcelId: 'west', parcelIds: ['west'], active: true } });
        const inFeet = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', distance: 110 / 0.3048, unit: 'ft', selection: { focusParcelId: 'west', parcelIds: ['west'], active: true } });
        expect(inMetres.selection).toEqual({ parcelSourceId: 'source', focusParcelId: 'east', parcelIds: ['west'], active: true });
        expect(inFeet.selection).toEqual(inMetres.selection);
        expect(inMetres.point).toEqual(inFeet.point);
        await expect(navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'west', distance: 110, selection: { focusParcelId: 'west', parcelIds: [], active: false } })).rejects.toMatchObject({ code: 'parcel-neighbour-not-found' });
        await expect(navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', distance: 110, point: [0, 0], selection: { focusParcelId: 'west', parcelIds: [], active: false } })).rejects.toMatchObject({ code: 'invalid-parcel-action' });
    });

    it('chooses a uniformly random exact parcel identity from representative points in a bounded search', async () => {
        const low = readers();
        const high = readers({ result: [...parcels, structuredClone(parcels[1])] });
        const middle = readers();
        const point = [0.0015, 0.0005];
        const oldSelection = { focusParcelId: 'west', parcelIds: ['west', 'far-east'], active: true };
        const first = await createMcpNavigation({ read: low, random: () => 0 }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'random', point, selection: oldSelection });
        const last = await createMcpNavigation({ read: high, random: () => 0.999999 }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'random', point, selection: oldSelection });
        const middlePick = await createMcpNavigation({ read: middle, random: () => 0.5 }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'random', point });
        expect(first.selection).toEqual({ parcelSourceId: 'source', focusParcelId: 'east', parcelIds: ['east'], active: false });
        expect(last.selection).toEqual({ parcelSourceId: 'source', focusParcelId: 'west', parcelIds: ['west'], active: false });
        expect(middlePick.selection.focusParcelId).toBe('far-east');
        expect(first.point).toEqual([0.0015, 0.0005]);
        expect(low.parcels).toHaveBeenCalledWith({ city: 'test', parcelSourceId: 'source', geometry: expect.objectContaining({ type: 'Polygon' }) });
        const north = { type: 'Feature', id: 'a-north', properties: { parcelId: 'a-north' }, geometry: { type: 'Polygon', coordinates: [[[0, 0.001], [0.001, 0.001], [0.001, 0.002], [0, 0.002], [0, 0.001]]] } };
        const east = square('z-east', 0.001, 0.002);
        const directed = await createMcpNavigation({ read: readers({ result: [north, east] }), random: () => 0 }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'random', point: [0.0005, 0.0005], direction: 'east', radiusM: 200 });
        expect(directed.selection.focusParcelId).toBe('z-east');
    });

    it('refuses incomplete, truncated, empty and invalid random searches', async () => {
        const args = { city: 'test', parcelSourceId: 'source', action: 'random', point: [0.0005, 0.0005] };
        await expect(createMcpNavigation({ read: readers({ complete: false }) }).selectParcels(args)).rejects.toMatchObject({ code: 'parcel-coverage-incomplete' });
        await expect(createMcpNavigation({ read: readers({ truncated: true }) }).selectParcels(args)).rejects.toMatchObject({ code: 'parcel-coverage-incomplete' });
        await expect(createMcpNavigation({ read: readers({ result: [square('far', 0.01, 0.011)] }) }).selectParcels({ ...args, radiusM: 20 })).rejects.toMatchObject({ code: 'parcel-not-found' });
        const crossingButFarRepresentative = { type: 'Feature', id: 'spanning', properties: { parcelId: 'spanning' }, geometry: { type: 'Polygon', coordinates: [[[0.0008, 0], [0.01, 0], [0.01, 0.001], [0.0008, 0.001], [0.0008, 0]]] } };
        await expect(createMcpNavigation({ read: readers({ result: [crossingButFarRepresentative] }) }).selectParcels({ ...args, point: [0.0005, 0.0005], radiusM: 50 })).rejects.toMatchObject({ code: 'parcel-not-found' });
        await expect(createMcpNavigation({ read: readers() }).selectParcels({ ...args, parcelId: 'west' })).rejects.toMatchObject({ code: 'invalid-parcel-action' });
        await expect(createMcpNavigation({ read: readers() }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'random', parcelId: 'west' })).rejects.toMatchObject({ code: 'invalid-parcel-action' });
        await expect(createMcpNavigation({ read: readers() }).selectParcels({ ...args, radiusM: 1001 })).rejects.toMatchObject({ code: 'invalid-radius' });
        await expect(createMcpNavigation({ read: readers() }).selectParcels({ ...args, unit: 'm' })).rejects.toMatchObject({ code: 'invalid-parcel-action' });
        await expect(createMcpNavigation({ read: readers() }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', radiusM: 250 })).rejects.toMatchObject({ code: 'invalid-parcel-action' });
    });

    it('resolves a point to exactly one parcel and omits an absent point', async () => {
        const read = readers();
        const navigation = createMcpNavigation({ read });
        const selected = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', point: [0.0005, 0.0005] });
        expect(selected.selection).toMatchObject({ focusParcelId: 'west', parcelIds: ['west'] });
        expect(selected).toHaveProperty('point');
        expect(read.parcels).toHaveBeenCalledWith({ city: 'test', parcelSourceId: 'source', geometry: expect.objectContaining({ type: 'Polygon' }) });
        const ambiguous = createMcpNavigation({ read: readers() });
        await expect(ambiguous.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', point: [0.001, 0.0005] })).rejects.toMatchObject({ code: 'parcel-ambiguous' });
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'clear' }))).not.toHaveProperty('point');
    });

    it('enforces the 100-parcel selection cap on input state and add', async () => {
        const navigation = createMcpNavigation({ read: readers() });
        const full = Array.from({ length: 100 }, (_, index) => `id-${index}`);
        await expect(navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'add', parcelId: 'east', selection: { focusParcelId: 'west', parcelIds: full, active: true } })).rejects.toMatchObject({ code: 'parcel-selection-limit' });
        await expect(navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'clear', selection: { parcelIds: [...full, 'extra'] } })).rejects.toMatchObject({ code: 'parcel-selection-limit' });
    });

    it('steps through dense local source coverage without treating fetched feature count as block size', async () => {
        const extras = Array.from({ length: 105 }, (_, index) => {
            const west = 0.0011 + index * 0.00001;
            return { type: 'Feature', id: `extra-${index}`, properties: { parcelId: `extra-${index}` }, geometry: { type: 'Polygon', coordinates: [[[west, 0.0001], [west + 0.000001, 0.0001], [west + 0.000001, 0.000101], [west, 0.000101], [west, 0.0001]]] } };
        });
        const navigation = createMcpNavigation({ read: readers({ result: [...parcels, ...extras] }) });
        const result = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'step', direction: 'east', selection: { focusParcelId: 'west', parcelIds: [], active: false } });
        expect(result.selection.focusParcelId).toBe('east');
    });

    it('uses road-buffer barriers to find the bounded block and fails incomplete coverage', async () => {
        const seed = { type: 'Feature', id: 'seed', properties: { parcelId: 'seed' }, geometry: { type: 'Polygon', coordinates: [[[-0.0002, -0.0002], [0.0002, -0.0002], [0.0002, 0.0002], [-0.0002, 0.0002], [-0.0002, -0.0002]]] } };
        const enclosedRoads = { features: [
            road('north', [[-0.001, 0.001], [0.001, 0.001]]), road('south', [[-0.001, -0.001], [0.001, -0.001]]),
            road('east', [[0.001, -0.001], [0.001, 0.001]]), road('west', [[-0.001, -0.001], [-0.001, 0.001]])
        ] };
        const read = readers({ streets: enclosedRoads, result: [seed] });
        const navigation = createMcpNavigation({ read });
        const block = await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'seed' });
        expect(block.selection.parcelIds).toEqual(['seed']);
        const detached = { type: 'Feature', id: 'detached', properties: { parcelId: 'detached' }, geometry: { type: 'Polygon', coordinates: [[[0.0004, 0.0004], [0.0005, 0.0004], [0.0005, 0.0005], [0.0004, 0.0005], [0.0004, 0.0004]]] } };
        const nonTouching = readers({ streets: enclosedRoads, result: [seed, detached] });
        expect((await createMcpNavigation({ read: nonTouching }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'seed' })).selection.parcelIds).toEqual(['seed', 'detached']);
        const incomplete = readers({ streets: { partial: true, features: [] }, result: [seed] });
        await expect(createMcpNavigation({ read: incomplete }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'seed' })).rejects.toMatchObject({ code: 'street-coverage-incomplete' });
        const oneRoad = readers({ streets: { features: [road('only', [[-0.001, 0], [0.001, 0]])] }, result: [seed] });
        await expect(createMcpNavigation({ read: oneRoad }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'seed' })).rejects.toMatchObject({ code: 'parcel-block-unproven' });
        const bridge = readers({ streets: { features: enclosedRoads.features.map(feature => feature.id === 'north' ? road('north', feature.geometry.coordinates, { highway: 'residential', bridge: 'yes' }) : feature) }, result: [seed] });
        await expect(createMcpNavigation({ read: bridge }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'seed' })).rejects.toMatchObject({ code: 'parcel-block-unproven' });
        expect(read.request).toHaveBeenCalledWith('/blocks/roads', { bbox: expect.any(String) });
        const manyParcels = Array.from({ length: 101 }, (_, index) => {
            const west = -0.0008 + index * 0.000015;
            return { type: 'Feature', id: `inside-${index}`, properties: { parcelId: `inside-${index}` }, geometry: { type: 'Polygon', coordinates: [[[west, -0.00005], [west + 0.000005, -0.00005], [west + 0.000005, 0.00005], [west, 0.00005], [west, -0.00005]]] } };
        });
        const crowded = readers({ streets: enclosedRoads, result: manyParcels });
        await expect(createMcpNavigation({ read: crowded }).selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'inside-0' })).rejects.toMatchObject({ code: 'parcel-block-limit' });
    });

    it.each([
        ['rail', { railway: 'rail' }],
        ['stream', { waterway: 'stream' }]
    ])('selects an enclosed source parcel using %s boundaries through MCP', async (_name, boundary) => {
        const seed = { type: 'Feature', id: 'seed', properties: { parcelId: 'seed' }, geometry: {
            type: 'Polygon', coordinates: [[[-0.0002, -0.0002], [0.0002, -0.0002], [0.0002, 0.0002], [-0.0002, 0.0002], [-0.0002, -0.0002]]] } };
        const boundaries = { features: [
            road('north', [[-0.001, 0.001], [0.001, 0.001]], boundary),
            road('south', [[-0.001, -0.001], [0.001, -0.001]], boundary),
            road('east', [[0.001, -0.001], [0.001, 0.001]], boundary),
            road('west', [[-0.001, -0.001], [-0.001, 0.001]], boundary)
        ] };
        const read = readers({ streets: boundaries, result: [seed] });
        const result = await createMcpNavigation({ read }).selectParcels({
            city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'seed'
        });

        expect(result.selection).toMatchObject({ focusParcelId: 'seed', parcelIds: ['seed'], active: true });
        expect(read.request).toHaveBeenCalledWith('/blocks/roads', { bbox: expect.any(String) });
    });

    it('returns a bounded 100-ID preview on an MCP block limit error without applying it', async () => {
        const inside = Array.from({ length: 101 }, (_, index) => {
            const west = -0.0008 + index * 0.000015;
            return { type: 'Feature', id: `inside-${index}`, properties: { parcelId: `inside-${index}` }, geometry: {
                type: 'Polygon', coordinates: [[[west, -0.00005], [west + 0.000005, -0.00005],
                    [west + 0.000005, 0.00005], [west, 0.00005], [west, -0.00005]]] } };
        });
        const boundaries = { features: [
            road('north', [[-0.001, 0.001], [0.001, 0.001]]), road('south', [[-0.001, -0.001], [0.001, -0.001]]),
            road('east', [[0.001, -0.001], [0.001, 0.001]]), road('west', [[-0.001, -0.001], [-0.001, 0.001]])
        ] };
        const selection = { parcelSourceId: 'source', focusParcelId: 'previous', parcelIds: ['previous'], active: true };
        const before = structuredClone(selection);
        const error = await createMcpNavigation({ read: readers({ streets: boundaries, result: inside }) })
            .selectParcels({ city: 'test', parcelSourceId: 'source', action: 'block', parcelId: 'inside-0', selection })
            .catch(value => value);

        expect(error).toMatchObject({ code: 'parcel-block-limit', constraints: {
            limit: 100, parcelCount: 101, previewParcelIds: expect.arrayContaining(['inside-0'])
        } });
        expect(error.constraints.previewParcelIds).toHaveLength(100);
        expect(error).not.toHaveProperty('selection');
        expect(selection).toEqual(before);
    });

    it('requires explicit source identity and keeps begin, finish and clear deterministic', async () => {
        const navigation = createMcpNavigation({ read: readers() });
        await expect(navigation.selectParcels({ city: 'test', action: 'select', parcelId: 'west' })).rejects.toMatchObject({ code: 'parcel-source-required' });
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'begin', selection: { parcelSourceId: 'source', focusParcelId: 'west', parcelIds: [], active: false } })).selection).toMatchObject({ active: true, parcelIds: ['west'] });
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'finish', selection: { parcelSourceId: 'source', focusParcelId: 'west', parcelIds: ['west'], active: true } })).selection.active).toBe(false);
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'clear' })).selection).toMatchObject({ focusParcelId: null, parcelIds: [], active: false });
    });
});
