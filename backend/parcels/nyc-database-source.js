// The imported NYS footprints used by /parcel-nyc. These are US-NY SWIS identities,
// distinct from the optional live DOF source's US-NYC-BBL identities.
export const NYC_DATABASE_SOURCE_ID = 'parcel-nyc';
export const NYC_GEOMETRY_COLUMN = ['geom', 'geometry'].includes(process.env.PARCEL_NYC_GEOMETRY_COLUMN?.trim().toLowerCase())
    ? process.env.PARCEL_NYC_GEOMETRY_COLUMN.trim().toLowerCase() : 'geom';
const MAX_PARCELS = 5000;

export function nycParcelIds(row) {
    const values = Array.isArray(row?.swis_sbl_ids) ? row.swis_sbl_ids : [row?.swis_sbl_id];
    return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))].sort();
}

export function nycParcelId(value) {
    const id = String(value ?? '').trim();
    return id ? (id.toUpperCase().startsWith('US-NY-') ? id : `US-NY-${id}`) : null;
}

export function nycDatabaseSource(db) {
    const geometry = `g.${NYC_GEOMETRY_COLUMN}`;
    async function query(condition, params) {
        const result = await db.query(`
            SELECT g.geom_id, ST_AsGeoJSON(${geometry})::json AS geom,
                array_remove(array_agg(DISTINCT u.swis_sbl_id ORDER BY u.swis_sbl_id), NULL) AS swis_sbl_ids
            FROM parcel_nyc_geom g
            LEFT JOIN parcel_nyc_unit u ON u.geom_id = g.geom_id
            WHERE ${condition}
            GROUP BY g.geom_id, ${geometry}
            LIMIT ${MAX_PARCELS + 1}`, params);
        if (result.rows.length > MAX_PARCELS) return { complete: false, features: [] };
        return { complete: true, features: result.rows.map(row => {
            const parcelId = nycParcelId(nycParcelIds(row)[0]);
            if (!parcelId || !['Polygon', 'MultiPolygon'].includes(row.geom?.type)) {
                throw new Error('Imported NYC parcel has no usable identity or geometry.');
            }
            return { type: 'Feature', properties: { parcelId, sourceId: NYC_DATABASE_SOURCE_ID }, geometry: row.geom };
        }) };
    }
    return {
        async queryGeometry(site) {
            const siteGeometry = 'ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)';
            return query(`${geometry} && ${siteGeometry} AND ST_Intersects(${geometry}, ${siteGeometry})`, [JSON.stringify(site)]);
        },
        async queryIds(ids) {
            if (!ids.every(id => /^US-NY-.+/.test(id))) throw new Error('Expected imported NYC parcel IDs.');
            const result = await query('EXISTS (SELECT 1 FROM parcel_nyc_unit requested WHERE requested.geom_id = g.geom_id AND requested.swis_sbl_id = ANY($1::text[]))',
                [ids.map(id => id.slice('US-NY-'.length))]);
            // One footprint can have many condo units. Its canonical map identity is the first
            // SWIS ID; another unit's ID must not silently become that footprint's identity.
            const features = result.features.filter(feature => ids.includes(feature.properties.parcelId));
            const found = new Set(features.map(feature => feature.properties.parcelId));
            return { ...result, features, absentIds: result.complete ? ids.filter(id => !found.has(id)) : [] };
        }
    };
}
