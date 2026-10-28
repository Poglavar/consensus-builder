// Pin GeoOttawa's public parcel proxy and its nested query before granting relay access.
export const OTTAWA_SOURCE_ID = 'ca-on-ottawa-geoottawa-property-parcels';
export const OTTAWA_LAYER = 'https://maps.ottawa.ca/arcgis/rest/services/Property_Information/MapServer/3';
export const OTTAWA_ENDPOINT = `https://maps.ottawa.ca/proxy/proxy.ashx?${OTTAWA_LAYER}`;
export const OTTAWA_REFERER = 'https://maps.ottawa.ca/geoottawa/';

export function isOttawaParcelSource(descriptor) {
    return descriptor.id === OTTAWA_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === OTTAWA_ENDPOINT;
}

export function isOttawaParcelRequest(url) {
    if (!(url instanceof URL) || url.username || url.password || url.hash
        || !url.href.startsWith(`${OTTAWA_ENDPOINT}/query?`)) return false;
    const params = new URLSearchParams(url.href.slice(`${OTTAWA_ENDPOINT}/query?`.length));
    const allowed = new Set(['where', 'outFields', 'returnGeometry', 'outSR', 'f', 'geometry',
        'geometryType', 'inSR', 'spatialRel', 'orderByFields', 'resultRecordCount',
        'resultOffset', 'returnCountOnly', 'returnIdsOnly', 'objectIds']);
    return [...params.keys()].every(key => allowed.has(key) && params.getAll(key).length === 1)
        && ['OBJECTID', 'OBJECTID,PIN'].includes(params.get('outFields'))
        && ['json', 'geojson'].includes(params.get('f'))
        && (!params.has('outSR') || params.get('outSR') === '4326');
}
