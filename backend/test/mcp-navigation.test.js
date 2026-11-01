import { describe, expect, it, vi } from 'vitest';
import { createMcpNavigation } from '../agents/mcp-navigation.js';

const square = (id, west, east) => ({ type: 'Feature', id, properties: { parcelId: id }, geometry: { type: 'Polygon', coordinates: [[[west, 0], [east, 0], [east, 0.001], [west, 0.001], [west, 0]]] } });
const parcels = [square('west', 0, 0.001), square('east', 0.001, 0.002), square('far-east', 0.002, 0.003)];
function readers({ streets = { features: [] }, result = parcels } = {}) {
    return {
        parcels: vi.fn(async ({ parcelIds } = {}) => ({ complete: true,
            features: parcelIds ? result.filter(f => parcelIds.includes(f.id)) : result })),
        request: vi.fn(async () => streets)
    };
}
const road = (id, coordinates, properties = { highway: 'residential' }) => ({ type: 'Feature', id, properties, geometry: { type: 'LineString', coordinates } });

describe('MCP map navigation', () => {
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

    it('requires explicit source identity and keeps begin, finish and clear deterministic', async () => {
        const navigation = createMcpNavigation({ read: readers() });
        await expect(navigation.selectParcels({ city: 'test', action: 'select', parcelId: 'west' })).rejects.toMatchObject({ code: 'parcel-source-required' });
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'begin', selection: { parcelSourceId: 'source', focusParcelId: 'west', parcelIds: [], active: false } })).selection).toMatchObject({ active: true, parcelIds: ['west'] });
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'finish', selection: { parcelSourceId: 'source', focusParcelId: 'west', parcelIds: ['west'], active: true } })).selection.active).toBe(false);
        expect((await navigation.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'clear' })).selection).toMatchObject({ focusParcelId: null, parcelIds: [], active: false });
    });
});
