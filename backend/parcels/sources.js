// Resolves executable parcel descriptors and adapters for routes and authoritative proposal binding.
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from './arcgis-source.js';
import { createWfsParcelSource } from './wfs-source.js';
import { createSocrataParcelSource } from './socrata-source.js';
import { createOgcApiParcelSource } from './ogc-api-source.js';
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { createHttpsJsonFetch } from './https-json-fetch.js';

export const parcelSourceCatalog = JSON.parse(readFileSync(new URL('./source-catalog.json', import.meta.url), 'utf8'));
const certificateFetches = new Map();

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
    validateCityMetrics(descriptor);
    const factory = { arcgis: createArcgisParcelSource, wfs: createWfsParcelSource, 'ogc-api': createOgcApiParcelSource,
        'geojson-snapshot': createGeojsonSnapshotParcelSource, socrata: createSocrataParcelSource }[descriptor.adapter];
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

export function parcelSourceForCity(city) {
    const descriptor = parcelSourceCatalog.sources.find(source => source.cityIds.includes(city));
    if (!descriptor) return null;
    const adapter = createParcelSource(descriptor);
    // Keep adapter/cache identity tied to the original shared provider; only binding's projection varies.
    return { descriptor: descriptor.metricSridByCity ? { ...descriptor, metricSrid: descriptor.metricSridByCity[city] } : descriptor, adapter };
}

export function parcelSourceForIds(ids) {
    const descriptor = parcelSourceCatalog.sources.find(source => ids.some(id => String(id).startsWith(source.idPrefix)));
    return descriptor ? { descriptor, adapter: createParcelSource(descriptor) } : null;
}
