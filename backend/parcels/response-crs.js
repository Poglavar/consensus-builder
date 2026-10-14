// GeoJSON may omit `crs` under RFC 7946. When a provider does declare one, only
// accept names that identify the coordinate system requested by the adapter.
const GEOJSON_CRS_NAMES = Object.freeze({
    4326: new Set([
        'urn:ogc:def:crs:OGC::CRS84', 'urn:ogc:def:crs:OGC:1.3:CRS84',
        'http://www.opengis.net/def/crs/OGC/1.3/CRS84', 'OGC:CRS84', 'CRS84',
        'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'http://www.opengis.net/def/crs/EPSG/0/4326'
    ]),
    3857: new Set([
        'EPSG:3857', 'urn:ogc:def:crs:EPSG::3857', 'http://www.opengis.net/def/crs/EPSG/0/3857'
    ])
});

export function geoJsonResponseCrsMatches(crs, expectedSrid, { required = false } = {}) {
    if (crs === undefined || crs === null) return !required;
    return crs.type === 'name' && GEOJSON_CRS_NAMES[expectedSrid]?.has(crs.properties?.name) === true;
}
