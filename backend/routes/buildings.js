// GET /buildings/tables - Check what tables exist
import { createBuildingProviders } from '../buildings/index.js';
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

// The bbox layer caps how many footprints one request may return. A request that HITS the cap was
// truncated — it does not cover its bbox, and the caller must be told, because a building that
// never loaded can never be detected and so can never be demolished (see corridor-tunnel.js).
const BUILDING_BBOX_LIMIT = 4000;

export function setupBuildingsRoute(app, pool) {
    // Per-city 3D building source registry (Zagreb mesh table, NYC live footprints, …).
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
        try {
            const cesticaId = req.query.cestica_id;
            const bbox = String(req.query.bbox || '').trim();
            const parts = bbox.split(',').map(n => Number(n));
            const source = String(req.query.source || 'gdi').trim().toLowerCase();

            if (bbox && (parts.length !== 4 || parts.some(v => !isFinite(v)))) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }
            if (source !== 'gdi' && source !== 'dgu') {
                return res.status(400).json({ error: `Unknown source '${source}'. Expected 'gdi' or 'dgu'.` });
            }

            if (cesticaId) {
                // Buildings inside a parcel: GDI footprints, the working set.
                const sql = `
                    SELECT
                        bf.*,
                        ST_AsGeoJSON(bf.geom)::json AS geometry,
                        ST_Area(bf.geom) AS footprint_area,
                        ST_Area(ST_Intersection(p.geom, bf.geom)) AS intersection_area,
                        CASE
                            WHEN ST_Area(bf.geom) > 0 THEN ST_Area(ST_Intersection(p.geom, bf.geom)) / ST_Area(bf.geom)
                            ELSE 0
                        END AS containment_ratio,
                        p.CESTICA_ID,
                        p.BROJ_CESTICE
                    FROM gdi_building_footprint bf
                    CROSS JOIN parcel p
                    WHERE p.CESTICA_ID = $1
                    AND ST_Intersects(p.geom, bf.geom)
                    AND ST_Area(ST_Intersection(p.geom, bf.geom)) / ST_Area(bf.geom) >= 0.9
                    ORDER BY containment_ratio DESC
                `;

                const { rows } = await pool.query(sql, [cesticaId]);

                const features = rows.map(row => ({
                    type: 'Feature',
                    properties: {
                        ...row,
                        footprint_area: row.footprint_area,
                        containment_ratio: row.containment_ratio,
                        cestica_id: row.CESTICA_ID,
                        broj_cestice: row.BROJ_CESTICE
                    },
                    geometry: row.geometry
                }));

                res.json({
                    type: 'FeatureCollection',
                    features,
                    cestica_id: cesticaId,
                    count: features.length
                });
            } else {
                if (!bbox) {
                    return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
                }
                const [minX, minY, maxX, maxY] = parts;

                // GDI (default): the objects we actually work with. `object_id` is the id every
                // demolition record is keyed by, so it must be in the properties.
                // DGU: the cadastre reference layer, keyed by zgrada_id, current rows only.
                const sql = source === 'dgu'
                    ? `
                        SELECT
                            ST_AsGeoJSON(b.geom)::json AS geometry,
                            (to_jsonb(b) - 'geom' - 'bbox') AS properties
                        FROM dgu_building b
                        WHERE b.current
                          AND b.geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                          AND ST_Intersects(b.geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                        LIMIT ${BUILDING_BBOX_LIMIT}
                      `
                    : `
                        SELECT
                            ST_AsGeoJSON(f.geom)::json AS geometry,
                            jsonb_build_object(
                                'object_id',     f.object_id,
                                'area_m2',       g.area_m2,
                                'height_m',      g.height_m,
                                'eave_height_m', g.eave_height_m,
                                'survey_year',   g.survey_year
                            ) AS properties
                        FROM gdi_building_footprint f
                        LEFT JOIN gdi_building g ON g.object_id = f.object_id
                        WHERE f.geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                          AND ST_Intersects(f.geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                        LIMIT ${BUILDING_BBOX_LIMIT}
                      `;

                const { rows } = await pool.query(sql, [minX, minY, maxX, maxY]);

                const features = rows.map(row => ({
                    type: 'Feature',
                    properties: row.properties || {},
                    geometry: row.geometry
                }));

                res.json({
                    type: 'FeatureCollection',
                    features,
                    source,
                    truncated: features.length >= BUILDING_BBOX_LIMIT
                });
            }
        } catch (err) {
            console.error('Error in /buildings:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/near - Full 3D building meshes within `buffer_meters` of a GeoJSON point/geometry.
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326>, buffer_meters?: number, city?: string,
    //         proposals?: string[] | string }
    //
    // Source is per-city via the building-provider registry (see backend/buildings/): Zagreb
    // serves pre-built LOD2 meshes from `gdi_building_3d`, NYC extrudes live footprint sources, etc.
    // Whatever the source, every provider yields the same flat-face shape in EPSG:4326 with Z in
    // metres. `city` is the CityConfigManager city id; omitting it defaults to Zagreb.
    //
    // `proposals` (OPTIONAL) is a list of proposal ids whose demolitions should already be applied
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
            const city = typeof body.city === 'string' ? body.city : undefined;
            const proposalIds = body.proposals === undefined ? [] : parseProposalIds(body.proposals);

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            const provider = buildingProviders.resolve(city);
            if (!provider) {
                return res.status(400).json({ error: `No 3D building source for city '${city}'.` });
            }

            const result = await provider.near(geometry, bufferMeters);
            if (!proposalIds.length) {
                return res.json({ buildings: result.buildings, count: result.count, source: result.source });
            }

            const proposals = await fetchProposalsForCarve(pool, proposalIds);
            const carveContext = carveRecordsFor(proposals);
            const buildings = carveBuildings(result.buildings, carveContext);
            res.json({ buildings, count: buildings.length, source: result.source });
        } catch (err) {
            console.error('Error in POST /buildings/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/carve - What the given applied proposals did to the EXISTING buildings under
    // them, as a verdict per AFFECTED building. Nothing else is returned: a building absent from
    // `carves` is untouched and should render exactly as its source gives it.
    // Body: { proposals: string[] | string, city?: string, geometry?: <GeoJSON>, buffer_meters?: number }
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
            const city = typeof body.city === 'string' ? body.city : undefined;
            const proposalIds = parseProposalIds(body.proposals);
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 50;

            if (!proposalIds.length) {
                return res.status(400).json({ error: 'Missing `proposals` (expected one or more proposal ids).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            const provider = buildingProviders.resolve(city);
            if (!provider) {
                return res.status(400).json({ error: `No 3D building source for city '${city}'.` });
            }

            const proposals = await fetchProposalsForCarve(pool, proposalIds);
            const carveContext = carveRecordsFor(proposals);

            // No records at all (the ids matched nothing, or nothing is applied) means nothing was
            // carved. Say so — do not fall through into an unbounded building query.
            const area = (body.geometry && body.geometry.type) ? body.geometry : carveRecordsBounds(carveContext);
            if (!area) {
                return res.json({ carves: [], count: 0, source: null });
            }

            const result = await provider.near(area, bufferMeters);
            const carves = carveVerdicts(result.buildings, carveContext);
            console.log(`[buildings/carve] ${proposalIds.length} proposal(s): ${carveContext.records.size} demolition `
                + `record(s) → ${carves.length} building(s) affected (matched by object_id)`);
            res.json({ carves, count: carves.length, source: result.source });
        } catch (err) {
            console.error('Error in POST /buildings/carve:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /buildings/footprints - 2D footprints (+ known heights) of existing buildings mostly
    // inside a GeoJSON polygon. Backs the urban-rule "based on existing buildings" mode.
    // Body: { geometry: <GeoJSON Geometry in EPSG:4326>, city?: string }
    //
    // Footprints are an OPTIONAL per-city provider capability: a provider that implements
    // `footprints(geometry)` supports it, everything else reports `supported: false` (the
    // frontend hides/reverts the mode). Unknown cities resolve to no provider on purpose —
    // the Zagreb fallback used by /buildings/near would falsely claim support here.
    //
    // Response shape:
    //   {
    //     supported: true|false,
    //     footprints: [ { id, geometry: <GeoJSON Polygon/MultiPolygon>, height_m|null, floors|null }, ... ],
    //     count: N,
    //     source: '<provider id>'
    //   }
    app.post('/buildings/footprints', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const city = typeof body.city === 'string' ? body.city : undefined;

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }

            const provider = buildingProviders.resolveExact(city);
            if (!provider || typeof provider.footprints !== 'function') {
                return res.json({ supported: false, footprints: [], count: 0, source: null });
            }

            const result = await provider.footprints(geometry);
            res.json({ supported: true, footprints: result.footprints, count: result.count, source: result.source });
        } catch (err) {
            console.error('Error in POST /buildings/footprints:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
