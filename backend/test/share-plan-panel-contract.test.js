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
        expect(closeFn).toContain('map.removeLayer(state.overlayGroup)');
        // A failed open must not leave the map locked.
        expect(panelFn).toContain('try { closeSharePlanPanel(); } catch (_) { }');
    });

    it('paints checked proposals and unpaints unchecked ones', () => {
        expect(panelFn).toContain('const syncPlanOverlay = (key)');
        expect(panelFn).toContain('if (!selected.has(key)) return;');
        const checkboxChange = sourceSection(panelFn, 'const onCheckboxChange =', 'const attachRow =');
        expect(checkboxChange).toContain('syncPlanOverlay(key)');
        // Every proposal starts checked and painted.
        expect(panelFn).toContain('proposalsByHash.forEach((_, key) => syncPlanOverlay(key));');
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
