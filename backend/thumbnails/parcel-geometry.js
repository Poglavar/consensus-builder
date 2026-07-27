// Parent-parcel polygon lookups used to give a proposal thumbnail its context: the dashed outline of
// the parcel(s) a proposed building sits in. The browser used to read these off the loaded parcel
// layer; server-side we read them straight out of the city's parcel table.
//
// Parcel ids are per-city identities, not table primary keys — Zagreb's is the composed
// `HR-<maticni_broj_ko>-<broj_cestice>` (see backend/routes/parcels.js resolveParcelIdToCesticaId),
// so each city needs its own matching rule. Cities that are not listed here simply get no parcel
// outline: their thumbnails still render the proposal geometry itself, which is the subject anyway.
const CITY_PARCEL_QUERIES = {
    // Zagreb ids look like `HR-339164-7045` (broj_cestice may contain a slash: `HR-339164-7052/1`);
    // bare numeric ids are a cestica_id. Matching the composed id with a string expression would seq
    // scan 14M rows, so the ids are split back into their parts and joined on the
    // (maticni_broj_ko, broj_cestice) index — same key parcels.js resolves single parcels by.
    zagreb: (ids) => {
        const maticni = [];
        const brojevi = [];
        const cesticaIds = [];
        for (const raw of ids) {
            const normalized = raw.replace(/^(HR-)+/i, '');
            if (/^[0-9]+$/.test(normalized)) {
                cesticaIds.push(normalized);
                continue;
            }
            const dashIdx = normalized.indexOf('-');
            if (dashIdx <= 0) continue;
            const cadMun = Number(normalized.slice(0, dashIdx).trim());
            const parcelNumber = normalized.slice(dashIdx + 1).trim();
            if (!Number.isFinite(cadMun) || !parcelNumber) continue;
            maticni.push(cadMun);
            brojevi.push(parcelNumber);
        }
        return {
            sql: `
                SELECT ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry
                FROM parcel p
                JOIN (SELECT * FROM unnest($1::bigint[], $2::text[]) AS t(maticni_broj_ko, broj_cestice)) k
                  ON p.maticni_broj_ko = k.maticni_broj_ko AND p.broj_cestice = k.broj_cestice
                WHERE p.current = true
                UNION ALL
                SELECT ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry
                FROM parcel p
                WHERE p.current = true AND p.cestica_id = ANY($3::bigint[])
            `,
            params: [maticni, brojevi, cesticaIds]
        };
    },
    ljubljana: (ids) => ({
        sql: `
            SELECT ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
            FROM parcel_lj
            WHERE current = true AND eid_parcela::text = ANY($1::text[])
        `,
        params: [ids]
    }),
    buenos_aires: (ids) => ({
        sql: `
            SELECT ST_AsGeoJSON(geometry)::json AS geometry
            FROM parcel_ba
            WHERE smp::text = ANY($1::text[])
        `,
        params: [ids]
    })
};

export function hasParcelContext(city) {
    return !!CITY_PARCEL_QUERIES[city];
}

function geometryToRings(geometry) {
    if (!geometry || !geometry.coordinates) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.slice();
    return [];
}

/**
 * Fetch the polygons of specific parcels by the ids a proposal stores in parentParcelIds.
 * @returns {Promise<Array>} GeoJSON polygon coordinate arrays ([lng, lat] order)
 */
export async function fetchParcelPolygonsByIds(pool, city, parcelIds) {
    const buildQuery = CITY_PARCEL_QUERIES[city];
    const ids = Array.from(new Set(
        (parcelIds || []).map(id => (id === null || id === undefined) ? null : String(id).trim()).filter(Boolean)
    ));
    if (!buildQuery || !pool || !ids.length) return [];

    const { sql, params } = buildQuery(ids);
    const { rows } = await pool.query(sql, params);
    return rows.flatMap(row => geometryToRings(row.geometry));
}

export { CITY_PARCEL_QUERIES };
