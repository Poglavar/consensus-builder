import { createSupermapParcelSource } from './supermap-source.js';
import { createTaichungParcelSource } from './taichung-source.js';
import { createMojMapXmlParcelSource } from './moj-mapxml-source.js';
import { createUgnlisParcelSource } from './ugnlis-source.js';
import { createArcgisWebmapParcelSource } from './arcgis-webmap-source.js';
import { createKmlKmzParcelSource } from './kml-kmz-source.js';
import { createGwangjuJijukParcelSource } from './gwangju-jijuk-source.js';
import { createCadgisParcelSource } from './be-cadgis-source.js';
import { createGisarWmsParcelSource } from './kg-gisar-wms-source.js';
import { createDncSnigParcelSource } from './uy-dnc-snig-source.js';
import { createGeojsonRangeParcelSource } from './geojson-range-source.js';
import { createHuainanMapshineParcelSource } from './huainan-mapshine-source.js';
import { createSofiaParcelSource } from './sofia-isofmap-source.js';
import { createSantosLotesSource } from './santos-lotes-source.js';
import { createGlisParcelSource } from './pk-glis-source.js';
import { createInterpiSigefParcelSource } from './interpi-sigef-source.js';
import { createKartverketParcelSource } from './kartverket-source.js';
import { createShapefileRangeParcelSource } from './shapefile-range-source.js';
// Resolves executable parcel descriptors and adapters for routes and authoritative proposal binding.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createArcgisParcelSource } from './arcgis-source.js';
import { createDdaParcelSource } from './dda-source.js';
import { createWfsParcelSource } from './wfs-source.js';
import { createDguParcelSource } from './dgu-source.js';
import { createShenzhenLandCertainSource } from './shenzhen-source.js';
import { createSocrataParcelSource } from './socrata-source.js';
import { createOgcApiParcelSource } from './ogc-api-source.js';
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { officialArchiveFetch, createGmlSnapshotParcelSource } from './gml-snapshot-source.js';
import { createShapefileSnapshotParcelSource } from './shapefile-snapshot-source.js';
import { createCatastroWfsParcelSource } from './catastro-wfs-source.js';
import { createDlrsSheetParcelSource } from './dlrs-sheet-source.js';
import { createKeralaParcelSource } from './kerala-source.js';
import { createNairobiOutlineSource } from './nairobi-outline-source.js';
import { createKazakhstanPkkSource } from './kazakhstan-pkk-source.js';
import { createMsdaPointSource } from './msda-point-source.js';
import { createTkgmPointSource } from './tkgm-point-source.js';
import { createUldkPointSource } from './pl-uldk-point-source.js';
import { createBevTileParcelSource } from './bev-tile-source.js';
import { createVectorTileParcelSource } from './vector-tile-source.js';
import { createHamburgAlkisParcelSource } from './hamburg-alkis-source.js';
import { createFrankfurtWfsParcelSource } from './frankfurt-wfs-source.js';
import { createGmlWfsParcelSource } from './gml-wfs-source.js';
import { createPulsePublicParcelSource } from './pulse-public-source.js';
import { createBfDgiParcelSource } from './bf-dgi-source.js';
import { createDivoEcommunesSource } from './divo-ecommunes-source.js';
import { createHttpsJsonFetch } from './https-json-fetch.js';
import { HttpError } from '../utils/helpers.js';
import { decodeCustomSource } from './custom-source-config.js';
import { createPublicSourceFetch } from './public-source-fetch.js';
import { withSourceCooldown, withSourceConcurrency, withSourceControls } from './source-controls.js';
const SourceRuntime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');

export { withSourceCooldown, withSourceConcurrency } from './source-controls.js';

export const parcelSourceCatalog = JSON.parse(readFileSync(new URL('../../frontend/data/source-catalog.json', import.meta.url), 'utf8'));
const certificateFetches = new Map();
const customFetch = createPublicSourceFetch();
const runtimeSources = new Map();
export function clearParcelSourceRuntimeCache() { runtimeSources.clear(); }

const parcelFactories = {
    'supermap-map': createSupermapParcelSource,
    'taichung-gismap': createTaichungParcelSource,
    'moj-mapxml': createMojMapXmlParcelSource,
    'ugnlis-parcel-search': createUgnlisParcelSource,
    'ecommunes-xml': createDivoEcommunesSource,
    'arcgis-webmap': createArcgisWebmapParcelSource,
    'kml-kmz': createKmlKmzParcelSource,
    'gwangju-jijuk': createGwangjuJijukParcelSource,
    'be-cadgis': createCadgisParcelSource,
    'kg-gisar-wms': createGisarWmsParcelSource,
    'uy-dnc-snig': createDncSnigParcelSource,
    'geojson-range': createGeojsonRangeParcelSource,
    'huainan-mapshine': createHuainanMapshineParcelSource,
    'sofia-isofmap': createSofiaParcelSource,
    'santos-lotes': createSantosLotesSource,
    'pk-glis': createGlisParcelSource,
    'interpi-sigef': createInterpiSigefParcelSource,
    'kartverket-eiendom': createKartverketParcelSource,
    'shapefile-range': createShapefileRangeParcelSource, 'dda-public-plots': createDdaParcelSource, 'shenzhen-land-certain': (_descriptor, opts) => createShenzhenLandCertainSource(opts), 'dgu-wfs': createDguParcelSource, arcgis: createArcgisParcelSource, wfs: createWfsParcelSource, 'ogc-api': createOgcApiParcelSource,
        'geojson-snapshot': (source, opts) => source.snapshotFormat === 'shapefile-zip'
            ? createShapefileSnapshotParcelSource(source, opts) : createGeojsonSnapshotParcelSource(source, opts),
        'shapefile-snapshot': createShapefileSnapshotParcelSource, 'shapefile-zip': createShapefileSnapshotParcelSource,
        'gml-snapshot': createGmlSnapshotParcelSource,
        'hmlr-browser': (source, opts) => {
            let adapter;
            const get = () => adapter ||= (async () => {
                const featureStore = opts.featureStore || (await import('./node-hmlr-feature-store.js'))
                    .getSharedNodeHmlrFeatureStore(source.manifestUrl, source.snapshotId);
                const module = await import('./hmlr-browser-source.js');
                return module.createHmlrBrowserParcelSource(source, { ...opts, featureStore,
                    fetchImpl: (url, options) => new URL(url).hostname === 'use-land-property-data.service.gov.uk'
                        ? officialArchiveFetch(url, options) : (opts.fetchImpl || globalThis.fetch)(url, options) });
            })();
            return Object.fromEntries(['queryBounds', 'queryIds', 'queryGeometry'].map(method => [method, async (...args) => (await get())[method](...args)]));
        },
        'catastro-wfs': createCatastroWfsParcelSource, 'dlrs-sheet': createDlrsSheetParcelSource,
        'kerala-entebhoomi': createKeralaParcelSource,
        'nairobi-outlines': createNairobiOutlineSource,
        'kazakhstan-pkk': createKazakhstanPkkSource,
        'msda-point': createMsdaPointSource,
        'tkgm-point': createTkgmPointSource,
        'pl-uldk-point': createUldkPointSource,
        'bev-tiles': createBevTileParcelSource,
        'vector-tiles': createVectorTileParcelSource,
        'hamburg-alkis-wfs': createHamburgAlkisParcelSource,
        'frankfurt-wfs': createFrankfurtWfsParcelSource,
        'gml-wfs': createGmlWfsParcelSource,
        'pulse-public': createPulsePublicParcelSource,
        'bf-dgi-geojson': createBfDgiParcelSource,
        'divo-ecommunes-xml': createDivoEcommunesSource,
        socrata: createSocrataParcelSource };

export const parcelSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'parcels',
    adapters: Object.fromEntries(Object.entries(parcelFactories).map(([id, create]) => [id, { create,
        custom: ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot'].includes(id)
    }])),
    sources: parcelSourceCatalog.sources.map(descriptor => SourceRuntime.source('parcels', descriptor.adapter, descriptor)),
    required: ['queryBounds', 'queryIds', 'queryGeometry']
});

export function createParcelSource(descriptor, options = {}) {
    if (descriptor.id?.startsWith('custom.')) {
        descriptor = decodeCustomSource(descriptor.id);
        options = { ...options, fetchImpl: options.fetchImpl || customFetch };
    }
    if (!parcelFactories[descriptor.adapter]) throw new Error(`Unsupported parcel adapter: ${descriptor.adapter}`);
    if (descriptor.caCertificate && !options.fetchImpl) {
        if (!certificateFetches.has(descriptor.caCertificate)) {
            const certificate = readFileSync(new URL(descriptor.caCertificate, import.meta.url), 'utf8');
            certificateFetches.set(descriptor.caCertificate, createHttpsJsonFetch(certificate));
        }
        options = { ...options, fetchImpl: certificateFetches.get(descriptor.caCertificate) };
    }
    const source = SourceRuntime.source('parcels', descriptor.adapter, descriptor, {
        kind: /^(custom|building)\./.test(descriptor.id) ? 'custom' : 'default'
    });
    // Native descriptors are trusted application configuration. Portable visitor sources are
    // decoded above and remain custom; they never add or replace configured defaults.
    if (source.kind === 'default') parcelSourceRegistry.register(source, { replace: true });
    return parcelSourceRegistry.open(source, options);
}

export function resolveParcelSourceDescriptor(sourceId) {
    return typeof sourceId === 'string' && sourceId.startsWith('custom.')
        ? decodeCustomSource(sourceId) : parcelSourceCatalog.sources.find(source => source.id === sourceId) || null;
}

export function runtimeParcelSource(descriptor) {
    if (!runtimeSources.has(descriptor.id)) {
        if (runtimeSources.size >= 160) runtimeSources.delete(runtimeSources.keys().next().value);
        const adapter = createParcelSource(descriptor, descriptor.id.startsWith('custom.') || descriptor.caCertificate || descriptor.adapter === 'gml-snapshot'
            ? {} : { fetchImpl: (...args) => globalThis.fetch(...args) });
        runtimeSources.set(descriptor.id, withSourceControls(adapter, { maxConcurrentQueries: descriptor.maxConcurrentQueries }));
    }
    return runtimeSources.get(descriptor.id);
}

// Explicit dataset selection. City defaults and namespace inference belong to the consumer.
export function parcelSourceById(sourceId) {
    const descriptor = resolveParcelSourceDescriptor(sourceId);
    if (!descriptor) throw Object.assign(new HttpError(400, 'Choose an explicit parcel source.'), { code: 'invalid-parcel-source' });
    return { descriptor, adapter: runtimeParcelSource(descriptor) };
}
