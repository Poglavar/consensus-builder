import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');

function extracted(name) {
    const ast = parse(source, { sourceType: 'script' });
    let declaration = null;
    (function find(node) {
        if (!node || typeof node !== 'object' || declaration) return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
            declaration = node;
            return;
        }
        Object.keys(node).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(find); else find(value);
        });
    })(ast);
    expect(declaration, `${name} declaration exists`).toBeTruthy();
    return source.slice(declaration.start, declaration.end);
}

function previewHarness({ modal, authoredSite, lastSuperparcel, ruleKind }) {
    const context = { blockifyModal: modal, authoredSite, lastSuperparcel, ruleKind };
    vm.runInNewContext(`
        let blockifyModal=this.blockifyModal;
        let blockifyAuthoredSite=this.authoredSite;
        let blockifyGenerationSite=this.authoredSite;
        let lastSuperparcel=this.lastSuperparcel;
        let blockRuleKind=this.ruleKind;
        ${extracted('blockifyDesignBoundary')}
        ${extracted('publishBlockifyPreview')}
        this.publish=publishBlockifyPreview;
    `, context);
    return context.publish;
}

function closeHarness() {
    const removed = [];
    const map = {
        hasLayer: vi.fn(() => true),
        removeLayer: vi.fn(layer => removed.push(layer)),
        remove: vi.fn()
    };
    const names = ['parcel', 'boundary', 'building', 'footprint', 'debug', 'piece', 'excluded', 'handles'];
    const layers = Object.fromEntries(names.map(name => [name, { name }]));
    const events = [];
    const pending = { id: 'pending-building-proposal' };
    const discarded = vi.fn();
    const finished = vi.fn();
    const modal = { close: vi.fn() };
    const polygonEditor = { destroy: vi.fn() };
    const tracker = { stop: vi.fn() };
    const document = { dispatchEvent: event => events.push(event) };
    const window = {
        pendingBuildingFromBlockify: { feature: true },
        discardProposalDraftDesignSession: discarded,
        finishProposalDraftDesignSession: finished
    };
    const prefix = `
        let blockifyModal=this.modal, blockifyMap=this.map;
        let blockifyParcelLayer=this.layers.parcel, blockifyBoundaryLayer=this.layers.boundary;
        let blockifyBuildingLayer=this.layers.building, blockifyFootprintLayer=this.layers.footprint;
        let blockifyDebugLayer=this.layers.debug, blockifyPieceLayers=[this.layers.piece];
        let blockifyExcludedLayers=[this.layers.excluded], blockifyHandleLayer=this.layers.handles;
        let blockifyPolygonEditor=this.polygonEditor, blockifyPendingVertexActionIndex=3;
        let blockifyDesignChangeTracker=this.tracker, generatedBuildingFeature={ feature: true };
        let generatedBuildingFeatures=[{ feature: true }], existingFootprints=[{ feature: true }];
        let existingFootprintsPromise=Promise.resolve([]), blockifyBlock={ parcels: [] };
        let blockifyBlockNameOverride='block', blockifyAuthoredSite={ geometry: {} };
        let blockifyGenerationSite={ geometry: {} }, blockifyHistoryKeydown=null, blockifyHistory=null, blockifyUndoButton=null;
        let blockifyDragState=null, blockifyShapeHistoryRecorded=false, blockifyPlacementTransform={ translationMeters: [0, 0], rotationDegrees: 0 };
        let blockifyPlacementSite={ geometry: {} };
        let currentSetback=99, currentBuildingWidth=88;
        const DEFAULT_SETBACK=2, DEFAULT_BUILDING_WIDTH=15;
        const document=this.document, window=this.window, CustomEvent=this.CustomEvent;
        const setPendingBuildingProposalContext=this.setPendingBuildingProposalContext;
    `;
    const context = {
        map, layers, modal, polygonEditor, tracker, document, window,
        CustomEvent: class { constructor(type) { this.type = type; } },
        setPendingBuildingProposalContext: vi.fn(value => { context.pendingContext = value; })
    };
    vm.runInNewContext(`
        ${prefix}
        ${extracted('clearGapWingHandles')}
        ${extracted('closeBlockifyModal')}
        this.close=closeBlockifyModal;
        this.getState=()=>({
            modal:blockifyModal, map:blockifyMap, parcel:blockifyParcelLayer, boundary:blockifyBoundaryLayer,
            building:blockifyBuildingLayer, footprint:blockifyFootprintLayer, debug:blockifyDebugLayer,
            pieces:blockifyPieceLayers, excluded:blockifyExcludedLayers, handle:blockifyHandleLayer,
            polygonEditor:blockifyPolygonEditor, generated:generatedBuildingFeature,
            generatedFeatures:generatedBuildingFeatures, existing:existingFootprints,
            existingPromise:existingFootprintsPromise, block:blockifyBlock, blockName:blockifyBlockNameOverride,
            site:blockifyAuthoredSite, generationSite:blockifyGenerationSite, pendingVertex:blockifyPendingVertexActionIndex,
            setback:currentSetback, width:currentBuildingWidth
        });
    `, context);
    return { ...context, removed, events, pending, discarded, finished };
}

describe('Urban rule shared-map editor behavior', () => {
    it('publishes generated examples, the authored boundary, and only valid envelope/exclusion features', () => {
        const authoredSite = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [] } };
        const fallback = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
        const example = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { role: 'example' } };
        const envelope = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { role: 'envelope' } };
        const excluded = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { role: 'excluded' } };
        const setPreview = vi.fn();
        const publish = previewHarness({
            modal: { setPreview }, authoredSite, lastSuperparcel: fallback, ruleKind: 'maximum'
        });

        publish({ exampleBuildings: [example, { properties: { malformed: true } }, null], envelopes: [envelope, {}], excluded: [excluded, null] });

        expect(setPreview).toHaveBeenCalledOnce();
        expect(setPreview).toHaveBeenCalledWith({
            draftPreview: { kind: 'buildings', features: [example] },
            boundary: authoredSite,
            envelopes: [envelope],
            excluded: [excluded]
        });
    });

    it('omits envelopes for exact rules and does not publish without an active editor session', () => {
        const setPreview = vi.fn();
        const authoredSite = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
        const publish = previewHarness({ modal: { setPreview }, authoredSite, lastSuperparcel: null, ruleKind: 'exact' });
        const envelope = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
        publish({ envelopes: [envelope] });
        expect(setPreview).toHaveBeenCalledWith(expect.objectContaining({ envelopes: [] }));

        const noSession = previewHarness({ modal: null, authoredSite, lastSuperparcel: null, ruleKind: 'maximum' });
        expect(() => noSession({ envelopes: [envelope] })).not.toThrow();
    });

    it('closes the shared session, removes only urban-rule layers, resets state, and discards on cancel', () => {
        const h = closeHarness();
        h.close();

        expect(h.modal.close).toHaveBeenCalledOnce();
        expect(h.map.remove).not.toHaveBeenCalled();
        expect(h.map.removeLayer.mock.calls.map(([layer]) => layer.name)).toEqual([
            'handles', 'parcel', 'boundary', 'building', 'footprint', 'debug', 'piece', 'excluded'
        ]);
        expect(h.polygonEditor.destroy).toHaveBeenCalledOnce();
        expect(h.tracker.stop).toHaveBeenCalledOnce();
        expect(h.getState()).toMatchObject({
            modal: null, map: null, parcel: null, boundary: null, building: null, footprint: null, debug: null,
            pieces: [], excluded: [], handle: null, polygonEditor: null, generated: null,
            generatedFeatures: null, existing: null, existingPromise: null, block: null, blockName: null,
            site: null, generationSite: null, pendingVertex: null, setback: 2, width: 15
        });
        expect(h.setPendingBuildingProposalContext).toHaveBeenCalledWith(null);
        expect(h.window.pendingBuildingFromBlockify).toBeNull();
        expect(h.discarded).toHaveBeenCalledOnce();
        expect(h.finished).toHaveBeenCalledOnce();
        expect(h.events.map(event => event.type)).toEqual(['blockifyModalClosed', 'urbanRuleModalClosed']);
    });

    it('preserves a Done result during teardown while still closing the session and finishing it', () => {
        const h = closeHarness();
        h.close({ preservePending: true });

        expect(h.modal.close).toHaveBeenCalledOnce();
        expect(h.discarded).not.toHaveBeenCalled();
        expect(h.finished).toHaveBeenCalledOnce();
        expect(h.setPendingBuildingProposalContext).not.toHaveBeenCalled();
        expect(h.window.pendingBuildingFromBlockify).toEqual({ feature: true });
    });

    it('keeps the shared 2D/model editor, authored-site boundary and specialized rule controls wired', () => {
        expect(source).toContain("modes: ['2d', 'model']");
        expect(source).toContain('const initialBoundary = blockifyAuthoredSite?.geometry ? blockifyAuthoredSite : featureCollection;');
        expect(source).toContain('const parcels = blockParcelsForSplit();');
        for (const id of [
            'algorithm-select', 'proposed-height-slider', 'setback-slider', 'chamfer-slider',
            'blockify-ruletype-select', 'blockify-minplot-slider', 'gaps-slider', 'wings-slider',
            'btn-blockify-cancel', 'btn-blockify-regenerate', 'btn-blockify-done'
        ]) expect(source).toContain(id);
    });
});
