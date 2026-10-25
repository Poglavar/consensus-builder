// Xuchang publishes its anonymous cadastral query over HTTP on a fixed port.
// Keep that exception source-scoped; arbitrary HTTP ArcGIS URLs remain rejected.
export const XUCHANG_SOURCE_ID = 'cn-xuchang-xcbdc-yituchafang';
export const XUCHANG_ENDPOINT = 'http://www.xcbdc.org.cn:7878/estate/forward/arcgis/rest/services/YTCF/ZD_DBZD/MapServer/0/query';

export function isXuchangSource(descriptor) {
    return descriptor?.id === XUCHANG_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === XUCHANG_ENDPOINT && descriptor.browserTransport === 'relay'
        && descriptor.idField === 'ZDTYBM' && descriptor.objectIdField === 'OBJECTID'
        && descriptor.idType === 'string' && descriptor.queryFormat === 'esri-json'
        && descriptor.boundsQueryMode === 'object-ids' && descriptor.idsQueryMode === 'single-equality'
        && descriptor.outFields?.length === 2 && descriptor.outFields.includes('OBJECTID')
        && descriptor.outFields.includes('ZDTYBM');
}

export function isXuchangQueryUrl(url) {
    const endpoint = new URL(XUCHANG_ENDPOINT);
    if (!(url instanceof URL) || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname
        || url.username || url.password || url.hash) return false;
    const allowed = new Set(['where', 'outFields', 'returnGeometry', 'f', 'outSR', 'returnTrueCurves',
        'returnCountOnly', 'returnIdsOnly', 'objectIds', 'geometry', 'geometryType', 'inSR', 'spatialRel']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key)
        || url.searchParams.getAll(key).length !== 1)) return false;
    const fields = url.searchParams.get('outFields')?.split(',');
    return url.searchParams.get('f') === 'json' && fields?.length > 0
        && fields.every(field => ['OBJECTID', 'ZDTYBM'].includes(field));
}
