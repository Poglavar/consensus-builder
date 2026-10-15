import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/corridor-editor.js', import.meta.url), 'utf8');

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

describe('corridor editor collision lifecycle', () => {
    it('cleans its pending editor state when the shared map is already owned', () => {
        const incumbent = { owner: 'single-building-editor' };
        const active = { current: incumbent };
        const open = vi.fn(options => {
            if (active.current) return null;
            active.current = { owner: options.owner };
            return active.current;
        });
        const lockCalls = [];
        const enter = vi.fn();
        const exit = vi.fn();
        const clearPreview = vi.fn();
        const removeListener = vi.fn();
        const logger = { error: vi.fn() };
        const showEphemeralMessage = vi.fn();
        const document = { removeEventListener: removeListener };
        const window = {
            OnMapEditor: { open },
            RoadEditingZoom: { enter, exit },
            ProposalBeforeAfter: { dispose: vi.fn() },
            refreshSelectedCorridorSegmentHighlight: vi.fn()
        };
        const context = {
            editorState: { mode: 'drawing', profile: { strips: [] }, startedCompare: false },
            window, document, console: logger, clearTimeout: vi.fn(), showEphemeralMessage,
            corridorProfileWidth: () => 6,
            corridorEditorTotalText: () => '6 m',
            corridorEditorI18n: (key, fallback) => key === 'modal.corridor.openError' ? 'Localized opening error' : fallback,
            corridorEditorLockMap: value => lockCalls.push(value),
            corridorEditorCancel: vi.fn(),
            clearCorridorProfilePreview: clearPreview,
            corridorEditorRenderBuildingHits: vi.fn(),
            corridorEditorClearClearanceOverlays: vi.fn(),
            corridorEditorClearEdgeFillPreview: vi.fn(),
            corridorEditorOnBuildingLayersChanged: () => {}
        };
        vm.runInNewContext(`
            let corridorEditorState=this.editorState, corridorEditorSession=null, corridorEditorObstacleTimer=null;
            const window=this.window, document=this.document, console=this.console, clearTimeout=this.clearTimeout;
            const corridorProfileWidth=this.corridorProfileWidth, corridorEditorTotalText=this.corridorEditorTotalText;
            const corridorEditorI18n=this.corridorEditorI18n, corridorEditorLockMap=this.corridorEditorLockMap;
            const corridorEditorCancel=this.corridorEditorCancel;
            const clearCorridorProfilePreview=this.clearCorridorProfilePreview;
            const corridorEditorRenderBuildingHits=this.corridorEditorRenderBuildingHits;
            const corridorEditorClearClearanceOverlays=this.corridorEditorClearClearanceOverlays;
            const corridorEditorClearEdgeFillPreview=this.corridorEditorClearEdgeFillPreview;
            const corridorEditorOnBuildingLayersChanged=this.corridorEditorOnBuildingLayersChanged;
            ${extracted('corridorEditorClose')}
            ${extracted('corridorEditorOpenOverlayBody')}
            ${extracted('corridorEditorOpenOverlay')}
            this.openEditor=corridorEditorOpenOverlay;
            this.getState=()=>({ state:corridorEditorState, session:corridorEditorSession });
        `, context);

        context.openEditor();

        expect(open).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ owner: 'corridor-editor', modes: ['2d'] }));
        expect(active.current).toBe(incumbent);
        expect(lockCalls).toEqual([false]);
        expect(enter).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith('cross-section');
        expect(clearPreview).toHaveBeenCalledOnce();
        expect(removeListener).toHaveBeenCalledWith('building-layers-changed', expect.any(Function));
        expect(context.getState()).toEqual({ state: null, session: null });
        expect(logger.error).toHaveBeenCalledOnce();
        expect(showEphemeralMessage).toHaveBeenCalledExactlyOnceWith('Localized opening error', 5000, 'error');
    });
});
