// NYC 3D building provider backed by the NYCMaps/ArcGIS Building feature service.
// This is the temporary default while the NYC Open Data Socrata publication is incomplete.

import { extrudeFootprint } from './extrude.js';

const ARCGIS_QUERY_URL = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/BUILDING_view/FeatureServer/0/query';
const FEET_TO_METRES = 0.3048;
const FEATURE_CODE_BUILDING = 2100;
const MAX_BUILDINGS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const cache = new Map();

function geometryBbox(geometry) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const visit = (node) => {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'number' && typeof node[1] === 'number') {
            if (node[0] < minLng) minLng = node[0];
            if (node[0] > maxLng) maxLng = node[0];
            if (node[1] < minLat) minLat = node[1];
            if (node[1] > maxLat) maxLat = node[1];
            return;
        }
        for (const child of node) visit(child);
    };
    visit(geometry && geometry.coordinates);
    if (!isFinite(minLng) || !isFinite(minLat)) return null;
    return [minLng, minLat, maxLng, maxLat];
}

function bboxCornerRadiusMeters(bbox) {
    const midLat = (bbox[1] + bbox[3]) / 2;
    const dLatM = ((bbox[3] - bbox[1]) / 2) * 111320;
    const dLngM = ((bbox[2] - bbox[0]) / 2) * 111320 * Math.max(0.1, Math.cos(midLat * Math.PI / 180));
    return Math.sqrt(dLatM * dLatM + dLngM * dLngM);
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function buildArcgisUrl(centerLng, centerLat, radiusM) {
    const params = new URLSearchParams({
        f: 'geojson',
        where: `HEIGHT_ROOF > 0 AND FEATURE_CODE = ${FEATURE_CODE_BUILDING}`,
        geometry: `${centerLng},${centerLat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        outSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        distance: String(radiusM),
        units: 'esriSRUnit_Meter',
        outFields: 'BIN,DOITT_ID,HEIGHT_ROOF,FEATURE_CODE,NAME,OBJECTID',
        returnGeometry: 'true',
        resultRecordCount: String(MAX_BUILDINGS)
    });
    return `${ARCGIS_QUERY_URL}?${params.toString()}`;
}

export function createNycArcgisProvider() {
    async function near(geometry, bufferMeters) {
        const baseBbox = geometryBbox(geometry);
        if (!baseBbox) return { buildings: [], count: 0, source: 'nyc-arcgis' };

        const centerLng = (baseBbox[0] + baseBbox[2]) / 2;
        const centerLat = (baseBbox[1] + baseBbox[3]) / 2;
        const radiusM = bufferMeters + bboxCornerRadiusMeters(baseBbox);

        const cacheKey = [centerLng, centerLat].map(v => v.toFixed(5)).join(',') + ':' + Math.round(radiusM);
        const cached = cache.get(cacheKey);
        if (cached && (cached.at + CACHE_TTL_MS) > cacheNow()) {
            return { buildings: cached.buildings, count: cached.buildings.length, source: 'nyc-arcgis', cached: true };
        }

        const resp = await fetch(buildArcgisUrl(centerLng, centerLat, radiusM));
        if (!resp.ok) {
            throw new Error(`NYC ArcGIS HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
        const fc = await resp.json();
        if (fc && fc.error) {
            throw new Error(`NYC ArcGIS error: ${JSON.stringify(fc.error).slice(0, 200)}`);
        }
        const features = (fc && Array.isArray(fc.features)) ? fc.features : [];

        const buildings = [];
        for (const f of features) {
            const props = f && f.properties ? f.properties : {};
            const heightM = num(props.HEIGHT_ROOF) * FEET_TO_METRES;
            const rec = extrudeFootprint(props.BIN || props.DOITT_ID || props.OBJECTID, f.geometry, heightM);
            if (rec) buildings.push(rec);
        }

        if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
        cache.set(cacheKey, { at: cacheNow(), buildings });

        return { buildings, count: buildings.length, source: 'nyc-arcgis' };
    }

    return { near };
}

function cacheNow() { return Date.now(); }
