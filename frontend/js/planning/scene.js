// Shared planning view state: display choices, the dice counter and the selection, plus the
// viewport cells and answer cache its feeds share. Pure data logic, used by 2D, 3D and headless tests. Realising Permitted envelopes from the state lives
// in planning/envelopes.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningScene = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const roles = Object.freeze(['existing', 'permitted', 'proposed']);
    const displayStates = Object.freeze(['solid', 'ghost', 'off']);
    const choices = Object.freeze({
        existing: displayStates, permitted: displayStates, proposed: displayStates,
        existingScope: ['all', 'surviving', 'removed'],
        proposedForm: ['massing', 'buildout', 'both'],
        permittedForm: ['bound', 'configuration', 'both'],
        permittedMap: ['footprint', 'steps'], zoningAreas: ['off', 'ghost']
    });
    const defaults = Object.freeze({ existing: 'off', permitted: 'ghost', proposed: 'solid',
        existingScope: 'all', proposedForm: 'both', permittedForm: 'both', permittedMap: 'footprint', zoningAreas: 'off' });
    function settings(input = {}) {
        return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
            [key, choices[key].includes(input[key]) ? input[key] : value]));
    }
    function displayPolicy(state) { const values = settings(state); return Object.fromEntries(roles.map(role => [role, values[role]])); }
    function permittedRepresentationControl(source, preferred = defaults.permittedForm) {
        const values = source?.parcelStudy ? [...choices.permittedForm] : ['configuration'];
        return { values, value: values.includes(preferred) ? preferred : values[values.length - 1],
            disabled: values.length === 1 || !source };
    }
    // Source IDs do not fully describe a planning catalog: representation policy follows source
    // metadata such as parcelStudy. Sort object keys so equivalent descriptors never cause a rerender.
    function sourceCatalogSignature(sources) {
        const normalize = value => {
            if (Array.isArray(value)) return value.map(normalize);
            if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
                .map(key => [key, normalize(value[key])]));
            return value;
        };
        return JSON.stringify(normalize(sources));
    }
    function itemAppearance(item, state) {
        const values = settings(state);
        return item.assessment?.meaning === 'zoning-area' ? values.zoningAreas : values[item.role];
    }
    function createStore(initial = {}) {
        let state = Object.freeze({ ...settings(initial), proposedVariation: '', permittedVariation: '', selectedId: null, revision: 0 });
        const listeners = new Set();
        const set = patch => {
            if (Object.keys(patch).every(key => state[key] === patch[key])) return state;
            state = Object.freeze({ ...state, ...patch, revision: state.revision + 1 });
            listeners.forEach(listener => listener(state));
            return state;
        };
        return {
            get: () => state,
            configure: (key, value) => choices[key]?.includes(value) ? set({ [key]: value }) : state,
            // Each role has an independent roll. A layer showing only its envelope switches to
            // Both so the roll is visible.
            reroll: role => {
                if (role === 'proposed') return set({ proposedVariation: String(Number(state.proposedVariation) + 1),
                    proposedForm: state.proposedForm === 'massing' ? 'both' : state.proposedForm });
                if (role === 'permitted') return set({ permittedVariation: String(Number(state.permittedVariation) + 1),
                    permittedForm: state.permittedForm === 'bound' ? 'both' : state.permittedForm });
                return state;
            },
            select: id => set({ selectedId: id === null ? null : String(id) }),
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        };
    }
    // Display selection only: never change the observed feature or demolition record.
    function builtGeometry(geometry, record, scope = 'all') {
        if (scope === 'all') return geometry;
        if (scope === 'surviving') return record ? (record.remainder || null) : geometry;
        if (scope === 'removed') return record ? (record.demolishedPart || record.geometry || geometry) : null;
        return geometry;
    }
    function queryKey(city, bbox) { return `${city}:${bbox.map(value => Number(value).toFixed(5)).join(',')}`; }
    // The item that IS a parcel's permitted massing: its envelope when the source records one,
    // else the source's cached result for that parcel (`source.parcel`).
    function parcelItemOf(items, parcelId) {
        const id = parcelId == null ? '' : String(parcelId);
        if (!id) return null;
        const ofParcel = (Array.isArray(items) ? items : []).filter(item => item && item.role === 'permitted'
            && (String(item.sourceEvidence?.parcelReference?.parcelId ?? '') === id || String(item.source?.parcel ?? '') === id));
        return ofParcel.find(item => item.parcelEnvelope) || ofParcel[0] || null;
    }
    // ---- viewport cells ------------------------------------------------------------------------
    // Viewport feeds (planning sources here, the Explore designs index in proposals/design-sync.js)
    // ask for their view snapped outward to a grid, and keep the answers in a bounded cache looked
    // up by containment: a pan that stays inside an answered area, or returns to one, asks for
    // nothing. The cell side is the WGS84 parcel grid unit (city-config.js, 0.001 degrees) doubled
    // until about eight cells span the view, so snapping adds at most a quarter of the view per axis.
    const VIEWPORT_CELL_DEGREES = 0.001;
    const finiteBox = bbox => Array.isArray(bbox) && bbox.length === 4 && bbox.every(value => typeof value === 'number' && Number.isFinite(value))
        && bbox[0] <= bbox[2] && bbox[1] <= bbox[3];
    function viewportCellSize(bbox, { base = VIEWPORT_CELL_DEGREES, perSpan = 8 } = {}) {
        if (!finiteBox(bbox)) throw new TypeError('A viewport cell size needs a finite [west, south, east, north] box.');
        const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
        let size = base;
        while (size * perSpan < span) size *= 2;
        return size;
    }
    // The box of whole cells covering `bbox`. Lower edges are inclusive, so a box already on the grid
    // snaps to itself; a degenerate box still covers one cell.
    function snapBbox(bbox, size = viewportCellSize(bbox)) {
        if (!finiteBox(bbox) || !(size > 0)) throw new TypeError('Snapping needs a finite box and a positive cell size.');
        const tolerance = 1e-9;
        const low = value => Math.floor(value / size + tolerance);
        const high = (value, lower) => Math.max(lower + 1, Math.ceil(value / size - tolerance));
        const west = low(bbox[0]), south = low(bbox[1]);
        const edge = index => Number((index * size).toFixed(7));
        return [edge(west), edge(south), edge(high(bbox[2], west)), edge(high(bbox[3], south))];
    }
    function bboxContains(outer, inner) {
        const tolerance = 1e-9;
        return finiteBox(outer) && finiteBox(inner) && outer[0] <= inner[0] + tolerance && outer[1] <= inner[1] + tolerance
            && outer[2] >= inner[2] - tolerance && outer[3] >= inner[3] - tolerance;
    }
    function bboxIntersects(a, b) {
        return finiteBox(a) && finiteBox(b) && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
    }
    // Area as the API measures it (backend/utils/helpers.js wgs84BboxAreaKm2), for its size limits.
    function bboxAreaKm2(bbox) {
        if (!finiteBox(bbox)) return NaN;
        const midLat = (bbox[1] + bbox[3]) / 2 * Math.PI / 180;
        return Math.abs(bbox[2] - bbox[0]) * 111.32 * Math.cos(midLat) * Math.abs(bbox[3] - bbox[1]) * 110.57;
    }
    // Permitted massing loads as buildings do (building-cells.js): by cells of a fixed grid, nearest
    // the view's centre first, each asked, drawn and cached on its own, so a view of any size fills in
    // and a pan asks only for cells not yet held. A cell is 0.0025° a side (about 280 m north to
    // south, 0.08 km² at the equator), well inside the API's area and lot limits.
    const PLANNING_CELL_DEGREES = 0.0025;
    const MAX_PLANNING_CELLS = 400;
    // The cells covering `bbox`, nearest to `centre` ([lat, lng]) first, as [{ key, bbox, distanceM }].
    function viewCells(bbox, centre, size = PLANNING_CELL_DEGREES) {
        if (!finiteBox(bbox) || !(size > 0)) throw new TypeError('Cells need a finite box and a positive size.');
        const [lat, lng] = Array.isArray(centre) ? centre : [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
        const tolerance = 1e-9;
        const x0 = Math.floor(bbox[0] / size + tolerance), y0 = Math.floor(bbox[1] / size + tolerance);
        const x1 = Math.max(x0, Math.ceil(bbox[2] / size - tolerance) - 1), y1 = Math.max(y0, Math.ceil(bbox[3] / size - tolerance) - 1);
        const cos = Math.cos(lat * Math.PI / 180), edge = index => Number((index * size).toFixed(7));
        const cells = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            const box = [edge(x), edge(y), edge(x + 1), edge(y + 1)];
            const dx = Math.max(box[0] - lng, 0, lng - box[2]) * 111320 * cos, dy = Math.max(box[1] - lat, 0, lat - box[3]) * 110570;
            cells.push({ key: `${x},${y}`, bbox: box, distanceM: Math.hypot(dx, dy) });
        }
        return cells.sort((a, b) => a.distanceM - b.distanceM || a.key.localeCompare(b.key)).slice(0, MAX_PLANNING_CELLS);
    }
    // The cells' answers as one: an item, or an unavailable parcel, reaching over a cell line once;
    // each source's counts summed; everything else as the first answer has it.
    function mergeAnswers(answers) {
        if (!answers.length) return null;
        const items = new Map(), unavailable = new Map(), summaries = new Map();
        let omitted = 0;
        for (const answer of answers) {
            for (const item of answer.items || []) items.set(item.id, item);
            for (const entry of answer.unavailable || []) unavailable.set(entry.parcelId ?? JSON.stringify(entry), entry);
            for (const summary of answer.summaries || []) {
                const known = summaries.get(summary.sourceId);
                summaries.set(summary.sourceId, known ? Object.fromEntries(Object.entries(known).map(([key, value]) =>
                    [key, typeof value === 'number' && typeof summary[key] === 'number' ? value + summary[key] : value])) : { ...summary });
            }
            omitted += answer.omitted || 0;
        }
        return { ...answers[0], items: [...items.values()], unavailable: [...unavailable.values()], summaries: [...summaries.values()], omitted };
    }
    // A bounded least-recently-used cache of area answers with single-flight loading. `scope` names
    // what was asked (city, source, scenario); entries are keyed by scope and the exact box asked for.
    // `find` returns a fresh entry whose box contains the given one; `load` returns the stored entry
    // for that exact box, joins the request in flight for it, or starts one. A failed load stores
    // nothing. Each load has its own AbortController, so a superseded view can cancel only the
    // requests no current view still wants (`abortExcept`).
    function createViewportCache({ limit = 64, maxAgeMs = Infinity, now = () => Date.now() } = {}) {
        const entries = new Map(), inFlight = new Map();
        const keyOf = (scope, bbox) => `${scope}|${bbox.join(',')}`;
        const fresh = entry => now() - entry.at < maxAgeMs;
        const touch = entry => { entries.delete(entry.key); entries.set(entry.key, entry); return entry; };
        function find(scope, bbox) {
            let hit = null;
            for (const entry of Array.from(entries.values()).reverse()) {
                if (entry.scope !== scope) continue;
                if (!fresh(entry)) { entries.delete(entry.key); continue; }
                if (bboxContains(entry.bbox, bbox)) { hit = entry; break; }
            }
            return hit ? touch(hit) : null;
        }
        function load(scope, bbox, loader) {
            const key = keyOf(scope, bbox);
            const stored = entries.get(key);
            if (stored && fresh(stored)) return Promise.resolve(touch(stored));
            if (stored) entries.delete(key);
            const running = inFlight.get(key);
            if (running) return running.promise;
            const controller = new AbortController();
            const flight = { key, controller };
            // The loader starts at once, so a caller sees its request go out before the first await.
            flight.promise = (async () => loader(controller.signal))()
                .then(value => {
                    const entry = { key, scope, bbox: bbox.slice(), value, at: now() };
                    if (inFlight.get(key) === flight) {
                        entries.set(key, entry);
                        while (entries.size > limit) entries.delete(entries.keys().next().value);
                    }
                    return entry;
                })
                .finally(() => { if (inFlight.get(key) === flight) inFlight.delete(key); });
            inFlight.set(key, flight);
            return flight.promise;
        }
        function abortExcept(keep = []) {
            const wanted = new Set(keep);
            for (const [key, flight] of inFlight) {
                if (wanted.has(key)) continue;
                inFlight.delete(key);
                flight.controller.abort();
            }
        }
        function clear() { abortExcept([]); entries.clear(); }
        return { keyOf, find, load, abortExcept, clear, get size() { return entries.size; }, get pending() { return inFlight.size; } };
    }
    // The loading ring on the Buildings and massing button: a third of the rim for each role still
    // loading and shown, in role order, packed from the first slot.
    function loadingArcs(loading = {}, shown = {}) {
        return roles.filter(role => loading[role] && shown[role] !== false).map((role, slot) => ({ role, slot }));
    }
    return { roles, displayStates, choices, defaults, settings, displayPolicy, permittedRepresentationControl, sourceCatalogSignature, itemAppearance, createStore, builtGeometry, queryKey, parcelItemOf, loadingArcs,
        VIEWPORT_CELL_DEGREES, viewportCellSize, snapBbox, bboxContains, bboxIntersects, bboxAreaKm2, createViewportCache,
        PLANNING_CELL_DEGREES, viewCells, mergeAnswers };
});
