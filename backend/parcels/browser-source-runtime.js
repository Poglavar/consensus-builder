// Runs the existing complete-source adapters in a worker, preferring provider fetch over a byte relay.
import catalog from './source-catalog.json' with { type: 'json' };
import { createArcgisParcelSource } from './arcgis-source.js';
import { createWfsParcelSource } from './wfs-source.js';
import { createOgcApiParcelSource } from './ogc-api-source.js';
import { createSocrataParcelSource } from './socrata-source.js';
import { createDdaParcelSource } from './dda-source.js';
import { createPulsePublicParcelSource } from './pulse-public-source.js';
import { createShenzhenLandCertainSource } from './shenzhen-source.js';
import { createDguParcelSource } from './dgu-source.js';
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { createShapefileSnapshotParcelSource } from './shapefile-snapshot-source.js';
import { createGmlSnapshotParcelSource } from './gml-snapshot-source.js';
import { createGmlWfsParcelSource } from './gml-wfs-source.js';
import { createCatastroWfsParcelSource } from './catastro-wfs-source.js';
import { createFrankfurtWfsParcelSource } from './frankfurt-wfs-source.js';
import { createHamburgAlkisParcelSource } from './hamburg-alkis-source.js';
import { createBevTileParcelSource } from './bev-tile-source.js';
import { createVectorTileParcelSource } from './vector-tile-source.js';
import { createDlrsSheetParcelSource } from './dlrs-sheet-source.js';
import { createKeralaParcelSource } from './kerala-source.js';
import { createNairobiOutlineSource } from './nairobi-outline-source.js';
import { createKazakhstanPkkSource } from './kazakhstan-pkk-source.js';
import { createMsdaPointSource } from './msda-point-source.js';
import { createTkgmPointSource } from './tkgm-point-source.js';
import { createUldkPointSource } from './pl-uldk-point-source.js';
import { knownLimitFor, upstreamError } from './source-contract.js';
import { withSourceControls } from './source-controls.js';

function expectedEtagForUrl(descriptor, url) {
    const requested = new URL(url).href;
    const resources = [descriptor, ...(Array.isArray(descriptor.snapshots) ? descriptor.snapshots : [])];
    return resources.find(resource => resource.expectedEtag !== undefined
        && typeof resource.endpoint === 'string' && new URL(resource.endpoint).href === requested)?.expectedEtag;
}

export const browserParcelFactories = Object.freeze({
    'hmlr-browser': async (descriptor, options) => (await import('./hmlr-browser-source.js')).createHmlrBrowserParcelSource(descriptor, options), arcgis: createArcgisParcelSource, wfs: createWfsParcelSource,
    'ogc-api': createOgcApiParcelSource, socrata: createSocrataParcelSource,
    'dda-public-plots': createDdaParcelSource, 'pulse-public': createPulsePublicParcelSource,
    'shenzhen-land-certain': (_descriptor, options) => createShenzhenLandCertainSource(options),
    'dgu-wfs': createDguParcelSource,
    'geojson-snapshot': (descriptor, options) => descriptor.snapshotFormat === 'shapefile-zip'
        ? createShapefileSnapshotParcelSource(descriptor, options) : createGeojsonSnapshotParcelSource(descriptor, options),
    'shapefile-snapshot': createShapefileSnapshotParcelSource, 'shapefile-zip': createShapefileSnapshotParcelSource,
    'gml-snapshot': createGmlSnapshotParcelSource, 'gml-wfs': createGmlWfsParcelSource,
    'catastro-wfs': createCatastroWfsParcelSource, 'frankfurt-wfs': createFrankfurtWfsParcelSource,
    'hamburg-alkis-wfs': createHamburgAlkisParcelSource, 'bev-tiles': createBevTileParcelSource, 'vector-tiles': createVectorTileParcelSource,
    'dlrs-sheet': createDlrsSheetParcelSource, 'kerala-entebhoomi': createKeralaParcelSource,
    'nairobi-outlines': createNairobiOutlineSource, 'kazakhstan-pkk': createKazakhstanPkkSource,
    'msda-point': createMsdaPointSource, 'tkgm-point': createTkgmPointSource, 'pl-uldk-point': createUldkPointSource });

// A provider that ignores some networks can leave the direct connection hanging rather than
// failing it, which would spend the adapter's whole timeout and never reach the relay.
const DIRECT_HEADERS_BUDGET_MS = 6000;

export function createBrowserProviderFetch(descriptor, { fetchImpl = globalThis.fetch, relayBase, now = Date.now,
    directBudgetMs = DIRECT_HEADERS_BUDGET_MS } = {}) {
    const blocked = new Map();
    // Only a source the catalog marks network-restricted gets a deadline for its direct answer's
    // headers; past it, the request goes through the relay, which answers from a served network.
    const directBudget = descriptor.knownLimit?.kind === 'network-restricted' ? directBudgetMs : null;
    // A provider that lets no other site read its answers (no CORS) is never tried directly: the
    // attempt fails for every visitor, so it would only delay the relay and say nothing about them.
    const relayOnly = descriptor.browserTransport === 'relay';
    const needsSession = descriptor.adapter === 'kerala-entebhoomi'
        || descriptor.adapter === 'dgu-wfs'
        || (descriptor.adapter === 'gml-snapshot' && new URL(descriptor.endpoint).hostname === 'use-land-property-data.service.gov.uk');
    async function relay(url, options) {
        if (!relayBase) throw upstreamError('Provider requires a transport relay; none is configured.');
        const headers = Object.fromEntries([...new Headers(options.headers)].filter(([name]) => !['user-agent', 'accept-encoding', 'host', 'content-length'].includes(name)));
        let response = await fetchImpl(`${relayBase.replace(/\/$/, '')}/parcel-provider-relay/${encodeURIComponent(descriptor.id)}`, {
            method: 'POST', signal: options.signal, credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: String(url), method: options.method || 'GET', headers,
                ...(options.body === undefined ? {} : { body: String(options.body) }), redirect: options.redirect })
        });
        const upstreamStatus = response.headers.get('x-parcel-upstream-status');
        if (upstreamStatus !== null) {
            if (response.status !== 200 || !/^3[0-9]{2}$/.test(upstreamStatus)) throw upstreamError('Provider relay returned invalid HTTP metadata.');
            const status = Number(upstreamStatus), headers = new Headers(response.headers);
            const location = headers.get('x-parcel-upstream-location');
            if (location) headers.set('location', location);
            let body = response.body;
            if (status === 304) { await body?.cancel(); body = null; }
            response = new Response(body, { status, headers });
        }
        Object.defineProperty(response, 'url', { value: String(url) });
        // Cookie sessions belong to this browser's adapter, never to a shared server cache.
        const cookies = response.headers.get('x-parcel-upstream-cookies');
        if (cookies) {
            let values;
            try { values = JSON.parse(cookies); } catch { throw upstreamError('Provider relay returned invalid session metadata.'); }
            if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw upstreamError('Provider relay returned invalid session metadata.');
            Object.defineProperty(response.headers, 'getSetCookie', { value: () => values });
        }
        return response;
    }
    return async function browserProviderFetch(url, options = {}) {
        const origin = new URL(url).origin;
        if (relayOnly || needsSession || (descriptor.adapter === 'hmlr-browser' && new URL(url).hostname === 'use-land-property-data.service.gov.uk') || (blocked.get(origin) || 0) > now()) return relay(url, options);
        let response;
        const budget = directBudget === null ? null : new AbortController();
        const timer = budget ? setTimeout(() => budget.abort(), directBudget) : null;
        try {
            const signal = budget ? (options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal) : options.signal;
            response = await fetchImpl(url, { ...options, ...(signal ? { signal } : {}), credentials: 'omit' });
        } catch (error) {
            if (options.signal?.aborted) throw error;
            if (!budget?.signal.aborted && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
            // Fetch cannot distinguish CORS/TLS from a network failure. Only a transport failure
            // (or a network-restricted provider's silence) retries through the relay; an upstream
            // HTTP denial stays a denial.
            blocked.set(origin, now() + 5 * 60 * 1000);
            return relay(url, options);
        } finally {
            clearTimeout(timer);
        }
        if (response.ok && expectedEtagForUrl(descriptor, url) !== undefined && response.headers.get('etag') === null) {
            await response.body?.cancel();
            blocked.set(origin, now() + 5 * 60 * 1000);
            return relay(url, options);
        }
        return response;
    };
}

// What the map tells a visitor about a source: catalog wording and links only, never request details.
export function publicSourceInfo(source) {
    const link = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };
    let host = null;
    try { host = new URL(source.endpoint || source.manifestUrl).hostname; } catch { /* A source without a URL keeps its name. */ }
    const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    return { id: source.id, name: text(source.name) || source.id, attribution: text(source.attribution), scope: text(source.scope),
        licenceNote: text(source.licenceNote), licenceUrl: link(source.licenceUrl), catalogueUrl: link(source.catalogueUrl),
        host, viaRelay: source.browserTransport === 'relay' };
}

export function createBrowserParcelRuntime(options = {}) {
    const { factories = browserParcelFactories, ...fetchOptions } = options;
    const adapters = new Map();
    const pending = new Set();
    const progressListeners = new Map();
    function reportProgress(sourceId, detail) {
        for (const listener of progressListeners.get(sourceId) || []) {
            try { listener(detail); } catch { /* A display callback must not fail a provider query. */ }
        }
    }
    function trimAdapters() {
        while (adapters.size > 8) {
            const oldestResolved = [...adapters.keys()].find(sourceId => !pending.has(sourceId));
            if (oldestResolved === undefined) return;
            adapters.delete(oldestResolved);
        }
    }
    function descriptor(sourceId, customDescriptor) {
        const known = catalog.sources.find(source => source.id === sourceId);
        if (known) return known;
        if (sourceId.startsWith('custom.') && customDescriptor?.id === sourceId) return customDescriptor;
        throw upstreamError('Unknown browser parcel source.', 404);
    }
    function adapter(sourceId, customDescriptor) {
        if (adapters.has(sourceId)) {
            const cached = adapters.get(sourceId);
            adapters.delete(sourceId);
            adapters.set(sourceId, cached);
            return cached;
        }
        const source = descriptor(sourceId, customDescriptor), factory = factories[source.adapter];
        if (!factory) throw upstreamError('Parcel source has no browser adapter.', 422, 'browser-adapter-unavailable');
        const fetchImpl = createBrowserProviderFetch(source, fetchOptions);
        pending.add(sourceId);
        let instancePromise;
        instancePromise = Promise.resolve().then(async () => {
            const created = await factory(source, { fetchImpl, onProgress: detail => reportProgress(sourceId, detail),
                ...(source.adapter === 'dgu-wfs' ? { token: 'browser-relay' } : {}) });
            const instance = withSourceControls(created, { maxConcurrentQueries: source.maxConcurrentQueries });
            pending.delete(sourceId);
            trimAdapters();
            return instance;
        }).catch(error => {
            pending.delete(sourceId);
            if (adapters.get(sourceId) === instancePromise) adapters.delete(sourceId);
            throw error;
        });
        adapters.set(sourceId, instancePromise);
        trimAdapters();
        return instancePromise;
    }
    return Object.freeze({
        describe(sourceId, customDescriptor) { return publicSourceInfo(descriptor(sourceId, customDescriptor)); },
        async query(sourceId, method, args, customDescriptor, { onProgress, signal } = {}) {
            if (!['queryBounds', 'queryIds', 'queryGeometry', 'queryPoint'].includes(method)) throw upstreamError('Unknown browser parcel operation.', 400);
            // Cached adapters can serve several viewport cells. Subscribe for each query's
            // lifetime, including time spent waiting for a shared authority download.
            const listener = typeof onProgress === 'function' ? detail => onProgress(detail) : null;
            if (listener) {
                if (!progressListeners.has(sourceId)) progressListeners.set(sourceId, new Set());
                progressListeners.get(sourceId).add(listener);
            }
            try {
                const instance = await adapter(sourceId, customDescriptor);
                if (typeof instance[method] !== 'function') throw upstreamError('Parcel source does not support this operation.', 422);
                signal?.throwIfAborted();
                // Adapters that support cancellation read the signal from the options argument.
                const result = await instance[method](args[0], { signal });
                if (result.complete !== true || !Array.isArray(result.features)) throw upstreamError('Browser parcel source returned incomplete data.');
                return result;
            } catch (error) {
                // Only catalog sources declare a known limit; a visitor's own descriptor cannot.
                const knownLimit = knownLimitFor(catalog.sources.find(source => source.id === sourceId), error);
                if (knownLimit && error && typeof error === 'object') error.knownLimit = knownLimit;
                throw error;
            } finally {
                const listeners = progressListeners.get(sourceId);
                listeners?.delete(listener);
                if (!listeners?.size) progressListeners.delete(sourceId);
            }
        },
        sources: catalog.sources.filter(source => browserParcelFactories[source.adapter]),
        clear() { adapters.clear(); }
    });
}
