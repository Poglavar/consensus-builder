import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
const source = path => readFileSync(new URL(`../../frontend/js/${path}`, import.meta.url), 'utf8');
const mapCoreSource = source('map-core.js');
const structuresSource = source('structures.js');
const parcelSelectionSource = source('parcels/ui/parcel-selection.js');
const layerRenderSource = source('proposals/layer-render.js');
const claimsUiSource = source('proposals/claims-ui.js');
function functionSource(text, name) {
    const ast = parse(text, { sourceType: 'script' });
    let node = null;
    const visit = value => {
        if (!value || typeof value !== 'object' || node) return;
        if (value.type === 'FunctionDeclaration' && value.id?.name === name) { node = value; return; }
        Object.keys(value).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const child = value[key];
            if (Array.isArray(child)) child.forEach(visit); else visit(child);
        });
    };
    visit(ast);
    expect(node, `missing function ${name}`).toBeTruthy();
    return text.slice(node.start, node.end);
}
function proposalClickSource() {
    const ast = parse(layerRenderSource, { sourceType: 'script' });
    const matches = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ArrowFunctionExpression') {
            const body = layerRenderSource.slice(node.start, node.end);
            if (body.includes('focusProposalDetails(') && body.includes('stopPropagation')) matches.push(node);
        }
        Object.keys(node).forEach(key => {
            if (key === 'loc' || key === 'start' || key === 'end') return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(visit); else visit(value);
        });
    };
    visit(ast);
    const match = matches.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    expect(match, 'missing selected proposal surface click handler').toBeTruthy();
    return layerRenderSource.slice(match.start, match.end);
}
function event() {
    return { latlng: { lat: 1, lng: 2 }, originalEvent: {}, target: {} };
}
function parcelHandler({ drawing = false, mapPick = false, browse = false } = {}) {
    const stopped = vi.fn();
    const clickStack = vi.fn();
    const pick = vi.fn();
    const select = vi.fn();
    const layer = {};
    const proposal = { proposalId: 'design-1' };
    const context = vm.createContext({
        console,
        document: { addEventListener: vi.fn() },
        L: { DomEvent: { stopPropagation: stopped } },
        roadDrawingMode: drawing,
        measureMode: false,
        pinpointToolIsActive: () => false,
        isParcelDrawingModeActive: () => false,
        __mapEditLock: { isHeld: () => false },
        isStructureGeometryEditorActive: () => false,
        AreaMonitorPaint: { isActive: () => false },
        ParcelPresenter: { getIdForLayer: () => 'parcel-1', getLayer: () => layer },
        LiveParcelFabric: { get: () => ({ properties: {}, geometry: { type: 'Polygon', coordinates: [] } }) },
        ParcelEstimates: { consumeRemovalClick: () => false },
        proposalStorage: { getProposalsForParcel: () => [proposal] },
        isProposalApplied: () => true,
        getProposalKey: item => item.proposalId,
        multiParcelSelection: { isActive: false },
        MapPick: { active: () => mapPick, pick },
        __drillUi: { stackAt: () => [{ kind: 'proposal', proposal }] },
        proposalListBrowseMode: browse,
        selectAndHighlightProposal: select,
        ClickStack: { handleClick: clickStack },
        isRoadParcel: () => false,
        updateBlockButtonStates: vi.fn(),
        window: null
    });
    context.window = context;
    vm.runInContext(parcelSelectionSource, context);
    return { click: context.onParcelClick, stopped, clickStack, pick, select, layer };
}
function buildingHandler(drawing) {
    const stopped = vi.fn();
    const clickStack = vi.fn();
    const handlers = new Map();
    const panes = new Map();
    const context = vm.createContext({
        map: {
            getPane: name => panes.get(name),
            createPane(name) { const pane = {}; panes.set(name, pane); return pane; }
        },
        L: { DomEvent: { stopPropagation: stopped } },
        window: { roadDrawingMode: drawing, __mapEditLock: { isHeld: () => false }, ClickStack: { handleClick: clickStack } },
        buildingPoolFeatureKey: feature => feature.properties.id,
        buildingStyleForFeature: () => ({}),
        buildingRenderedLayersById: new Map()
    });
    const code = `${functionSource(mapCoreSource, 'buildingLayerOptions')}; buildingLayerOptions;`;
    const options = vm.runInContext(code, context)();
    options.onEachFeature({ properties: { id: 'w77765918' } }, { on: (name, handler) => handlers.set(name, handler) });
    return { click: handlers.get('click'), stopped, clickStack };
}
function structureHandler(drawing) {
    const stopped = vi.fn();
    const surfaceClick = vi.fn(() => true);
    const select = vi.fn();
    const handlers = new Map();
    const context = vm.createContext({
        window: { roadDrawingMode: drawing, cadastreViewActive: false, __mapEditLock: { isHeld: () => false },
            __drillUi: { handleSurfaceClick: surfaceClick }, selectAndHighlightProposal: select },
        L: { DomEvent: { stop: stopped } }
    });
    const binder = vm.runInNewContext(`${functionSource(structuresSource, 'bindStructureClaimClick')}; bindStructureClaimClick;`, context);
    binder({ on: (name, handler) => handlers.set(name, handler) }, { properties: { proposalId: 'park-1' } });
    return { click: handlers.get('click'), stopped, surfaceClick, select };
}
function selectedPreviewHandler(drawing) {
    const stopped = vi.fn();
    const focus = vi.fn();
    const context = vm.createContext({
        window: {
            roadDrawingMode: drawing,
            MapPick: { active: () => false },
            __mapEditLock: { isHeld: () => false }
        },
        measureMode: false,
        isParcelDrawingModeActive: () => false,
        pinpointToolIsActive: () => false,
        L: { DomEvent: { stopPropagation: stopped } },
        document: { getElementById: () => ({ classList: { contains: () => false } }) },
        proposal: { proposalId: 'park-preview' },
        getProposalKey: item => item.proposalId,
        focusProposalDetails: focus
    });
    const handler = vm.runInContext(`(${proposalClickSource()})`, context);
    return { click: handler, stopped, focus };
}

function cadastreCloneHandler(drawing) {
    const stopped = vi.fn();
    const open = vi.fn();
    const handlers = new Map();
    const layer = { on: (name, handler) => handlers.set(name, handler), setStyle: vi.fn(), bringToFront: vi.fn() };
    const context = vm.createContext({
        CADASTRE_PANE: 'cadastre-view', global: null, ensureCadastrePane: vi.fn(), openBaseParcel: open,
        CadastralParcelRepository: { list: () => [{ properties: { parcelId: 'base-1' }, geometry: { type: 'Polygon', coordinates: [] } }] },
        L: {
            DomEvent: { stop: stopped },
            layerGroup: () => ({ layers: [], addLayer(value) { this.layers.push(value); } }),
            geoJSON: (_feature, options) => { options.onEachFeature(null, layer); return { layer }; }
        }
    });
    context.global = { roadDrawingMode: drawing, __mapEditLock: { isHeld: () => false }, CadastralParcelRepository: context.CadastralParcelRepository };
    const builder = vm.runInNewContext(`${functionSource(claimsUiSource, 'buildCadastreLayer')}; buildCadastreLayer;`, context);
    builder();
    return { click: handlers.get('click'), stopped, open };
}
describe('map surface clicks belong to active road drawing', () => {
    it('lets the observed OSM building click reach the map, while retaining the normal click stack', () => {
        for (const drawing of [true, false]) {
            const target = buildingHandler(drawing);
            target.click(event());
            expect(target.stopped).toHaveBeenCalledTimes(drawing ? 0 : 1);
            expect(target.clickStack).toHaveBeenCalledTimes(drawing ? 0 : 1);
        }
    });

    it('lets ordinary parcel clicks bubble during drawing but keeps MapPick and browse clicks special', () => {
        const drawing = parcelHandler({ drawing: true });
        drawing.click({ ...event(), target: drawing.layer });
        expect(drawing.stopped).not.toHaveBeenCalled();
        expect(drawing.clickStack).not.toHaveBeenCalled();

        const ordinary = parcelHandler();
        ordinary.click({ ...event(), target: ordinary.layer });
        expect(ordinary.stopped).toHaveBeenCalledTimes(1);
        expect(ordinary.clickStack).toHaveBeenCalledTimes(1);

        const mapPick = parcelHandler({ mapPick: true });
        mapPick.click({ ...event(), target: mapPick.layer });
        expect(mapPick.pick).toHaveBeenCalledWith('design-1', { parcelId: 'parcel-1' });
        const browse = parcelHandler({ browse: true });
        browse.click({ ...event(), target: browse.layer });
        expect(browse.select).toHaveBeenCalledWith('design-1', 'parcel-1', true, true);
    });

    it('lets park, square and lake claim surfaces bubble during drawing', () => {
        for (const binderSite of ['updateParksLayer', 'updateSquaresLayer', 'drawLakeDecorations']) {
            expect(functionSource(structuresSource, binderSite)).toContain('bindStructureClaimClick(');
        }
        for (const kind of ['park', 'square', 'lake']) {
            const target = structureHandler(true);
            target.click(event());
            expect(target.stopped, kind).not.toHaveBeenCalled();
            expect(target.surfaceClick, kind).not.toHaveBeenCalled();
            expect(target.select, kind).not.toHaveBeenCalled();
        }
        const ordinary = structureHandler(false);
        ordinary.click(event());
        expect(ordinary.stopped).toHaveBeenCalledTimes(1);
        expect(ordinary.surfaceClick).toHaveBeenCalledTimes(1);
    });

    it('lets a selected unapplied proposal preview click bubble during drawing', () => {
        const drawing = selectedPreviewHandler(true);
        drawing.click(event());
        expect(drawing.stopped).not.toHaveBeenCalled();
        expect(drawing.focus).not.toHaveBeenCalled();
        const ordinary = selectedPreviewHandler(false);
        ordinary.click(event());
        expect(ordinary.stopped).toHaveBeenCalledTimes(1);
        expect(ordinary.focus).toHaveBeenCalledTimes(1);
    });

    it('lets cadastral clones bubble during drawing but opens their immutable source otherwise', () => {
        const drawing = cadastreCloneHandler(true);
        drawing.click(event());
        expect(drawing.stopped).not.toHaveBeenCalled();
        expect(drawing.open).not.toHaveBeenCalled();
        const ordinary = cadastreCloneHandler(false);
        ordinary.click(event());
        expect(ordinary.stopped).toHaveBeenCalledTimes(1);
        expect(ordinary.open).toHaveBeenCalledWith('base-1');
    });
});
