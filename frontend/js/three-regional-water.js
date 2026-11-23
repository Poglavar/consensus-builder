// A small tile controller for regional water in the 3D model view. It asks for a coarse level
// first, then a level whose tile width is about a third of the viewport. The caller renders the
// returned GeoJSON and decides how detailed water should look at each level.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeRegionalWater = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const TILE_PIXELS = 512;
    const MIN_ZOOM = 0;
    const MAX_ZOOM = 14;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const tileKey = tile => `${tile.z}/${tile.x}/${tile.y}`;

    function tileBounds({ z, x, y }) {
        const n = 2 ** z;
        const lng = value => value / n * 360 - 180;
        const lat = value => Math.atan(Math.sinh(Math.PI * (1 - 2 * value / n))) * 180 / Math.PI;
        return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
    }

    function mercatorY(lat) {
        const radians = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
        return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
    }

    function viewZoom([west, south, east, north], width, height) {
        const xSpan = ((east - west + 360) % 360 || 360) / 360;
        const ySpan = Math.max(1e-9, Math.abs(mercatorY(north) - mercatorY(south)));
        const tilePixels = Math.max(Math.max(1, width) / Math.max(xSpan, 1e-9), Math.max(1, height) / ySpan);
        return Math.log2(tilePixels / TILE_PIXELS);
    }

    // A dateline-crossing view is represented by west > east. Splitting it keeps every tile key
    // ordinary and avoids requesting the entire planet.
    function tilesForBounds(bounds, z, limit = 64, padding = 0) {
        const [west, south, east, north] = bounds;
        if (![west, south, east, north].every(Number.isFinite) || south >= north) return [];
        const n = 2 ** z;
        const x = lng => (lng + 180) / 360 * n;
        const y = lat => mercatorY(lat) * n;
        let left = x(west), right = x(east);
        if (right < left || (right === left && west !== east)) right += n;
        const horizontalPad = (right - left) * Math.max(0, padding);
        const verticalPad = Math.abs(y(south) - y(north)) * Math.max(0, padding);
        left -= horizontalPad; right += horizontalPad;
        const top = clamp(Math.floor(y(north) - verticalPad), 0, n - 1);
        const bottom = clamp(Math.floor(y(south) + verticalPad), 0, n - 1);
        const out = [];
        for (let unwrappedX = Math.floor(left); unwrappedX <= Math.floor(right); unwrappedX++) {
            const wrappedX = ((unwrappedX % n) + n) % n;
            for (let ty = top; ty <= bottom; ty++) {
                out.push({ z, x: wrappedX, y: ty });
                if (out.length > limit) return [];
            }
        }
        return out;
    }

    function levelsForView(bounds, width, height) {
        const detail = clamp(Math.ceil(viewZoom(bounds, width, height)) + 1, MIN_ZOOM, MAX_ZOOM);
        return [Math.max(MIN_ZOOM, detail - 2), detail];
    }

    function boundedTiles(bounds, desiredZoom, limit, padding) {
        for (let z = desiredZoom; z >= MIN_ZOOM; z--) {
            const tiles = tilesForBounds(bounds, z, limit, padding);
            if (tiles.length) return tiles;
        }
        return [];
    }

    function create({ fetchTile, onChange = () => {}, concurrency = 4, maxCache = 96, retryLimit = 2, retryDelayMs = 300 } = {}) {
        if (typeof fetchTile !== 'function') throw new Error('Regional water requires fetchTile(tile, { signal }).');
        const cache = new Map();
        const queued = new Map();
        const active = new Map();
        const failures = new Map();
        let plan = null;
        let committed = new Set();
        let revision = 0;
        let destroyed = false;
        let retryTimer = null;

        function trim() {
            while (cache.size > maxCache) {
                const needed = new Set([...(plan?.coarse || []), ...(plan?.detail || []), ...committed]);
                const key = [...cache.keys()].find(candidate => !needed.has(candidate));
                // Before the atomic replacement, both the previous visible view and every current
                // candidate tile are protected. A brief cache overage is cheaper than a shoreline
                // disappearing during that handoff.
                if (!key) break;
                cache.delete(key);
            }
        }
        function publish() {
            const tiles = [...committed].map(key => cache.get(key)).filter(Boolean)
                .map(entry => ({ tile: entry.tile, areas: entry.areas }));
            onChange({ tiles, loading: active.size > 0 || queued.size > 0 });
        }
        function complete(keys) { return keys.length > 0 && keys.every(key => cache.has(key)); }
        function failed(keys) { return keys.some(key => failures.get(key)?.revision === plan?.revision); }
        function settle() {
            if (!plan || destroyed) return;
            if (complete(plan.detail)) {
                if (plan.phase !== 'detail') { committed = new Set(plan.detail); plan.phase = 'detail'; publish(); }
                return;
            }
            if (complete(plan.coarse) && !failed(plan.coarse) && plan.phase !== 'coarse') {
                committed = new Set(plan.coarse); plan.phase = 'coarse'; publish();
            }
        }
        function scheduleRetry() {
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            if (!plan || destroyed) return;
            const retry = [...failures.entries()].find(([key, failure]) => failure.revision === plan.revision
                && failure.attempts <= retryLimit && plan.tiles.has(key));
            if (!retry) return;
            const [, failure] = retry;
            const delay = retryDelayMs * 2 ** Math.max(0, failure.attempts - 1);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (!plan || destroyed) return;
                for (const [key, entry] of failures) {
                    if (entry.revision !== plan.revision || entry.attempts > retryLimit || !plan.tiles.has(key)) continue;
                    if (!cache.has(key) && !active.has(key) && !queued.has(key)) queued.set(key, plan.tiles.get(key));
                }
                next();
            }, delay);
        }
        function next() {
            if (destroyed) return;
            while (active.size < concurrency && queued.size) {
                const entry = [...queued.values()].sort((a, b) => a.priority - b.priority)[0];
                queued.delete(entry.key);
                const controller = new AbortController();
                const job = { controller, revision: entry.revision };
                active.set(entry.key, job);
                Promise.resolve().then(() => fetchTile(entry.tile, { signal: controller.signal })).then(payload => {
                    if (destroyed || controller.signal.aborted || active.get(entry.key) !== job) return;
                    cache.set(entry.key, { tile: entry.tile, areas: Array.isArray(payload?.areas) ? payload.areas : [] });
                    failures.delete(entry.key);
                }).catch(error => {
                    if (!controller.signal.aborted && active.get(entry.key) === job) {
                        const prior = failures.get(entry.key);
                        failures.set(entry.key, { revision: job.revision, attempts: prior?.revision === job.revision ? prior.attempts + 1 : 1 });
                        if (typeof console !== 'undefined') console.warn('[regional water] tile unavailable', entry.key, error);
                    }
                }).finally(() => {
                    if (active.get(entry.key) !== job) return;
                    active.delete(entry.key);
                    trim(); settle(); scheduleRetry(); publish(); next();
                });
            }
        }
        function update({ bounds, width, height }) {
            if (destroyed) return;
            const [coarseLevel, detailLevel] = levelsForView(bounds, width, height);
            const detailTiles = boundedTiles(bounds, detailLevel, 48, 0.12);
            const detail = detailTiles.map(tileKey);
            const actualDetailLevel = detailTiles[0]?.z ?? MIN_ZOOM;
            const coarseTiles = boundedTiles(bounds, Math.max(MIN_ZOOM, actualDetailLevel - 2), 48, 0.12);
            const coarse = coarseTiles.map(tileKey);
            const signature = `${coarse.join(',')}|${detail.join(',')}`;
            if (plan?.signature === signature) { scheduleRetry(); next(); return; }
            const pendingRevision = ++revision;
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            const requested = [...coarseTiles, ...detailTiles];
            const entries = new Map(requested.map((tile, index) => {
                const key = tileKey(tile);
                return [key, { key, tile, priority: index < coarseTiles.length ? 0 : 1, revision: pendingRevision }];
            }));
            plan = { revision: pendingRevision, signature, coarse, detail, phase: null, tiles: entries };
            const wanted = new Set([...coarse, ...detail]);
            for (const key of failures.keys()) if (!wanted.has(key)) failures.delete(key);
            for (const [key, job] of active) {
                if (!wanted.has(key)) {
                    job.controller.abort();
                    // An aborted network request may settle late. Removing its slot immediately
                    // keeps a fast pan from being held behind a server that ignores cancellation.
                    active.delete(key);
                } else job.revision = pendingRevision;
            }
            for (const [key] of queued) {
                if (!wanted.has(key)) queued.delete(key);
                else queued.set(key, entries.get(key));
            }
            requested.forEach((tile, index) => {
                const key = tileKey(tile);
                if (cache.has(key) || active.has(key)) return;
                queued.set(key, entries.get(key));
            });
            settle(); publish(); next();
        }
        function clear() {
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            for (const job of active.values()) job.controller.abort();
            active.clear(); queued.clear(); cache.clear(); failures.clear(); committed.clear(); plan = null; publish();
        }
        function destroy() { clear(); destroyed = true; }
        return { update, clear, destroy, state: () => ({ cached: cache.size, loading: active.size + queued.size, visible: committed.size }), tileBounds };
    }

    return { MIN_ZOOM, MAX_ZOOM, tileBounds, tileKey, tilesForBounds, levelsForView, boundedTiles, create };
});
