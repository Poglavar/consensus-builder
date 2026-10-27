// Seyhan's public parcel service currently has an expired HTTPS certificate.
// Permit its bounded anonymous HTTP reads only through the fixed-source relay.
export const SEYHAN_SOURCE_ID = 'tr-seyhan-gispya-kentrehberi-parsel';
export const SEYHAN_ENDPOINT = 'http://gispya.seyhan.bel.tr/arcgis/rest/services/KENTREHBERI/MapServer/4';

export function isSeyhanSource(descriptor) {
    return descriptor?.id === SEYHAN_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === SEYHAN_ENDPOINT && descriptor.browserTransport === 'relay'
        && descriptor.idField === 'GLOBALID' && descriptor.idType === 'string'
        && descriptor.objectIdField === 'OBJECTID' && descriptor.queryFormat === 'geojson'
        && descriptor.idPrefix === 'TR-SEYHAN-' && descriptor.idQueryBraces !== true
        && descriptor.boundsQueryMode === 'offset' && descriptor.idsQueryMode === 'offset'
        && descriptor.outFields?.length === 2 && descriptor.outFields.includes('GLOBALID')
        && descriptor.outFields.includes('OBJECTID')
        && Number.isSafeInteger(descriptor.idBatchSize) && descriptor.idBatchSize >= 1
        && descriptor.idBatchSize <= 3;
}

export function isSeyhanQueryUrl(url) {
    const endpoint = new URL(SEYHAN_ENDPOINT);
    if (!(url instanceof URL) || url.origin !== endpoint.origin
        || url.pathname !== `${endpoint.pathname}/query` || url.username || url.password || url.hash) return false;
    const allowed = new Set(['where', 'outFields', 'returnGeometry', 'outSR', 'f',
        'orderByFields', 'resultRecordCount', 'resultOffset', 'geometry', 'geometryType', 'inSR', 'spatialRel']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key)
        || url.searchParams.getAll(key).length !== 1)) return false;
    const fields = url.searchParams.get('outFields')?.split(',');
    const guid = "'\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}'";
    const exact = new RegExp(`^GLOBALID IN \\(${guid}(?:,${guid}){0,2}\\)$`);
    const where = url.searchParams.get('where');
    return url.searchParams.get('f') === 'geojson' && url.searchParams.get('outSR') === '4326'
        && url.searchParams.get('returnGeometry') === 'true'
        && fields?.length === 2 && new Set(fields).size === 2
        && fields.every(field => ['GLOBALID', 'OBJECTID'].includes(field))
        && (where === '1=1' || exact.test(where));
}
