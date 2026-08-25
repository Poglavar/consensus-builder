// Integration contract for the Share Plan panel: it is a right-docked PANEL (not a modal) that
// puts the app in share-plan mode — the map is pan/zoom only, every fabric surface is inert, and
// the checked proposals are painted on the map. These greps lock the lockdown wiring so a guard
// cannot silently drop out of one of the several files that each hold a piece of it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const dialogShare = read('../../frontend/js/proposals/dialog-share.js');
const sharingRoutes = read('../../frontend/js/proposals/sharing-routes.js');
const mapEditLock = read('../../frontend/js/map-edit-lock.js');
const parcelHover = read('../../frontend/js/parcels/selection.js');
const parcelClick = read('../../frontend/js/parcels/ui/parcel-selection.js');
const drillUi = read('../../frontend/js/proposals/drill-ui.js');
const layerRender = read('../../frontend/js/proposals/layer-render.js');
const listUi = read('../../frontend/js/proposals/list-ui.js');
const proposalsCss = read('../../frontend/css/proposals.css');

function sourceSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('share plan panel contract', () => {
    const panelFn = sourceSection(dialogShare, 'function showSharePlanPanel()', 'function showShareLinkModal');

    it('opens as a right-docked panel, never through the share modal', () => {
        expect(panelFn).toContain("panelRoot.className = 'share-plan-panel'");
        expect(panelFn).toContain("panelContent.className = 'share-plan-panel-content'");
        expect(panelFn).not.toContain('showSimpleShareModal(');
        // The panel replaced the modal entirely — no share-plan modal entry point remains.
        expect(dialogShare).not.toContain('function showSharePlanModal');
        expect(sharingRoutes).toContain('showSharePlanPanel()');
    });

    it('enters and leaves share-plan mode symmetrically', () => {
        expect(panelFn).toContain('window.sharePlanMode = true');
        expect(panelFn).toContain("document.body.classList.add('share-plan-mode')");
        const closeFn = sourceSection(dialogShare, 'function closeSharePlanPanel()', 'function showSharePlanPanel');
        expect(closeFn).toContain('window.sharePlanMode = false');
        expect(closeFn).toContain("document.body.classList.remove('share-plan-mode')");
        // Both highlight groups come off the map, not just whichever was showing.
        expect(closeFn).toContain('map.removeLayer(state.overlayGroups[bucket])');
        expect(closeFn).toContain('Object.keys(state.overlayGroups)');
        // A failed open must not leave the map locked.
        expect(panelFn).toContain('try { closeSharePlanPanel(); } catch (_) { }');
    });

    it('paints a proposal when its row is toggled, and only then', () => {
        expect(panelFn).toContain('const syncPlanOverlay = (key)');
        // Unchecking a row drops its overlay from whichever group holds it; only checked proposals
        // are ever painted.
        const sync = sourceSection(panelFn, 'const syncPlanOverlay = (key)', 'const applyHighlightMode');
        expect(sync).toContain('if (!selected.has(key)) {');
        expect(sync).toContain('overlayByKey.delete(key)');
        expect(panelFn).toContain('if (!overlayGroups || overlayByKey.has(key) || !selected.has(key)) return;');
        const checkboxChange = sourceSection(panelFn, 'const onCheckboxChange =', 'const attachRow =');
        expect(checkboxChange).toContain('syncPlanOverlay(key)');
    });

    it('draws NOTHING when the panel opens', () => {
        // Opening a list is not a request to draw three hundred overlays. It cost seconds of turf
        // and Leaflet work before the panel was usable, and left the map unreadable under the whole
        // plan at once.
        //
        // Scoped to the FILL, not the whole function: drawing all of them is now available behind a
        // toggle, and a file-wide grep for 'drawingProposals' would fail on that even though the
        // fill still draws nothing. Asserting the absence of a string is a proxy; the property is
        // that opening the panel starts no drawing.
        const fill = panelFn.slice(panelFn.indexOf('(async () => {'), panelFn.indexOf('await initializeUploadChecks();'));
        expect(fill).not.toContain("'drawingProposals'");
        expect(fill).not.toContain('syncPlanOverlay');
        // One pass in the fill — the rows. A second would be a drawing pass.
        expect(fill.match(/if \(!await inChunks\(/g) || []).toHaveLength(1);
    });

    it('offers the subset highlight as All/Uploaded/Not-uploaded, starting on All', () => {
        // Hovering rows one at a time answers "is THIS one uploaded"; it cannot answer "which of my
        // three hundred are". The filter can, in the treatments the legend defines. "All" is the
        // base drawing the map already shows, so it must be the starting mode and paint nothing.
        expect(panelFn).toContain("{ value: 'all', key: 'plan.filterAll'");
        expect(panelFn).toContain("{ value: 'uploaded', key: 'plan.filterUploaded'");
        expect(panelFn).toContain("{ value: 'pending', key: 'plan.filterPending'");
        expect(panelFn).toContain("let highlightMode = 'all';");
        // And it draws in slices, like the row build — 300 overlays in one task is the freeze the
        // panel was rebuilt to avoid.
        const apply = sourceSection(panelFn, 'const applyHighlightMode', 'const setHighlightMode');
        expect(apply).toContain('await inChunks([...proposalsByHash.keys()], key => buildPlanOverlay(key)');
    });

    // The property that makes the filter usable at all: flipping between subsets must not redo the
    // geometry. The checkbox this replaced rebuilt every footprint on each tick — a turf resolve per
    // proposal — which is why nobody waited for it.
    it('switches subsets by moving Leaflet groups, not by rebuilding overlays', () => {
        const apply = sourceSection(panelFn, 'const applyHighlightMode', 'const setHighlightMode');
        // Builds once, behind a latch...
        expect(panelFn).toContain('let overlaysBuilt = false;');
        expect(apply).toContain('if (!overlaysBuilt)');
        // ...and every later switch is add/remove of a whole group.
        expect(apply).toContain('map.removeLayer(overlayGroups[bucket])');
        expect(apply).toContain('overlayGroups[show].addTo(map)');
        // Nothing in the switch resolves geometry again.
        expect(apply, 'the mode switch rebuilds overlay geometry').not.toContain('groundFeaturesFor(');
        expect(apply, 'the mode switch re-resolves proposal features').not.toContain('proposalFeaturesFor(');
    });

    // Painting the subset ON TOP of the base drawing answered nothing: the whole city is already
    // drawn, so "Not uploaded yet" looked like "All" with one more shape in it. Choosing a subset
    // has to push everything else back.
    it('dims everything that is not the chosen subset, and undims on All', () => {
        const apply = sourceSection(panelFn, 'const applyHighlightMode', 'const setHighlightMode');
        expect(apply).toContain("document.body.classList.add('share-plan-highlighting')");
        expect(apply).toContain("document.body.classList.remove('share-plan-highlighting')");
        // The subset itself sits in its own pane, above the dimming.
        expect(panelFn).toContain("const HIGHLIGHT_PANE = 'shareplan-highlight'");
        expect(panelFn).toContain('pane: map.getPane(HIGHLIGHT_PANE) ? HIGHLIGHT_PANE : undefined');
        // Closing with a subset chosen must not leave the map dimmed behind the panel.
        const closeFn = sourceSection(dialogShare, 'function closeSharePlanPanel()', 'function showSharePlanPanel');
        expect(closeFn).toContain("document.body.classList.remove('share-plan-highlighting')");
    });

    it('dims by Leaflet pane structure, not by this app\'s pane names', () => {
        // A rule listing pane names leaves the next fabric pane as the one thing still bright.
        const rule = proposalsCss.slice(proposalsCss.indexOf('body.share-plan-highlighting .leaflet-map-pane'));
        expect(rule.slice(0, 260)).toContain(':not(.leaflet-tile-pane)');
        expect(rule.slice(0, 260)).toContain(':not(.leaflet-shareplan-highlight-pane)');
        const opacity = Number((rule.match(/opacity:\s*([\d.]+)/) || [])[1]);
        expect(opacity, 'dimming too faint to separate the subset').toBeLessThanOrEqual(0.3);
    });

    // Parcels switch off below a zoom, and a whole-plan highlight is exactly the zoomed-out case. A
    // highlight that can only resolve LOADED PARCEL LAYERS therefore paints almost nothing at the
    // zoom where it is wanted: on a 298-member plan it drew a handful of scattered shapes, the ones
    // whose geometry happens to be self-contained.
    it('highlights the proposal\'s OWN geometry, not the parcels under it', () => {
        const build = sourceSection(panelFn, 'const buildPlanOverlay = (key)', 'const syncPlanOverlay = (key)');
        expect(build).toContain('const body = proposalBodyFeaturesFor(proposal);');
        // Body first. Ground is the hover treatment — it answers "what does this stand on", which is
        // a different question and a much worse shape here: the rail track has no child parcels, so
        // its ground came out as twelve 0-4 px fragments against a 472x155 px corridor.
        expect(build).toContain('(body && body.length)');
        expect(build).toMatch(/\?\s*body\s*\n\s*:\s*groundFeaturesFor\(/);
        expect(build, 'an empty resolve must not abandon the proposal')
            .not.toMatch(/const features = groundFeaturesFor\([^)]*\);\s*\n\s*if \(!features\.length\) return;/);
    });

    // An upload changes only which treatment a proposal wears and which group it sits in. Rebuilding
    // its layer would throw away geometry that did not change.
    it('restyles and moves a layer on upload instead of rebuilding it', () => {
        const sync = sourceSection(panelFn, 'const syncPlanOverlay = (key)', 'const applyHighlightMode');
        expect(sync).toContain('existing.layer.setStyle(overlayStyleFor(');
        expect(sync).toContain('overlayGroups[bucket].addLayer(existing.layer)');
        expect(sync, 'syncPlanOverlay still rebuilds geometry for an existing layer')
            .not.toContain('groundFeaturesFor(');
    });

    it('rows highlight on hover/click and never open details', () => {
        expect(panelFn).toContain("row.addEventListener('mouseenter', () => highlightRowProposal(key));");
        expect(panelFn).toContain('frameRowProposal(key);');
        expect(panelFn).not.toContain('selectAndHighlightProposal(');
        expect(panelFn).not.toContain('showProposalDetails(');
    });

    it('hovering a row tells the proposal apart from the ground it stands on', () => {
        // One colour for both made a hovered building unreadable among its neighbours' boundaries:
        // the body (footprint/corridor/park) and the parcels are painted as two groups now.
        const hoverFn = sourceSection(panelFn, 'const highlightRowProposal = (key)', 'const frameRowProposal');
        expect(hoverFn).toContain('highlightFeatureGroupsForHover([');
        expect(hoverFn).toContain('features: parcelFeatures');
        expect(hoverFn).toContain('features: bodyFeatures');
        // Body last — later groups draw on top (see highlightFeatureGroupsForHover).
        expect(hoverFn.indexOf('features: parcelFeatures')).toBeLessThan(hoverFn.indexOf('features: bodyFeatures'));

        const colorOf = (name) => {
            const match = dialogShare.match(new RegExp(`const ${name} = '([^']+)'`));
            expect(match, `missing colour constant: ${name}`).toBeTruthy();
            return match[1];
        };
        expect(colorOf('SHARE_PLAN_HOVER_PARCEL_COLOR')).not.toBe(colorOf('SHARE_PLAN_HOVER_BODY_COLOR'));
        expect(hoverFn).toContain('SHARE_PLAN_HOVER_PARCEL_COLOR');
        expect(hoverFn).toContain('SHARE_PLAN_HOVER_BODY_COLOR');

        // The body comes from the proposal's OWN geometry, never from the parcels under it.
        expect(panelFn).toContain('collectProposalFeatureSets(proposal, { includeBuildingGeometry: true })');
        // The grouped painter clears once and keeps every group (contract in
        // proposal-hover-groups.test.js) — the share panel relies on both groups surviving.
        expect(layerRender).toContain('function highlightFeatureGroupsForHover(featureGroups)');
    });

    it('locks every fabric interaction surface while open', () => {
        // Selection/edit gate shared by many surfaces.
        expect(sourceSection(mapEditLock, 'function blocksSelection()', 'const api'))
            .toContain('if (global.sharePlanMode) return true;');
        // Parcel hover.
        expect(sourceSection(parcelHover, 'function highlightFeature(e)', 'clearPreviousHover'))
            .toContain('if (global.sharePlanMode) return;');
        // Parcel click (incl. applied proposals under the click).
        expect(sourceSection(parcelClick, 'function onParcelClick(e)', 'proposalListBrowseMode'))
            .toContain('if (global.sharePlanMode) {');
        // Drill: both the fallback block list and the direct structure-surface entry.
        expect(sourceSection(drillUi, 'function interactionBlocked()', 'let hoverPending'))
            .toContain('if (global.sharePlanMode) return true;');
        expect(sourceSection(drillUi, 'function handleSurfaceClick(latlng)', 'const stack'))
            .toContain('if (global.sharePlanMode) return false;');
        // The one funnel every proposal-opening surface goes through.
        expect(sourceSection(layerRender, 'function selectAndHighlightProposal(', 'const resolvedId'))
            .toContain('if (window.sharePlanMode) return;');
    });

    it('disables the chrome but keeps zoom, via CSS lockdown', () => {
        expect(proposalsCss).toContain('body.share-plan-mode #sidebar');
        expect(proposalsCss).toContain('body.share-plan-mode .map-mode-toggle');
        const zoomRule = sourceSection(proposalsCss,
            'body.share-plan-mode .leaflet-control-container .leaflet-control-zoom', '}');
        expect(zoomRule).toContain('pointer-events: auto');
    });

    it('pads map fits by the share panel footprint', () => {
        expect(sourceSection(listUi, 'function getProposalPanelFitPadding(', 'function fitMapToAppliedProposals'))
            .toContain(".share-plan-panel-content");
        expect(sourceSection(listUi, 'function fitMapToAppliedProposals(', 'function updateProposalList'))
            .toContain('getProposalPanelFitPadding(40)');
    });
});
