// Regression for a road definition whose authoritative cut is a MultiPolygon. Extending a road can
// make its cached union temporarily/discontinuously multipart; choosing only the largest component
// makes an unrelated old component disappear from the cut and changes parcels far from the edit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const parcelContiguity = require('../../frontend/js/proposals/parcel-contiguity.js');
const { syntheticParcelAllocatorKey } = require('../../frontend/js/synthetic-parcel-identity.js');

const GLOBAL_KEYS = [
    'window', 'turf', 'L', 'proposalStorage', 'corridorIsTrack',
    'syntheticParcelAllocatorKey',
    '_ensurePolygonIsClosed', '_extractPolygonsWithHolesFromGeometry',
    '_calculateAreaFromLatLngPolygon', '_calculateGeoJsonArea', '_geometryHash'
];
const saved = {};

const LON = 15.96;
const LAT = 45.80;

function rect(dx0, dy0, dx1, dy1) {
    return {
        type: 'Polygon',
        coordinates: [[
            [LON + dx0 * 1e-3, LAT + dy0 * 1e-3],
            [LON + dx1 * 1e-3, LAT + dy0 * 1e-3],
            [LON + dx1 * 1e-3, LAT + dy1 * 1e-3],
            [LON + dx0 * 1e-3, LAT + dy1 * 1e-3],
            [LON + dx0 * 1e-3, LAT + dy0 * 1e-3]
        ]]
    };
}

function closed(ring) {
    const out = ring.map(point => point.slice());
    const first = out[0];
    const last = out[out.length - 1];
    if (!last || last[0] !== first[0] || last[1] !== first[1]) out.push(first.slice());
    return out;
}

beforeEach(() => {
    GLOBAL_KEYS.forEach(key => { saved[key] = globalThis[key]; });
    globalThis.turf = turf;
    globalThis.window = {
        turf,
        __formationEdit: formationEdit,
        __parcelContiguity: parcelContiguity,
        isRoadParcel: () => false
    };
    globalThis.L = {
        latLng: (lat, lng) => ({ lat, lng }),
        geoJSON: () => ({})
    };
    globalThis.proposalStorage = { getAllProposals: () => [] };
    globalThis.corridorIsTrack = () => false;
    globalThis.syntheticParcelAllocatorKey = syntheticParcelAllocatorKey;
    globalThis._ensurePolygonIsClosed = closed;
    globalThis._extractPolygonsWithHolesFromGeometry = geometry => {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') {
            return [{ outer: geometry.coordinates[0], holes: geometry.coordinates.slice(1) }];
        }
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(poly => ({ outer: poly[0], holes: poly.slice(1) }));
        }
        return [];
    };
    globalThis._calculateAreaFromLatLngPolygon = latLngs => turf.area(turf.polygon([
        latLngs.map(point => [point.lng, point.lat])
    ]));
    globalThis._calculateGeoJsonArea = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
    globalThis._geometryHash = coordinates => JSON.stringify(coordinates);
});

afterEach(() => {
    GLOBAL_KEYS.forEach(key => {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
    });
});

describe('_buildChildFeaturesFromDefinition — authoritative corridor geometry', () => {
    it('cuts with every MultiPolygon component and mints one contiguous road parcel per component', () => {
        const parentGeometry = rect(0, 0, 6, 4);
        const firstRoadPart = rect(1, 0, 1.5, 4);
        const secondRoadPart = rect(4, 0, 4.5, 4);
        const fullRoadGeometry = {
            type: 'MultiPolygon',
            coordinates: [firstRoadPart.coordinates, secondRoadPart.coordinates]
        };
        const parent = {
            type: 'Feature',
            properties: {
                parcelId: 'HR-A',
                BROJ_CESTICE: 'A',
                rootParcelId: 'HR-A',
                rootParcelNumber: 'A'
            },
            geometry: parentGeometry
        };
        const proposal = {
            proposalId: 'p-road',
            title: 'Road',
            author: 'City',
            roadProposal: {
                definition: {
                    polygon: fullRoadGeometry,
                    metadata: { isCorridor: true },
                    points: []
                }
            }
        };

        const children = ProposalManager._buildChildFeaturesFromDefinition(
            proposal.proposalId, proposal, [parent], { uncutParentIds: [] }
        );
        const corridor = children.filter(feature => feature.properties.isCorridor === true);
        const remainders = children.filter(feature => feature.properties.isCorridor !== true);

        expect(corridor).toHaveLength(2);
        expect(corridor.every(feature => feature.geometry.type === 'Polygon')).toBe(true);
        const corridorArea = corridor.reduce((sum, feature) => sum + turf.area(feature), 0);
        expect(corridorArea).toBeCloseTo(turf.area({ type: 'Feature', properties: {}, geometry: fullRoadGeometry }), 3);

        const remainderArea = remainders.reduce((sum, feature) => sum + turf.area(feature), 0);
        const expectedRemainder = turf.area({ type: 'Feature', properties: {}, geometry: parentGeometry }) - corridorArea;
        expect(remainderArea).toBeCloseTo(expectedRemainder, 3);
    });
});
