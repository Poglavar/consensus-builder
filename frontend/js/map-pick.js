// map-pick.js — one pick-on-map mode for any surface (plan-design-agreement.md, "M3 notes", UI
// decision 2026-10-22): while a surface picks designs on the map (the share panel, the agreement
// editor) the map is pan/zoom only, a click on an applied design is handed to that surface, and the
// designs it names are drawn in one highlight pane over the fabric while the rest of the map dims.
// window.MapPick: begin / end / active / pick / refresh, and the shapes of a design on the map that
// the highlight draws (bodyOf / parcelsOf / groundOf / outlineOf).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.MapPick = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // Leaflet names the pane's element .leaflet-pick-highlight-pane. Its stacking, its inertness, the
    // dimming of every other pane and the lockdown of body.map-pick-mode are in css/proposals.css.
    const PANE = 'pick-highlight';
    const MODE_CLASS = 'map-pick-mode';
    const HIGHLIGHTING_CLASS = 'map-pick-highlighting';
    // A highlighted design drawn without a surface style of its own takes its look from CSS.
    const HIGHLIGHT_CLASS = 'map-pick-highlight';
    // A large highlight is drawn in frame-sized slices, so the map is never locked for more than a frame.
    const FRAME_BUDGET_MS = 12;

    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());
    const stamp = () => new Date().toISOString();
    const log = message => console.log(`[${stamp()}] [MapPick] ${message}`);
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const nextFrame = () => new Promise(resolve => {
        if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(() => resolve());
        else resolve();
    });

    // ---- a design's shapes on the map ------------------------------------------------------------

    // Whether a design's body stands on a parcel: the shared rule (geometry-tolerances.js
    // reachesInto). A clip that fails is an UNKNOWN reach, not none: it is reported and counted in
    // clipHealth() (parcel-arrangement.js) and the parcel is kept — showing a parcel too many beats
    // silently dropping the ground a design stands on.
    function groundReaches(body, parcel) {
        const rule = root.GeometryTolerances
            || (typeof require === 'function' ? require('./geometry-tolerances.js') : null);
        try {
            return rule.reachesInto(root.turf, body, parcel, 0, { site: 'map-pick.groundUnderBody' });
        } catch (error) {
            const clips = root.__parcelArrangement
                || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
            if (!clips || typeof clips.reportClipFailure !== 'function') throw error;
            clips.reportClipFailure('intersect', error, { site: 'map-pick.groundUnderBody' }, [body, parcel]);
            return true;
        }
    }

    // The live parcels a design materialized (LiveParcelFabric owns them; they are never copied into
    // the record), else the features its highlight resolves to.
    function parcelsOf(record) {
        const ids = new Set();
        const claims = root.__claims;
        if (record && claims && typeof claims.materializedParcelIdsOf === 'function') {
            (claims.materializedParcelIdsOf(record) || []).forEach(id => { if (idOf(id)) ids.add(idOf(id)); });
        }
        const features = [];
        ids.forEach(id => {
            try {
                const feature = typeof root.getParcelFeatureForHighlight === 'function' ? root.getParcelFeatureForHighlight(id, record) : null;
                if (feature && feature.geometry) features.push(feature);
            } catch (error) {
                console.warn(`[${stamp()}] [MapPick] parcel ${id} of ${idOf(record && record.proposalId)} has no shape`, error);
            }
        });
        if (features.length) return features;
        if (typeof root.collectProposalHighlightFeatures !== 'function') return [];
        try {
            return (root.collectProposalHighlightFeatures(record) || []).filter(feature => feature && feature.geometry);
        } catch (error) {
            console.warn(`[${stamp()}] [MapPick] the parcels of ${idOf(record && record.proposalId)} could not be resolved`, error);
            return [];
        }
    }

    // A design's OWN shape, whatever parcels it sits on: a building's footprints, a corridor surface,
    // a park or square polygon, a readjustment's plots. It is the shape that names the design.
    function bodyOf(record) {
        if (typeof root.collectProposalFeatureSets !== 'function') return [];
        try {
            const sets = root.collectProposalFeatureSets(record, { includeBuildingGeometry: true }) || {};
            return (sets.primaryFeatures || []).filter(feature => feature && feature.geometry);
        } catch (error) {
            console.warn(`[${stamp()}] [MapPick] the shape of ${idOf(record && record.proposalId)} could not be resolved`, error);
            return [];
        }
    }

    // The ground a design STANDS ON among the parcels it minted: a remainder handed back to the host
    // is not its ground, and it can be twenty times its size.
    function groundOf(parcels, body) {
        const ground = root.__hoverGround;
        if (!ground || typeof ground.groundUnderBody !== 'function' || !root.turf) return parcels;
        return ground.groundUnderBody(parcels, body, { reaches: groundReaches });
    }

    // What the highlight draws: the design's body, else the ground it stands on. The body comes first
    // because it needs no parcels, no map state and no zoom (parcels switch off below a zoom, and a
    // whole plan is looked at zoomed out), and because the two answers diverge badly: the rail track
    // resolves to almost no child parcels, while its body is the corridor you want to see.
    function outlineOf(record) {
        const body = bodyOf(record);
        return body.length ? body : groundOf(parcelsOf(record), body);
    }

    // ---- the mode --------------------------------------------------------------------------------

    // The surface picking now: { name, onPick, highlight, style, close, onProgress, layers (id → its
    // built highlight, or null when it has no shape), group (the Leaflet group on the map), token,
    // building }. One at a time.
    let state = null;

    function recordOf(id) {
        const storage = root.proposalStorage;
        return storage && typeof storage.getProposal === 'function' ? storage.getProposal(id) || null : null;
    }

    function hide(current, layer) {
        if (layer && current.group && current.group.hasLayer(layer)) current.group.removeLayer(layer);
    }

    function show(current, id, layer, record) {
        if (!layer || !current.group) return;
        if (!current.group.hasLayer(layer)) current.group.addLayer(layer);
        // A surface's style follows its own state (the share panel's published or not).
        if (current.style) layer.setStyle(current.style(id, record));
    }

    // One design's highlight, built once while the mode lasts: its outline in the highlight pane,
    // never a click target. null when it has no shape (remembered, so it is not resolved again).
    function build(current, id, record) {
        let layer = null;
        try {
            const features = outlineOf(record);
            if (features.length && root.L) {
                layer = root.L.geoJSON({ type: 'FeatureCollection', features }, {
                    interactive: false,
                    pane: PANE,
                    ...(current.style ? { style: () => current.style(id, record) } : { className: HIGHLIGHT_CLASS })
                });
            }
        } catch (error) {
            console.error(`[${stamp()}] [MapPick] ${current.name}: the highlight of ${id} could not be drawn`, error);
        }
        current.layers.set(id, layer);
        return layer;
    }

    function stop() {
        const ending = state;
        state = null;
        if (!ending) return;
        ending.token += 1;
        if (ending.group && root.map && typeof root.map.removeLayer === 'function') root.map.removeLayer(ending.group);
        const body = root.document && root.document.body;
        if (body) {
            body.classList.remove(MODE_CLASS, HIGHLIGHTING_CLASS);
            body.removeAttribute('data-map-pick');
        }
    }

    /** The name of the surface picking on the map, or null. The map's click and hover paths ask this. */
    function active() {
        return state ? state.name : null;
    }

    /**
     * A surface starts picking on the map. options:
     *   name — 'share', 'agreement'; body.map-pick-mode carries it as data-map-pick;
     *   pick(proposalId, record, { parcelId }) — an applied design was clicked on the map;
     *   highlight() — the design ids to draw, or null to draw none and dim nothing;
     *   style(proposalId, record) — Leaflet path options (optional: without it the look is CSS's);
     *   close() — how this surface closes when another one begins (optional);
     *   onProgress(done, total) — a large highlight reports its slices (optional).
     * Resolves as refresh() does, once the first highlight is drawn.
     */
    function begin(options = {}) {
        const name = idOf(options.name);
        if (!name) throw new TypeError('MapPick.begin needs a name.');
        if (typeof options.pick !== 'function') throw new TypeError('MapPick.begin needs pick(proposalId, record).');
        if (state) {
            const previous = state;
            // One surface picks at a time: another one still picking closes first (its close ends its
            // mode); the same surface beginning again starts clean.
            if (previous.name !== name && typeof previous.close === 'function') {
                log(`${name} begins while ${previous.name} is picking: ${previous.name} closes`);
                previous.close();
            }
            if (state === previous) stop();
        }
        // The highlight is a 2D map layer: leave model/photo view first, or it would be invisible and
        // the way back locked with the rest of the chrome.
        if (typeof root.isThreeModeActive === 'function' && root.isThreeModeActive() && typeof root.exitThreeMode === 'function') {
            root.exitThreeMode();
        }
        const map = root.map;
        let group = null;
        if (map && root.L && typeof map.createPane === 'function') {
            if (!map.getPane(PANE)) map.createPane(PANE);
            group = root.L.layerGroup().addTo(map);
        }
        state = {
            name,
            onPick: options.pick,
            highlight: typeof options.highlight === 'function' ? options.highlight : null,
            style: typeof options.style === 'function' ? options.style : null,
            close: typeof options.close === 'function' ? options.close : null,
            onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
            layers: new Map(),
            group,
            token: 0,
            building: false
        };
        const body = root.document && root.document.body;
        if (body) {
            body.classList.add(MODE_CLASS);
            body.setAttribute('data-map-pick', name);
        }
        log(`${name}: picking on the map`);
        return refresh();
    }

    /**
     * The surface stops picking: the lockdown, the highlight and the dimming go. With a name, only
     * that surface's mode ends, so a surface closing late never ends the one that replaced it.
     */
    function end(name) {
        if (!state) return false;
        if (name !== undefined && idOf(name) !== state.name) return false;
        log(`${state.name}: done picking`);
        stop();
        return true;
    }

    /**
     * The map's click resolution hands over the design it found under the pointer. Only an applied
     * design stands on the map, so only an applied one reaches the surface. True when it did.
     */
    function pick(proposalId, context = {}) {
        if (!state) return false;
        const id = idOf(proposalId);
        const record = id ? recordOf(id) : null;
        if (!record || typeof root.isApplied !== 'function' || !root.isApplied(record)) {
            log(`${state.name}: ${id || '(no design)'} is not an applied design; nothing picked`);
            return false;
        }
        state.onPick(idOf(record.proposalId) || id, record, { parcelId: context && context.parcelId !== undefined ? context.parcelId : null });
        return true;
    }

    /**
     * Repaints the highlight from the surface's highlight(): each design it names is drawn (built
     * once, kept while the mode lasts), the others are taken off. `only` limits the work to those
     * designs (one row changed); during a build it restarts the whole repaint instead. Resolves true
     * once drawn, false when the mode ended or a newer repaint took over.
     */
    async function refresh(only = null) {
        const current = state;
        if (!current) return false;
        const body = root.document && root.document.body;
        const ids = current.highlight ? current.highlight() : null;
        if (!Array.isArray(ids)) {
            current.token += 1;
            current.building = false;
            current.layers.forEach(layer => hide(current, layer));
            if (body) body.classList.remove(HIGHLIGHTING_CLASS);
            return true;
        }
        if (body) body.classList.add(HIGHLIGHTING_CLASS);
        const wanted = new Set(ids.map(idOf).filter(Boolean));
        if (Array.isArray(only) && !current.building) {
            only.map(idOf).filter(Boolean).forEach(id => {
                if (!wanted.has(id)) { hide(current, current.layers.get(id)); return; }
                const record = recordOf(id);
                if (!record) return;
                show(current, id, current.layers.has(id) ? current.layers.get(id) : build(current, id, record), record);
            });
            return true;
        }
        const token = ++current.token;
        current.building = true;
        try {
            const missing = [];
            current.layers.forEach((layer, id) => { if (!wanted.has(id)) hide(current, layer); });
            wanted.forEach(id => {
                if (!current.layers.has(id)) missing.push(id);
                else show(current, id, current.layers.get(id), recordOf(id));
            });
            let sliceStarted = now();
            for (let index = 0; index < missing.length; index += 1) {
                if (state !== current || current.token !== token) return false;
                const id = missing[index];
                const record = current.layers.has(id) ? null : recordOf(id);
                if (record) show(current, id, build(current, id, record), record);
                if (current.onProgress) current.onProgress(index + 1, missing.length);
                // The clock every step: one design's outline can cost more than the whole budget.
                if (now() - sliceStarted >= FRAME_BUDGET_MS) {
                    await nextFrame();
                    sliceStarted = now();
                }
            }
            return state === current && current.token === token;
        } finally {
            if (current.token === token) current.building = false;
        }
    }

    return { begin, end, active, pick, refresh, bodyOf, parcelsOf, groundOf, outlineOf, groundReaches };
});
