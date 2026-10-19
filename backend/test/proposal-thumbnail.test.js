// Tests for the server-side proposal thumbnail renderer: the framing maths (which zoom, which tiles,
// which bbox) and the geometry resolution that decides WHAT the picture is of. Deliberately covers
// only the pure parts — no tiles are fetched, so these are deterministic and offline.
import { describe, it, expect } from 'vitest';
import {
    computeStitchFrame,
    computeBestZoomForBbox,
    normalizeToGeoJSON,
    lngToTileX,
    latToTileY,
    renderProposalThumbnailSet,
    renderProposalThumbnail,
    PAIR_GAP,
    TILE_SIZE
} from '../thumbnails/tile-stitch.js';
import { createCanvas, loadImage } from 'canvas';
import {
    resolveProposalPolygon,
    shouldSkipProposalThumbnail,
    normalizeGoalKey,
    getProposalCadastreParcelIds
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
        // At z14 this is an 8x8 grid (64 tiles per upload). The zoom search now continues below z14
        // until the frame fits the 6x6 budget, so the per-thumbnail cap is 36 tiles.
        expect(frame.zoom).toBe(13);
        expect(frame.tilesX).toBeLessThanOrEqual(6);
        expect(frame.tilesY).toBeLessThanOrEqual(6);
    });

    it('rejects a polygon that is not a polygon', () => {
        expect(() => computeStitchFrame({ polygon: [[15.977, 45.81]], polygonOrder: 'lnglat' }))
            .toThrow(/Invalid polygon/);
    });

    it('rejects an absurd bbox rather than rendering a picture of the whole planet', () => {
        const absurd = [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]];
        expect(() => computeStitchFrame({ polygon: absurd, polygonOrder: 'lnglat' }))
            .toThrow(/invalid bounding box: spans more than/);
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
            roadProposal: { definition: { polygon: { type: 'Polygon', coordinates: ZAGREB_SQUARE } } }
        });
        expect(resolved.polygon).toEqual(ZAGREB_SQUARE);
        expect(resolved.fitToPolygonOnly).toBe(true);
    });

    it('does not invent a second footprint when the canonical corridor polygon is absent', () => {
        const resolved = resolveProposalPolygon({
            goal: 'road-track',
            roadProposal: {
                definition: {
                    width: 8,
                    points: [{ lat: 45.8100, lng: 15.9770 }, { lat: 45.8104, lng: 15.9775 }]
                }
            }
        });
        expect(resolved.polygon).toBeNull();
    });

    it('frames a canonical road proposal even when it has no goal key', () => {
        const resolved = resolveProposalPolygon({
            type: 'road',
            roadProposal: {
                definition: {
                    polygon: { type: 'Polygon', coordinates: ZAGREB_SQUARE }
                }
            }
        });
        expect(resolved.polygon).toEqual(ZAGREB_SQUARE);
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
        const resolved = resolveProposalPolygon({ goal: 'decide-later', cadastreParcelIds: ['HR-1-2'] });
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

    it('reads the proposal\'s single cadastral declaration', () => {
        expect(getProposalCadastreParcelIds({ cadastreParcelIds: ['HR-1-2', 'HR-1-3'] })).toEqual(['HR-1-2', 'HR-1-3']);
        expect(getProposalCadastreParcelIds({ cadastreParcelIds: [42], roadProposal: {} })).toEqual(['42']);
        expect(getProposalCadastreParcelIds({})).toEqual([]);
    });
});

describe('resolveProposalPolygon on a plan of buildings', () => {
    const square = (lng, lat) => [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]];
    const site = { type: 'MultiPolygon', coordinates: [square(15.97, 45.80)] };

    it('draws every building, not the site they share', () => {
        const resolved = resolveProposalPolygon({
            goal: 'buildings', site,
            geometry: { buildings: [
                { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(15.9701, 45.8001) } },
                { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [square(15.9703, 45.8001), square(15.9705, 45.8001)] } }
            ] }
        });
        expect(resolved.polygonOrder).toBe('lnglat');
        expect(resolved.polygon).toEqual([square(15.9701, 45.8001), square(15.9703, 45.8001), square(15.9705, 45.8001)]);
    });

    it('still frames the site when the plan holds no drawable building', () => {
        const resolved = resolveProposalPolygon({ goal: 'buildings', site, geometry: { buildings: [{ type: 'Feature', geometry: null }] } });
        expect(resolved.polygon).toEqual(site.coordinates[0]);
    });
});

// One solid-colour tile for every request: the pictures are then deterministic and offline.
function solidTileSource(hex = '#336699') {
    const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    const bytes = canvas.toBuffer('image/png');
    const requests = [];
    return { requests, getTileBytes: async (tile) => { requests.push(tile); return bytes; } };
}

async function pixelAt(buffer, x, y) {
    const image = await loadImage(buffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, rgba: Array.from(ctx.getImageData(x, y, 1, 1).data) };
}

describe('renderProposalThumbnailSet (dividers.md M3)', () => {
    const PARCEL = [[[15.9768, 45.8098], [15.9777, 45.8098], [15.9777, 45.8106], [15.9768, 45.8106], [15.9768, 45.8098]]];

    it('tags the frame polygons by role so the before picture can leave the proposal out', () => {
        const frame = computeStitchFrame({ polygon: ZAGREB_SQUARE, polygonOrder: 'lnglat', parcelPolygons: [PARCEL], parcelPolygonOrder: 'lnglat' });
        expect(frame.polygons.map(poly => poly.role)).toEqual(['proposal', 'parcel']);
    });

    it('frames every plan part and keeps overlapping fills and each part’s holes independent', async () => {
        const outer = [[15.9770, 45.8100], [15.9776, 45.8100], [15.9776, 45.8106], [15.9770, 45.8106], [15.9770, 45.8100]];
        const hole = [[15.9772, 45.8102], [15.9773, 45.8102], [15.9773, 45.8103], [15.9772, 45.8103], [15.9772, 45.8102]];
        const overlap = [[15.9774, 45.8103], [15.9780, 45.8103], [15.9780, 45.8108], [15.9774, 45.8108], [15.9774, 45.8103]];
        const parts = [[outer, hole], [overlap]];
        const frame = computeStitchFrame({ polygonParts: parts, polygonOrder: 'lnglat' });
        expect(frame.polygons).toHaveLength(2);
        expect(frame.polygons.map(poly => poly.coords)).toEqual(parts);
        expect(frame.lngMax).toBeGreaterThan(15.9780);

        const set = await renderProposalThumbnailSet({ polygonParts: parts, polygonOrder: 'lnglat',
            tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileSource: solidTileSource() });
        const pixel = async (coordinate) => {
            const point = (await import('../thumbnails/tile-stitch.js')).lngLatToPixel(...coordinate, set.frame.xMin, set.frame.yMin, set.frame.zoom);
            return pixelAt(set.after.buffer, Math.round(point.px), Math.round(point.py));
        };
        const inHole = await pixel([15.97725, 45.81025]);
        const inOverlap = await pixel([15.9775, 45.81045]);
        expect(inHole.rgba).toEqual([0x33, 0x66, 0x99, 255]);
        expect(inOverlap.rgba[0]).toBeGreaterThan(0x33);
    });

    it('draws the thumbnail, the same ground without the proposal, and the pair from one tile fetch', async () => {
        const tileSource = solidTileSource();
        const options = { polygon: ZAGREB_SQUARE, polygonOrder: 'lnglat', parcelPolygons: [PARCEL], parcelPolygonOrder: 'lnglat',
            badge: { text: '🏠' }, tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileSource };
        const set = await renderProposalThumbnailSet(options);
        const frame = set.frame;
        expect(set.tiles).toEqual({ loaded: frame.tilesX * frame.tilesY, failed: 0, total: frame.tilesX * frame.tilesY });
        expect(tileSource.requests).toHaveLength(frame.tilesX * frame.tilesY);

        // The proposal's centre: orange fill over the tile in "after", the bare tile in "before".
        const centre = ZAGREB_SQUARE[0].slice(0, 4).reduce((acc, c) => [acc[0] + c[0] / 4, acc[1] + c[1] / 4], [0, 0]);
        const { px, py } = (await import('../thumbnails/tile-stitch.js')).lngLatToPixel(centre[0], centre[1], frame.xMin, frame.yMin, frame.zoom);
        const after = await pixelAt(set.after.buffer, Math.round(px), Math.round(py));
        const before = await pixelAt(set.before.buffer, Math.round(px), Math.round(py));
        expect(before.rgba).toEqual([0x33, 0x66, 0x99, 255]);
        expect(after.rgba).not.toEqual(before.rgba);
        expect(after.rgba[0]).toBeGreaterThan(before.rgba[0]);
        expect([after.width, after.height]).toEqual([frame.canvasWidth, frame.canvasHeight]);
        expect([before.width, before.height]).toEqual([frame.canvasWidth, frame.canvasHeight]);

        // The pair: before on the left, a white gap, after on the right.
        const pair = await pixelAt(set.pair.buffer, Math.round(px), Math.round(py));
        expect([pair.width, pair.height]).toEqual([frame.canvasWidth * 2 + PAIR_GAP, frame.canvasHeight]);
        expect(pair.rgba).toEqual(before.rgba);
        const gap = await pixelAt(set.pair.buffer, frame.canvasWidth + Math.floor(PAIR_GAP / 2), Math.round(py));
        expect(gap.rgba).toEqual([255, 255, 255, 255]);
        const right = await pixelAt(set.pair.buffer, frame.canvasWidth + PAIR_GAP + Math.round(px), Math.round(py));
        expect(right.rgba).toEqual(after.rgba);

        // The single-picture renderer is the "after" of the set.
        const single = await renderProposalThumbnail(options);
        expect(single.buffer.equals(set.after.buffer)).toBe(true);
        expect(single.frame.zoom).toBe(frame.zoom);
    });
});
