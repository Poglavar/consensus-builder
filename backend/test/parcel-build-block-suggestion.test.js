import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The palette's "is there a parcel context" predicate lives in the parcel menu model (shared with
// the menu's "Offer my land"); in the page it is a global loaded before the palette runs.
const ParcelMenuModel = createRequire(import.meta.url)('../../frontend/js/ui/parcel-menu-model.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const actionsSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/parcels/ui/proposal-actions.js'),
    'utf8'
);
const listUiSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/proposals/list-ui.js'),
    'utf8'
);
const urbanRulesSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/proposals/urban-rules.js'),
    'utf8'
);
const geometrySource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/proposals/geometry.js'),
    'utf8'
);

function loadActions(overrides = {}) {
    const window = {
        document: { querySelector: vi.fn(() => null), getElementById: vi.fn(() => null) },
        console,
        ParcelMenuModel,
        LiveParcelFabric: { get: id => ({ id: String(id) }) },
        ...overrides
    };
    window.window = window;
    vm.runInNewContext(actionsSource, {
        window,
        globalThis: window,
        document: window.document,
        console
    });
    return window;
}

describe('whole-block fresh-proposal suggestion', () => {
    it('marks only Row houses unavailable for one parcel and enables it for two', () => {
        const window = loadActions();
        const one = window.buildProposalPaletteHtml({ selectionCount: 1 });
        const buttons = [...one.matchAll(/<button\b[\s\S]*?<\/button>/g)].map(match => match[0]);
        const unavailable = buttons.filter(button => button.includes('aria-disabled="true"'));
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]).toContain('parcel-build-btn--row');
        expect(unavailable[0]).not.toMatch(/\sdisabled(?:\s|>)/);
        expect(unavailable[0]).toContain('Select another parcel or use Detect block.');
        expect(unavailable[0]).toContain('aria-describedby="parcel-row-selection-hint"');
        expect(window.buildProposalPaletteHtml({ selectionCount: 2 })).not.toContain('aria-disabled="true"');
        // Site palettes keep their own explicit restrictions and do not inherit parcel counts.
        expect(window.buildProposalPaletteHtml()).not.toContain('aria-disabled="true"');
        expect(window.buildProposalPaletteHtml({ disabled: { row: 'Choose a frontage first.' } }))
            .toContain(' disabled aria-disabled="true"');
    });

    it.each([false, true])('a one-parcel Row request guides selection without launching or leaving active mode (%s)', async active => {
        const selectedParcels = new Set(['parcel-1']);
        const multi = { isActive: active, selectedParcels, toggle: vi.fn(() => { multi.isActive = true; }), showSelectionInPanel: vi.fn() };
        const startInstantProposalDesign = vi.fn(), showStyledConfirm = vi.fn(), showEphemeralMessage = vi.fn();
        const window = loadActions({ currentParcel: { id: 'parcel-1' }, multiParcelSelection: multi,
            startInstantProposalDesign, showStyledConfirm, showEphemeralMessage });
        await window.startParcelBuildTool('row');
        expect(multi.isActive).toBe(true);
        expect([...selectedParcels]).toEqual(['parcel-1']);
        expect(multi.toggle).toHaveBeenCalledTimes(active ? 0 : 1);
        expect(multi.showSelectionInPanel).toHaveBeenCalledOnce();
        expect(showEphemeralMessage).toHaveBeenCalledWith(expect.stringContaining('Select another parcel'), 4000, 'info');
        expect(startInstantProposalDesign).not.toHaveBeenCalled();
        expect(showStyledConfirm).not.toHaveBeenCalled();
    });

    it('launches Row houses once two parcels are selected', async () => {
        const startInstantProposalDesign = vi.fn();
        const window = loadActions({ multiParcelSelection: { isActive: true, selectedParcels: new Set(['a', 'b']) }, startInstantProposalDesign });
        await window.startParcelBuildTool('row');
        expect(startInstantProposalDesign).toHaveBeenCalledWith('row', ['a', 'b']);
    });

    it('renders transport icons with full station labels, and no Ownership group (M2: owner offers are gone)', () => {
        const container = { innerHTML: '' };
        const document = {
            querySelector: vi.fn(() => null),
            getElementById: vi.fn(id => id === 'parcel-proposal-primary-actions' ? container : null)
        };
        const window = loadActions({
            document,
            currentParcel: { id: 'parcel-1' },
            CityConfigManager: { isFeatureEnabled: vi.fn(() => true) }
        });

        window.renderParcelProposalActions();

        const html = container.innerHTML;
        expect(html).toContain('parcel-transport-group');
        expect(html).toContain('parcel-transport-grid');
        expect(html).toContain('parcel-transport-btn--road');
        expect(html).toContain('parcel-transport-btn--track');
        expect(html.match(/data-station-type=/g)).toHaveLength(2);
        expect(html).toContain('data-station-type="bus"');
        expect(html).toContain('data-station-type="track"');
        expect(html).toContain('Road station');
        expect(html).toContain('Track station');
        expect(html).not.toContain('Tram station');
        expect(html).not.toContain('Metro station');
        expect(html).not.toContain('parcel-ownership-group');
        expect(html).not.toContain('parcel-build-btn--offer');
        // Transport follows the construction tools and parcel-layout section.
        expect(html.indexOf('parcel-build-btn--park')).toBeGreaterThan(-1);
        expect(html.indexOf('parcel-build-btn--park')).toBeLessThan(html.indexOf('parcel-transport-group'));
    });

    it('offers structures, rules, parcel layout and transport, and opens the layout tool', async () => {
        const container = { innerHTML: '' };
        const document = {
            querySelector: vi.fn(() => null),
            getElementById: vi.fn(id => id === 'parcel-proposal-primary-actions' ? container : null)
        };
        const startInstantProposalDesign = vi.fn(async () => true);
        const window = loadActions({ document, currentParcel: { id: 'parcel-1' }, startInstantProposalDesign });

        window.renderParcelProposalActions();
        const html = container.innerHTML;
        expect(html).toContain('parcel-build-btn--parcel-layout');
        expect(html).toContain('Lay out parcels');
        expect(html).not.toContain('parcel-build-btn--reparcellization');
        expect([...html.matchAll(/<section class="(parcel-[\w-]+-group)">/g)].map(match => match[1]))
            .toEqual(['parcel-structures-group', 'parcel-rules-group', 'parcel-layout-group', 'parcel-transport-group']);
        expect(html.indexOf('parcel-build-btn--parcel-layout')).toBeGreaterThan(html.indexOf('parcel-layout-group'));

        await window.startParcelBuildTool('parcel-layout');
        expect(startInstantProposalDesign).toHaveBeenCalledWith('parcel-layout', ['parcel-1']);
    });

    it('routes transport palette icons to the existing corridor and station tools', () => {
        const requestRoadDrawTool = vi.fn();
        const requestTrackDrawTool = vi.fn();
        const startTransitStationPlacement = vi.fn();
        const chooseTrackStationType = vi.fn();
        const window = loadActions({
            requestRoadDrawTool,
            requestTrackDrawTool,
            startTransitStationPlacement,
            chooseTrackStationType
        });

        window.startParcelTransportTool('road');
        window.startParcelTransportTool('track');
        window.startParcelTransportTool('roadStation');
        window.startParcelTransportTool('trackStation');

        expect(requestRoadDrawTool).toHaveBeenCalledOnce();
        expect(requestTrackDrawTool).toHaveBeenCalledOnce();
        expect(startTransitStationPlacement).toHaveBeenCalledExactlyOnceWith('bus');
        expect(chooseTrackStationType).toHaveBeenCalledOnce();
    });

    it('defines one goal policy for block-scale creation and excludes exact-parcel proposals', () => {
        const window = loadActions();

        ['buildings', 'row', 'parcelBased', 'single', 'parcel-layout', 'park', 'square', 'lake', 'urban-rule']
            .forEach(goal => expect(window.shouldSuggestWholeBlockForFreshProposal(goal)).toBe(true));
        ['offer', 'road-track', 'ownership-transfer', 'as-is']
            .forEach(goal => expect(window.shouldSuggestWholeBlockForFreshProposal(goal)).toBe(false));
    });

    it('offers every detected block, including blocks larger than the old hidden cutoff', async () => {
        const showStyledConfirm = vi.fn(async () => false);
        const window = loadActions({
            detectBlockParcelIdsForParcel: vi.fn(() => ({ count: 81, parcelIds: [] })),
            showStyledConfirm
        });

        await expect(window.maybeSuggestWholeBlockForFreshProposal('row', ['parcel-1'])).resolves.toBe(false);
        expect(showStyledConfirm).toHaveBeenCalledOnce();
        expect(showStyledConfirm.mock.calls[0][0]).toContain('81');
    });

    it.each([null, { count: 1, parcelIds: ['parcel-1'] }])('still offers block detection when silent detection returns %s', async block => {
        const showStyledConfirm = vi.fn(async () => false);
        const window = loadActions({ detectBlockParcelIdsForParcel: () => block, showStyledConfirm });
        await expect(window.maybeSuggestWholeBlockForFreshProposal('block', ['parcel-1'])).resolves.toBe(false);
        expect(showStyledConfirm).toHaveBeenCalledOnce();
        expect(showStyledConfirm.mock.calls[0][0]).toContain('detect the whole block');
    });

    it('stops the one-parcel launch after accepting and selecting the block', async () => {
        const animateFloodfillFromSelected = vi.fn(async () => true);
        const window = loadActions({
            detectBlockParcelIdsForParcel: vi.fn(() => ({ count: 16, parcelIds: [] })),
            showStyledConfirm: vi.fn(async () => true),
            animateFloodfillFromSelected
        });

        await expect(window.maybeSuggestWholeBlockForFreshProposal('row', ['parcel-1'])).resolves.toBe(true);
        expect(animateFloodfillFromSelected).toHaveBeenCalledWith({ replaceSelection: true });
    });

    it('opens the build palette for the selected block after accepting', async () => {
        // Selection changes no longer open the parcel panel; without this the user is left with
        // only the selection tray and no palette after answering "Yes, select the block".
        const showSelectionInPanel = vi.fn();
        const switchParcelTab = vi.fn();
        const multiParcelSelection = { isActive: false, selectedParcels: new Set(), showSelectionInPanel };
        const window = loadActions({
            detectBlockParcelIdsForParcel: vi.fn(() => ({ count: 3, parcelIds: [] })),
            showStyledConfirm: vi.fn(async () => true),
            animateFloodfillFromSelected: vi.fn(async () => {
                multiParcelSelection.isActive = true;
                ['a', 'b', 'c'].forEach(id => multiParcelSelection.selectedParcels.add(id));
            }),
            multiParcelSelection,
            switchParcelTab
        });

        await window.maybeSuggestWholeBlockForFreshProposal('buildings', ['a']);
        expect(showSelectionInPanel).toHaveBeenCalledOnce();
        expect(switchParcelTab).toHaveBeenCalledWith(null, 'propose-tab');
    });

    it('runs the same preflight when Detached is launched from the classic proposal dialog', async () => {
        const maybeSuggestWholeBlockForFreshProposal = vi.fn(async () => true);
        const openParcelBasedForParcels = vi.fn();
        const layer = { feature: {} };
        const context = {
            console,
            window: null,
            document: { addEventListener() { } },   // list-ui.js listens for the sheet events at load
            selectedParcelId: 'parcel-1',
            currentParcel: { layer },
            LiveParcelFabric: { get: vi.fn(() => layer.feature) },
            ParcelPresenter: { getLayer: vi.fn(() => layer) },
            maybeSuggestWholeBlockForFreshProposal,
            openParcelBasedForParcels,
            updateStatus: vi.fn()
        };
        context.window = context;
        vm.runInNewContext(listUiSource, context);

        await context.launchParcelBasedToolForSelection();

        expect(maybeSuggestWholeBlockForFreshProposal).toHaveBeenCalledWith('parcelBased', ['parcel-1']);
        expect(openParcelBasedForParcels).not.toHaveBeenCalled();
    });

    it('closes a fresh classic dialog after block selection and skips copied proposal scopes', async () => {
        const maybeSuggestWholeBlockForFreshProposal = vi.fn(async () => true);
        const closeProposalDialog = vi.fn();
        const context = {
            console,
            window: null,
            document: { addEventListener() { } },   // list-ui.js listens for the sheet events at load
            maybeSuggestWholeBlockForFreshProposal,
            closeProposalDialog
        };
        context.window = context;
        vm.runInNewContext(listUiSource, context);

        await expect(context.shouldStopFreshProposalForWholeBlock(
            'row', { ids: ['parcel-1'], layers: [{}] }
        )).resolves.toBe(true);
        expect(closeProposalDialog).toHaveBeenCalledOnce();

        context.pendingProposalCopySource = { proposalId: 'source-1' };
        await expect(context.shouldStopFreshProposalForWholeBlock(
            'row', { ids: ['parcel-1'], layers: [{}] }
        )).resolves.toBe(false);
        expect(maybeSuggestWholeBlockForFreshProposal).toHaveBeenCalledOnce();
    });

    it('covers classic Freeform and Row launchers with the same preflight', async () => {
        const maybeSuggestWholeBlockForFreshProposal = vi.fn(async () => true);
        const openSingleBuildingForParcels = vi.fn();
        const openRowHouseForParcels = vi.fn();
        const layer = { feature: {} };
        const context = {
            console,
            window: null,
            document: { addEventListener() { } },   // list-ui.js listens for the sheet events at load
            selectedParcelId: 'parcel-1',
            currentParcel: { layer },
            LiveParcelFabric: { get: vi.fn(() => layer.feature) },
            ParcelPresenter: { getLayer: vi.fn(() => layer) },
            maybeSuggestWholeBlockForFreshProposal,
            openSingleBuildingForParcels,
            openRowHouseForParcels,
            updateStatus: vi.fn()
        };
        context.window = context;
        vm.runInNewContext(listUiSource, context);

        await context.launchSingleBuildingToolForSelection();
        await context.launchRowHouseToolForSelection();

        expect(maybeSuggestWholeBlockForFreshProposal.mock.calls).toEqual([
            ['single', ['parcel-1']],
            ['row', ['parcel-1']]
        ]);
        expect(openSingleBuildingForParcels).not.toHaveBeenCalled();
        expect(openRowHouseForParcels).not.toHaveBeenCalled();
    });

    it('covers the classic Block editor and no-editor public-space choice', async () => {
        const shouldStopFreshProposalForWholeBlock = vi.fn(async () => true);
        const openUrbanRuleForParcels = vi.fn();
        const context = {
            console,
            window: null,
            document: { addEventListener() { } },   // list-ui.js listens for the sheet events at load
            getCurrentParcelSelectionContext: vi.fn(() => ({ ids: ['parcel-1'], layers: [{}] })),
            shouldStopFreshProposalForWholeBlock,
            openUrbanRuleForParcels,
            updateStatus: vi.fn()
        };
        context.window = context;
        vm.runInNewContext(urbanRulesSource, context);

        await context.launchUrbanRuleToolForSelection();
        await context.selectFreshProposalLandUse('square');

        expect(shouldStopFreshProposalForWholeBlock).toHaveBeenNthCalledWith(
            1, 'urban-rule', { ids: ['parcel-1'], layers: [{}] }
        );
        expect(shouldStopFreshProposalForWholeBlock).toHaveBeenNthCalledWith(2, 'square');
        expect(openUrbanRuleForParcels).not.toHaveBeenCalled();
    });

    it('does not mark classic geometry submitted when block selection stops the editor launch', async () => {
        const setGeometryStatus = vi.fn();
        const context = {
            console,
            window: {},
            currentGeometryGoal: 'single',
            getProposalI18nHelper: vi.fn(() => (_key, fallback) => fallback),
            getRoadDesignationTranslator: vi.fn(() => (_key, fallback) => fallback),
            launchSingleBuildingToolForSelection: vi.fn(async () => false),
            setGeometryStatus,
            updateCreateProposalSubmitState: vi.fn()
        };
        vm.runInNewContext(geometrySource, context);

        await context.handleGeometryAction('edit');

        expect(context.launchSingleBuildingToolForSelection).toHaveBeenCalledOnce();
        expect(setGeometryStatus).not.toHaveBeenCalled();
    });
});
