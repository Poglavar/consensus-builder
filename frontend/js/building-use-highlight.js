// Highlight by building use: the storey uses ticked in Layers → Building use (housing, shops,
// offices, public, industrial, not stated) colour the storeys of that use, in existing buildings and
// designs alike, and everything else fades. A residential building with shops lights its ground floor
// under Shops and the storeys above under Housing. 3D colours each storey band; 2D draws a building
// in the colour of its highest ticked storey. Nothing ticked draws the map as it is. This module holds
// the choice, the palette (the legend swatches and both views read it from here) and the per-view
// rules; the views repaint on `onChange`.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingUseHighlight = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const buildingUse = () => (root && root.BuildingUse) || require('./building-use.js');

    // A storey use's colour on the map ('none': the building states no use). Saturated enough to read
    // against faded context in both views.
    const COLORS = Object.freeze({
        residential: '#e9b730',
        shop: '#ef6a2e',
        // Not blue: water is.
        office: '#d6457a',
        public: '#8b52d6',
        industrial: '#7d6553',
        none: '#8a929c'
    });
    const CATEGORIES = Object.freeze(Object.keys(COLORS));
    const FADED_OPACITY = 0.12;
    // Storeys of a building that states its storey count nowhere: its height at this storey height.
    const STOREY_M = 3.3;

    const selected = new Set();
    const listeners = new Set();

    const isActive = () => selected.size > 0;

    function notify() {
        listeners.forEach(listener => {
            try { listener(); } catch (error) { console.error('[building-use-highlight] a view failed to repaint', error); }
        });
    }

    function setSelected(category, on) {
        if (!CATEGORIES.includes(category)) throw new Error(`Unknown storey use: ${category}`);
        if (on === selected.has(category)) return;
        if (on) selected.add(category); else selected.delete(category);
        notify();
    }

    function clear() {
        if (!selected.size) return;
        selected.clear();
        notify();
    }

    function onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    // A building's storey count: stated, else its height at STOREY_M (at least one).
    function storeyCount(floors, heightM) {
        if (Number.isInteger(floors) && floors > 0) return floors;
        return typeof heightM === 'number' && Number.isFinite(heightM) && heightM > 0 ? Math.max(1, Math.round(heightM / STOREY_M)) : 1;
    }

    // The use of each storey of a building, ground floor first, as highlight categories; a building
    // that states no use is one 'none' storey.
    function storeysOf(properties, { floors, heightM } = {}) {
        const uses = buildingUse().storeyUsesOf(properties, storeyCount(floors ?? (properties || {}).floors, heightM));
        return uses.length ? uses : ['none'];
    }

    // Consecutive storeys of one look merged: [{ from, to (storey fractions 0–1), category, lit }].
    function bands(storeys) {
        const list = [];
        storeys.forEach((category, index) => {
            const lit = selected.has(category);
            const last = list[list.length - 1];
            const key = lit ? category : null;
            if (last && last.key === key) last.to = (index + 1) / storeys.length;
            else list.push({ key, category: lit ? category : null, lit, from: index / storeys.length, to: (index + 1) / storeys.length });
        });
        return list.map(({ key, ...band }) => band);
    }

    // A Leaflet path style for a building with these storeys: unchanged while nothing is ticked, the
    // colour of its highest ticked storey (what is seen from above), else faded.
    function style2d(base, storeys) {
        if (!isActive()) return base;
        const top = [...storeys].reverse().find(category => selected.has(category));
        if (top) {
            const color = COLORS[top];
            return { ...base, color, fillColor: color, fillOpacity: 0.85, opacity: 1 };
        }
        return { ...base, fillOpacity: FADED_OPACITY / 2, opacity: 0.25 };
    }

    // The 3D pass over built groups. Each building mesh carries its storeys in
    // `userData.buildingStoreys`; untagged meshes of the groups count as a building stating no use.
    // A building wholly of one ticked use takes `materialFor(category)`, one with no ticked storey
    // `faded`, and one lit in part `bandMaterial(bands, mesh)`, owned by the mesh (`from`/`to` are fractions
    // of its height). Each mesh keeps its own material in `userData.cbUseHighlightOriginal` and gets it back
    // when nothing is ticked. `skip(mesh)` leaves helpers (depth pre-passes) alone. Returns how many
    // meshes changed.
    function apply3d(groups, { materialFor, faded, bandMaterial, skip = () => false }) {
        let changed = 0;
        const active = isActive();
        const disposeOwned = data => {
            if (data.cbUseHighlightBands) { data.cbUseHighlightBands.dispose(); delete data.cbUseHighlightBands; }
        };
        groups.filter(Boolean).forEach(group => group.traverse(object => {
            if (!object || !object.isMesh || skip(object)) return;
            const data = object.userData || (object.userData = {});
            const hasOriginal = Object.prototype.hasOwnProperty.call(data, 'cbUseHighlightOriginal');
            if (!active) {
                if (!hasOriginal) return;
                object.material = data.cbUseHighlightOriginal;
                delete data.cbUseHighlightOriginal;
                disposeOwned(data);
                changed += 1;
                return;
            }
            if (!hasOriginal) data.cbUseHighlightOriginal = object.material;
            disposeOwned(data);
            const parts = bands(Array.isArray(data.buildingStoreys) && data.buildingStoreys.length ? data.buildingStoreys : ['none']);
            let next;
            if (parts.length === 1) next = parts[0].lit ? materialFor(parts[0].category) : faded;
            else next = data.cbUseHighlightBands = bandMaterial(parts.map(band => ({ ...band,
                color: band.lit ? COLORS[band.category] : COLORS.none, opacity: band.lit ? 1 : FADED_OPACITY })), object);
            if (object.material !== next) { object.material = next; changed += 1; }
        }));
        return changed;
    }

    return {
        COLORS, CATEGORIES, FADED_OPACITY, isActive, setSelected, clear, onChange, storeyCount, storeysOf, bands,
        style2d, apply3d, selected: () => CATEGORIES.filter(category => selected.has(category))
    };
});
