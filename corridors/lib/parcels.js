// Parcel-set extraction: buffer a smoothed centerline (EPSG:3765) in PostGIS
// and intersect with the cadastre. The returned parcel set IS the proposal's
// identity (see ../algorithmic-corridors.md §1).
export async function extractParcels(client, coords3765, corridorWidth) {
    const lineGeoJSON = JSON.stringify({ type: 'LineString', coordinates: coords3765.map(c => [round2(c[0]), round2(c[1])]) });
    const { rows } = await client.query(`
        WITH line AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 3765) g),
        corr AS (SELECT ST_Buffer(g, $2) p FROM line)
        SELECT p.cestica_id, p.maticni_broj_ko, p.broj_cestice,
               ST_Area(p.geom)::int AS area_m2,
               ST_Area(ST_Intersection(p.geom, corr.p))::int AS taken_m2
        FROM parcel p, corr
        WHERE p.current AND p.geom && corr.p AND ST_Intersects(p.geom, corr.p)`,
        [lineGeoJSON, corridorWidth / 2]);
    const { rows: [geo] } = await client.query(`
        WITH line AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 3765) g)
        SELECT ST_AsGeoJSON(ST_Transform(ST_Buffer(g, $2), 4326), 6) AS corridor,
               ST_AsGeoJSON(ST_Transform(g, 4326), 6) AS centerline
        FROM line`,
        [lineGeoJSON, corridorWidth / 2]);
    return {
        parcels: rows,
        parcelIds: new Set(rows.map(r => r.cestica_id)),
        corridorGeoJSON: JSON.parse(geo.corridor),
        centerlineGeoJSON: JSON.parse(geo.centerline),
    };
}

export function jaccard(setA, setB) {
    let inter = 0;
    for (const id of setA) if (setB.has(id)) inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

const round2 = x => Math.round(x * 100) / 100;
