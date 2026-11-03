import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const bbox = [-0.01, -0.01, 0.02, 0.02];
const square = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];
const feature = (id, properties, coordinates) => ({ type: 'Feature', id, properties,
    geometry: { type: 'LineString', coordinates } });
const roadsFor = properties => turf.featureCollection(square.slice(1).map((end, index) =>
    feature(`edge-${index}`, properties, [square[index], end])));

describe('urban block ground boundaries', () => {
    it.each([
        ['unnamed footway', { highway: 'footway' }],
        ['unnamed cycleway', { highway: 'cycleway' }],
        ['track', { highway: 'track' }],
        ['railway', { railway: 'rail' }],
        ['tram', { railway: 'tram' }],
        ['river', { waterway: 'river' }],
        ['canal', { waterway: 'canal' }],
        ['stream', { waterway: 'stream' }],
        ['coastline', { natural: 'coastline' }]
    ])('uses %s ways as ground block boundaries', (_name, properties) => {
        const blocks = model.detectBlocks(roadsFor(properties), bbox, turf);
        expect(blocks.features).toHaveLength(1);
    });

    it('keeps source type fields and existing ground-level exclusions', () => {
        expect(model.isGroundBoundary({ railway_type: 'tram' })).toBe(true);
        expect(model.isGroundBoundary({ waterway_type: 'river' })).toBe(true);
        expect(model.isGroundBoundary({ highway: 'footway', bridge: 'yes' })).toBe(false);
        expect(model.isGroundBoundary({ railway: 'rail', tunnel: 'yes' })).toBe(false);
        expect(model.isGroundBoundary({ natural: 'water', layer: '1' })).toBe(false);
        expect(model.isGroundBoundary({ isTrack: true })).toBe(true);
        expect(model.isGroundBoundary({ isCorridor: true })).toBe(true);
        expect(model.isGroundRoad({ highway: 'footway' })).toBe(true);
        expect(model.isGroundRoad({ railway: 'tram' })).toBe(false);
    });

    it('uses supplied polygon rings as boundaries', () => {
        const polygon = { type: 'Feature', id: 'corridor-area', properties: { isTrack: true },
            geometry: { type: 'Polygon', coordinates: [square] } };
        expect(model.detectBlocks(turf.featureCollection([polygon]), bbox, turf).features).toHaveLength(1);
    });

    it.each(['workshop', 'roundhouse', 'station', 'platform', 'signal_box'])('does not turn a railway %s into an enclosure', railway => {
        const building = feature('rail-facility', { railway, building: 'industrial' }, [
            [0.002, 0.002], [0.008, 0.002], [0.008, 0.008], [0.002, 0.008], [0.002, 0.002]
        ]);
        const blocks = model.detectBlocks(turf.featureCollection([...roadsFor({ railway: 'rail' }).features, building]), bbox, turf);
        expect(blocks.features).toHaveLength(1);
        expect(blocks.features[0].geometry.coordinates).toHaveLength(1);
        expect(model.isGroundBoundary({ railway_type: railway })).toBe(false);
    });

    it('keeps shores as boundaries while excluding mapped water and retaining its land holes', () => {
        const shore = [[0.002, 0.002], [0.008, 0.002], [0.008, 0.008], [0.002, 0.008], [0.002, 0.002]];
        const island = [[0.004, 0.004], [0.006, 0.004], [0.006, 0.006], [0.004, 0.006], [0.004, 0.004]];
        const water = { type: 'Feature', id: 'lake', properties: { waterway: 'riverbank' },
            geometry: { type: 'Polygon', coordinates: [shore, island.slice().reverse()] } };
        const roads = turf.featureCollection([
            ...square.slice(1).map((end, index) => feature(`road-${index}`, { highway: 'residential' }, [square[index], end])),
            water
        ]);
        const blocks = model.detectBlocks(roads, bbox, turf);

        expect(blocks.features).toHaveLength(2); // surrounding land and the land island in the hole
        expect(blocks.features.some(block => turf.booleanPointInPolygon(turf.point([0.001, 0.001]), block))).toBe(true);
        expect(blocks.features.some(block => turf.booleanPointInPolygon(turf.point([0.005, 0.005]), block))).toBe(true);
        expect(blocks.features.some(block => turf.booleanPointInPolygon(turf.point([0.003, 0.005]), block))).toBe(false);

        const closedWay = feature('closed-lake', { natural: 'water' }, shore);
        const wayBlocks = model.detectBlocks(turf.featureCollection([
            ...square.slice(1).map((end, index) => feature(`way-road-${index}`, { highway: 'residential' }, [square[index], end])),
            closedWay
        ]), bbox, turf);
        expect(wayBlocks.features).toHaveLength(1); // outer land only; the closed way's inner face is water
    });

    it('does not use elevated water surfaces as ground masks', () => {
        const lake = { type: 'Feature', id: 'raised-lake', properties: { natural: 'water', layer: '1' },
            geometry: { type: 'Polygon', coordinates: [[[0.002, 0.002], [0.008, 0.002], [0.008, 0.008], [0.002, 0.008], [0.002, 0.002]]] } };
        const blocks = model.detectBlocks(turf.featureCollection([
            ...square.slice(1).map((end, index) => feature(`level-road-${index}`, { highway: 'residential' }, [square[index], end])), lake
        ]), bbox, turf);
        expect(blocks.features).toHaveLength(1);
        expect(blocks.features[0].geometry.coordinates).toHaveLength(1);
    });

    it('assigns a spanning parcel to one strict representative-point enclosure', () => {
        const blocks = turf.featureCollection([
            turf.polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], { id: 'west' }),
            turf.polygon([[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]], { id: 'east' })
        ]);
        const spanning = turf.polygon([[[0.25, 0.2], [1.5, 0.2], [1.5, 0.8], [0.25, 0.8], [0.25, 0.2]]], { parcelId: 'span' });
        const westParcel = turf.polygon([[[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2], [0.1, 0.1]]], { parcelId: 'west-parcel' });
        const eastParcel = turf.polygon([[[1.7, 0.1], [1.8, 0.1], [1.8, 0.2], [1.7, 0.2], [1.7, 0.1]]], { parcelId: 'east-parcel' });
        const west = blocks.features[0], east = blocks.features[1];

        expect(model.enclosureForParcel(blocks, spanning, turf)).toBe(west);
        expect(model.parcelIdsInBlock(west, [spanning, westParcel, eastParcel], turf).sort())
            .toEqual(['span', 'west-parcel']);
        expect(model.parcelIdsInBlock(east, [spanning, westParcel, eastParcel], turf))
            .toEqual(['east-parcel']);
        expect(model.enclosureForParcel(blocks, null, turf)).toBeNull();
    });
});
