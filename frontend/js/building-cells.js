// Buildings are loaded cell by cell on the city's parcel grid (docs/source-loading-plan.md): the
// cells under a view or around a 3D anchor, nearest first, a few in flight, each cached and answered
// wholly by one source of the city's ordered list (its own survey, then any declared stand-ins).
// Pure: the transport, the projections and the clock are injected, so node tests drive it.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingCells = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Building cells are aligned blocks of parcel cells about this wide, so a 100 m parcel grid
    // does not mean a hundred requests for a 3D scene.
    const TARGET_SIDE_M = 300;
    const DEFAULT_CONCURRENCY = 6;
    const DEFAULT_BACKOFF_S = 30;
    const EDGE_SAMPLES = 8;

    const metresPerDegLat = 110540;
    const metresPerDegLng = lat => 111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180));

    // [w, s, e, n] → the dataset-space envelope of its perimeter.
    function datasetEnvelope([w, s, e, n], toDataset) {
        let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
        for (let i = 0; i <= EDGE_SAMPLES; i++) {
            const f = i / EDGE_SAMPLES;
            for (const [lat, lng] of [[s, w + (e - w) * f], [n, w + (e - w) * f], [s + (n - s) * f, w], [s + (n - s) * f, e]]) {
                const point = toDataset(lat, lng);
                const easting = Number(point?.[0]), northing = Number(point?.[1]);
                if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
                minE = Math.min(minE, easting); maxE = Math.max(maxE, easting);
                minN = Math.min(minN, northing); maxN = Math.max(maxN, northing);
            }
        }
        return [minE, minN, maxE, maxN];
    }

    // A dataset-space rectangle → its WGS84 [w, s, e, n] box.
    function wgs84Box([e0, n0, e1, n1], toLatLng) {
        const corners = [[e0, n0], [e1, n0], [e0, n1], [e1, n1]].map(([easting, northing]) => toLatLng(easting, northing));
        const lats = corners.map(c => Number(c?.[0])), lngs = corners.map(c => Number(c?.[1]));
        if (![...lats, ...lngs].every(Number.isFinite)) return null;
        return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
    }

    // Metres from a [lng, lat] point to the nearest point of a box (0 inside it).
    function distanceToBoxM([lng, lat], [w, s, e, n]) {
        const dx = (lng < w ? w - lng : lng > e ? lng - e : 0) * metresPerDegLng(lat);
        const dy = (lat < s ? s - lat : lat > n ? lat - n : 0) * metresPerDegLat;
        return Math.hypot(dx, dy);
    }

    // How many parcel cells a building cell spans per side, from the size of one parcel cell here.
    function blockSideAt(gridSize, toDataset, toLatLng, [lng, lat]) {
        const origin = toDataset(lat, lng);
        if (!origin) return 1;
        const e0 = Math.floor(origin[0] / gridSize) * gridSize, n0 = Math.floor(origin[1] / gridSize) * gridSize;
        const box = wgs84Box([e0, n0, e0 + gridSize, n0 + gridSize], toLatLng);
        if (!box) return 1;
        const side = Math.max((box[2] - box[0]) * metresPerDegLng(lat), (box[3] - box[1]) * metresPerDegLat);
        return Math.max(1, Math.round(TARGET_SIDE_M / side));
    }

    /**
     * The building cells covering a WGS84 box, nearest to `centre` first.
     * @returns [{ key, bbox:[w,s,e,n], distanceM }] or [] when the grid or projections are unusable.
     */
    function cellsCovering({ box, centre, gridSize, toDataset, toLatLng, withinM = Infinity }) {
        if (!(gridSize > 0) || typeof toDataset !== 'function' || typeof toLatLng !== 'function') return [];
        const middle = centre || [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
        const envelope = datasetEnvelope(box, toDataset);
        if (!envelope) return [];
        const k = blockSideAt(gridSize, toDataset, toLatLng, middle);
        const blockSize = gridSize * k;
        const cells = [];
        // A box edge on a cell line does not reach into the next cell.
        const x0 = Math.floor(envelope[0] / blockSize), x1 = Math.max(x0, Math.ceil(envelope[2] / blockSize - 1e-9) - 1);
        const y0 = Math.floor(envelope[1] / blockSize), y1 = Math.max(y0, Math.ceil(envelope[3] / blockSize - 1e-9) - 1);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 10000) return [];
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const bbox = wgs84Box([x * blockSize, y * blockSize, (x + 1) * blockSize, (y + 1) * blockSize], toLatLng);
                if (!bbox) continue;
                const distanceM = distanceToBoxM(middle, bbox);
                if (distanceM > withinM) continue;
                cells.push({ key: `${k}:${x},${y}`, bbox, distanceM });
            }
        }
        return cells.sort((a, b) => a.distanceM - b.distanceM || a.key.localeCompare(b.key));
    }

    // The point a building is filed under: the first vertex of its outline (a footprint's geometry, or a
    // 3D record's first face), so a building reaching over a cell line belongs to exactly one cell.
    function anchorOf(item) {
        let node = item?.geometry?.coordinates ?? item?.faces?.[0]?.coordinates ?? null;
        while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
        return Array.isArray(node) && Number.isFinite(node[0]) && Number.isFinite(node[1]) ? [node[0], node[1]] : null;
    }
    // Half-open, so a vertex on a shared line has one owner.
    const withinBox = ([x, y], [w, s, e, n]) => x >= w && x < e && y >= s && y < n;

    function bboxOf(geometry) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        const walk = node => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number') { w = Math.min(w, node[0]); e = Math.max(e, node[0]); s = Math.min(s, node[1]); n = Math.max(n, node[1]); return; }
            node.forEach(walk);
        };
        walk(geometry?.coordinates);
        return Number.isFinite(w) ? [w, s, e, n] : null;
    }

    /**
     * Which of `items` ({ key, geometry }) another survey already shows: more than `fraction` of the
     * item's area under `others` ({ geometry }). Used both ways round: a stand-in's building that
     * duplicates one of an earlier source over a cell line is dropped, and an outlined source's
     * building that nothing shown covers is "only in" that source. → Set of covered keys.
     */
    function coveredKeys(items, others, turf, fraction = 0.5) {
        const covered = new Set();
        const boxed = (others || []).filter(other => other?.geometry).map(other => ({ geometry: other.geometry, bbox: bboxOf(other.geometry) }));
        for (const item of items || []) {
            if (!item?.geometry) continue;
            const box = bboxOf(item.geometry);
            const near = boxed.filter(other => other.bbox && box && other.bbox[0] <= box[2] && box[0] <= other.bbox[2] && other.bbox[1] <= box[3] && box[1] <= other.bbox[3]);
            if (!near.length) continue;
            const own = { type: 'Feature', properties: {}, geometry: item.geometry };
            const total = Number(turf.area(own)) || 0;
            if (!(total > 0)) continue;
            let under = 0;
            for (const other of near) {
                try {
                    const clip = turf.intersect(own, { type: 'Feature', properties: {}, geometry: other.geometry });
                    if (clip) under += Number(turf.area(clip)) || 0;
                } catch (_) { /* an invalid ring overlaps nothing it can measure */ }
                if (under > total * fraction) { covered.add(item.key); break; }
            }
        }
        return covered;
    }

    // The cells within `radiusM` of a [lng, lat] centre, nearest first.
    function cellsAround({ centre, radiusM, gridSize, toDataset, toLatLng }) {
        const [lng, lat] = centre;
        const dLat = radiusM / metresPerDegLat, dLng = radiusM / metresPerDegLng(lat);
        return cellsCovering({ box: [lng - dLng, lat - dLat, lng + dLng, lat + dLat], centre, gridSize, toDataset, toLatLng, withinM: radiusM });
    }

    /**
     * request({ kind, source, bbox, signal }) → { items, complete, unavailable?, retryAfter?, supported? }
     * load({ kind, sources, cells, signal, onCell, onProgress }) → summary
     * Each cell is answered wholly by the first source of `sources` that does not fail it; a source
     * that fails is left alone for its retry time, and its cells go to the next source meanwhile.
     */
    function createCellLoader({ request, now = Date.now, concurrency = DEFAULT_CONCURRENCY } = {}) {
        if (typeof request !== 'function') throw new TypeError('createCellLoader needs request().');
        const cache = new Map();
        const inFlight = new Map();
        const backoffUntil = new Map();

        // A stand-in answers a cell the source before it failed or found empty (a city survey ends
        // at its boundary); an empty cell the stand-ins cannot fill stays the first source's answer.
        async function resolveCell(kind, sources, cell, signal) {
            let lastFailure = null, empty = null;
            for (let index = 0; index < sources.length; index++) {
                const source = sources[index];
                const until = backoffUntil.get(source) || 0;
                if (until > now()) { lastFailure = { retryAfter: Math.ceil((until - now()) / 1000) }; continue; }
                let answer;
                try {
                    answer = await request({ kind, source, bbox: cell.bbox, signal });
                } catch (error) {
                    if (error?.name === 'AbortError') throw error;
                    const status = Number(error?.status);
                    // Our own server refusing the request is not the source failing: say so, with its
                    // status, instead of hiding the fault behind a stand-in.
                    if (status >= 400 && status < 500 && status !== 429) {
                        return { items: [], complete: false, failed: true, retryAfter: null, status };
                    }
                    answer = { unavailable: true, retryAfter: null, status: Number.isFinite(status) ? status : null };
                }
                if (answer?.supported === false) return { items: [], complete: true, source, standIn: index > 0, unsupported: true };
                if (answer?.unavailable) {
                    const seconds = Number(answer.retryAfter) > 0 ? Number(answer.retryAfter) : DEFAULT_BACKOFF_S;
                    backoffUntil.set(source, now() + seconds * 1000);
                    lastFailure = { retryAfter: seconds, status: answer.status ?? null };
                    continue;
                }
                // Each building is kept by the one cell its first vertex lies in. Whether the source has
                // anything here is judged on its whole answer, before that filing.
                const answered = Array.isArray(answer?.items) ? answer.items : [];
                const items = answered.filter(item => {
                    const anchor = anchorOf(item);
                    return anchor && withinBox(anchor, cell.bbox);
                });
                const result = { items, complete: answer?.complete === true, source, standIn: index > 0 };
                if (answered.length) return result;
                empty = empty || result;
            }
            if (empty) return empty;
            return { items: [], complete: false, failed: true, retryAfter: lastFailure?.retryAfter ?? null, status: lastFailure?.status ?? null };
        }

        async function load({ kind, sources, cells, signal, onCell, onProgress }) {
            const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
            if (!list.length) throw new Error('No building source to load from.');
            const queue = [...cells].sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
            const summary = { total: queue.length, done: 0, loaded: 0, standIn: 0, failed: 0, incomplete: 0, unsupported: 0, cached: 0, retryAfter: null, status: null };
            const settle = (cell, result, cached) => {
                summary.done++;
                if (cached) summary.cached++;
                if (result.failed) {
                    summary.failed++;
                    if (result.status) summary.status = result.status;
                    summary.retryAfter = Math.max(summary.retryAfter || 0, result.retryAfter || 0) || summary.retryAfter;
                } else {
                    summary.loaded++;
                    if (result.unsupported) summary.unsupported++;
                    if (result.standIn) summary.standIn++;
                    if (!result.complete) summary.incomplete++;
                }
                onCell?.(cell, result);
                onProgress?.({ ...summary });
            };
            const worker = async () => {
                while (queue.length) {
                    signal?.throwIfAborted?.();
                    const cell = queue.shift();
                    const key = `${kind}|${list.join('>')}|${cell.key}`;
                    if (cache.has(key)) { settle(cell, cache.get(key), true); continue; }
                    let pending = inFlight.get(key);
                    if (!pending) {
                        pending = resolveCell(kind, list, cell, signal).finally(() => inFlight.delete(key));
                        inFlight.set(key, pending);
                    }
                    const result = await pending;
                    // Only a whole answer from the city's own source is kept: a stand-in or failed
                    // cell is asked of the first source again next time.
                    if (!result.failed && !result.standIn && result.complete) cache.set(key, result);
                    settle(cell, result, false);
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
            return summary;
        }

        // Retry now: forget the back-off of every source (cached whole answers stay).
        function retry() { backoffUntil.clear(); }
        function clear() { cache.clear(); backoffUntil.clear(); }
        function isCached(kind, sources, cellKey) { return cache.has(`${kind}|${sources.join('>')}|${cellKey}`); }

        return { load, retry, clear, isCached };
    }

    return { TARGET_SIDE_M, cellsCovering, cellsAround, createCellLoader, distanceToBoxM, anchorOf, coveredKeys };
});
