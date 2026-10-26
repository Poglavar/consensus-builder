// Integration contract for the Share Plan panel: it is a right-docked PANEL (not a modal) that picks
// on the map through js/map-pick.js (MapPick 'share', plan-design-agreement.md "M3 notes"): the map is
// pan/zoom only, every fabric surface is inert while a surface picks, and the checked designs of the
// chosen subset are painted in MapPick's highlight pane while the rest of the map dims. MapPick itself
// (the lockdown classes, the highlight built once per design, the slices, the shapes) is exercised in
// map-pick.test.js; these greps lock the wiring that spans several files, so a guard cannot silently
// drop out of one of them. Since M2 a row publishes its design (DesignSync.publishDesign) and the link
// names the selection by CID.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const dialogShare = read('../../frontend/js/proposals/dialog-share.js');
const sharingRoutes = read('../../frontend/js/proposals/sharing-routes.js');
const mapPick = read('../../frontend/js/map-pick.js');
const mapEditLock = read('../../frontend/js/map-edit-lock.js');
const parcelHover = read('../../frontend/js/parcels/selection.js');
const parcelClick = read('../../frontend/js/parcels/ui/parcel-selection.js');
const drillUi = read('../../frontend/js/proposals/drill-ui.js');
const clickStackPanel = read('../../frontend/js/click-stack/click-stack-panel.js');
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
    const panelFn = sourceSection(dialogShare, 'function showSharePlanPanel(', 'function showSimpleShareModal(');
    const closeFn = sourceSection(dialogShare, 'function closeSharePlanPanel(', 'function showSharePlanPanel');
    const begin = sourceSection(panelFn, 'window.MapPick.begin({', '}).catch(');
    const fill = sourceSection(panelFn, '(async () => {', "const diagnostic = window.AppDiagnostics?.report(error, { code: 'share-failed'");

    it('opens as a right-docked panel, never through the share modal', () => {
        expect(panelFn).toContain("panelRoot.className = 'share-plan-panel share-plan-panel--embedded'");
        expect(panelFn).toContain("panelContent.className = 'share-plan-panel-content'");
        // Empty maps share their location in the same panel.
        expect(panelFn).not.toContain('showSimpleShareModal(');
        expect(panelFn).toContain("document.getElementById('designs-share').replaceChildren(panelRoot)");
        // The panel replaced the modal entirely — no share-plan modal entry point remains.
        expect(dialogShare).not.toContain('function showSharePlanModal');
        expect(sharingRoutes).toContain('showSharePlanPanel(');
    });

    it('picks on the map as "share" while open, and ends exactly its own pick mode on close', () => {
        expect(begin).toContain("name: 'share'");
        // Another surface beginning (the agreement editor) closes the panel the panel's own way.
        expect(begin).toContain('close: closeSharePlanPanel');
        expect(closeFn).toContain("window.MapPick.end('share')");
        // The lockdown lives in one place: the panel no longer flags a mode of its own.
        expect(dialogShare).not.toContain('sharePlanMode');
        expect(dialogShare).not.toContain("classList.add('share-plan-mode')");
        // A failed open must not leave the map locked.
        expect(panelFn).toContain('try { closeSharePlanPanel(); } catch (_) { }');
    });

    it('paints a design when its row is toggled, and only checked designs', () => {
        // The highlight is the CHECKED designs of the chosen subset; All highlights nothing.
        expect(begin).toContain('highlight: highlightedKeys');
        const highlighted = sourceSection(panelFn, 'const highlightedKeys = () =>', 'const applyHighlightMode');
        expect(highlighted).toContain("highlightMode === 'all'");
        expect(highlighted).toContain('[...selected].filter(');
        // A toggled row repaints that row only.
        const checkboxChange = sourceSection(panelFn, 'const onCheckboxChange =', 'const publishRow =');
        expect(checkboxChange).toContain('updateRowState(key)');
        expect(sourceSection(panelFn, 'const updateRowState = (key) => {', 'const onCheckboxChange =')).toContain('window.MapPick.refresh([key]);');
    });

    it('draws NOTHING when the panel opens', () => {
        // Opening a list is not a request to draw three hundred overlays. It cost seconds of turf and
        // Leaflet work before the panel was usable, and left the map unreadable under the whole plan.
        // The panel opens on "All", whose highlight is none (MapPick then draws and dims nothing), and
        // the fill repaints row by row only through updateRowState, which builds nothing under "All".
        expect(panelFn).toContain("let highlightMode = 'all';");
        expect(fill).not.toContain("'proposals.share.panel.drawing'");
        expect(fill).not.toContain('MapPick.refresh()');
        // Two passes in the fill — the rows, then each row's publication state.
        expect(fill.match(/if \(!await inChunks\(/g) || []).toHaveLength(2);
    });

    it('knows which designs are published from their own CIDs, asking no server', () => {
        // A design reads as published while it hashes to the CID it was published as at this index
        // (DesignSync.publishedCid). The city-scoped server listing this replaced missed designs it
        // did not cover and offered to upload them a second time.
        expect(fill).toContain('const cid = window.DesignSync.publishedCid(proposal);');
        expect(panelFn).not.toMatch(/\bfetch\(/);
        // The link waits for every selected design to be published, then names them by CID.
        const link = sourceSection(panelFn, 'const updateShareUrl = () => {', 'const updateRowState =');
        expect(link).toContain('if (cids.length !== selectedKeys.length) {');
        expect(link).toContain('window.MapShare.link(window.DesignSync.designLink(cids), shareView)');
    });

    it('publishes a row through DesignSync and never a parcel layout', () => {
        // A layout is published with the agreement that settles its land (ProposalPublishTerms.publishRefusal).
        expect(panelFn).toContain('const refusal = cid ? null : window.ProposalPublishTerms.publishRefusal(proposal);');
        expect(panelFn).toContain('window.ShareSelection.prepare(applied, {');
        const publish = sourceSection(panelFn, 'const publishRow = async (key) => {', 'const attachRow =');
        expect(publish).toContain('if (!proposal || publishRefusals.has(key)) return;');
        expect(publish).toContain('await window.DesignSync.publishDesign(proposal);');
    });

    it('offers the subset highlight as All/Published/Not published yet, starting on All', () => {
        // Hovering rows one at a time answers "is THIS one published"; it cannot answer "which of my
        // three hundred are". The filter can, in the treatments the legend defines.
        expect(panelFn).toContain("{ value: 'all', key: 'modal.roadWidth.share.plan.filterAll'");
        expect(panelFn).toContain("{ value: 'published', key: 'proposals.share.panel.filterPublished'");
        expect(panelFn).toContain("{ value: 'pending', key: 'proposals.share.panel.filterPending'");
        // A large highlight is drawn in slices by MapPick, reporting its progress in the panel.
        expect(begin).toContain("onProgress: (done, total) => showProgress('proposals.share.panel.drawing'");
    });

    // The property that makes the filter usable at all: flipping between subsets must not redo the
    // geometry. MapPick builds each design's outline once and keeps it while the mode lasts.
    it('switches subsets by repainting the pick highlight, never by resolving geometry itself', () => {
        const apply = sourceSection(panelFn, 'const applyHighlightMode', 'const setHighlightMode');
        expect(apply).toContain('await window.MapPick.refresh();');
        for (const resolver of ['groundFeaturesFor(', 'proposalFeaturesFor(', 'outlineOf(', 'L.geoJSON(']) {
            expect(apply, `the mode switch resolves geometry: ${resolver}`).not.toContain(resolver);
        }
        // The panel draws no overlay layers of its own any more.
        expect(panelFn).not.toContain('overlayGroups');
        expect(panelFn).not.toContain('buildPlanOverlay');
    });

    // Painting the subset ON TOP of the base drawing answered nothing: the whole city is already
    // drawn, so "Not published yet" looked like "All" with one more shape in it. Choosing a subset
    // has to push everything else back.
    it('dims everything that is not the highlight, by Leaflet pane structure', () => {
        // MapPick sets body.map-pick-highlighting while a surface highlights designs, in its own pane.
        expect(mapPick).toContain("const HIGHLIGHTING_CLASS = 'map-pick-highlighting';");
        expect(mapPick).toContain("const PANE = 'pick-highlight';");
        // A rule listing pane names leaves the next fabric pane as the one thing still bright.
        const rule = proposalsCss.slice(proposalsCss.indexOf('body.map-pick-highlighting .leaflet-map-pane'));
        expect(rule.slice(0, 260)).toContain(':not(.leaflet-tile-pane)');
        expect(rule.slice(0, 260)).toContain(':not(.leaflet-pick-highlight-pane)');
        const dim = Number((rule.slice(0, 260).match(/opacity:\s*var\(--map-pick-dim,\s*([\d.]+)\)/) || [])[1]);
        expect(dim, 'dimming too faint to separate the subset').toBeLessThanOrEqual(0.3);
        // The highlight pane is never a click target.
        expect(sourceSection(proposalsCss, '\n.leaflet-pick-highlight-pane {', '}')).toContain('pointer-events: none');
    });

    it('design buttons focus the map independently of the checkbox and never open details', () => {
        expect(panelFn).toContain("main.addEventListener('click', () => {");
        expect(panelFn).toContain('main.append(chip, text);');
        expect(panelFn).toContain('row.append(selection, main, actions);');
        expect(panelFn).not.toContain("row.addEventListener('mouseenter'");
        expect(panelFn).toContain('frameRowProposal(key);');
        expect(panelFn).not.toContain('selectAndHighlightProposal(');
        expect(panelFn).not.toContain('showProposalDetails(');
    });

    it('hovering a row tells the design apart from the ground it stands on, in the shapes the highlight draws', () => {
        // Shared yellow uses different geometry styles: the body and parcels remain two groups.
        const hoverFn = sourceSection(panelFn, 'const highlightRowProposal = (key)', 'const frameRowProposal');
        expect(hoverFn).toContain('const bodyFeatures = window.MapPick.bodyOf(proposal);');
        expect(hoverFn).toContain('const parcelFeatures = window.MapPick.groundOf(window.MapPick.parcelsOf(proposal), bodyFeatures);');
        expect(hoverFn).toContain('highlightFeatureGroupsForHover([');
        // Body last — later groups draw on top (see highlightFeatureGroupsForHover).
        expect(hoverFn.indexOf('features: parcelFeatures')).toBeLessThan(hoverFn.indexOf('features: bodyFeatures'));

        const colorOf = (name) => {
            const match = dialogShare.match(new RegExp(`const ${name} = ([^;]+);`));
            expect(match, `missing colour constant: ${name}`).toBeTruthy();
            return match[1];
        };
        expect(colorOf('SHARE_PLAN_HOVER_PARCEL_COLOR')).toBe('window.MapHighlight.color');
        expect(colorOf('SHARE_PLAN_HOVER_BODY_COLOR')).toBe('window.MapHighlight.color');
        expect(hoverFn).toContain('SHARE_PLAN_HOVER_PARCEL_COLOR');
        expect(hoverFn).toContain('SHARE_PLAN_HOVER_BODY_COLOR');
        // The body comes from the design's OWN geometry (MapPick.bodyOf), never from the parcels under it.
        expect(sourceSection(mapPick, 'function bodyOf(record)', 'function groundOf(')).toContain('collectProposalFeatureSets(record, { includeBuildingGeometry: true })');
        // The grouped painter clears once and keeps every group (contract in proposal-hover-groups.test.js).
        expect(layerRender).toContain('function highlightFeatureGroupsForHover(featureGroups)');
    });

    it('locks every fabric interaction surface while a surface picks', () => {
        // Selection/edit gate shared by many surfaces.
        expect(sourceSection(mapEditLock, 'function blocksSelection(', 'const api'))
            .toContain('try { if (global.MapPick?.active()) return true; } catch (_) { }');
        // Parcel hover.
        expect(sourceSection(parcelHover, 'function highlightFeature(e)', 'clearPreviousHover'))
            .toContain('if (global.MapPick?.active()) return;');
        // Parcel click (incl. applied designs under the click): handed to the picking surface.
        expect(sourceSection(parcelClick, 'function onParcelClick(e)', 'proposalListBrowseMode'))
            .toContain('if (global.MapPick?.active()) {');
        // Drill: the fallback block list (its hover and background click). Structure and corridor
        // clicks reach the click stack, whose pick-mode hand-off is executed in
        // click-stack-panel.test.js ("a surface picking designs").
        expect(sourceSection(drillUi, 'function interactionBlocked()', 'let hoverPending'))
            .toContain('if (global.MapPick?.active()) return true;');
        const stackClick = sourceSection(clickStackPanel, 'function handleClick(', 'const hits =');
        expect(stackClick).toContain('if (global.MapPick?.active()) {');
        expect(stackClick).toContain('if (top) global.MapPick.pick(top.key);');
        // The one funnel every proposal-opening surface goes through.
        expect(sourceSection(layerRender, 'function selectAndHighlightProposal(', 'const resolvedId'))
            .toContain('if (window.MapPick?.active()) return;');
    });

    it('disables the chrome but keeps zoom, via CSS lockdown', () => {
        expect(proposalsCss).toContain('body.map-pick-mode .map-shell-cluster');
        expect(proposalsCss).toContain('body.map-pick-mode .map-sheet');
        expect(proposalsCss).not.toContain('.game-pill'); // the simulation is inside a sheet now
        // The view strip's tiles (2D, 3D models, 3D aerial imagery) are .map-mode-tile.
        expect(proposalsCss).toContain('body.map-pick-mode .map-mode-tile');
        const zoomRule = sourceSection(proposalsCss,
            'body.map-pick-mode .leaflet-control-container .leaflet-control-zoom', '}');
        expect(zoomRule).toContain('pointer-events: auto');
        // The old share-only lockdown is gone with its mode.
        expect(proposalsCss).not.toContain('body.share-plan-mode');
    });

    it('pads map fits by the share panel footprint', () => {
        expect(sourceSection(listUi, 'function getProposalPanelFitPadding(', 'function fitMapToAppliedProposals'))
            .toContain(".share-plan-panel-content");
        expect(sourceSection(listUi, 'function fitMapToAppliedProposals(', 'function updateProposalList'))
            .toContain('getProposalPanelFitPadding(40)');
    });
});
