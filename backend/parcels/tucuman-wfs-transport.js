// Pin the DGC's officially published HTTP service to its reviewed public parcel layer.
export const TUCUMAN_SOURCE_ID = 'ar-tucuman-dgc-wfs-parcelasrubep';
export const TUCUMAN_WFS_ENDPOINT = 'http://200.49.89.203/geoserver/dgct/wfs';

export function isTucumanWfsSource(descriptor) {
    return descriptor.id === TUCUMAN_SOURCE_ID && descriptor.adapter === 'wfs'
        && descriptor.endpoint === TUCUMAN_WFS_ENDPOINT && descriptor.version === '1.1.0'
        && descriptor.featureType === 'dgct:PARCELASRUBEP' && descriptor.idField === 'KEY'
        && descriptor.idType === 'string' && descriptor.geometryField === 'GEOMETRY'
        && descriptor.requestProperties === true && descriptor.outFields?.length === 1
        && descriptor.outFields[0] === 'KEY' && descriptor.responseSrid === undefined
        && descriptor.browserTransport === 'relay';
}

export function isTucumanWfsUrl(url) {
    if (!(url instanceof URL) || url.username || url.password || url.hash
        || `${url.origin}${url.pathname}` !== TUCUMAN_WFS_ENDPOINT) return false;
    const expected = { service: 'WFS', version: '1.1.0', request: 'GetFeature',
        typeName: 'dgct:PARCELASRUBEP', outputFormat: 'application/json',
        srsName: 'CRS:84', propertyName: 'GEOMETRY,KEY' };
    // OGC parameter names are case-insensitive upstream. Reject alternate-case
    // overrides and duplicate keys instead of relying on the server's precedence.
    const allowed = new Set([...Object.keys(expected), 'sortBy', 'maxFeatures', 'startIndex', 'bbox', 'cql_filter']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key)
        || url.searchParams.getAll(key).length !== 1)) return false;
    return Object.entries(expected).every(([key, value]) =>
        url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value);
}
