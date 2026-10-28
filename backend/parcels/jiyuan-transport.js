// Jiyuan publishes its registration-linked cadastral service at this fixed HTTP endpoint.
// Browser reads use our relay; never extend this exception to arbitrary HTTP layers.
export const JIYUAN_SOURCE_ID = 'cn-jiyuan-yituchafang-zd';
export const JIYUAN_ENDPOINT = 'http://221.13.152.245:7878/estate/forward/arcgis/rest/services/YTCF/ZD/MapServer';

export function isJiyuanSource(descriptor) {
    return descriptor?.id === JIYUAN_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === JIYUAN_ENDPOINT && descriptor.layerId === 0 && descriptor.browserTransport === 'relay'
        && descriptor.idField === 'ZDTYBM' && descriptor.objectIdField === 'FID'
        && descriptor.idType === 'string' && descriptor.queryFormat === 'esri-json'
        && descriptor.boundsQueryMode === 'object-ids' && descriptor.idsQueryMode === 'single-equality'
        && descriptor.outFields?.length === 2 && descriptor.outFields.includes('FID')
        && descriptor.outFields.includes('ZDTYBM')
        && descriptor.idPrefix === 'CN-JIYUAN-YTCF-ZDTYBM-'
        && descriptor.idBatchSize === 1
        && Number.isSafeInteger(descriptor.pageSize) && descriptor.pageSize >= 1 && descriptor.pageSize <= 80;
}

export function isJiyuanQueryUrl(url) {
    const endpoint = new URL(JIYUAN_ENDPOINT);
    if (!(url instanceof URL) || url.origin !== endpoint.origin || url.pathname !== `${endpoint.pathname}/0/query`
        || url.username || url.password || url.hash) return false;
    const allowed = new Set(['where', 'outFields', 'returnGeometry', 'f', 'outSR', 'returnTrueCurves',
        'returnCountOnly', 'returnIdsOnly', 'objectIds', 'geometry', 'geometryType', 'inSR', 'spatialRel']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key)
        || url.searchParams.getAll(key).length !== 1)) return false;
    const q = url.searchParams, fields = q.get('outFields')?.split(',');
    const where = q.get('where');
    const nativeKeys = /^ZDTYBM='[0-9A-Z]{19}'$/;
    if (q.get('f') !== 'json' || !fields?.length || new Set(fields).size !== fields.length
        || fields.some(field => !['FID', 'ZDTYBM'].includes(field))
        || (where !== '1=1' && !nativeKeys.test(where))) return false;
    const objects = q.get('objectIds');
    if (objects !== null && (!/^[0-9]+(?:,[0-9]+){0,79}$/.test(objects))) return false;
    if (q.get('returnGeometry') === 'true') return objects !== null && q.get('outSR') === '4326';
    if (q.get('returnGeometry') !== 'false'
        || !(q.get('returnCountOnly') === 'true' || q.get('returnIdsOnly') === 'true')) return false;
    // Unfiltered manifests are never allowed: bounds reads or explicit native keys only.
    if (where !== '1=1') return true;
    try {
        const coordinates = q.get('geometry')?.split(',');
        if (coordinates?.length !== 4 || coordinates.some(value => !value.trim())) return false;
        const [xmin, ymin, xmax, ymax] = coordinates.map(Number);
        const b = { xmin, ymin, xmax, ymax };
        return q.get('geometryType') === 'esriGeometryEnvelope' && q.get('inSR') === '4326'
            && q.get('spatialRel') === 'esriSpatialRelIntersects'
            && [b.xmin, b.ymin, b.xmax, b.ymax].every(Number.isFinite)
            && b.xmin >= -180 && b.xmax <= 180 && b.ymin >= -90 && b.ymax <= 90
            && b.xmin < b.xmax && b.ymin < b.ymax
            && (b.xmax - b.xmin) * (b.ymax - b.ymin) * 12364 <= 4;
    } catch { return false; }
}
