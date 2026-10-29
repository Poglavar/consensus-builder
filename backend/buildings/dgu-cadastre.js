// Zagreb's DGU cadastre as a building source (`dgu`): the registered buildings in `dgu_building`
// (current rows, keyed zgrada_id), a key space of its own (it relates to the GDI survey only through
// dgu_gdi_building_match, many-to-one). The cadastre records no height or storey count, so every
// block rises to the shared seeded estimate (building-heights.js) and says so in `height_source`.
// Same near/footprints/footprintsUnder contract as the other providers, plus the 2D map's cell read.
import { createRequire } from 'node:module';

const { footprintFeatureToBuilding } = createRequire(import.meta.url)('../../frontend/js/footprint-provider.js');

// One row past the cap says the area holds more: the answer is truncated and a cell reader splits it.
const CAP = 4000;

// Current cadastre buildings touching a WGS84 geometry grown by `bufferMeters`, in WGS84.
async function touching(pool, geometry, bufferMeters = 0) {
    const { rows } = await pool.query(`
        WITH q AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS g
        )
        SELECT b.zgrada_id, b.broj_zgrade, b.naziv_vrste_zgrade,
               ST_AsGeoJSON(ST_Transform(b.geom, 4326), 7)::json AS geometry
        FROM dgu_building b, q
        WHERE b.current AND ST_DWithin(b.geom, q.g, $2)
        ORDER BY b.geom <-> q.g, b.zgrada_id
        LIMIT ${CAP + 1}
    `, [JSON.stringify(geometry), bufferMeters]);
    const truncated = rows.length > CAP;
    return { rows: truncated ? rows.slice(0, CAP) : rows, truncated };
}

const flatItem = row => ({ id: row.zgrada_id, geometry: row.geometry, height_m: null, floors: null });

export function createDguProvider(pool) {
    async function near(geometry, bufferMeters) {
        const { rows, truncated } = await touching(pool, geometry, bufferMeters);
        const buildings = [];
        const heights = { measured: 0, levels: 0, estimated: 0 };
        for (const row of rows) {
            const record = footprintFeatureToBuilding({ type: 'Feature', id: String(row.zgrada_id), geometry: row.geometry,
                properties: { measured_height_m: null, levels: null, building: null } });
            if (!record) continue;
            heights[record.height_source] += 1;
            buildings.push(record);
        }
        return { buildings, count: buildings.length, source: 'dgu-3d', heights, ...(truncated ? { truncated: true } : {}) };
    }

    // The 2D map's footprints for one cell: every current building touching the area, with its
    // cadastral number and type.
    async function mapFootprints(geometry) {
        const { rows, truncated } = await touching(pool, geometry);
        const footprints = rows.map(row => ({ ...flatItem(row), broj_zgrade: row.broj_zgrade ?? null,
            naziv_vrste_zgrade: row.naziv_vrste_zgrade ?? null }));
        return { footprints, count: footprints.length, truncated, source: 'dgu-footprints' };
    }

    // Buildings mostly (≥ 50 % of their area) inside the polygon, as the other providers answer it.
    async function footprints(geometry) {
        const { rows } = await pool.query(`
            WITH q AS (
                SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS g
            )
            SELECT b.zgrada_id, ST_AsGeoJSON(ST_Transform(b.geom, 4326), 7)::json AS geometry
            FROM dgu_building b
            JOIN q ON b.geom && q.g AND ST_Intersects(b.geom, q.g)
            WHERE b.current
              AND ST_Area(ST_Intersection(ST_MakeValid(b.geom), q.g)) >= 0.5 * ST_Area(b.geom)
            ORDER BY b.zgrada_id
            LIMIT ${CAP + 1}
        `, [JSON.stringify(geometry)]);
        const truncated = rows.length > CAP;
        const list = (truncated ? rows.slice(0, CAP) : rows).map(flatItem);
        return { footprints: list, count: list.length, truncated, source: 'dgu-footprints' };
    }

    // Buildings touching each region (the demolition scan); a capped answer voids the whole scan.
    async function footprintsUnder(regions) {
        const byKey = new Map(regions.map(region => [String(region.key), []]));
        const { rows } = await pool.query(`
            WITH regions AS (
                SELECT r.key, ST_CollectionExtract(ST_MakeValid(ST_Transform(
                    ST_SetSRID(ST_GeomFromGeoJSON(r.geometry::text), 4326), 3765)), 3) AS geom
                FROM jsonb_to_recordset($1::jsonb) AS r(key text, geometry jsonb)
            )
            SELECT r.key, b.zgrada_id, ST_AsGeoJSON(ST_Transform(b.geom, 4326), 7)::json AS geometry
            FROM regions r
            JOIN dgu_building b ON b.geom && r.geom AND ST_Intersects(b.geom, r.geom)
            WHERE b.current
            ORDER BY r.key, b.zgrada_id
            LIMIT ${CAP + 1}
        `, [JSON.stringify(regions)]);
        const truncated = rows.length > CAP;
        if (!truncated) for (const row of rows) byKey.get(String(row.key)).push(flatItem(row));
        return { regions: byKey, truncated, source: 'dgu-footprints' };
    }

    return { near, footprints, mapFootprints, footprintsUnder };
}
