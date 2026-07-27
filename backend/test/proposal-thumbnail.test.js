// Tests for the server-side proposal thumbnail renderer: the framing maths (which zoom, which tiles,
// which bbox) and the geometry resolution that decides WHAT the picture is of. Deliberately covers
// only the pure parts — no tiles are fetched, so these are deterministic and offline.
import { describe, it, expect } from 'vitest';
import {
    computeStitchFrame,
    computeBestZoomForBbox,
    normalizeToGeoJSON,
    lngToTileX,
    latToTileY
} from '../thumbnails/tile-stitch.js';
import {
    resolveProposalPolygon,
    shouldSkipProposalThumbnail,
    normalizeGoalKey,
    getProposalParentParcelIds
} from '../thumbnails/proposal-thumbnail.js';

// A small square in Zagreb (~40m across), in GeoJSON [lng, lat] order.
const ZAGREB_SQUARE = [[
    [15.9770, 45.8100],
    [15.9775, 45.8100],
    [15.9775, 45.8104],
    [15.9770, 45.8104],
    [15.9770, 45.8100]
]];

describe('tile maths', () => {
    it('maps Zagreb lng/lat onto the expected slippy tile at zoom 19', () => {
        expect(lngToTileX(15.9770, 19)).toBe(285412);
        expect(latToTileY(45.8100, 19)).toBe(186919);
    });

    it('drops the zoom until the bbox fits the tile budget', () => {
        // A whole-city bbox cannot fit in 6 tiles at z19, so it must come back at the floor.
        expect(computeBestZoomForBbox(15.8, 16.1, 45.75, 45.85, 6, 14, 19)).toBe(14);
        // A single small block fits at full zoom.
        expect(computeBestZoomForBbox(15.9770, 15.9775, 45.8100, 45.8104, 6, 14, 19)).toBe(19);
    });
});

describe('normalizeToGeoJSON', () => {
    it('passes through [lng, lat] rings when told the order is lnglat', () => {
        const out = normalizeToGeoJSON(ZAGREB_SQUARE, 'lnglat');
        expect(out[0][0]).toEqual([15.9770, 45.8100]);
    });

    it('swaps Leaflet [lat, lng] rings into GeoJSON order', () => {
        const leafletRing = [[45.8100, 15.9770], [45.8100, 15.9775], [45.8104, 15.9775]];
        const out = normalizeToGeoJSON(leafletRing, 'latlng');
        expect(out[0]).toEqual([15.9770, 45.8100]);
    });

    it('accepts a GeoJSON Polygon geometry object', () => {
        const out = normalizeToGeoJSON({ type: 'Polygon', coordinates: ZAGREB_SQUARE }, 'lnglat');
        expect(out[0][0]).toEqual([15.9770, 45.8100]);
    });

    it('takes the first polygon of a MultiPolygon geometry', () => {
        const out = normalizeToGeoJSON({ type: 'MultiPolygon', coordinates: [ZAGREB_SQUARE] }, 'lnglat');
        expect(out[0][0]).toEqual([15.9770, 45.8100]);
    });
});

describe('computeStitchFrame', () => {
    it('frames a known polygon deterministically', () => {
        const frame = computeStitchFrame({
            polygon: ZAGREB_SQUARE,
            polygonOrder: 'lnglat',
            padding: 0.12,
            zoom: 19
        });

        // 12% padding on each side of the polygon's own bbox.
        expect(frame.lngMin).toBeCloseTo(15.9770 - 0.0005 * 0.12, 9);
        expect(frame.lngMax).toBeCloseTo(15.9775 + 0.0005 * 0.12, 9);
        expect(frame.latMin).toBeCloseTo(45.8100 - 0.0004 * 0.12, 9);
        expect(frame.latMax).toBeCloseTo(45.8104 + 0.0004 * 0.12, 9);

        // This square straddles a tile boundary, so it needs a 2x2 grid at full zoom.
        expect(frame.zoom).toBe(19);
        expect(frame.xMin).toBe(285412);
        expect(frame.yMin).toBe(186918);
        expect(frame.tilesX).toBe(2);
        expect(frame.tilesY).toBe(2);
        expect(frame.canvasWidth).toBe(512);
        expect(frame.canvasHeight).toBe(512);

        // The proposal polygon is drawn first, in orange.
        expect(frame.polygons[0].style.color).toBe('#ff6600');
        expect(frame.polygons[0].style.fillOpacity).toBeGreaterThan(0);
    });

    it('expands the frame to keep parent parcels in view', () => {
        const parcel = [[
            [15.9760, 45.8095],
            [15.9785, 45.8095],
            [15.9785, 45.8110],
            [15.9760, 45.8110],
            [15.9760, 45.8095]
        ]];

        const withoutParcel = computeStitchFrame({ polygon: ZAGREB_SQUARE, polygonOrder: 'lnglat', padding: 0 });
        const withParcel = computeStitchFrame({
            polygon: ZAGREB_SQUARE,
            parcelPolygons: [parcel],
            polygonOrder: 'lnglat',
            parcelPolygonOrder: 'lnglat',
            padding: 0
        });

        expect(withParcel.lngMin).toBeLessThan(withoutParcel.lngMin);
        expect(withParcel.lngMax).toBeGreaterThan(withoutParcel.lngMax);
        expect(withParcel.latMin).toBeLessThan(withoutParcel.latMin);
        expect(withParcel.latMax).toBeGreaterThan(withoutParcel.latMax);

        // The parcel is drawn as a dashed black outline on top of the proposal polygon.
        expect(withParcel.polygons).toHaveLength(2);
        expect(withParcel.polygons[1].style.dashArray).toBe('3 2');
    });

    it('honours fitToPolygonOnly: parcels are drawn but never move the frame', () => {
        const parcel = [[
            [15.9700, 45.8000],
            [15.9800, 45.8000],
            [15.9800, 45.8200],
            [15.9700, 45.8200],
            [15.9700, 45.8000]
        ]];

        const pinned = computeStitchFrame({
            polygon: ZAGREB_SQUARE,
            parcelPolygons: [parcel],
            polygonOrder: 'lnglat',
            parcelPolygonOrder: 'lnglat',
            padding: 0,
            fitToPolygonOnly: true
        });
        const bare = computeStitchFrame({ polygon: ZAGREB_SQUARE, polygonOrder: 'lnglat', padding: 0 });

        expect(pinned.lngMin).toBeCloseTo(bare.lngMin, 12);
        expect(pinned.lngMax).toBeCloseTo(bare.lngMax, 12);
        expect(pinned.latMin).toBeCloseTo(bare.latMin, 12);
        expect(pinned.latMax).toBeCloseTo(bare.latMax, 12);
        expect(pinned.polygons).toHaveLength(2); // still drawn
    });

    it('drops the zoom for a huge proposal instead of fetching thousands of tiles', () => {
        const wide = [[
            [15.90, 45.75],
            [16.05, 45.75],
            [16.05, 45.85],
            [15.90, 45.85],
            [15.90, 45.75]
        ]];
        const frame = computeStitchFrame({ polygon: wide, polygonOrder: 'lnglat', padding: 0.05, zoom: 19 });
        // Nothing fits the 6-tile budget here, so it bottoms out at the zoom floor (14) — same as the
        // browser did. The hard cap that matters is the tile count, which stays well under the limit.
        expect(frame.zoom).toBe(14);
        expect(frame.tilesX * frame.tilesY).toBe(64);
        expect(frame.tilesX * frame.tilesY).toBeLessThanOrEqual(100);
    });

    it('rejects a polygon that is not a polygon', () => {
        expect(() => computeStitchFrame({ polygon: [[15.977, 45.81]], polygonOrder: 'lnglat' }))
            .toThrow(/Invalid polygon/);
    });

    it('rejects an absurd bbox rather than rendering a picture of the whole planet', () => {
        const absurd = [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]];
        expect(() => computeStitchFrame({ polygon: absurd, polygonOrder: 'lnglat' }))
            .toThrow(/Invalid bounding box/);
    });
});

describe('resolveProposalPolygon', () => {
    it('frames a building proposal on its building footprint', () => {
        const resolved = resolveProposalPolygon({
            goal: 'single',
            buildingGeometry: { type: 'Polygon', coordinates: ZAGREB_SQUARE }
        });
        expect(resolved.polygon).toEqual(ZAGREB_SQUARE);
        expect(resolved.polygonOrder).toBe('lnglat');
        expect(resolved.fitToPolygonOnly).toBeFalsy();
    });

    it('frames a road proposal on its corridor, pinned to the corridor only', () => {
        const resolved = resolveProposalPolygon({
            goal: 'road-track',
            roadProposal: { polygon: { type: 'Polygon', coordinates: ZAGREB_SQUARE } }
        });
        expect(resolved.polygon).toEqual(ZAGREB_SQUARE);
        expect(resolved.fitToPolygonOnly).toBe(true);
    });

    it('buffers a road centerline when the corridor polygon was never stored', () => {
        const resolved = resolveProposalPolygon({
            goal: 'road-track',
            roadProposal: {
                definition: {
                    width: 8,
                    points: [{ lat: 45.8100, lng: 15.9770 }, { lat: 45.8104, lng: 15.9775 }]
                }
            }
        });
        expect(resolved.polygon).toBeTruthy();
        expect(resolved.fitToPolygonOnly).toBe(true);
        expect(resolved.polygon[0].length).toBeGreaterThan(3);
    });

    it('still frames an old road proposal that has a roadProposal but no goal key', () => {
        // These exist in the wild (type 'road'/'Track', no `goal`). The browser only matched the exact
        // key 'road-track', so it silently drew nothing for them.
        const resolved = resolveProposalPolygon({
            type: 'road',
            roadProposal: {
                definition: {
                    width: 7.5,
                    points: [{ lat: 45.8100, lng: 15.9770 }, { lat: 45.8104, lng: 15.9775 }]
                }
            }
        });
        expect(resolved.polygon).toBeTruthy();
        expect(resolved.fitToPolygonOnly).toBe(true);
    });

    it('frames a structure proposal on its structure geometry', () => {
        const resolved = resolveProposalPolygon({
            goal: 'park',
            structureProposal: { geometry: { type: 'Polygon', coordinates: ZAGREB_SQUARE } }
        });
        expect(resolved.polygon).toEqual(ZAGREB_SQUARE);
    });

    it('returns no polygon for a parcel-only proposal (the caller unions the parents instead)', () => {
        const resolved = resolveProposalPolygon({ goal: 'decide-later', parentParcelIds: ['HR-1-2'] });
        expect(resolved.polygon).toBeNull();
    });
});

describe('goal handling', () => {
    it('normalizes goal aliases the way the frontend does', () => {
        expect(normalizeGoalKey('buildings')).toBe('single');
        expect(normalizeGoalKey('road track')).toBe('road-track');
        expect(normalizeGoalKey('Ownership Transfer To Me')).toBe('ownership-transfer-to-me');
    });

    it('skips goals that have no map geometry to draw', () => {
        expect(shouldSkipProposalThumbnail({ goal: 'urban-rule' })).toBe(true);
        expect(shouldSkipProposalThumbnail({ goal: 'ownership-transfer' })).toBe(true);
        expect(shouldSkipProposalThumbnail({ goal: 'single' })).toBe(false);
        expect(shouldSkipProposalThumbnail({ goal: 'road-track' })).toBe(false);
    });

    it('reads parent parcel ids from the proposal or its road proposal', () => {
        expect(getProposalParentParcelIds({ parentParcelIds: ['HR-1-2', 'HR-1-3'] })).toEqual(['HR-1-2', 'HR-1-3']);
        expect(getProposalParentParcelIds({ roadProposal: { parentParcelIds: [42] } })).toEqual(['42']);
        expect(getProposalParentParcelIds({})).toEqual([]);
    });
});
