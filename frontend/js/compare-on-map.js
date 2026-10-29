// The Compare tab on the 2D map: the map is split at the same divider as the model view, and each
// half draws the building footprints of one side (three-compare.js holds the sides and the rules).
// Standing buildings that no side removes stay where they are on the map; the ones an applied
// design demolishes, and every applied design's buildings, are drawn again per side into two
// clipped panes. Permitted massing keeps its own pane, clipped to the side(s) that show it.
// Parcels, roads and parks are not split: both halves show them.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CompareOnMap = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const compare = () => global.ThreeCompare || require('./three-compare.js');

    // Which half of the map shows permitted massing: 'both', 'left', 'right' or 'none'.
    function permittedHalf(left, right) {
        const descriptor = { role: 'permitted' };
        const onLeft = compare().showsOn(left, descriptor), onRight = compare().showsOn(right, descriptor);
        return onLeft && onRight ? 'both' : onLeft ? 'left' : onRight ? 'right' : 'none';
    }

    // What one side draws of the buildings applied designs demolish. affected: [{ id, geometry,
    // remainder, demolishedBy }]. A side that keeps the building draws it whole; a side that applies
    // the demolition draws what is left of a cut building and nothing of a destroyed one.
    function demolishedOn(side, affected) {
        const pieces = [];
        for (const building of affected || []) {
            if (compare().showsOn(side, { role: 'existing', demolishedBy: building.demolishedBy })) {
                if (building.geometry) pieces.push({ id: building.id, geometry: building.geometry, outcome: null });
            } else if (building.remainder) {
                pieces.push({ id: building.id, geometry: building.remainder, outcome: 'cut' });
            }
        }
        return pieces;
    }

    // The applied designs whose buildings one side draws.
    function designsOn(side, designIds) {
        return (designIds || []).map(String).filter(id => compare().showsOn(side, { role: 'proposed', designId: id }));
    }

    // The clip-path of each half for a pane, in the pane's own pixels. view: the map's visible box in
    // those pixels { left, top, right, bottom }; x: the divider in the same pixels.
    function halfClips(view, x) {
        const box = (from, to) => `polygon(${from}px ${view.top}px, ${to}px ${view.top}px, ${to}px ${view.bottom}px, ${from}px ${view.bottom}px)`;
        return { left: box(view.left, x), right: box(x, view.right) };
    }

    const pure = { permittedHalf, demolishedOn, designsOn, halfClips };
    if (!global || !global.document) return Object.freeze(pure);

    // ── the map ───────────────────────────────────────────────────────────────────────────────

    const doc = global.document;
    const PANES = { left: 'compareLeftPane', right: 'compareRightPane' };
    // The path style keys copied from a design's drawn buildings, so a side draws them as the map does.
    const STYLE_KEYS = ['stroke', 'color', 'weight', 'opacity', 'dashArray', 'fill', 'fillColor', 'fillOpacity'];
    const state = { scene: null, groups: null, hidden: [], drawnKey: null, dirty: true };

    function log(...args) { global.console.log(`[${new Date().toISOString()}] [compare-on-map]`, ...args); }

    function map() { return global.map; }

    function ensureGroups() {
        if (state.groups) return state.groups;
        const m = map();
        state.groups = {};
        for (const [side, name] of Object.entries(PANES)) {
            if (!m.getPane(name)) m.createPane(name).classList.add('map-compare-pane');
            state.groups[side] = global.L.layerGroup([], { pane: name }).addTo(m);
        }
        return state.groups;
    }

    // The design an outcome record belongs to, as the Compare sides name designs.
    function designIdOfRecord(record) {
        const by = record?.proposalKey || record?.proposalId;
        if (!by) return null;
        const proposal = global.getProposalByIdOrHash?.(by) || global.proposalStorage?.getProposal?.(by);
        return proposal ? String(proposal.proposalId) : String(by);
    }

    // Standing buildings an applied design demolishes, with their drawn map layers.
    function affectedBuildings() {
        const records = global.currentBuildingOutcomeState?.()?.demolishedById;
        const layer = global.buildingLayer;
        if (!records?.size || !layer || !map().hasLayer(layer)) return { affected: [], layers: [] };
        const affected = [], layers = [];
        layer.eachLayer(drawn => {
            const id = global.buildingPoolFeatureKey?.(drawn.feature);
            const record = id ? records.get(id) : null;
            if (!record) return;
            layers.push(drawn);
            affected.push({ id, geometry: record.geometry || drawn.feature?.geometry || null, remainder: record.remainder || null,
                demolishedBy: designIdOfRecord(record) });
        });
        return { affected, layers };
    }

    // Every applied design's drawn buildings: [[designId, featureGroup]].
    function designBuildingGroups() {
        // building-blocks.js keeps one group per drawn design (a classic-script global).
        const groups = typeof proposedBuildingSublayers !== 'undefined' ? proposedBuildingSublayers : null;
        return groups ? Array.from(groups.entries()) : [];
    }

    function eachPath(layer, visit) {
        if (typeof layer.eachLayer === 'function') layer.eachLayer(child => eachPath(child, visit));
        else if (typeof layer.toGeoJSON === 'function') visit(layer);
    }

    function clearDrawing() {
        state.hidden.forEach(layer => layer.getElement?.()?.classList.remove('map-compare-hidden'));
        state.hidden = [];
        if (state.groups) Object.values(state.groups).forEach(group => group.clearLayers());
        const container = map()?.getContainer();
        container?.classList.remove('map-comparing');
        delete container?.dataset.comparePermitted;
        const sources = map()?.getPane('planningSources');
        if (sources) sources.style.clipPath = '';
        state.drawnKey = null;
    }

    function draw(left, right) {
        const groups = ensureGroups();
        clearDrawing();
        const container = map().getContainer();
        container.classList.add('map-comparing');
        container.dataset.comparePermitted = permittedHalf(left, right);
        const { affected, layers } = affectedBuildings();
        layers.forEach(layer => layer.getElement?.()?.classList.add('map-compare-hidden'));
        state.hidden = layers;
        const designs = designBuildingGroups();
        const outcomeStyle = global.buildingOutcomeStyle;
        for (const [name, side] of [['left', left], ['right', right]]) {
            const group = groups[name], pane = PANES[name];
            for (const piece of demolishedOn(side, affected)) {
                global.L.geoJSON(piece.geometry, { pane, interactive: false,
                    style: { ...(outcomeStyle?.(piece.outcome) || {}), className: 'map-compare-shape map-compare-shape--existing' } }).addTo(group);
            }
            const shown = new Set(designsOn(side, designs.map(([id]) => id)));
            for (const [id, designGroup] of designs) {
                if (!shown.has(String(id))) continue;
                eachPath(designGroup, path => {
                    const style = Object.fromEntries(STYLE_KEYS.filter(key => path.options[key] !== undefined).map(key => [key, path.options[key]]));
                    global.L.geoJSON(path.toGeoJSON(), { pane, interactive: false,
                        style: { ...style, className: 'map-compare-shape map-compare-shape--proposed' } }).addTo(group);
                });
            }
        }
        state.drawnKey = `${left.value}|${right.value}`;
        state.dirty = false;
        log(`${left.value} | ${right.value}: ${affected.length} demolished buildings, ${designs.length} designs`);
    }

    // Each half's pane keeps to its side of the divider as the map moves under it.
    function clip() {
        if (!state.drawnKey) return;
        const m = map(), { percent } = global.ThreeCompare.sides();
        const size = m.getSize();
        const topLeft = m.containerPointToLayerPoint([0, 0]), bottomRight = m.containerPointToLayerPoint([size.x, size.y]);
        const x = m.containerPointToLayerPoint([size.x * percent / 100, 0]).x;
        const clips = halfClips({ left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y }, x);
        for (const [side, name] of Object.entries(PANES)) m.getPane(name).style.clipPath = clips[side];
        const half = m.getContainer().dataset.comparePermitted;
        const sources = m.getPane('planningSources');
        if (sources) sources.style.clipPath = half === 'left' || half === 'right' ? clips[half] : '';
    }

    function update() {
        const active = !!map() && global.ThreeCompare?.isActive?.(state.scene);
        if (!active) { if (state.drawnKey) clearDrawing(); return; }
        const { left, right } = global.ThreeCompare.sides();
        if (state.dirty || state.drawnKey !== `${left.value}|${right.value}`) draw(left, right);
        clip();
    }

    function redraw() { state.dirty = true; update(); }

    function init() {
        const m = map();
        if (!m || !global.ThreeCompare?.attachMap) return;
        state.scene = { container: m.getContainer(), invalidate: update };
        m.on('move zoomend viewreset resize', update);
        for (const event of ['buildingsLayerUpdated', 'proposedBuildingsUpdated', 'parcelFabricCommitted']) global.addEventListener(event, redraw);
        global.ThreeCompare.attachMap(state.scene);
    }

    if (typeof global.whenMapCoreReady === 'function') global.whenMapCoreReady().then(init);

    return Object.freeze({ ...pure, update });
});
