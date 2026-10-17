// Remembers which parcel source last answered a map read, so Settings → Information can name the
// source behind the parcels in view (a pan can cross into a city served by another source).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelSourceInView = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    // A city's parcels block names either a browser source (catalog id) or a server-side source.
    function sourceKeyFor(parcels) {
        if (!parcels || typeof parcels !== 'object') return null;
        if (parcels.source === 'parcel-source') {
            return typeof parcels.sourceId === 'string' && parcels.sourceId ? { sourceKey: parcels.sourceId, browserSource: true } : null;
        }
        return typeof parcels.source === 'string' && parcels.source && parcels.source !== 'none'
            ? { sourceKey: parcels.source, browserSource: false } : null;
    }
    function createTracker(now = () => Date.now()) {
        let latest = null;
        const listeners = new Set();
        // detail: what a non-catalog source needs to be named (e.g. the host of a visitor's file).
        function record(cityId, parcels, detail = null) {
            const key = sourceKeyFor(parcels);
            if (!key) return null;
            const changed = !latest || latest.sourceKey !== key.sourceKey || latest.cityId !== String(cityId || '')
                || JSON.stringify(latest.detail || null) !== JSON.stringify(detail || null);
            latest = { cityId: String(cityId || ''), ...key, detail, at: now() };
            if (changed) listeners.forEach(listener => { try { listener(latest); } catch (_) { /* A display listener must not fail a parcel read. */ } });
            return latest;
        }
        return {
            record,
            latest: () => latest,
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        };
    }
    const tracker = createTracker();
    return Object.freeze({ sourceKeyFor, createTracker, record: tracker.record, latest: tracker.latest, subscribe: tracker.subscribe });
});
