// A before/after divider over a Leaflet map. The host map stays live as "after"; a second map
// ("before") is drawn in the same container, clipped by a draggable divider, showing the host's
// own basemap (its raster tile sources are cloned, so the browser cache serves the tiles) plus
// whatever the host draws on it. The divider is ui/map-compare-control.js. First built inside the
// land readjustment modal, extracted so other surfaces can compare too (dividers.md).
//
// API (window.__MapBeforeAfter / module.exports)
//   clipInset(width, percent) -> { x, clipPath }     pure: where the divider sits and what to clip
//   tileLayerSpecs(map, L) -> [{ url, options }]     the host's raster tile sources, in map order
//   attachDivider(container, beforeEl, options) -> divider
//     the divider alone, over any two stacked elements (two images in the bet dialog): clips
//     `beforeEl`, which the host positions over the container's content; takes labels,
//     labelPlacement, sliderLabel, percent; returns { handleEl, getPercent, setPercent, applyClip, dispose }
//   attach(map, options) -> session
//     options.L                 Leaflet (default window.L)
//     options.drawBefore(map)   draws the "before" content on the second map
//     options.labels            { before, after } visible labels (already translated)
//     options.labelPlacement    'corners' (default: bottom corners of the map) or 'divider'
//                               (beside the grip, for maps whose corners are under other chrome)
//     options.sliderLabel       the divider's accessible name
//     options.percent           initial divider position (default 50)
//     options.freeze            host gestures off while comparing (default true)
//     session: { beforeMap, beforeEl, handleEl, getPercent, setPercent, sync, dispose }
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__MapBeforeAfter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    // The host's interaction handlers that would move "after" out from under "before".
    const FROZEN_HANDLERS = ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'touchZoom', 'boxZoom', 'keyboard'];

    function clampPercent(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
    }

    // "Before" shows left of the divider: clip the before map away from the right edge.
    function clipInset(width, percent) {
        const w = Number.isFinite(Number(width)) ? Math.max(0, Number(width)) : 0;
        const x = w * clampPercent(percent) / 100;
        return { x, clipPath: 'inset(0 ' + Math.max(0, w - x) + 'px 0 0)' };
    }

    function tileLayerSpecs(map, L) {
        const specs = [];
        const TileLayer = L && L.TileLayer;
        if (!map || typeof map.eachLayer !== 'function' || typeof TileLayer !== 'function') return specs;
        map.eachLayer(layer => {
            if (layer instanceof TileLayer && typeof layer._url === 'string' && layer._url) {
                specs.push({ url: layer._url, options: Object.assign({}, layer.options) });
            }
        });
        return specs;
    }

    function attachDivider(container, beforeEl, options = {}) {
        const control = options.control || root.__MapCompareControl;
        if (!container || !beforeEl) throw new TypeError('MapBeforeAfter.attachDivider needs a container and a before element');
        if (!control || typeof control.create !== 'function') throw new TypeError('MapBeforeAfter.attachDivider needs MapCompareControl');
        const doc = container.ownerDocument;
        const labels = options.labels || {};
        let percent = clampPercent(options.percent === undefined ? 50 : options.percent);
        let disposed = false;

        const handleEl = doc.createElement('div');
        handleEl.className = 'map-compare__handle';
        const grip = doc.createElement('span');
        grip.className = 'map-compare__grip';
        grip.textContent = '↔';
        handleEl.appendChild(grip);
        container.appendChild(handleEl);

        const onDivider = options.labelPlacement === 'divider';
        const labelEls = ['before', 'after'].map(side => {
            const el = doc.createElement('div');
            el.className = 'map-compare__label map-compare__label--' + side + (onDivider ? ' map-compare__label--divider' : '');
            el.textContent = labels[side] || side;
            (onDivider ? handleEl : container).appendChild(el);
            return el;
        });

        function applyClip() {
            if (disposed) return;
            const { x, clipPath } = clipInset(container.clientWidth, percent);
            beforeEl.style.clipPath = clipPath;
            handleEl.style.left = x + 'px';
        }

        const divider = control.create({
            container, handle: handleEl, value: percent, label: options.sliderLabel || 'Before and after comparison',
            onChange: next => { percent = clampPercent(next); applyClip(); }
        });
        applyClip();

        return {
            handleEl,
            labelEls,
            getPercent: () => percent,
            setPercent(next) { divider.setValue(next); percent = divider.getValue(); applyClip(); return percent; },
            applyClip,
            dispose() {
                if (disposed) return;
                disposed = true;
                divider.dispose();
                [handleEl].concat(labelEls).forEach(el => { try { el.remove(); } catch (_) { /* detached */ } });
            }
        };
    }

    function attach(map, options = {}) {
        const L = options.L || root.L;
        if (!map || typeof map.getContainer !== 'function') throw new TypeError('MapBeforeAfter.attach needs a Leaflet map');
        if (!L || typeof L.map !== 'function') throw new TypeError('MapBeforeAfter.attach needs Leaflet');

        const container = map.getContainer();
        const doc = container.ownerDocument;
        const freeze = options.freeze !== false;
        let disposed = false;

        // Only handlers that were on get switched back on at the end.
        const frozen = [];
        if (freeze) {
            FROZEN_HANDLERS.forEach(name => {
                const handler = map[name];
                if (!handler || typeof handler.disable !== 'function') return;
                const wasEnabled = typeof handler.enabled === 'function' ? handler.enabled() : true;
                if (!wasEnabled) return;
                try { handler.disable(); frozen.push(handler); } catch (_) { /* a handler without a map */ }
            });
        }

        const beforeEl = doc.createElement('div');
        beforeEl.className = 'map-compare__before';
        container.appendChild(beforeEl);
        const divider = attachDivider(container, beforeEl, options);
        const handleEl = divider.handleEl;

        const beforeMap = L.map(beforeEl, {
            zoomControl: false, attributionControl: false, fadeAnimation: false, zoomAnimation: false,
            dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false,
            maxZoom: map.getMaxZoom(), minZoom: typeof map.getMinZoom === 'function' ? map.getMinZoom() : undefined,
            zoomSnap: map.options && map.options.zoomSnap
        });
        tileLayerSpecs(map, L).forEach(spec => L.tileLayer(spec.url, spec.options).addTo(beforeMap));
        beforeMap.setView(map.getCenter(), map.getZoom(), { animate: false });
        if (typeof options.drawBefore === 'function') options.drawBefore(beforeMap);

        // The host may still move programmatically (a fly-to, a resize): follow it.
        function sync() {
            if (disposed) return;
            try {
                beforeMap.invalidateSize();
                beforeMap.setView(map.getCenter(), map.getZoom(), { animate: false });
            } catch (_) { /* the before map is mid-teardown */ }
            divider.applyClip();
        }

        map.on('move zoom resize', sync);
        sync();
        // Once the container has had its layout, measure again (the first paint can run before it).
        if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(sync);

        return {
            beforeMap,
            beforeEl,
            handleEl,
            getPercent: divider.getPercent,
            setPercent: divider.setPercent,
            sync,
            dispose() {
                if (disposed) return;
                disposed = true;
                map.off('move zoom resize', sync);
                divider.dispose();
                try { beforeMap.remove(); } catch (_) { /* already gone with its container */ }
                try { beforeEl.remove(); } catch (_) { /* detached */ }
                frozen.forEach(handler => { try { handler.enable(); } catch (_) { /* the host map is closing */ } });
            }
        };
    }

    return { FROZEN_HANDLERS, clipInset, tileLayerSpecs, attachDivider, attach };
});
