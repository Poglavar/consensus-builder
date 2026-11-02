// One bounded source-enclosure selection for the map and MCP. Geometry is shared with the
// block browser; parcel membership never walks through a large parcel into another enclosure.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelBlockDetection = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const MAX_SPAN = 0.06;
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const idOf = feature => String(feature?.properties?.parcelId ?? feature?.properties?.parcel_id
        ?? feature?.properties?.PARCEL_ID ?? feature?.properties?.id ?? feature?.id ?? '');

    function padBounds(bbox, meters) {
        const dy = meters / 111320;
        const dx = dy / Math.max(0.15, Math.cos((bbox[1] + bbox[3]) * Math.PI / 360));
        return [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy];
    }
    function supportedBounds(bbox) {
        return bbox.every(Number.isFinite) && bbox[0] >= -180 && bbox[2] <= 180
            && bbox[1] >= -85 && bbox[3] <= 85
            && bbox[2] - bbox[0] <= MAX_SPAN && bbox[3] - bbox[1] <= MAX_SPAN;
    }

    async function detect({ seed, turf, model, fetchBoundaries, loadParcels,
        detectBlocks = (source, bbox) => model.detectBlocks(source, bbox, turf),
        extraBoundaries = [], isCorridor = () => false, limit, signal }) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Block selection needs a positive parcel limit.');
        const seedId = idOf(seed);
        if (!seedId) throw fail('block-seed-unresolved', 'The selected parcel has no identity.');
        let bbox = padBounds(turf.bbox(seed), 500);
        let enclosure = null;
        for (let expansion = 0; expansion < 4 && supportedBounds(bbox); expansion++) {
            signal?.throwIfAborted();
            const source = await fetchBoundaries(bbox, signal);
            if (source?.complete !== true || source.partial || source.truncated || !Array.isArray(source.features)) {
                throw fail('block-boundaries-incomplete', 'OSM boundary coverage is incomplete.');
            }
            const extra = typeof extraBoundaries === 'function' ? extraBoundaries(bbox) : extraBoundaries;
            const blocks = await detectBlocks({ ...source, features: [...source.features, ...extra] }, bbox, signal);
            enclosure = model.enclosureForParcel(blocks, seed, turf);
            if (enclosure) break;
            bbox = padBounds(bbox, 500 * (expansion + 1));
        }
        if (!enclosure) return { isValid: false, invalidReason: 'unbounded', ids: [], previewIds: [] };
        signal?.throwIfAborted();
        const ground = await loadParcels(enclosure, signal);
        if (ground?.complete !== true || ground.truncated || !Array.isArray(ground.features)) {
            throw fail('block-parcels-incomplete', 'Parcel coverage under the block is incomplete.');
        }
        const members = ground.features.filter(feature => !isCorridor(feature));
        const ids = model.parcelIdsInBlock(enclosure, members, turf).sort((a, b) =>
            a === seedId ? -1 : b === seedId ? 1 : a.localeCompare(b));
        if (!ids.includes(seedId)) return { isValid: false, invalidReason: 'seed_excluded', ids: [], previewIds: [], enclosure };
        if (ids.length > limit) return { isValid: false, invalidReason: 'parcel_limit_exceeded',
            ids: [], previewIds: ids.slice(0, limit), enclosure, count: ids.length };
        return { isValid: true, ids, previewIds: [], enclosure, count: ids.length };
    }

    function detectInWorker(win, source, bbox, signal) {
        return new Promise((resolve, reject) => {
            const worker = new win.Worker(win.appendBuildToken('js/urban-blocks-worker.js'));
            let settled = false;
            const finish = (error, blocks) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                worker.terminate();
                if (error) reject(error); else resolve(blocks);
            };
            const abort = () => finish(fail('block-detection-cancelled', 'Block detection cancelled.'));
            signal?.addEventListener('abort', abort, { once: true });
            worker.onmessage = ({ data }) => finish(data.error ? fail('block-boundaries-invalid', data.error) : null, data.blocks);
            worker.onerror = () => finish(fail('block-boundaries-invalid', 'Block boundary analysis failed.'));
            if (signal?.aborted) { abort(); return; }
            worker.postMessage({ roads: source, bbox });
        });
    }

    async function fetchBoundaries(win, bbox, signal) {
        const base = win.getBackendBase().replace(/\/$/, '');
        const response = await win.fetch(`${base}/blocks/roads?bbox=${encodeURIComponent(bbox.join(','))}`, { signal });
        if (!response.ok) throw Object.assign(fail('block-boundaries-unavailable', 'OSM boundaries could not be loaded.'), { status: response.status });
        return response.json();
    }

    // The browser adapter reads live pieces after the repository has supplied the complete source
    // ground. It never treats a deep link's one loaded parcel as proof of a one-parcel block.
    function createBrowser(win) {
        let last = null;
        const city = () => win.CityConfigManager.getCurrentCityId();
        return {
            async detect(seed, { signal } = {}) {
                const ownCity = city();
                const fabric = win.LiveParcelFabric;
                const corridor = feature => {
                    const p = feature.properties || {};
                    return p.isCorridor === true || p.isRoad === true || p.isTrack === true;
                };
                const result = await detect({ seed, turf: win.turf, model: win.UrbanBlocksModel, signal,
                    limit: win.__parcelBlockTopology.MAX_BLOCK_PARCELS,
                    fetchBoundaries: (bbox, signal) => fetchBoundaries(win, bbox, signal),
                    detectBlocks: (source, bbox, signal) => detectInWorker(win, source, bbox, signal),
                    extraBoundaries: bbox => fabric.peekBounds(bbox, { includeCorridors: true }).filter(corridor),
                    isCorridor: corridor,
                    async loadParcels(enclosure, signal) {
                        const [w, s, e, n] = win.turf.bbox(enclosure);
                        const bounds = win.L.latLngBounds([s, w], [n, e]);
                        const loaded = await win.CadastralParcelRepository.ensureBounds(bounds, { signal, city: ownCity });
                        if (city() !== ownCity) throw fail('block-detection-cancelled', 'The city changed.');
                        return { complete: loaded.status === 'ready', features: fabric.peekBounds(bounds, { includeCorridors: true }) };
                    }
                });
                if (city() !== ownCity) throw fail('block-detection-cancelled', 'The city changed.');
                last = { seedId: idOf(seed), city: ownCity, revision: fabric.revision(), result };
                return result;
            },
            cached(seedId) {
                return last?.seedId === String(seedId) && last.city === city()
                    && last.revision === win.LiveParcelFabric.revision() ? last.result : null;
            }
        };
    }
    return { detect, createBrowser, detectInWorker, fetchBoundaries, idOf };
});
