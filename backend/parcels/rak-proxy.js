// Preserve RAK Addressing's official nested GET URL and restrict relay access to its parcel layer.
export const RAK_SOURCE_ID = 'ae-rak-raklocator-parcels';
export const RAK_LAYER = 'https://gis.rak.ae/server/rest/services/RakLocatorMap/RakLocatorMap/MapServer/4';
export const RAK_PROXY = 'https://maps.rak.ae/Dotnet/proxy.ashx?';

export function isRakParcelSource(descriptor) {
    return descriptor.id === RAK_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === RAK_LAYER;
}

export function rakParcelQueryUrl(search) {
    return `${RAK_PROXY}${RAK_LAYER}/query?${search}`;
}

export function isRakParcelRequest(url) {
    const prefix = `${RAK_PROXY}${RAK_LAYER}/query?`;
    if (!(url instanceof URL) || url.username || url.password || url.hash
        || !url.href.startsWith(prefix)) return false;
    const params = new URLSearchParams(url.href.slice(prefix.length));
    const allowed = new Set(['where', 'outFields', 'returnGeometry', 'outSR', 'f', 'geometry',
        'geometryType', 'inSR', 'spatialRel', 'orderByFields', 'resultRecordCount',
        'resultOffset', 'returnCountOnly', 'returnIdsOnly', 'objectIds', 'returnTrueCurves']);
    return [...params.keys()].every(key => allowed.has(key) && params.getAll(key).length === 1)
        && ['OBJECTID', 'ParcelID', 'OBJECTID,ParcelID'].includes(params.get('outFields'))
        && params.get('f') === 'json'
        && (!params.has('outSR') || params.get('outSR') === '4326');
}
