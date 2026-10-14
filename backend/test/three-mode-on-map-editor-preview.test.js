// Regression tests for live on-map editor previews entering, updating, and leaving 3D mode.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
const declarations = new Map();
function collectFunctions(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    Object.keys(node).forEach(key => {
        if (key === 'loc' || key === 'start' || key === 'end') return;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collectFunctions);
        else collectFunctions(value);
    });
}
collectFunctions(ast);

function group() {
    return {
        children: [],
        add(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
    };
}

function previewHarness() {
    let livePreview = null;
    const editor = {
        isActive: () => !!livePreview,
        getPreview: () => livePreview
    };
    const mapEditLock = { held: false, blocksSelection() { return this.held; } };
    const calls = {
        added: [],
        context: [],
        modelOptions: [],
        invalidations: 0
    };
    const disposeDraftPreviewChildren = vi.fn(target => { target.children.length = 0; });
    const addDraftPreviewFeature3D = vi.fn((feature, target, style, kind, options) => {
        calls.added.push({ feature, style, kind });
        if (options?.isCurrent) calls.modelOptions.push(options);
        target.add({ feature });
    });
    const polygonFeatureToMeshes = vi.fn((feature, material, z, depth) => {
        calls.context.push({ type: 'surface', feature, material, z, depth });
        return [{ geometry: {}, material }];
    });
    const polygonFeatureToBorderLines = vi.fn((feature, material, z) => {
        calls.context.push({ type: 'boundary', feature, material, z });
        return [{ geometry: {}, material }];
    });
    const stubs = {
        window: {
            OnMapEditor: editor,
            __mapEditLock: mapEditLock,
            proposalDraftStore: { getDraft: () => null }
        },
        THREE: {
            Group: group,
            DoubleSide: 'double',
            MeshLambertMaterial: class { constructor(options) { this.options = options; } },
            LineBasicMaterial: class { constructor(options) { this.options = options; } }
        },
        disposeDraftPreviewChildren,
        collectSourcePreviewFeatures: proposal => proposal.features || [],
        collectDraftPreviewFeatures: descriptor => descriptor.features || [],
        addDraftPreviewFeature3D,
        polygonFeatureToMeshes,
        polygonFeatureToBorderLines,
        markOwnedMaterial: vi.fn(),
        invalidateThreeView: () => { calls.invalidations += 1; }
    };
    const context = { console, ...stubs };
    const bindings = Object.keys(stubs).map(name => `const ${name}=this.${name};`).join('\n');
    const names = ['activeOnMapEditorPreviewDetail', 'addOnMapEditorContextPreview3D',
        'resolvedProposalDraftPreviewDetail', 'rebuildProposalDraftPreview3D', 'handleOnMapEditorPreviewChange',
        'mapSelectionBlockedByEditor'];
    const code = `let isActive=true; let proposalDraftGroup=this.previewGroup; let latestProposalDraftPreviewDetail=null; let onMapEditorModelPreviewGeneration=0;\n${bindings}\n${names.map(name => declarations.get(name)).join('\n')}\nthis.api={${names.join(',')}};`;
    context.previewGroup = group();
    vm.runInNewContext(code, context);
    return {
        api: context.api,
        calls,
        editor,
        mapEditLock,
        group: context.previewGroup,
        disposeDraftPreviewChildren,
        addDraftPreviewFeature3D
    };
}

function cleanupHarness(editorActive) {
    const pendingContext = { parcelIds: ['parcel-77'] };
    const calls = { proposalClose: 0, blockifyClose: 0, detailHide: 0 };
    const blockifyModal = {};
    const stubs = {
        window: { OnMapEditor: { isActive: () => editorActive } },
        document: { getElementById: () => blockifyModal, querySelectorAll: () => [] },
        hideParcelInfoPanel: vi.fn(), hideProposalDetailsPanel: vi.fn(() => { calls.detailHide += 1; }),
        hideBlockInfo: vi.fn(), hideRoadInfoPanel: vi.fn(), hideRoadAnalysisPanel: vi.fn(),
        hideOSMRoadSegmentListPopup: vi.fn(), hideBlocksList: vi.fn(),
        closeProposalDialog: vi.fn(() => { calls.proposalClose += 1; pendingContext.parcelIds = []; }),
        closeBlockifyModal: vi.fn(() => { calls.blockifyClose += 1; })
    };
    const context = { console, ...stubs };
    vm.runInNewContext(`${declarations.get('closeAllPanelsAndModalsFor3D')}\nthis.close=closeAllPanelsAndModalsFor3D;`, context);
    context.close();
    return { calls, pendingContext, stubs };
}

describe('three-mode on-map editor live preview', () => {
    it('keeps the suspended proposal form and parcel context while the building editor is active', () => {
        const active = cleanupHarness(true);
        expect(active.calls.proposalClose).toBe(0);
        expect(active.pendingContext.parcelIds).toEqual(['parcel-77']);
        expect(active.calls.blockifyClose).toBe(0);
        expect(active.stubs.hideProposalDetailsPanel).toHaveBeenCalledOnce();

        const inactive = cleanupHarness(false);
        expect(inactive.calls.proposalClose).toBe(1);
        expect(inactive.pendingContext.parcelIds).toEqual([]);
        expect(inactive.calls.blockifyClose).toBe(1);
        expect(inactive.stubs.hideProposalDetailsPanel).toHaveBeenCalledOnce();
    });

    it('seeds from the live editor when 3D loads late, prioritizes it over comparison, and restores comparison on close', () => {
        const harness = previewHarness();
        const comparison = {
            sourceProposal: { features: [{ id: 'source' }] },
            draftId: 'comparison-draft',
            draftPreview: { kind: 'buildings', features: [{ id: 'comparison' }] }
        };
        const building = { id: 'live-building', geometry: { type: 'Polygon', coordinates: [] } };
        const boundary = { id: 'parcel-boundary', geometry: { type: 'Polygon', coordinates: [] } };
        const groundSurface = { polygon: { type: 'Polygon', coordinates: [] }, treatment: 'green' };

        // The editor was already open when the lazy-loaded model module starts building its scene.
        harness.editor.isActive = () => true;
        harness.editor.getPreview = () => ({ draftPreview: { kind: 'buildings', features: [building] }, boundary, groundSurface });
        harness.api.rebuildProposalDraftPreview3D(comparison);

        expect(harness.calls.added).toEqual([{ feature: building, style: 'draft', kind: 'buildings' }]);
        expect(harness.calls.context.map(item => item.type)).toEqual(['surface', 'boundary']);
        expect(harness.calls.context[0].material.options.color).toBe(0x4f8b55);
        expect(harness.calls.context[1].feature).toBe(boundary);

        const movedBuilding = { id: 'moved-building', geometry: { type: 'Polygon', coordinates: [] } };
        harness.editor.getPreview = () => ({ draftPreview: { kind: 'buildings', features: [movedBuilding] }, boundary, groundSurface });
        harness.api.handleOnMapEditorPreviewChange();
        expect(harness.calls.added.at(-1).feature).toBe(movedBuilding);
        expect(harness.calls.invalidations).toBe(2);

        harness.editor.isActive = () => false;
        harness.editor.getPreview = () => null;
        harness.api.handleOnMapEditorPreviewChange();
        expect(harness.calls.added.slice(-1)[0]).toMatchObject({ feature: { id: 'comparison' }, style: 'draft' });
        expect(harness.calls.added.slice(-2, -1)[0]).toMatchObject({ feature: { id: 'source' }, style: 'source' });
        expect(harness.calls.invalidations).toBe(3);
    });

    it('keeps permitted envelopes and excluded parcels distinct from actual buildout', () => {
        const harness = previewHarness();
        const features = [{ id: 'actual-building' }];
        const envelope = { id: 'permitted-envelope' };
        const excluded = { id: 'excluded-parcel' };
        harness.editor.isActive = () => true;
        harness.editor.getPreview = () => ({ draftPreview: { kind: 'buildings', features }, envelopes: [envelope], excluded: [excluded] });
        harness.api.rebuildProposalDraftPreview3D();
        expect(harness.calls.added).toEqual([
            { feature: envelope, style: 'envelope', kind: 'buildings' },
            { feature: excluded, style: 'excluded', kind: 'buildings' },
            { feature: features[0], style: 'draft', kind: 'buildings' }
        ]);
    });

    it('invalidates pending uploaded-model loads on preview replacement and editor close', () => {
        const harness = previewHarness();
        harness.editor.isActive = () => true;
        const model = { id: 'uploaded', properties: { modelUrl: '/building.glb' }, geometry: { type: 'Polygon', coordinates: [] } };
        harness.editor.getPreview = () => ({ draftPreview: { kind: 'buildings', features: [model] } });
        harness.api.rebuildProposalDraftPreview3D();
        const first = harness.calls.modelOptions[0].isCurrent;
        expect(first()).toBe(true);

        harness.api.rebuildProposalDraftPreview3D();
        const second = harness.calls.modelOptions[1].isCurrent;
        expect(first()).toBe(false);
        expect(second()).toBe(true);

        harness.editor.isActive = () => false;
        harness.editor.getPreview = () => null;
        harness.api.handleOnMapEditorPreviewChange();
        expect(second()).toBe(false);
    });

    it('wires the editor lifecycle event and blocks 3D selection through the shared map edit lock', () => {
        expect(source).toContain("document.addEventListener('on-map-editor-preview-change', handleOnMapEditorPreviewChange);");
        const clickStart = source.indexOf('function handleParcelClick(evt)');
        const clickBody = source.slice(clickStart, source.indexOf('\n    }', clickStart));
        expect(clickBody).toContain('mapSelectionBlockedByEditor()');
        const harness = previewHarness();
        expect(harness.api.mapSelectionBlockedByEditor()).toBe(false);
        harness.mapEditLock.held = true;
        expect(harness.api.mapSelectionBlockedByEditor()).toBe(true);
    });
});
