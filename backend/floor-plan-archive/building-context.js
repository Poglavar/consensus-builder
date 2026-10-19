// The same GDI survey meshes used in Consensus Builder, restricted to one public project's neighbours.
export const CONTEXT_RADIUS_M = 65;
export const CONTEXT_LIMIT = 100;

export async function readBuildingContext(db, project) {
    const footprint = project?.model?.envelope?.footprint;
    if (!footprint || !['Polygon', 'MultiPolygon'].includes(footprint.type)) return null;
    const { rows } = await db.query(`WITH q AS MATERIALIZED (
        SELECT ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1),4326),3765)) AS g
    ), near AS MATERIALIZED (
        SELECT b.*, ST_Distance(b.geom2d_3765,q.g) AS distance
        FROM public.gdi_building_3d b, q
        WHERE ST_DWithin(b.geom2d_3765,q.g,$2) AND b.faces_4326 IS NOT NULL
        ORDER BY b.geom2d_3765 <-> q.g, b.object_id LIMIT $3
    ), repaired AS MATERIALIZED (
        SELECT object_id,z_min,z_max,faces_4326,distance,
            ST_MakeValid(ST_Simplify(geom2d_3765,0.15)) AS g FROM near
    ) SELECT b.object_id,b.z_min,b.z_max,b.faces_4326 AS faces,
        ST_Area(ST_Intersection(b.g,q.g)) / NULLIF(ST_Area(b.g),0) > 0.5 AS replaced
    FROM repaired b,q ORDER BY b.distance,b.object_id`, [JSON.stringify(footprint), CONTEXT_RADIUS_M, CONTEXT_LIMIT + 1]);
    const selected = rows.slice(0, CONTEXT_LIMIT);
    // A common datum preserves relative terrain elevations. Never coerce a missing altitude to zero.
    const ground = selected.map(b => b.z_min).filter(Number.isFinite);
    if (!ground.length) return { buildings: [], groundZ: null, radiusM: CONTEXT_RADIUS_M, source: 'zagreb-3d', truncated: false };
    const projectGround = selected.find(b => b.replaced && Number.isFinite(b.z_min))?.z_min ?? ground[0];
    return { buildings: selected.filter(b => !b.replaced && Number.isFinite(b.z_min)),
        groundZ: projectGround, radiusM: CONTEXT_RADIUS_M,
        source: 'zagreb-3d', surveyYear: 2022, truncated: rows.length > CONTEXT_LIMIT };
}
