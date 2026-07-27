// Server-side port of frontend/js/map-screenshot.js `captureViaTileStitch`: fetch the basemap tiles
// covering a proposal's geometry, stitch them onto a canvas, draw the proposal polygon (plus parcel
// and neighbour outlines) on top, and return PNG bytes. Deliberately the same tile math, zoom
// selection, padding and draw order as the browser, so a server-rendered thumbnail frames a proposal
// the same way the client used to. Uses node-canvas (same Canvas 2D API as the browser), NOT a
// headless browser and NOT leaflet-image — no live Leaflet map is involved anywhere in this path.
import { createCanvas, loadImage } from 'canvas';

const DEFAULT_TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
const TILE_SIZE = 256;
const DEFAULT_STITCH_ZOOM = 19;
const MAX_STITCH_TILES_PER_AXIS = 6; // Target max ~36 tiles (6x6)
const MAX_TILES = 100;
const DEFAULT_TILE_TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────────────────
// Tile math: convert WGS84 (lat/lng) ⇔ tile coordinates at zoom z
// ─────────────────────────────────────────────────────────────────────────

export function lngToTileX(lng, z) {
    return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}

export function latToTileY(lat, z) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, z);
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
}

/**
 * Convert a WGS84 coordinate to pixel position within a stitched tile grid.
 */
export function lngLatToPixel(lng, lat, xMin, yMin, z) {
    const n = Math.pow(2, z);
    const globalX = ((lng + 180) / 360) * n * TILE_SIZE;
    const latRad = (lat * Math.PI) / 180;
    const globalY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE_SIZE;
    return { px: globalX - xMin * TILE_SIZE, py: globalY - yMin * TILE_SIZE };
}

/**
 * Compute the best zoom level so that the bbox fits within maxTilesPerAxis tiles.
 */
export function computeBestZoomForBbox(lngMin, lngMax, latMin, latMax, maxTilesPerAxis = MAX_STITCH_TILES_PER_AXIS, minZoom = 14, maxZoom = 19) {
    for (let z = maxZoom; z >= minZoom; z--) {
        const xMin = lngToTileX(lngMin, z);
        const xMax = lngToTileX(lngMax, z);
        const yMin = latToTileY(latMax, z);
        const yMax = latToTileY(latMin, z);
        if ((xMax - xMin + 1) <= maxTilesPerAxis && (yMax - yMin + 1) <= maxTilesPerAxis) {
            return z;
        }
    }
    return minZoom;
}

function expandTileUrl(template, x, y, z) {
    const subdomains = ['a', 'b', 'c'];
    const s = subdomains[(x + y) % subdomains.length];
    return template
        .replace('{s}', s)
        .replace('{x}', String(x))
        .replace('{y}', String(y))
        .replace('{z}', String(z));
}

/**
 * Normalize various polygon formats to GeoJSON [lng, lat] rings.
 * Server-side variant of the browser's normalizeToGeoJSON: the Leaflet-bounds disambiguation branch
 * is gone (there is no L on the server) — callers pass an explicit order hint, and the magnitude
 * heuristic covers the rest.
 * @param {string} inputOrder - 'lnglat' (already GeoJSON), 'latlng' (Leaflet order), or 'auto'
 */
export function normalizeToGeoJSON(polygon, inputOrder = 'auto') {
    if (!polygon) return null;

    const orderHint = inputOrder === true ? 'lnglat' : (inputOrder === false ? 'auto' : inputOrder);

    const normalizePair = (a, b) => {
        if (orderHint === 'lnglat') return [a, b];
        if (orderHint === 'latlng') return [b, a];
        if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [a, b];
        if (Math.abs(b) > 90 && Math.abs(a) <= 90) return [b, a];
        return [b, a]; // Default to Leaflet order, as the browser does
    };

    if (Array.isArray(polygon) && polygon.length > 0) {
        const first = polygon[0];

        // MultiPolygon: [[[ [lng,lat], ... ]], ...] → flatten to array of rings
        if (Array.isArray(first) && Array.isArray(first[0]) && Array.isArray(first[0][0]) && typeof first[0][0][0] === 'number') {
            return polygon
                .flatMap(poly => (Array.isArray(poly) ? poly : []))
                .map(ring => (Array.isArray(ring) ? ring.map(c => normalizePair(c[0], c[1])) : ring))
                .filter(ring => Array.isArray(ring) && ring.length >= 3);
        }

        // Polygon with rings/holes: [ring, hole1, ...]
        if (Array.isArray(first) && Array.isArray(first[0]) && first[0].length >= 2 && typeof first[0][0] === 'number') {
            return polygon.map(ring => ring.map(c => normalizePair(c[0], c[1])));
        }

        // Flat ring: [[lng,lat], ...]
        if (Array.isArray(first) && first.length >= 2 && typeof first[0] === 'number') {
            return polygon.map(c => normalizePair(c[0], c[1]));
        }

        // Array of {lat, lng} objects
        if (first && typeof first === 'object' && 'lat' in first && 'lng' in first) {
            return polygon.map(c => [c.lng, c.lat]);
        }
    }

    // GeoJSON geometry object
    if (polygon && typeof polygon === 'object' && typeof polygon.type === 'string' && Array.isArray(polygon.coordinates)) {
        if (polygon.type === 'Polygon') {
            return polygon.coordinates.map(ring => ring.map(c => normalizePair(c[0], c[1])));
        }
        if (polygon.type === 'MultiPolygon' && Array.isArray(polygon.coordinates[0])) {
            return polygon.coordinates[0].map(ring => ring.map(c => normalizePair(c[0], c[1])));
        }
    }

    return null;
}

function outerRingOf(norm) {
    if (!Array.isArray(norm) || !norm.length) return null;
    if (Array.isArray(norm[0]) && Array.isArray(norm[0][0])) return norm[0];
    if (Array.isArray(norm[0]) && typeof norm[0][0] === 'number') return norm;
    return null;
}

/**
 * Pure framing step: from the proposal polygon (+ optional parcel/neighbour outlines) work out the
 * padded bbox, the zoom that keeps the tile grid small, and the styled polygon list to draw.
 * Split out of the render so the framing can be asserted in tests without fetching a single tile.
 *
 * @returns {{ lngMin, lngMax, latMin, latMax, zoom, xMin, xMax, yMin, yMax, tilesX, tilesY,
 *             canvasWidth, canvasHeight, polygons }}
 */
export function computeStitchFrame(options = {}) {
    const {
        polygon,
        padding = 0.05,
        parcelPolygons = [],
        zoom = DEFAULT_STITCH_ZOOM,
        polygonOrder = 'auto',
        parcelPolygonOrder = 'auto',
        fitToPolygonOnly = false,
        maxTilesPerAxis = MAX_STITCH_TILES_PER_AXIS
    } = options;

    const geoCoords = normalizeToGeoJSON(polygon, polygonOrder);
    const outerRing = outerRingOf(geoCoords);
    if (!outerRing || outerRing.length < 3) {
        throw new Error('Invalid polygon for tile stitch capture');
    }

    let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
    const expandBbox = (coords) => {
        const walk = (node) => {
            if (!Array.isArray(node)) return;
            if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
                if (node[0] < lngMin) lngMin = node[0];
                if (node[0] > lngMax) lngMax = node[0];
                if (node[1] < latMin) latMin = node[1];
                if (node[1] > latMax) latMax = node[1];
                return;
            }
            node.forEach(walk);
        };
        walk(coords);
    };
    expandBbox(geoCoords);

    // Sanity check: detect swapped lat/lng coordinates (GeoJSON is [lng, lat]).
    const obviouslySwapped = (lngMin > 90 || lngMax > 90 || latMin < -90 || latMax < -90);
    const zagrebSwapped = (lngMin > 40 && lngMax < 50 && latMin > 10 && latMax < 20);
    if (obviouslySwapped || zagrebSwapped) {
        const tmpLngMin = lngMin, tmpLngMax = lngMax;
        lngMin = latMin;
        lngMax = latMax;
        latMin = tmpLngMin;
        latMax = tmpLngMax;
    }

    const normalizeOrder = (order) => (order === 'lnglat' || order === 'latlng') ? order : 'auto';

    // Draw order matches the browser: the proposal polygon first, then the parent parcel outlines.
    //
    // The browser also had a third "neighbours" layer (surrounding parcels, heavy dashed outlines).
    // It is deliberately not reproduced here: it was fed from whatever the live map happened to have
    // loaded, which in practice was nothing — every client-generated thumbnail we still have shows
    // zero neighbour outlines. Re-creating it from the parcel table drowns the subject of the picture
    // in 200 black dashed polygons, which is the opposite of what the layer was for.
    const polygons = [
        { coords: geoCoords, style: { color: '#ff6600', weight: 3, opacity: 0.9, fillColor: '#ff6600', fillOpacity: 0.18, lineJoin: 'round', lineCap: 'round' } }
    ];

    if (Array.isArray(parcelPolygons)) {
        for (const p of parcelPolygons) {
            const norm = normalizeToGeoJSON(p, normalizeOrder(parcelPolygonOrder || polygonOrder));
            const ring = outerRingOf(norm);
            if (ring && ring.length >= 3) {
                // Parent parcels expand the frame (so the parcel stays in view) unless the caller
                // pinned the frame to the proposal polygon — e.g. road corridors.
                if (!fitToPolygonOnly) expandBbox(norm);
                polygons.push({ coords: norm, style: { color: '#000', weight: 2.5, opacity: 1, dashArray: '3 2' } });
            }
        }
    }

    const bboxLooksInvalid = (lngMin > 180 || lngMax > 180 || lngMin < -180 || lngMax < -180 ||
        latMin > 90 || latMax > 90 || latMin < -90 || latMax < -90 ||
        (lngMax - lngMin) > 10 || (latMax - latMin) > 10);
    if (bboxLooksInvalid) {
        throw new Error('Invalid bounding box computed for tile stitch - coordinates may be malformed');
    }

    // Apply padding
    const padLng = (lngMax - lngMin) * padding;
    const padLat = (latMax - latMin) * padding;
    lngMin -= padLng;
    lngMax += padLng;
    latMin -= padLat;
    latMax += padLat;

    const effectiveZoom = computeBestZoomForBbox(lngMin, lngMax, latMin, latMax, maxTilesPerAxis, 14, zoom);

    const xMin = lngToTileX(lngMin, effectiveZoom);
    const xMax = lngToTileX(lngMax, effectiveZoom);
    const yMin = latToTileY(latMax, effectiveZoom); // higher lat = lower tile Y
    const yMax = latToTileY(latMin, effectiveZoom);
    const tilesX = xMax - xMin + 1;
    const tilesY = yMax - yMin + 1;

    if (tilesX * tilesY > MAX_TILES) {
        throw new Error(`Tile request too large (${tilesX * tilesY} tiles)`);
    }

    return {
        lngMin, lngMax, latMin, latMax,
        zoom: effectiveZoom,
        xMin, xMax, yMin, yMax,
        tilesX, tilesY,
        canvasWidth: tilesX * TILE_SIZE,
        canvasHeight: tilesY * TILE_SIZE,
        polygons
    };
}

function hexToRgba(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function drawBadge(ctx, badge) {
    if (!ctx || !badge || !badge.text) return;
    const size = Number.isFinite(badge.size) ? badge.size : 56;
    const margin = Number.isFinite(badge.margin) ? badge.margin : 12;
    const radius = Math.min(size / 4, 14);
    const x = margin;
    const y = margin;

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, size, size, radius);
    ctx.fillStyle = badge.background || 'rgba(255,255,255,0.94)';
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2;
    ctx.strokeStyle = badge.borderColor || '#000';
    ctx.stroke();

    ctx.fillStyle = badge.color || '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = badge.font || '28px "Noto Emoji", "Apple Color Emoji", sans-serif';
    ctx.fillText(badge.text, x + size / 2, y + size / 2 + 1);
    ctx.restore();
}

async function fetchTileImage(url, timeoutMs = DEFAULT_TILE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'consensus-builder-thumbnailer' }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        return await loadImage(buffer);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Stitch tiles covering the frame and draw the polygon overlays. Returns PNG bytes.
 *
 * @param {Object} options - same shape as the browser's captureViaTileStitch
 * @param {Array|Object} options.polygon - proposal geometry (rings or GeoJSON geometry)
 * @param {Array} [options.parcelPolygons] - parent parcel outlines (expand the frame)
 * @param {number} [options.padding=0.05]
 * @param {number} [options.zoom=19] - maximum zoom; lowered automatically to cap the tile count
 * @param {Object} [options.badge] - { text } goal badge drawn top-left
 * @param {string} [options.parcelLabel] - label drawn at the polygon's centre
 * @returns {Promise<{ buffer: Buffer, frame: Object, tiles: { loaded: number, failed: number } }>}
 */
export async function renderProposalThumbnail(options = {}) {
    const {
        tileUrl = DEFAULT_TILE_URL,
        parcelLabel = null,
        badge = null,
        tileTimeoutMs = DEFAULT_TILE_TIMEOUT_MS
    } = options;

    const frame = computeStitchFrame(options);
    const { xMin, xMax, yMin, yMax, zoom, canvasWidth, canvasHeight, polygons } = frame;

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Fill with light gray in case tiles fail
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    let loaded = 0;
    let failed = 0;
    const tilePromises = [];
    for (let ty = yMin; ty <= yMax; ty++) {
        for (let tx = xMin; tx <= xMax; tx++) {
            const url = expandTileUrl(tileUrl, tx, ty, zoom);
            const dx = (tx - xMin) * TILE_SIZE;
            const dy = (ty - yMin) * TILE_SIZE;
            tilePromises.push(
                fetchTileImage(url, tileTimeoutMs)
                    .then(img => {
                        ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
                        loaded++;
                    })
                    .catch(err => {
                        // A missing tile leaves grey background; a wholly grey thumbnail is caught
                        // by the caller via the returned tile counts.
                        console.warn(`[thumbnail] tile ${zoom}/${tx}/${ty} failed: ${err.message}`);
                        failed++;
                    })
            );
        }
    }
    await Promise.all(tilePromises);

    const traceRing = (ring) => {
        let first = true;
        for (const coord of ring) {
            const { px, py } = lngLatToPixel(coord[0], coord[1], xMin, yMin, zoom);
            if (first) {
                ctx.moveTo(px, py);
                first = false;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.closePath();
    };

    for (const poly of polygons) {
        const { coords, style = {} } = poly;
        if (!coords) continue;

        const rings = (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) ? coords : [coords];
        const outer = rings[0];
        if (!outer || outer.length < 3) continue;

        ctx.beginPath();
        rings.forEach(traceRing);

        if (style.fillColor && style.fillOpacity > 0) {
            ctx.fillStyle = hexToRgba(style.fillColor, style.fillOpacity || 0.2);
            ctx.fill('evenodd');
        }
        if (style.color) {
            ctx.strokeStyle = style.color;
            ctx.lineWidth = style.weight || 2;
            ctx.lineJoin = style.lineJoin || 'round';
            ctx.lineCap = style.lineCap || 'round';
            if (style.dashArray) {
                const dashes = style.dashArray.split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
                ctx.setLineDash(dashes);
            } else {
                ctx.setLineDash([]);
            }
            ctx.globalAlpha = style.opacity !== undefined ? style.opacity : 1;
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.setLineDash([]);
        }
    }

    if (parcelLabel && polygons.length > 0) {
        const ring = outerRingOf(polygons[0].coords);
        if (ring && ring.length) {
            let sumLng = 0, sumLat = 0;
            for (const c of ring) {
                sumLng += c[0];
                sumLat += c[1];
            }
            const { px, py } = lngLatToPixel(sumLng / ring.length, sumLat / ring.length, xMin, yMin, zoom);

            ctx.font = 'bold 14px "Helvetica Neue", Arial, sans-serif';
            const textWidth = ctx.measureText(parcelLabel).width;
            const textHeight = 14;
            const padX = 8, padY = 4;
            const boxX = px - textWidth / 2 - padX;
            const boxY = py - textHeight / 2 - padY;

            ctx.fillStyle = 'rgba(255,255,255,0.86)';
            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            roundRect(ctx, boxX, boxY, textWidth + padX * 2, textHeight + padY * 2, 6);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#0f172a';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(parcelLabel, px, py);
        }
    }

    if (badge && badge.text) {
        drawBadge(ctx, badge);
    }

    return {
        buffer: canvas.toBuffer('image/png'),
        frame,
        tiles: { loaded, failed, total: loaded + failed }
    };
}

export { DEFAULT_TILE_URL, TILE_SIZE, MAX_STITCH_TILES_PER_AXIS };
