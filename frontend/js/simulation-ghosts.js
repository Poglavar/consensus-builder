// simulation-ghosts.js — designs the agents drew in the last few simulation turns, shown on the map
// as ghosts that fade turn by turn without being applied. Pure bookkeeping (which designs, how
// strong) plus the 2D drawing; three-mode.js draws the same ghosts in 3D (rebuildProposalInteraction3D).
// Nothing here writes a proposal or a parcel, so Stop and New game simply clear the list.
// UMD, so backend/test/frontend-simulation-ghosts.test.js loads it without a DOM.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SimulationGhosts = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // A design shows at full strength in the turn it was drawn and is gone FADE_TURNS turns later.
    const FADE_TURNS = 3;
    const CHANGE_EVENT = 'simulationghostschange';
    const PANE = 'simulationGhostPane';

    // Pure: how strong a ghost drawn `age` turns ago is, 1 when new, 0 once it has faded.
    function ghostStrength(age, fadeTurns = FADE_TURNS) {
        if (!Number.isInteger(age) || age < 0 || !Number.isInteger(fadeTurns) || age >= fadeTurns) return 0;
        return (fadeTurns - age) / fadeTurns;
    }

    // Pure: the ghosts still showing at `turn`, newest first, each with its strength.
    function liveGhosts(entries, turn, fadeTurns = FADE_TURNS) {
        return (entries || [])
            .map(entry => ({ ...entry, strength: ghostStrength(turn - entry.turn, fadeTurns) }))
            .filter(entry => entry.strength > 0)
            .sort((a, b) => b.turn - a.turn);
    }

    let entries = [];
    let currentTurn = 0;

    function notify() {
        try { root?.dispatchEvent?.(new root.CustomEvent(CHANGE_EVENT)); } catch (_) { }
        render2D();
    }

    // A turn ended: its new designs join at full strength and older ones fade a step.
    function recordTurn(turn, proposalIds) {
        if (!Number.isInteger(turn)) return;
        currentTurn = turn;
        const fresh = new Set((proposalIds || []).filter(id => id !== null && id !== undefined).map(String));
        entries = liveGhosts(entries.filter(entry => !fresh.has(entry.proposalId)), turn)
            .map(({ proposalId, turn: drawn }) => ({ proposalId, turn: drawn }));
        fresh.forEach(proposalId => entries.push({ proposalId, turn }));
        notify();
    }

    function strengthOf(proposalId) {
        if (proposalId === null || proposalId === undefined) return 0;
        const entry = entries.find(item => item.proposalId === String(proposalId));
        return entry ? ghostStrength(currentTurn - entry.turn) : 0;
    }

    function list() {
        return liveGhosts(entries, currentTurn);
    }

    function clear() {
        if (!entries.length) return;
        entries = [];
        notify();
    }

    // --- 2D: one SVG group in its own pane under the selection highlight (proposalHighlightPane 650).
    let group = null;

    function ghostGroup(map) {
        if (group) return group;
        const L = root?.L;
        if (!L || !map?.createPane) return null;
        if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = '645';
        group = L.featureGroup().addTo(map);
        return group;
    }

    function ghostFeatures(proposal) {
        try {
            const sets = root.collectProposalFeatureSets(proposal, { includeBuildingGeometry: true });
            return sets.primaryFeatures?.length ? sets.primaryFeatures : (sets.parcelFeatures || []);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [simulation-ghosts] no outline for a design`, error);
            return [];
        }
    }

    // A click opens the design, as a click on a selected design's preview does (layer-render.js).
    function openGhost(event, proposalKey) {
        if (root.roadDrawingMode || root.MapPick?.active?.() || root.measureMode || root.__mapEditLock?.isHeld?.()
            || root.isParcelDrawingModeActive?.() || root.pinpointToolIsActive?.()) return;
        root.L.DomEvent.stopPropagation(event);
        root.focusProposalDetails?.(proposalKey, { centerOnProposal: false, showDetails: true, presentation: 'compact' });
    }

    function render2D() {
        const map = root?.map;
        if (!map || !root.proposalStorage || typeof root.collectProposalFeatureSets !== 'function') return;
        const target = ghostGroup(map);
        if (!target) return;
        target.clearLayers();
        list().forEach(({ proposalId, strength }) => {
            const proposal = root.proposalStorage.getProposal(proposalId);
            // An applied design stands on the map itself; 3D skips it the same way.
            if (!proposal || root.isProposalApplied?.(proposal)) return;
            const key = (typeof root.getProposalKey === 'function' && root.getProposalKey(proposal)) || proposalId;
            const className = strength === 1 ? 'simulation-ghost simulation-ghost--new' : 'simulation-ghost';
            ghostFeatures(proposal).forEach(feature => {
                const layer = root.L.geoJSON(feature, {
                    pane: PANE,
                    // Colour comes from .simulation-ghost in css/game.css; strength is per ghost.
                    style: () => ({ className, weight: 2, opacity: 0.9 * strength, fillOpacity: 0.35 * strength }),
                    pointToLayer: (_, latlng) => root.L.circleMarker(latlng, { radius: 6 })
                });
                layer.on('click', event => openGhost(event, key));
                layer.addTo(target);
            });
        });
    }

    return { FADE_TURNS, CHANGE_EVENT, ghostStrength, liveGhosts, recordTurn, strengthOf, list, clear, render2D };
});
