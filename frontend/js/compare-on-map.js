// The Compare tab on the 2D map: the map is split at the same divider as the model view, and each
// half draws the building footprints of one side (three-compare.js holds the sides and the rules).
// Standing buildings that no side removes stay where they are on the map; the ones an applied
// design demolishes or a plan's unapplied member clears, and every applied design's buildings, are
// drawn again per side into two clipped panes. A plan side draws its unapplied members itself, as
// footprints: buildings, road corridors and park, square and lake ground (compare-unapplied.js).
// Permitted massing keeps its own pane, clipped to the side(s) that show it. Parcels and applied
// roads and parks are not split: both halves show them.
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

    // What one side draws of the standing buildings designs cut or clear. affected: [{ id, geometry,
    // cuts: [{ by: { id, unapplied }, remainder }] }]. A side that applies none of a building's cuts
    // draws it whole; one that applies a cut draws what that cut leaves, nothing when it leaves
    // nothing. A building two of a side's designs cut keeps the first cut's remainder.
    function demolishedOn(side, affected) {
        const pieces = [];
        for (const building of affected || []) {
            const applied = (building.cuts || []).filter(cut => compare().appliesDesign(side, cut.by));
            if (!applied.length) {
                if (building.geometry) pieces.push({ id: building.id, geometry: building.geometry, outcome: null });
                continue;
            }
            const cut = applied.find(entry => !entry.remainder) || applied[0];
            if (cut.remainder) pieces.push({ id: building.id, geometry: cut.remainder, outcome: 'cut' });
        }
        return pieces;
    }

    // The footprints a side draws of the plan members it reads itself: part is compare-unapplied's
    // partOf(side) ({ rows }); footprints(record) its footprintsOf. [{ kind, feature, designId }].
    function unappliedOn(part, footprints) {
        return (part?.rows || []).flatMap(record => footprints(record).map(shape => ({ ...shape, designId: String(record.proposalId) })));
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

    const pure = { permittedHalf, demolishedOn, unappliedOn, designsOn, halfClips };
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

    // Standing buildings an applied design demolishes or a side's unapplied plan members clear, with
    // their drawn map layers. parts: the two sides' compare-unapplied parts (null when none).
    function affectedBuildings(parts) {
        const records = global.currentBuildingOutcomeState?.()?.demolishedById;
        const layer = global.buildingLayer;
        const clearing = parts.filter(part => part?.clearing.length);
        if ((!records?.size && !clearing.length) || !layer || !map().hasLayer(layer)) return { affected: [], layers: [] };
        const affected = [], layers = [];
        layer.eachLayer(drawn => {
            const id = global.buildingPoolFeatureKey?.(drawn.feature);
            if (!id) return;
            const record = records?.get(id) || null;
            const cuts = record ? [{ by: { id: designIdOfRecord(record), unapplied: false }, remainder: record.remainder || null }] : [];
            for (const part of clearing) cuts.push(...part.cutsOf(id, drawn.feature));
            if (!cuts.length) return;
            layers.push(drawn);
            affected.push({ id, geometry: record?.geometry || drawn.feature?.geometry || null, cuts });
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

    // An unapplied member's footprint as the map draws that kind: a building like the applied designs'
    // buildings (building-blocks.js's style in the Proposed colour), a road or a space outlined in
    // the Proposed colour by class (css/planning-views.css).
    function unappliedStyle(shape) {
        if (shape.kind !== 'building') return { className: `map-compare-shape map-compare-shape--${shape.kind} map-compare-shape--unapplied` };
        const base = typeof PROPOSED_BUILDING_STYLE !== 'undefined' ? PROPOSED_BUILDING_STYLE : {};
        const color = global.PlanningViews?.color?.('proposed');
        return { ...base, ...(color ? { color, fillColor: color } : {}), className: 'map-compare-shape map-compare-shape--proposed map-compare-shape--unapplied' };
    }

    function draw(left, right) {
        const groups = ensureGroups();
        clearDrawing();
        const container = map().getContainer();
        container.classList.add('map-comparing');
        container.dataset.comparePermitted = permittedHalf(left, right);
        const unapplied = global.CompareUnapplied;
        const parts = { left: unapplied?.partOf(left) || null, right: unapplied?.partOf(right) || null };
        const { affected, layers } = affectedBuildings(Object.values(parts));
        layers.forEach(layer => layer.getElement?.()?.classList.add('map-compare-hidden'));
        state.hidden = layers;
        const designs = designBuildingGroups();
        const outcomeStyle = global.buildingOutcomeStyle;
        let drawnUnapplied = 0;
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
            for (const shape of unappliedOn(parts[name], record => unapplied.footprintsOf(record))) {
                global.L.geoJSON(shape.feature, { pane, interactive: false, style: unappliedStyle(shape) }).addTo(group);
                drawnUnapplied += 1;
            }
        }
        state.drawnKey = `${left.value}|${right.value}`;
        state.dirty = false;
        log(`${left.value} | ${right.value}: ${affected.length} demolished buildings, ${designs.length} designs, ${drawnUnapplied} unapplied footprints`);
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
        for (const event of ['buildingsLayerUpdated', 'proposedBuildingsUpdated', 'parcelFabricCommitted', 'compareunappliedchange']) global.addEventListener(event, redraw);
        global.ThreeCompare.attachMap(state.scene);
    }

    if (typeof global.whenMapCoreReady === 'function') global.whenMapCoreReady().then(init);

    return Object.freeze({ ...pure, update });
});
