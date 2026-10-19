// Continues the globe fly-in across the page reload that a city switch causes: before navigating,
// the world view stores its last frame (WorldHandoff.store); on the next boot this script shows that
// frame full-screen over the map and fades it out once the map has actually drawn, so the dive and
// the map read as one motion. The record lives in sessionStorage and is ignored after 30 s.
//
// API (window.WorldHandoff)
//   store({ dataUrl, cityId, center: [lat, lon], zoom, proposalId? })
//   proposalReady(id) releases a proposal handoff after selection/framing, including failures
//   peek() -> record | null                                a fresh record, without consuming it
//   play({ dataUrl })                                      the same fade without a reload: shows the
//                                                          frame now and fades it once the map has drawn
//                                                          (move the map in the same task, after this)
// On load it consumes a fresh record by itself; include this script early in <body> so the frame
// covers the map before its first paint. Clicking the frame dismisses it at once.
(function (global) {
    'use strict';

    const KEY = 'cb_world_handoff';
    const MAX_AGE_MS = 30000;
    const log = message => console.log('[' + new Date().toISOString() + '] [world-handoff] ' + message);

    function read() {
        try {
            const raw = global.sessionStorage.getItem(KEY);
            if (!raw) return null;
            const record = JSON.parse(raw);
            if (!record || typeof record.dataUrl !== 'string' || !record.dataUrl.startsWith('data:image/')) return null;
            if (typeof record.at !== 'number' || Date.now() - record.at > MAX_AGE_MS || record.at > Date.now() + 1000) return null;
            return record;
        } catch (error) {
            console.warn('[world-handoff] unreadable record', error);
            return null;
        }
    }

    function store(record) {
        const value = Object.assign({}, record, { at: Date.now() });
        try {
            global.sessionStorage.setItem(KEY, JSON.stringify(value));
            return true;
        } catch (error) {
            // Quota or privacy mode: the switch still works, it just starts without the frame.
            console.warn('[world-handoff] could not store the handoff frame', error);
            return false;
        }
    }

    function clear() {
        try { global.sessionStorage.removeItem(KEY); } catch (_) { /* nothing stored */ }
    }

    function reducedMotion() {
        try {
            if (typeof global.prefersReducedMotion === 'function') return !!global.prefersReducedMotion();
            if (global.__reducedMotion) return true;
            if (new URLSearchParams(global.location.search).has('reduceMotion')) return true;
            return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (_) { return false; }
    }

    // Resolves once the app has booted (map-core's whenAppBooted) and the base map's tile layers have
    // finished their first load, so the fade reveals a drawn map rather than grey tiles.
    function whenMapDrawn() {
        const booted = typeof global.whenAppBooted === 'function'
            ? global.whenAppBooted()
            : new Promise(resolve => global.addEventListener('appBooted', resolve, { once: true }));
        return booted.then(() => {
            const map = global.map;
            if (!map || typeof map.eachLayer !== 'function' || !global.L || !global.L.GridLayer) return;
            const loading = [];
            map.eachLayer(layer => {
                if (layer instanceof global.L.GridLayer && typeof layer.isLoading === 'function' && layer.isLoading()) {
                    loading.push(new Promise(resolve => layer.once('load', resolve)));
                }
            });
            return Promise.all(loading);
        });
    }

    function show(record) {
        const overlay = document.createElement('div');
        overlay.className = 'world-handoff';
        overlay.setAttribute('aria-hidden', 'true');
        const img = document.createElement('img');
        img.className = 'world-handoff__img';
        img.alt = '';
        img.src = record.dataUrl;
        overlay.appendChild(img);
        document.body.appendChild(overlay);

        let removed = false;
        const remove = () => { if (!removed) { removed = true; overlay.remove(); } };
        const fade = reason => {
            if (removed || overlay.classList.contains('world-handoff--out')) return;
            log('fading handoff frame (' + reason + ')');
            if (reducedMotion()) { remove(); return; }
            overlay.addEventListener('transitionend', ev => { if (ev.target === overlay) remove(); });
            overlay.classList.add('world-handoff--out');
        };
        overlay.addEventListener('click', () => fade('clicked'));
        // A proposal route downloads after app boot. Keep the frame until its own camera is ready,
        // then wait for tiles at that destination rather than revealing the default city/world view.
        const focused = record.proposalId ? new Promise(resolve => {
            const onReady = event => {
                if (event.detail.proposalId !== record.proposalId) return;
                global.removeEventListener('worldproposal:ready', onReady);
                resolve();
            };
            global.addEventListener('worldproposal:ready', onReady);
        }) : Promise.resolve();
        focused.then(whenMapDrawn).then(() => fade('map drawn'), error => {
            console.error('[' + new Date().toISOString() + '] [world-handoff] waiting for the map failed', error);
            fade('map wait failed');
        });
    }

    function boot() {
        const record = read();
        clear();
        if (!record) return;
        log('showing handoff frame for ' + (record.cityId || 'explore') + ' (' + (Date.now() - record.at) + ' ms old)');
        show(record);
    }

    global.WorldHandoff = { store, peek: read, play: show,
        proposalReady: proposalId => global.dispatchEvent(new CustomEvent('worldproposal:ready', { detail: { proposalId } })), KEY, MAX_AGE_MS };

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
})(window);
