// Query the federal CadGIS live companion without bulk-loading its discovery-bound monthly archive.
import { createArcgisParcelSource } from './arcgis-source.js';
import { upstreamError } from './source-contract.js';
import { concatBytes } from './byte-utils.js';

export const CADGIS_LIVE_LAYER = 'https://ccff02.minfin.fgov.be/geoservices/arcgis/rest/services/WMS/Cadastral_LayersWFS/MapServer/11';
export const CADGIS_ARCHIVE = 'https://opendata.fin.belgium.be/download/datasets/1d797df0-c988-11ed-abc3-0050569393d1_20260807_shp_31370_04000.zip';

export function isCadgisCompanion(descriptor) {
    return descriptor.adapter === 'be-cadgis' && descriptor.id === 'be-fps-finances-cadgis-cadastral-parcels'
        && descriptor.endpoint === CADGIS_ARCHIVE && descriptor.liveEndpoint === CADGIS_LIVE_LAYER;
}

export function createCadgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (!isCadgisCompanion(descriptor) || descriptor.idPrefix !== 'BE-FPS-CADGIS:'
        || descriptor.idField !== 'CaPaKey' || descriptor.objectIdField !== 'OBJECTID'
        || descriptor.idType !== 'string' || descriptor.sourceCrs !== 'EPSG:3812'
        || JSON.stringify(descriptor.outFields) !== JSON.stringify(['CaPaKey', 'OBJECTID'])
        || descriptor.attributeFilters || descriptor.attributeExclusions || descriptor.attributeNotNull
        || descriptor.attributeNull || descriptor.attributeDateEquals || descriptor.identityKind
        || descriptor.nativeGeometryMode || descriptor.overlapResolution || descriptor.geometryPrecision
        || descriptor.responseSrid !== undefined || descriptor.layerId !== undefined
        || descriptor.idFields !== undefined) throw new Error('Invalid federal CadGIS live companion descriptor.');
    // Count actual decoded bytes, including when Content-Length is absent or compressed.
    // This wrapper is shared by backend and browser and never persists provider payloads.
    async function boundedFetch(url, options) {
        if (new URL(url).origin + new URL(url).pathname !== `${CADGIS_LIVE_LAYER}/query`) {
            throw upstreamError('CadGIS request is outside the verified live parcel layer.');
        }
        const response = await fetchImpl(url, options);
        if (!response.ok) return response;
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('CadGIS returned no readable parcel response.');
        const chunks = []; let length = 0;
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                length += part.value.length;
                if (length > 2 * 1024 * 1024) throw upstreamError('CadGIS response exceeds the bounded byte limit.');
                chunks.push(part.value);
            }
        } finally {
            await reader.cancel().catch(() => {}); reader.releaseLock();
        }
        return new Response(concatBytes(chunks, length), { status: response.status,
            headers: { 'Content-Type': 'application/json' } });
    }
    return createArcgisParcelSource({ ...descriptor, adapter: 'arcgis', endpoint: CADGIS_LIVE_LAYER,
        idPattern: '^\\d{5}[A-Z]\\d{4}/\\d{2}[A-Z_]\\d{3}$', queryFormat: 'geojson' }, { fetchImpl: boundedFetch });
}
