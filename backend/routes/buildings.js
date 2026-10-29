import { buildingMapLookup } from '../buildings/map-source.js';
export { PARCEL_BUILDINGS_SQL } from '../buildings/map-source.js';
// GET /buildings/tables - Check what tables exist
import { createBuildingProviders } from '../buildings/index.js';
import { osmReferenceSourceRegistry } from '../buildings/map-source.js';
import { attachNearbyFloorModels, nativeFloorModelSource } from '../buildings/floor-models.js';
import { splitRead, boxPolygon, boxSideMeters } from '../buildings/split-read.js';
import {
    fetchProposalsForCarve,
    carveRecordsFor,
    carveBuildings,
    carveVerdicts,
    carveRecordsBounds
} from '../buildings/carve.js';

// `proposals` may arrive as an array, a single id, or a comma-separated string.
function parseProposalIds(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
    return raw.map(id => String(id).trim()).filter(Boolean).slice(0, 100);
}

export function setupBuildingsRoute(app, pool) {
    // Named dataset services, selected explicitly by the caller.
    const buildingProviders = createBuildingProviders(pool);

    // GET /buildings?bbox=minX,minY,maxX,maxY[&source=gdi|dgu]  (HTRS96/TM EPSG:3765)
    // GET /buildings?cestica_id=ID - buildings mostly contained within a parcel
    //
    // TWO SURVEYS OF THE SAME CITY, and they disagree. `source` picks which one you get:
    //
    //   gdi (DEFAULT) — gdi_building_footprint, keyed by object_id. The photogrammetric survey:
    //                   what is actually THERE. This is the WORKING SET — the same objects
    //                   gdi_building_3d meshes (1:1 on object_id) and therefore the same objects
    //                   the 3D view, the walk sim and the corridor carve all render. Cut / tunnel /
    //                   demolish detection scans THIS, so a demolition record's id is an object_id
    //                   and every downstream consumer matches it EXACTLY, by id, with no guessing.
    //
    //   dgu           — dgu_building, keyed by zgrada_id. The cadastre: what is REGISTERED. A
    //                   visual reference layer only. Nothing is ever cut, tunnelled or demolished
    //                   against it — its ids are a different key space (they relate to GDI only
    //                   through dgu_gdi_building_match, many-to-one).
    //
    // Response is a GeoJSON FeatureCollection. `truncated` says the cap was hit and the bbox is
    // NOT fully covered.
    app.get('/buildings', async (req, res) => {
        try { return res.json(await buildingMapLookup(pool, req.query)); }
        catch (error) {
            if (error?.databaseSourceFailure) return res.status(error.status).json(error.payload);
            throw error;
        }
    });

    // POST /buildings/near - Full 3D building meshes within `buffer_meters` of a GeoJSON point/geometry.
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326>, buffer_meters?: number,
    //         proposals?: string[] | string }
    //
    // `source` explicitly names gdi-3d, nyc-arcgis, nyc-socrata, osm, wien-lod2 or a portable building descriptor.
    // `floorModelNamespace` optionally selects stored floor evidence. No city or location selects
    // a provider or evidence namespace on the server.
    //
    // `proposals` (OPTIONAL) is an explicit list of proposal definitions whose demolitions to apply
    // to the meshes that come back — see backend/buildings/carve.js. With it:
    //   demolished building → ABSENT from the response entirely (there is nothing left to draw, and
    //                         a flag would just make every consumer re-implement the filter)
    //   cut building        → present under the SAME object_id, its faces re-extruded from the
    //                         surviving remainder (a mesh cannot be sliced face by face)
    //   tunnelled building  → present, UNCHANGED — the road passes under it
    // Omitting `proposals` leaves the endpoint behaving exactly as it always has: raw meshes, no
    // proposal awareness, no extra query.
    //
    // Response shape:
    //   {
    //     buildings: [
    //       { object_id, z_min, z_max, faces: [<GeoJSON Polygon with 3D coords>, ...] },
    //       ...
    //     ],
    //     count: N,
    //     source: '<provider id>'
    //   }
    //
    // The client is expected to triangulate each face and lift it back into 3D.
    app.post('/buildings/near', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            const proposalIds = body.proposals === undefined ? [] : parseProposalIds(body.proposals);

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            // The caller selects the building dataset explicitly.
            const provider = buildingProviders.forRequest({ source: body.source, geometry });
            if (!provider) {
                return res.status(400).json({ error: 'No 3D building source here.' });
            }
            // Floor evidence uses an explicit registry namespace supplied by the caller.
            const floorModelCity = body.floorModelNamespace;
            if (floorModelCity !== undefined && (typeof floorModelCity !== 'string' || !floorModelCity.trim() || floorModelCity.length > 100)) {
                return res.status(400).json({ error: 'Invalid floorModelNamespace.' });
            }

            const result = await provider.near(geometry, bufferMeters);
            const floorModelSource = nativeFloorModelSource(body.source, result.source);
            // OSM: how many heights are measured, storey-derived or estimated, and whether the
            // upstream answered only in part (Overpass throttling).
            const extra = { floorModelSource };
            if (result.heights !== undefined) extra.heights = result.heights;
            if (result.partial !== undefined) extra.partial = result.partial;
            // The upstream failed outright: the browser tells the person instead of drawing nothing.
            if (result.unavailable) Object.assign(extra, { unavailable: true, retryAfter: result.retryAfter ?? null });
            if (!proposalIds.length) {
                const buildings = await attachNearbyFloorModels(pool, floorModelCity, floorModelSource, result.buildings);
                return res.json({ buildings, count: result.count, source: result.source, ...extra });
            }

            const proposals = await fetchProposalsForCarve(pool, proposalIds);
            const carveContext = carveRecordsFor(proposals);
            const buildings = carveBuildings(result.buildings, carveContext);
            // A cut proxy no longer has the authored floor shape. Enrich only untouched
            // objects (carveBuildings deliberately preserves those object references).
            const originals = new Set(result.buildings);
            const modeled = await attachNearbyFloorModels(pool, floorModelCity, floorModelSource,
                buildings.filter(building => originals.has(building)));
            const byId = new Map(modeled.map(building => [building.object_id, building]));
            const enriched = buildings.map(building => originals.has(building) ? byId.get(building.object_id) : building);
            res.json({ buildings: enriched, count: enriched.length, source: result.source, ...extra });
        } catch (err) {
            // A malformed user building source id is the caller's error.
            if (err && err.status === 400) return res.status(400).json({ error: err.message, code: err.code });
            console.error('Error in POST /buildings/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/carve - What the explicitly selected proposals do to EXISTING buildings under
    // them, as a verdict per AFFECTED building. Nothing else is returned: a building absent from
    // `carves` is untouched and should render exactly as its source gives it.
    // Body: { proposals: string[] | string, geometry?: <GeoJSON>, buffer_meters?: number }
    //
    // This exists for consumers that already have their own mesh source and only need to know what
    // changed — the walk sim streams `gdi_building_3d` from the cadastre API (with facade colours
    // and building types this API does not carry), so handing it carved meshes would mean handing
    // it worse meshes. It asks what changed instead, and applies that to the buildings it already
    // has. Both sides key on object_id, so a verdict lands on exactly the mesh it names.
    //
    // `geometry` is optional: with no area given, the proposals' own footprints define it, which is
    // what a caller that just wants "everything these proposals touched" wants.
    //
    // A `cut` verdict ships BOTH the remainder footprint and the mesh already re-extruded from it,
    // so a consumer never needs an extruder of its own — the sim swaps `faces` straight into the
    // feature it fetched from its own mesh source, keeping that source's colours and building type.
    //
    // Response shape:
    //   {
    //     carves: [
    //       { object_id, verdict: 'razed', remainder: null, faces: [] },
    //       { object_id, verdict: 'cut', remainder: <GeoJSON Polygon|MultiPolygon>,
    //         faces: [<GeoJSON Polygon with 3D coords>, ...], z_min, z_max },
    //       ...
    //     ],
    //     count: N,
    //     source: '<provider id>'
    //   }
    app.post('/buildings/carve', async (req, res) => {
        try {
            const body = req.body || {};
            const proposalIds = parseProposalIds(body.proposals);
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 50;

            if (!proposalIds.length) {
                return res.status(400).json({ error: 'Missing `proposals` (expected one or more proposal ids).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            // A malformed user source is the caller's error before anything is read.
            if (typeof body.source === 'string' && body.source) buildingProviders.resolveSource(body.source);

            const proposals = await fetchProposalsForCarve(pool, proposalIds);
            const carveContext = carveRecordsFor(proposals);

            // No records at all (the ids matched nothing or carry no demolitions) means nothing was
            // carved. Say so — do not fall through into an unbounded building query.
            const area = (body.geometry && body.geometry.type) ? body.geometry : carveRecordsBounds(carveContext);
            if (!area) {
                return res.json({ carves: [], count: 0, source: null });
            }

            // The caller selects the building dataset explicitly.
            const provider = buildingProviders.forRequest({ source: body.source, geometry: area });
            if (!provider) {
                return res.status(400).json({ error: 'No 3D building source here.' });
            }

            const result = await provider.near(area, bufferMeters);
            const carves = carveVerdicts(result.buildings, carveContext);
            console.log(`[buildings/carve] ${proposalIds.length} proposal(s): ${carveContext.records.size} demolition `
                + `record(s) → ${carves.length} building(s) affected (matched by object_id)`);
            res.json({ carves, count: carves.length, source: result.source });
        } catch (err) {
            // A malformed user building source id is the caller's error.
            if (err && err.status === 400) return res.status(400).json({ error: err.message, code: err.code });
            console.error('Error in POST /buildings/carve:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/footprints - 2D footprints (+ known heights) of existing buildings mostly
    // inside a GeoJSON polygon. Backs the urban-rule "based on existing buildings" mode.
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326> }
    //
    // All registered providers implement footprints and footprintsUnder. The explicit unsupported
    // response remains for a location with no provider; incomplete reads report truncated instead.
    //
    // Response shape:
    //   {
    //     supported: true|false,
    //     footprints: [ { id, geometry: <GeoJSON Polygon/MultiPolygon>, height_m|null, floors|null }, ... ],
    //     count: N,
    //     source: '<provider id>'
    //   }
    // POST /buildings/under — buildings touching EACH of many regions, one request for a plan.
    //
    // A replay used to ask /buildings/footprints once per proposal: hundreds of round trips, most
    // of them cold-cache, to answer a question one PostGIS join answers at once. POST because the
    // regions are geometry (far past any URL), but a pure read — it must stay in
    // RATE_LIMIT_EXEMPT_POST_PATHS with its siblings.
    //
    // Contract the client leans on: EVERY requested key appears in the response, an empty array
    // meaning "scanned, nothing there" — absence of a key is the only thing that may mean "not
    // covered". `truncated: true` voids the whole answer (the cap cannot say which region is
    // short), and the client falls back to per-proposal fetching rather than under-demolishing.
    app.post('/buildings/under', async (req, res) => {
        try {
            const body = req.body || {};
            const regions = Array.isArray(body.regions) ? body.regions : null;
            if (!regions || !regions.length) {
                return res.status(400).json({ error: 'regions must be a non-empty array of { key, geometry }.' });
            }
            if (regions.length > 400) {
                return res.status(400).json({ error: 'regions is capped at 400 per request.' });
            }
            const seen = new Set();
            for (const region of regions) {
                const key = region && region.key !== undefined && region.key !== null ? String(region.key) : '';
                if (!key) return res.status(400).json({ error: 'Every region needs a key.' });
                if (seen.has(key)) return res.status(400).json({ error: `Duplicate region key: ${key}` });
                seen.add(key);
                const geometry = region.geometry;
                const kind = geometry && typeof geometry === 'object' ? geometry.type : null;
                if ((kind !== 'Polygon' && kind !== 'MultiPolygon') || !Array.isArray(geometry.coordinates)) {
                    return res.status(400).json({ error: `Region ${key}: geometry must be a Polygon or MultiPolygon.` });
                }
            }

            // The caller names the building source (`source`); the place never selects one, and a
            // missing or unknown source is refused (400) before any query.
            const provider = buildingProviders.forRequest({ source: body.source, geometry: regions[0].geometry });
            if (!provider || typeof provider.footprintsUnder !== 'function') {
                return res.json({ supported: false, regions: {}, truncated: false, source: null });
            }
            const result = await provider.footprintsUnder(regions);
            const out = {};
            result.regions.forEach((buildings, key) => { out[key] = buildings; });
            res.json({
                supported: true,
                regions: out,
                truncated: result.truncated === true,
                scope: result.scope === undefined ? null : result.scope,
                source: result.source,
                ...(result.unavailable ? { unavailable: true, retryAfter: result.retryAfter ?? null } : {})
            });
        } catch (err) {
            // A malformed user building source id is the caller's error.
            if (err && err.status === 400) return res.status(400).json({ error: err.message, code: err.code });
            console.error('Error in POST /buildings/under:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.post('/buildings/footprints', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }

            // The caller selects the building dataset explicitly.
            const provider = buildingProviders.forRequest({ source: body.source, geometry });
            if (!provider || typeof provider.footprints !== 'function') {
                return res.json({ supported: false, footprints: [], count: 0, source: null });
            }

            const result = await provider.footprints(geometry);
            // `truncated` says the cap bound before the area did, so a caller filling a footprint
            // pool must not record the queried area as covered. Absent means "not capped".
            res.json({
                supported: true,
                footprints: result.footprints,
                count: result.count,
                truncated: result.truncated === true,
                // Which ingest answered — city, region, country, or none at all (data-scope.js).
                // Worth reporting: "874 buildings, scope croatia" is the difference between a city
                // with its own survey and one reading the countrywide pull.
                scope: result.scope === undefined ? null : result.scope,
                source: result.source,
                ...(result.unavailable ? { unavailable: true, retryAfter: result.retryAfter ?? null } : {})
            });
        } catch (err) {
            // A malformed user building source id is the caller's error.
            if (err && err.status === 400) return res.status(400).json({ error: err.message, code: err.code });
            console.error('Error in POST /buildings/footprints:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/cell - One cell of the city's grid from one building source, the unit the
    // browser loads buildings in (docs/source-loading-plan.md). Body:
    //   { source, kind: 'near' | 'footprints', bbox: [w, s, e, n] (WGS84, at most 2 km a side),
    //     floorModelNamespace? }
    // `near` answers 3D records (as POST /buildings/near), `footprints` the 2D pool's entries (as
    // POST /buildings/footprints). A cell the source caps is read in quarters (split-read.js), so
    // `complete` is false only when splitting ran out. A failed source answers `unavailable` for the
    // whole cell, never part of it, so the browser can answer it whole from a fallback source.
    // Complete answers are cached per source, kind and cell.
    const cellCache = new Map();
    const CELL_CACHE_TTL_MS = 15 * 60 * 1000;
    const CELL_CACHE_MAX = 2000;
    app.post('/buildings/cell', async (req, res) => {
        try {
            const body = req.body || {};
            const kind = body.kind;
            const bbox = Array.isArray(body.bbox) ? body.bbox.map(Number) : null;
            if (kind !== 'near' && kind !== 'footprints') {
                return res.status(400).json({ error: 'Invalid `kind` (near or footprints).' });
            }
            if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite) || !(bbox[0] < bbox[2]) || !(bbox[1] < bbox[3])
                || Math.abs(bbox[1]) > 90 || Math.abs(bbox[3]) > 90 || boxSideMeters(bbox) > 2000) {
                return res.status(400).json({ error: 'Invalid `bbox` (WGS84 [w, s, e, n], at most 2 km a side).' });
            }
            const floorModelCity = body.floorModelNamespace;
            if (floorModelCity !== undefined && (typeof floorModelCity !== 'string' || !floorModelCity.trim() || floorModelCity.length > 100)) {
                return res.status(400).json({ error: 'Invalid floorModelNamespace.' });
            }
            const provider = buildingProviders.forRequest({ source: body.source, geometry: boxPolygon(bbox) });
            if (!provider || (kind === 'footprints' && typeof provider.footprints !== 'function')) {
                return res.json({ supported: false, kind, bbox, items: [], complete: true, source: null });
            }
            const key = JSON.stringify([body.source || null, kind, floorModelCity || null, bbox.map(value => value.toFixed(7))]);
            const cached = cellCache.get(key);
            if (cached && cached.expires > Date.now()) return res.json(cached.answer);

            let source = null, floorModelSource = null;
            const read = await splitRead(bbox, async box => {
                const result = kind === 'near' ? await provider.near(boxPolygon(box), 0) : await provider.footprints(boxPolygon(box));
                source = result.source ?? source;
                if (result.unavailable) return { unavailable: true, retryAfter: result.retryAfter ?? null };
                // A capped answer is split; a partial one (an upstream that answered in part) is not.
                if (result.truncated === true && result.partial !== true) return { areaLimited: true };
                return { items: kind === 'near' ? result.buildings : result.footprints, complete: result.partial !== true };
            }, { idOf: item => kind === 'near' ? item.object_id : item.id });
            if (read.unavailable) {
                return res.json({ supported: true, kind, bbox, items: [], complete: false, source, unavailable: true, retryAfter: read.retryAfter });
            }
            let items = read.items;
            if (kind === 'near') {
                floorModelSource = nativeFloorModelSource(body.source, source);
                items = await attachNearbyFloorModels(pool, floorModelCity, floorModelSource, items);
            }
            const answer = { supported: true, kind, bbox, items, count: items.length, complete: read.complete, source,
                ...(kind === 'near' ? { floorModelSource } : {}) };
            if (read.complete) {
                if (cellCache.size >= CELL_CACHE_MAX) cellCache.delete(cellCache.keys().next().value);
                cellCache.set(key, { expires: Date.now() + CELL_CACHE_TTL_MS, answer });
            }
            res.json(answer);
        } catch (err) {
            if (err && err.status === 400) return res.status(400).json({ error: err.message, code: err.code });
            console.error('Error in POST /buildings/cell:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /buildings/osm?bbox=minLon,minLat,maxLon,maxLat  (WGS84 / EPSG:4326)
    //
    // The OSM buildings REFERENCE layer — the community footprints behind the OSM basemap, so they
    // line up with the tiles the user sees. Live via Overpass (cached per grid cell), global, and
    // like DGU it is a pure visual overlay: nothing is ever cut, tunnelled or demolished against it.
    // Response is a GeoJSON FeatureCollection with `truncated` and `partial` flags.
    //
    // 503 + Retry-After means Overpass is throttling us and we are backing off — a temporary, known
    // state, not a broken endpoint. It is separated from 502 (a real upstream failure) so the client
    // can go quiet for the cool-off instead of retrying into the rate limiter.
    app.get('/buildings/osm', async (req, res) => {
        const bbox = String(req.query.bbox || '').trim().split(',').map(Number);
        if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in EPSG:4326.' });
        }
        try {
            // Staged first: the same OSM footprints out of shared geodata, with no rate limit and no
            // outage. Overpass answers only for cities nobody has ingested yet.
            const fc = await osmReferenceSourceRegistry.open('osm-reference', { pool }).fetchBbox(bbox);
            res.json(fc);
        } catch (err) {
            const status = err && err.status ? err.status : 502;
            if (status === 503) {
                const retryAfter = Number(err.retryAfter) > 0 ? Math.ceil(err.retryAfter) : 60;
                console.warn(`[buildings/osm] Overpass is throttling us; backing off ${retryAfter}s`);
                res.set('Retry-After', String(retryAfter));
                return res.status(503).json({ error: 'OSM reference is rate-limited upstream.', retryAfter });
            }
            if (status >= 500) console.error('Error in GET /buildings/osm:', err);
            res.status(status).json({ error: status === 400 ? err.message : 'Failed to fetch OSM buildings.' });
        }
    });
}
