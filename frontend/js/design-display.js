// design-display.js — draws designs that are not applied, in their own look: a park's lawn, a square's
// paving, a lake's water, a building's volume. Display only: nothing here applies, writes or carves.
// Two layers use it: simulation ghosts (simulation-ghosts.js, fading by turn) and the Agent city
// (agent-city.js, executed designs at a date). This file draws 2D; three-mode.js draws the same
// entries in model and photo 3D (rebuildDesignDisplay3D) from displayParts().
// UMD, so backend/test/frontend-design-display.test.js loads the pure parts without a DOM.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DesignDisplay = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const CHANGE_EVENT = 'designdisplaychange';
    const STRUCTURE_KINDS = new Set(['park', 'square', 'lake']);
    const DEFAULT_STOREY_M = 3;
    // Layers in drawing priority. The Agent city shows the city at its own date, so while it is
    // open (its layer is set, even empty) it is the only layer drawn.
    const LAYER_ORDER = ['agentCity', 'ghosts'];
    const EXCLUSIVE = 'agentCity';

    const finite = value => typeof value === 'number' && Number.isFinite(value);

    function asFeature(value, properties = {}) {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry ? value : null;
        if (value.type && Array.isArray(value.coordinates)) return { type: 'Feature', properties, geometry: value };
        return null;
    }

    // A building's height in metres: its own, else its floors at a storey height, else null.
    function buildingHeightM(properties = {}) {
        if (finite(properties.height) && properties.height > 0) return properties.height;
        if (finite(properties.floors) && properties.floors > 0) return properties.floors * DEFAULT_STOREY_M;
        return null;
    }

    // Pure: what a design draws, as parts of one kind each: 'building' (a volume with a height),
    // 'park', 'square', 'lake', or 'ground' (a road surface or plots, drawn flat). Reads a local
    // proposal record and a published design/v1 content alike.
    function displayParts(design) {
        if (!design || typeof design !== 'object') return [];
        const parts = [];
        const pushBuilding = value => {
            if (value && value.type === 'FeatureCollection') { (value.features || []).forEach(pushBuilding); return; }
            const feature = asFeature(value);
            if (!feature) return;
            parts.push({ kind: 'building', feature, heightM: buildingHeightM(feature.properties || {}) });
        };
        const pushFlat = (kind, value) => {
            if (value && value.type === 'FeatureCollection') { (value.features || []).forEach(item => pushFlat(kind, item)); return; }
            const feature = asFeature(value);
            if (feature) parts.push({ kind, feature });
        };
        pushFlat('ground', design.roadProposal?.definition?.polygon);
        (design.buildingProposal?.buildings || design.geometry?.buildings || []).forEach(pushBuilding);
        pushBuilding(design.buildingProposal?.buildingFeature);
        if (!parts.some(part => part.kind === 'building') && design.buildingGeometry) {
            pushBuilding({ type: 'Feature', properties: design.buildingProperties || {}, geometry: design.buildingGeometry });
        }
        (design.parcelLayout?.plots || []).forEach(plot => pushFlat('ground', plot && plot.geometry));
        const structure = design.structureProposal;
        if (structure) {
            const kind = String(structure.kind || design.goal || '').toLowerCase();
            pushFlat(STRUCTURE_KINDS.has(kind) ? kind : 'ground', structure.geometry);
        }
        return parts;
    }

    // Pure: the entries to draw from every layer, in priority order, each design once; only the
    // exclusive layer's while it is set.
    function mergeLayers(layers, order = LAYER_ORDER) {
        const seen = new Set();
        const merged = [];
        const names = Array.isArray(layers[EXCLUSIVE]) ? [EXCLUSIVE] : order;
        names.forEach(name => (layers[name] || []).forEach(entry => {
            if (!entry || !entry.key || seen.has(entry.key)) return;
            seen.add(entry.key);
            merged.push(entry);
        }));
        return merged;
    }

    // Pure: an opacity's step, 1..3; each step is one 2D pane with that opacity in css/game.css.
    function strengthStep(opacity) {
        if (!finite(opacity) || opacity <= 0) return 0;
        return Math.max(1, Math.min(3, Math.round(opacity * 3)));
    }

    // entry: { key, design, opacity (0..1), fresh, label, open: { type: 'design' | 'agreement', id } }
    const layers = {};
    let renderQueued = false;

    // null removes the layer (the Agent city when it closes).
    function setLayer(name, entries) {
        if (entries === null) delete layers[name];
        else layers[name] = Array.isArray(entries) ? entries.filter(entry => entry && entry.key && entry.design) : [];
        if (renderQueued) return;
        renderQueued = true;
        Promise.resolve().then(() => {
            renderQueued = false;
            render2D();
            root?.dispatchEvent?.(new root.CustomEvent(CHANGE_EVENT));
        });
    }

    function entries() {
        return mergeLayers(layers);
    }

    function entryByKey(key) {
        return entries().find(entry => entry.key === key) || null;
    }

    function editingBlocksClicks() {
        return !!(root.roadDrawingMode || root.MapPick?.active?.() || root.measureMode || root.__mapEditLock?.isHeld?.()
            || root.isParcelDrawingModeActive?.() || root.pinpointToolIsActive?.());
    }

    // A click on a drawn design opens it: an agreement in its panel, a design of this browser as a
    // selected design (3D) or in its compact card (2D), as clicks on designs do elsewhere.
    function open(entry, { view = '2d' } = {}) {
        if (!entry?.open?.id) return;
        if (entry.open.type === 'agreement') {
            root.openActivityEntity?.({ type: 'agreement', id: entry.open.id });
            return;
        }
        const proposal = root.proposalStorage?.getProposal?.(entry.open.id) || null;
        if (!proposal) return;
        const key = (typeof root.getProposalKey === 'function' && root.getProposalKey(proposal)) || entry.open.id;
        if (view === '3d') root.selectAndHighlightProposal?.(key, proposal.cadastreParcelIds?.[0] || null, false, false, true);
        else root.focusProposalDetails?.(key, { centerOnProposal: false, showDetails: true, presentation: 'compact' });
    }

    function openKey(key, options) {
        const entry = entryByKey(key);
        if (entry) open(entry, options);
        return !!entry;
    }

    // --- 2D: a pane per strength step under the selection highlight (proposalHighlightPane, 650). A
    // pane's opacity fades everything in it alike; the colours are .design-display--<kind> in css/game.css.
    let group = null;

    function paneName(step) {
        return `designDisplayPane${step}`;
    }

    function ensureGroup(map) {
        const L = root?.L;
        if (!L || !map?.createPane) return null;
        [1, 2, 3].forEach(step => {
            if (map.getPane(paneName(step))) return;
            map.createPane(paneName(step)).classList.add('design-display-pane', `design-display-pane--${step}`);
        });
        if (!group) group = L.featureGroup().addTo(map);
        return group;
    }

    function render2D() {
        const map = root?.map;
        const L = root?.L;
        if (!map || !L) return;
        const target = ensureGroup(map);
        if (!target) return;
        target.clearLayers();
        entries().forEach(entry => {
            const step = strengthStep(entry.opacity ?? 1);
            if (!step) return;
            displayParts(entry.design).forEach(part => {
                const className = `design-display design-display--${part.kind}${entry.fresh ? ' design-display--fresh' : ''}`;
                const layer = L.geoJSON(part.feature, {
                    pane: paneName(step),
                    style: () => ({ className, weight: part.kind === 'building' ? 1.5 : 1 })
                });
                layer.on('click', event => {
                    if (editingBlocksClicks()) return;
                    L.DomEvent.stopPropagation(event);
                    open(entry, { view: '2d' });
                });
                layer.addTo(target);
            });
        });
    }

    return { CHANGE_EVENT, displayParts, mergeLayers, strengthStep, buildingHeightM, setLayer, entries, entryByKey, open, openKey, render2D };
});
