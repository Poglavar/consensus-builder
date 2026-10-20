// Small live OSM context around an illustrative parcel estimate; incomplete context is unsafe.
import { createOverpassCellSource } from '../buildings/osm-reference.js';

const CAP = 5000;
const VALID_CRS = 'EPSG:4326';

function closedRing(points) {
    if (!Array.isArray(points) || points.length < 4 || points.some(p => !Number.isFinite(p?.lon) || !Number.isFinite(p?.lat))) return null;
    const out = points.map(p => [p.lon, p.lat]);
    const a = out[0], b = out[out.length - 1];
    return a[0] === b[0] && a[1] === b[1] ? out : null;
}

// Stitch relation member fragments only when their endpoints connect into complete rings.
function joinRings(members) {
    const paths = members.map(m => {
        if (m?.type !== 'way' || !Array.isArray(m.geometry) || m.geometry.length < 2 || m.geometry.some(p => !Number.isFinite(p?.lon) || !Number.isFinite(p?.lat)))
            throw new Error('OSM multipolygon has malformed way member geometry');
        return m.geometry;
    });
    const rings = [];
    while (paths.length) {
        let path = paths.shift();
        let progressed = true;
        while (progressed && (path[0].lon !== path.at(-1).lon || path[0].lat !== path.at(-1).lat)) {
            progressed = false;
            for (let i = 0; i < paths.length; i++) {
                const next = paths[i], first = path[0], last = path.at(-1);
                const same = (a,b) => a.lon === b.lon && a.lat === b.lat;
                if (same(last,next[0])) path = path.concat(next.slice(1));
                else if (same(last,next.at(-1))) path = path.concat(next.slice(0,-1).reverse());
                else if (same(first,next.at(-1))) path = next.slice(0,-1).concat(path);
                else if (same(first,next[0])) path = next.slice(1).reverse().concat(path);
                else continue;
                paths.splice(i,1); progressed = true; break;
            }
        }
        const ring = closedRing(path);
        if (!ring) throw new Error('OSM multipolygon has an incomplete ring');
        rings.push(ring);
    }
    return rings;
}

function contains(ring, point) {
    const [x,y] = point; let inside = false;
    for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
        const [xi,yi]=ring[i], [xj,yj]=ring[j];
        if (((yi>y)!==(yj>y)) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) inside = !inside;
    }
    return inside;
}
function truthyTag(value) { return value != null && !['no','false','0'].includes(String(value).toLowerCase()); }

function feature(el, kind) {
    const tags = el.tags || {};
    let geometry;
    if (el.type === 'way') {
        const ring = closedRing(el.geometry);
        if (kind === 'building' || kind === 'water') {
            if (!ring) throw new Error(`OSM ${kind} way ${el.id} has incomplete polygon geometry`);
            geometry = { type: 'Polygon', coordinates: [ring] };
        } else {
            if (!Array.isArray(el.geometry) || el.geometry.length < 2 ||
                el.geometry.some(p => !Number.isFinite(p?.lon) || !Number.isFinite(p?.lat))) {
                throw new Error('OSM line has incomplete geometry');
            }
            const coords = el.geometry.map(p => [p.lon,p.lat]);
            geometry = { type: 'LineString', coordinates: coords };
        }
    } else if (el.type === 'relation' && (kind === 'building' || kind === 'water')) {
        const outer = joinRings((el.members || []).filter(m => m.role !== 'inner'));
        const inner = joinRings((el.members || []).filter(m => m.role === 'inner'));
        if (!outer.length) throw new Error(`OSM ${kind} relation ${el.id} has incomplete outer geometry`);
        const polygons = outer.map(r => [r]);
        for (const hole of inner) {
            const point = hole[0];
            const matches = outer.map((r,i) => contains(r, point) ? i : -1).filter(i => i >= 0);
            if (matches.length !== 1) throw new Error(`OSM ${kind} relation ${el.id} has an unassigned or ambiguous inner ring`);
            polygons[matches[0]].push(hole);
        }
        geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
    } else return null;
    return { type: 'Feature', id: `${el.type[0]}${el.id}`, geometry, properties: {
        kind, source_id: `${el.type[0]}${el.id}`,
        ...(['road','waterway'].includes(kind) ? { highway: kind === 'road' ? tags.highway : null, width_m: widthMetres(tags.width), bridge: truthyTag(tags.bridge), tunnel: truthyTag(tags.tunnel) } : {})
    } };
}

function widthMetres(v) {
    const m = String(v ?? '').trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(?:m|meter|metres|meters)?$/i);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 && n < 200 ? n : null;
}

function convert(elements, cap = CAP, source = null) {
    // Overpass can return HTTP 200 plus a timeout remark and only some elements.
    if (!Array.isArray(elements) || source?.remark) throw new Error('OSM context response is incomplete');
    let coordinates = 0;
    for (const el of elements) {
        coordinates += el?.geometry?.length || 0;
        for (const member of el?.members || []) coordinates += member?.geometry?.length || 0;
        if (coordinates > 100000) throw new Error('OSM context geometry exceeds the processing limit');
    }
    const features = [];
    const relationMembers = new Set();
    for (const el of elements || []) if (el?.type === 'relation' && ((truthyTag(el.tags?.building)) || el.tags?.natural === 'water' || el.tags?.landuse === 'reservoir'))
        for (const m of el.members || []) if (m?.type === 'way' && m.ref != null) relationMembers.add(String(m.ref));
    for (const el of elements || []) {
        const tags = el?.tags || {};
        if (el?.type === 'way' && relationMembers.has(String(el.id))) continue;
        const kind = truthyTag(tags.highway) ? 'road' : truthyTag(tags.building) ? 'building' :
            tags.waterway && tags.waterway !== 'riverbank' ? 'waterway' :
            (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir') ? 'water' : null;
        if (!kind) continue;
        if (features.length >= cap) return { features, truncated: true };
        const f = feature(el, kind);
        if (f) features.push(f);
    }
    return { features, truncated: false };
}

function query(bbox) {
    const [w,s,e,n] = bbox, b = `(${s},${w},${n},${e})`;
    return `[out:json][timeout:25];(way["building"]${b};relation["building"]["type"="multipolygon"]${b};way["highway"]${b};way["natural"="water"]${b};way["waterway"]${b};way["landuse"="reservoir"]${b};relation["natural"="water"]["type"="multipolygon"]${b};relation["waterway"="riverbank"]["type"="multipolygon"]${b};relation["landuse"="reservoir"]["type"="multipolygon"]${b};);out geom;`;
}
const fetchDefault = createOverpassCellSource({ label: 'parcel-estimate-context', buildQuery: query, convert, featureCap: CAP });

function parseBbox(raw, crs) {
    if (crs !== VALID_CRS) return null;
    const parts = String(raw ?? '').split(',');
    if (parts.length !== 4 || parts.some(v => !v.trim())) return null;
    const a = parts.map(Number);
    if (!a.every(Number.isFinite)) return null;
    const [w,s,e,n] = a;
    if (w < -180 || e > 180 || s < -80 || n > 80 || !(e > w) || !(n > s)) return null;
    const lat = (s+n)/2, mPerLon = 111320 * Math.cos(lat * Math.PI / 180), mPerLat = 111320;
    // One metre accommodates the frontend's local Mercator scale vs this geographic guard.
    if ((e-w)*mPerLon > 2001 || (n-s)*mPerLat > 2001) return null;
    return a;
}

export function setupEstimateContextRoute(app, options = {}) {
    app.get('/parcel-estimate/context', async (req,res) => {
        const bbox = parseBbox(req.query.bbox, req.query.crs);
        if (!bbox) return res.status(400).json({ error: 'bbox must be a finite EPSG:4326 w,s,e,n box no larger than 2 km per side, within latitude ±80°' });
        try {
            const fc = await (options.fetchContext || fetchDefault)(bbox, options);
            if (fc.partial || fc.truncated) return res.status(502).json({ error: fc.truncated ? 'OSM context was truncated; retry with a smaller area' : 'OSM context is incomplete; retry later' });
            return res.json({ type: 'FeatureCollection', features: fc.features });
        } catch (err) {
            return res.status(err.status && err.status >= 400 ? err.status : 502).json({ error: 'OSM context could not be generated completely' });
        }
    });
}

export { parseBbox, convert as overpassContextToGeoJSON };
