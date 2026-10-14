// Resolves executable parcel descriptors and adapters for routes and authoritative proposal binding.
import { readFileSync } from 'node:fs';
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
import { createHttpsJsonFetch } from './https-json-fetch.js';
import { HttpError } from '../utils/helpers.js';
import { decodeCustomSource } from './custom-source-config.js';
import { createPublicSourceFetch } from './public-source-fetch.js';
import { withSourceCooldown, withSourceConcurrency, withSourceControls } from './source-controls.js';

export { withSourceCooldown, withSourceConcurrency } from './source-controls.js';

export const parcelSourceCatalog = JSON.parse(readFileSync(new URL('./source-catalog.json', import.meta.url), 'utf8'));
const certificateFetches = new Map();
const customFetch = createPublicSourceFetch();
const runtimeSources = new Map();
export function clearParcelSourceRuntimeCache() { runtimeSources.clear(); }

function validateCityMetrics(descriptor) {
    const metrics = descriptor.metricSridByCity;
    if (metrics === undefined) return;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)
        || !Array.isArray(descriptor.cityIds)
        || Object.keys(metrics).length !== descriptor.cityIds.length
        || descriptor.cityIds.some(city => !Object.hasOwn(metrics, city))
        || Object.values(metrics).some(srid => !Number.isSafeInteger(srid) || srid <= 0)) {
        throw new Error('Invalid parcel source city metric projections.');
    }
}

export function createParcelSource(descriptor, options = {}) {
    if (descriptor.id?.startsWith('custom.')) {
        descriptor = decodeCustomSource(descriptor.id);
        options = { ...options, fetchImpl: options.fetchImpl || customFetch };
    }
    validateCityMetrics(descriptor);
    const factory = { 'dda-public-plots': createDdaParcelSource, 'shenzhen-land-certain': (_descriptor, opts) => createShenzhenLandCertainSource(opts), 'dgu-wfs': createDguParcelSource, arcgis: createArcgisParcelSource, wfs: createWfsParcelSource, 'ogc-api': createOgcApiParcelSource,
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
        socrata: createSocrataParcelSource }[descriptor.adapter];
    if (!factory) throw new Error(`Unsupported parcel adapter: ${descriptor.adapter}`);
    if (descriptor.caCertificate && !options.fetchImpl) {
        if (!certificateFetches.has(descriptor.caCertificate)) {
            const certificate = readFileSync(new URL(descriptor.caCertificate, import.meta.url), 'utf8');
            certificateFetches.set(descriptor.caCertificate, createHttpsJsonFetch(certificate));
        }
        options = { ...options, fetchImpl: certificateFetches.get(descriptor.caCertificate) };
    }
    return factory(descriptor, options);
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

export function parcelSourceForCity(city, sourceId = null) {
    const descriptor = sourceId === null || sourceId === undefined
        ? parcelSourceCatalog.sources.find(source => source.defaultForCity !== false && source.cityIds.includes(city))
        : resolveParcelSourceDescriptor(sourceId);
    if (sourceId !== null && sourceId !== undefined && (!descriptor || !descriptor.cityIds.includes(city))) {
        throw Object.assign(new HttpError(400, 'Parcel source is not configured for this city.'), { code: 'invalid-parcel-source' });
    }
    if (!descriptor) return null;
    const adapter = runtimeParcelSource(descriptor);
    // Keep adapter/cache identity tied to the original shared provider; only binding's projection varies.
    return { descriptor: descriptor.metricSridByCity ? { ...descriptor, metricSrid: descriptor.metricSridByCity[city] } : descriptor, adapter };
}

export function parcelSourceForIds(ids) {
    // Retired city defaults can still resolve immutable proposal references in their
    // original namespace; opt-in/unqualified sources need an explicit historical grant.
    // Resolve the most specific namespace before checking eligibility. An unavailable
    // GB-HMLR-BROWSER-v1 ID must not be interpreted through the older GB-HMLR prefix.
    const descriptor = parcelSourceCatalog.sources.filter(source => ids.some(id => String(id).startsWith(source.idPrefix)))
        .sort((a, b) => b.idPrefix.length - a.idPrefix.length)[0];
    return descriptor && (descriptor.defaultForCity !== false || descriptor.historicalForIds === true)
        ? { descriptor, adapter: runtimeParcelSource(descriptor) } : null;
}
