// Bounded live cadastral companion for DNC's discovery-bound national urban archive.
// The SNIG publication is explicit: it is not a byte-identical or date-pinned ZIP snapshot.
import { createArcgisParcelSource, nativeGeometryHash } from './arcgis-source.js';
import { concatBytes } from './byte-utils.js';
import { upstreamError } from './source-contract.js';

export const DNC_URBAN_ARCHIVE = 'https://catalogodatos.gub.uy/dataset/9e0dc092-a669-4697-b3ba-88808165c902/resource/3d211675-14a6-4e69-bc0b-6cc549060633/download/paisurbano_shp.zip';
export const SNIG_CADASTRAL_LAYER = 'https://web.snig.gub.uy/arcgisserver/rest/services/Uruguay/SNIG_Catastro/MapServer/1';
const FIELDS = ['OBJECTID', 'Codigo', 'codDepto', 'codLocCat', 'tipo'];
const FILTER = { codDepto: 'V', codLocCat: 'AA', tipo: 'U' };
const MAX_BYTES = 2 * 1024 * 1024;

export function isDncSnigCompanion(descriptor) {
    return descriptor.adapter === 'uy-dnc-snig' && descriptor.id === 'uy-dnc-pais-urbano-shp-2026'
        && descriptor.endpoint === DNC_URBAN_ARCHIVE && descriptor.liveEndpoint === SNIG_CADASTRAL_LAYER;
}

export function createDncSnigParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (!isDncSnigCompanion(descriptor) || descriptor.idPrefix !== 'UY-DNC-SNIG:'
        || descriptor.idField !== 'Codigo' || descriptor.objectIdField !== 'OBJECTID'
        || descriptor.idType !== 'string' || descriptor.identityKind !== 'native-key-geometry-sha256-v1'
        || JSON.stringify(descriptor.outFields) !== JSON.stringify(FIELDS)
        || JSON.stringify(descriptor.attributeFilters) !== JSON.stringify(FILTER)
        || descriptor.queryFormat !== 'geojson' || descriptor.boundsQueryMode !== 'object-ids'
        || descriptor.idsQueryMode !== 'object-ids' || descriptor.maxResponseBytes !== MAX_BYTES
        || descriptor.idFields !== undefined || descriptor.layerId !== undefined
        || descriptor.geometryPrecision !== undefined || descriptor.partsCoordinatePrecision !== undefined
        || descriptor.nativeGeometryMode !== undefined || descriptor.overlapResolution !== undefined
        || descriptor.responseSrid !== undefined || descriptor.attributeExclusions !== undefined
        || descriptor.attributeNull !== undefined || descriptor.attributeNotNull !== undefined
        || descriptor.attributeDateEquals !== undefined) throw new Error('Invalid DNC/SNIG cadastral companion descriptor.');

    // Isolate collision tracking per operation, including all OID pages. Identical
    // native-key/geometry hashes are ambiguous source rows, never deduplication permission.
    async function run(method, argument) {
        const seen = new Set();
        const boundedFetch = async (url, options) => {
            const target = new URL(url);
            if (target.origin + target.pathname !== `${SNIG_CADASTRAL_LAYER}/query`) {
                throw upstreamError('DNC/SNIG request is outside the verified cadastral layer.');
            }
            const response = await fetchImpl(url, options);
            if (!response.ok) return response;
            const reader = response.body?.getReader();
            if (!reader) throw upstreamError('DNC/SNIG returned no readable parcel response.');
            const chunks = []; let bytes = 0;
            try {
                for (;;) {
                    const part = await reader.read(); if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > MAX_BYTES) throw upstreamError('DNC/SNIG response exceeds the byte limit.');
                    chunks.push(part.value);
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            const body = concatBytes(chunks, bytes);
            const payload = JSON.parse(new TextDecoder().decode(body));
            if (payload.type === 'FeatureCollection') for (const row of payload.features || []) {
                const reference = `${row.properties?.Codigo}-${nativeGeometryHash(row.geometry)}`;
                if (seen.has(reference)) throw upstreamError('DNC/SNIG native-key geometry reference collision.');
                seen.add(reference);
            }
            return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
        };
        const source = createArcgisParcelSource({ ...descriptor, adapter: 'arcgis', endpoint: SNIG_CADASTRAL_LAYER,
            idPattern: '^VAA[0-9]{7}$' }, { fetchImpl: boundedFetch });
        return source[method](argument);
    }
    return Object.freeze(Object.fromEntries(['queryBounds', 'queryIds', 'queryGeometry']
        .map(method => [method, argument => run(method, argument)])));
}
