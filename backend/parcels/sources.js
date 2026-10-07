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
import { createGmlSnapshotParcelSource } from './gml-snapshot-source.js';
import { createCatastroWfsParcelSource } from './catastro-wfs-source.js';
import { createDlrsSheetParcelSource } from './dlrs-sheet-source.js';
import { createKeralaParcelSource } from './kerala-source.js';
import { createHttpsJsonFetch } from './https-json-fetch.js';
import { HttpError } from '../utils/helpers.js';
import { decodeCustomSource } from './custom-source-config.js';
import { createPublicSourceFetch } from './public-source-fetch.js';

export const parcelSourceCatalog = JSON.parse(readFileSync(new URL('./source-catalog.json', import.meta.url), 'utf8'));
const certificateFetches = new Map();
const customFetch = createPublicSourceFetch();
const runtimeSources = new Map();
export function clearParcelSourceRuntimeCache() { runtimeSources.clear(); }

// Source failures pause new traffic across viewport cells and binding calls. No failure is absence.
export function withSourceCooldown(adapter, { now = Date.now } = {}) {
    let failure = null, until = 0;
    const invoke = method => async (...args) => {
        if (failure && now() < until) throw Object.assign(new Error(failure.message), failure,
            { retryAfterSeconds: Math.ceil((until - now()) / 1000) });
        const previousFailure = failure;
        try {
            const result = await adapter[method](...args);
            if (failure === previousFailure) { failure = null; until = 0; }
            return result;
        }
        catch (error) {
            if (['parcel-source-blocked', 'parcel-source-rate-limited', 'parcel-source-unavailable'].includes(error.code)) {
                failure = error;
                until = now() + Math.max(1, Math.min(3600, error.retryAfterSeconds || (error.code === 'parcel-source-blocked' ? 60 : 30))) * 1000;
                error.retryAfterSeconds = Math.ceil((until - now()) / 1000);
            }
            throw error;
        }
    };
    return Object.freeze({ queryBounds: invoke('queryBounds'), queryIds: invoke('queryIds'), queryGeometry: invoke('queryGeometry') });
}

// Share a FIFO request budget across every query method used for one provider. A released slot is
// handed to its waiter directly, so new calls cannot jump the queue or oversubscribe the limit.
export function withSourceConcurrency(adapter, { limit = 2 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
        throw new TypeError('Parcel source concurrency limit must be an integer from 1 to 16.');
    }
    let active = 0;
    const waiting = [];
    const acquire = () => {
        if (active < limit) {
            active++;
            return Promise.resolve(makeRelease());
        }
        return new Promise(resolve => waiting.push(resolve));
    };
    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = waiting.shift();
            if (next) next(makeRelease());
            else active--;
        };
    };
    const invoke = method => async (...args) => {
        const release = await acquire();
        try { return await adapter[method](...args); }
        finally { release(); }
    };
    return Object.freeze({ queryBounds: invoke('queryBounds'), queryIds: invoke('queryIds'), queryGeometry: invoke('queryGeometry') });
}

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
        'geojson-snapshot': createGeojsonSnapshotParcelSource, 'gml-snapshot': createGmlSnapshotParcelSource,
        'catastro-wfs': createCatastroWfsParcelSource, 'dlrs-sheet': createDlrsSheetParcelSource,
        'kerala-entebhoomi': createKeralaParcelSource,
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
        const cooled = withSourceCooldown(adapter);
        runtimeSources.set(descriptor.id, descriptor.maxConcurrentQueries === undefined
            ? cooled : withSourceConcurrency(cooled, { limit: descriptor.maxConcurrentQueries }));
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
    const descriptor = parcelSourceCatalog.sources.filter(source => source.defaultForCity !== false
        && ids.some(id => String(id).startsWith(source.idPrefix)))
        .sort((a, b) => b.idPrefix.length - a.idPrefix.length)[0];
    return descriptor ? { descriptor, adapter: runtimeParcelSource(descriptor) } : null;
}
