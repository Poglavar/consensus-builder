import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionsSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/parcels/ui/proposal-actions.js'),
    'utf8'
);
const listUiSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/proposals/list-ui.js'),
    'utf8'
);
const reparcelSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/proposals/reparcel.js'),
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
    it('renders transport icons with full station labels, followed by a separate Ownership group', () => {
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
        expect(html.match(/data-station-type=/g)).toHaveLength(4);
        expect(html).toContain('data-station-type="bus"');
        expect(html).toContain('data-station-type="tram"');
        expect(html).toContain('data-station-type="underground"');
        expect(html).toContain('data-station-type="elevated"');
        expect(html).toContain('Bus station');
        expect(html).toContain('Tram station');
        expect(html).toContain('Metro station');
        expect(html).toContain('Elevated station');
        expect(html).toContain('parcel-ownership-group');
        expect(html.indexOf('parcel-transport-group')).toBeLessThan(html.indexOf('parcel-ownership-group'));
        expect(html.indexOf('parcel-ownership-group')).toBeLessThan(html.indexOf('parcel-build-btn--offer'));
    });

    it('routes transport palette icons to the existing corridor and station tools', () => {
        const requestRoadDrawTool = vi.fn();
        const requestTrackDrawTool = vi.fn();
        const startTransitStationPlacement = vi.fn();
        const window = loadActions({
            requestRoadDrawTool,
            requestTrackDrawTool,
            startTransitStationPlacement
        });

        window.startParcelTransportTool('road');
        window.startParcelTransportTool('track');
        window.startParcelTransportTool('bus');
        window.startParcelTransportTool('tram');
        window.startParcelTransportTool('underground');
        window.startParcelTransportTool('elevated');

        expect(requestRoadDrawTool).toHaveBeenCalledOnce();
        expect(requestTrackDrawTool).toHaveBeenCalledOnce();
        expect(startTransitStationPlacement.mock.calls).toEqual([
            ['bus'], ['tram'], ['underground'], ['elevated']
        ]);
    });

    it('defines one goal policy for block-scale creation and excludes exact-parcel proposals', () => {
        const window = loadActions();

        ['buildings', 'row', 'parcelBased', 'single', 'reparcellization', 'park', 'square', 'lake', 'urban-rule']
            .forEach(goal => expect(window.shouldSuggestWholeBlockForFreshProposal(goal)).toBe(true));
        ['offer', 'road-track', 'ownership-transfer', 'as-is', 'decide-later']
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

    it('stops the one-parcel launch after accepting and selecting the block', async () => {
        const animateFloodfillFromSelected = vi.fn(async () => true);
        const window = loadActions({
            detectBlockParcelIdsForParcel: vi.fn(() => ({ count: 16, parcelIds: [] })),
            showStyledConfirm: vi.fn(async () => true),
            animateFloodfillFromSelected
        });

        await expect(window.maybeSuggestWholeBlockForFreshProposal('row', ['parcel-1'])).resolves.toBe(true);
        expect(animateFloodfillFromSelected).toHaveBeenCalledOnce();
    });

    it('runs the same preflight when Detached is launched from the classic proposal dialog', async () => {
        const maybeSuggestWholeBlockForFreshProposal = vi.fn(async () => true);
        const openParcelBasedForParcels = vi.fn();
        const context = {
            console,
            window: null,
            document: {},
            selectedParcelId: 'parcel-1',
            currentParcel: { layer: { feature: {} } },
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
            document: {},
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

    it('covers classic Freeform, Row, and structure launchers with the same preflight', async () => {
        const maybeSuggestWholeBlockForFreshProposal = vi.fn(async () => true);
        const openSingleBuildingForParcels = vi.fn();
        const openRowHouseForParcels = vi.fn();
        const showStructureProposalDialog = vi.fn();
        const context = {
            console,
            window: null,
            document: {},
            selectedParcelId: 'parcel-1',
            currentParcel: { layer: { feature: {} } },
            maybeSuggestWholeBlockForFreshProposal,
            openSingleBuildingForParcels,
            openRowHouseForParcels,
            showStructureProposalDialog,
            updateStatus: vi.fn()
        };
        context.window = context;
        vm.runInNewContext(listUiSource, context);

        await context.launchSingleBuildingToolForSelection();
        await context.launchRowHouseToolForSelection();
        await context.launchStructureToolForSelection('park');

        expect(maybeSuggestWholeBlockForFreshProposal.mock.calls).toEqual([
            ['single', ['parcel-1']],
            ['row', ['parcel-1']],
            ['park', ['parcel-1']]
        ]);
        expect(openSingleBuildingForParcels).not.toHaveBeenCalled();
        expect(openRowHouseForParcels).not.toHaveBeenCalled();
        expect(showStructureProposalDialog).not.toHaveBeenCalled();
    });

    it('covers the classic Block editor and no-editor public-space choice', async () => {
        const shouldStopFreshProposalForWholeBlock = vi.fn(async () => true);
        const openUrbanRuleForParcels = vi.fn();
        const context = {
            console,
            window: null,
            document: {},
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

    it('runs the same preflight when land readjustment is launched from the classic proposal dialog', async () => {
        const shouldStopFreshProposalForWholeBlock = vi.fn(async () => true);
        const context = {
            console,
            window: null,
            document: { getElementById: vi.fn(() => null) },
            currentOwnershipMode: 'multiple',
            currentProposalTool: null,
            getCurrentParcelSelectionContext: vi.fn(() => ({ ids: ['parcel-1'], layers: [{}] })),
            shouldStopFreshProposalForWholeBlock
        };
        context.window = context;
        vm.runInNewContext(reparcelSource, context);

        await expect(context.handleReparcellizationAlgorithmClick('sweep-line')).resolves.toBe(false);

        expect(shouldStopFreshProposalForWholeBlock).toHaveBeenCalledWith(
            'reparcellization', { ids: ['parcel-1'], layers: [{}] }
        );
        expect(context.currentProposalTool).toBeNull();
    });
});
