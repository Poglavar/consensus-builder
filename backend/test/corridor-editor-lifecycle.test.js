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

describe('placed corridor stretch replacement in the shared editor', () => {
    it('mounts the road-wide override control and previews its default and replacement states', () => {
        const profile = { strips: [{ type: 'road', width: 6 }] };
        const definition = {
            segmentIds: ['live-1', 'live-2'],
            segmentProfiles: {
                'live-2': { strips: [{ type: 'sidewalk', width: 2 }] },
                retired: { strips: [{ type: 'sidewalk', width: 1 }] }
            }
        };
        const state = {};
        const cancel = vi.fn();
        const preview = vi.fn();
        const eventHandlers = {};
        let mountedInput = null;
        const host = {
            _html: '',
            set innerHTML(value) {
                this._html = value;
                const match = value.match(/class="corridor-editor-stretches-input"([^>]*)/);
                if (!match) { mountedInput = null; return; }
                mountedInput = {
                    checked: /\bchecked(?:\s|$)/.test(match[1]),
                    handlers: {},
                    addEventListener(type, handler) { this.handlers[type] = handler; }
                };
            },
            get innerHTML() { return this._html; },
            querySelector(selector) {
                return selector === '.corridor-editor-stretches-input' ? mountedInput : null;
            }
        };
        const footerControls = {
            '.corridor-editor-cancel': { addEventListener: (type, handler) => { eventHandlers[`cancel:${type}`] = handler; } },
            '.corridor-editor-save': { addEventListener: (type, handler) => { eventHandlers[`save:${type}`] = handler; } }
        };
        const root = { querySelectorAll: () => [], querySelector: selector => footerControls[selector] || null };
        const session = { root, panel: { classList: { add: vi.fn() } }, close: vi.fn() };
        const open = vi.fn(options => {
            if (options.content.includes('corridor-editor-stretches-host')) state.documentHost = host;
            state.shellOptions = options;
            return session;
        });
        const document = {
            querySelector: selector => selector === '.corridor-editor-stretches-host' ? state.documentHost : null,
            addEventListener: vi.fn()
        };
        const window = {
            OnMapEditor: { open },
            __corridorFootprint: { frameForDefinition: vi.fn(() => ({ kind: 'metric-frame' })) },
            RoadEditingZoom: { enter: vi.fn(), exit: vi.fn() },
            refreshSelectedCorridorSegmentHighlight: vi.fn()
        };
        const i18n = (_key, fallback, values) => Object.entries(values || {}).reduce(
            (text, [name, value]) => text.replaceAll(`{{${name}}}`, value), fallback
        );
        const context = {
            document, window, console, clearTimeout: vi.fn(),
            corridorEditorCancel: cancel,
            corridorEditorClose: vi.fn(),
            corridorEditorSave: vi.fn(),
            corridorEditorLockMap: vi.fn(),
            corridorEditorTotalText: width => `${width} m`,
            corridorEditorI18n: i18n,
            corridorProfileWidth: () => 6,
            corridorProposalDefinition: proposal => proposal.definition,
            corridorProfileOf: value => value.profile,
            getProposalByIdOrHash: () => ({ proposalId: 'road-1', definition: { ...definition, profile } }),
            getProposalKey: () => 'road-1',
            setCorridorProfilePreview: preview,
            corridorEditorFocusMap: vi.fn(),
            corridorEditorShowBuildingFootprints: vi.fn(),
            corridorEditorOnBuildingLayersChanged: vi.fn(),
            corridorEditorCompareHtml: () => ''
        };
        vm.runInNewContext(`
            let corridorEditorState=null, corridorEditorSession=null;
            const document=this.document, window=this.window, console=this.console;
            const corridorEditorCancel=this.corridorEditorCancel;
            const corridorEditorClose=this.corridorEditorClose;
            const corridorEditorSave=this.corridorEditorSave;
            const corridorEditorLockMap=this.corridorEditorLockMap;
            const corridorEditorTotalText=this.corridorEditorTotalText;
            const corridorEditorI18n=this.corridorEditorI18n;
            const corridorProfileWidth=this.corridorProfileWidth;
            const corridorProposalDefinition=this.corridorProposalDefinition;
            const corridorProfileOf=this.corridorProfileOf;
            const getProposalByIdOrHash=this.getProposalByIdOrHash;
            const getProposalKey=this.getProposalKey;
            const setCorridorProfilePreview=this.setCorridorProfilePreview;
            const corridorEditorFocusMap=this.corridorEditorFocusMap;
            const corridorEditorShowBuildingFootprints=this.corridorEditorShowBuildingFootprints;
            const corridorEditorOnBuildingLayersChanged=this.corridorEditorOnBuildingLayersChanged;
            const corridorEditorCompareHtml=this.corridorEditorCompareHtml;
            const corridorEditorRender=()=>{
                corridorEditorRenderStretchesOption();
                corridorEditorPreview(corridorEditorState.profile);
            };
            ${extracted('corridorEditorPreview')}
            ${extracted('corridorEditorOwnProfileCount')}
            ${extracted('corridorEditorStretchesOptionHtml')}
            ${extracted('corridorEditorRenderStretchesOption')}
            ${extracted('corridorEditorOpenOverlayBody')}
            ${extracted('corridorEditorOpenOverlay')}
            ${extracted('openCorridorProfileEditor')}
            this.openPlacedRoad=()=>openCorridorProfileEditor('road-1');
            this.getEditorState=()=>corridorEditorState;
        `, context);

        context.openPlacedRoad();

        expect(open).toHaveBeenCalledOnce();
        expect(state.shellOptions).toEqual(expect.objectContaining({
            owner: 'corridor-editor', modes: ['2d'], onCancel: cancel
        }));
        expect(state.shellOptions.content).toContain('corridor-editor-stretches-host');
        expect(session.panel.classList.add).toHaveBeenCalledWith('corridor-editor');
        expect(host.innerHTML).toContain('Also replace the 1 stretches');
        expect(mountedInput.checked).toBe(false);
        expect(preview).toHaveBeenLastCalledWith('road-1', profile, null, { keepOverrides: true });
        expect(eventHandlers['cancel:click']).toBe(cancel);

        mountedInput.checked = true;
        mountedInput.handlers.change();

        expect(context.getEditorState().replaceStretchProfiles).toBe(true);
        expect(preview).toHaveBeenLastCalledWith('road-1', profile, null, { keepOverrides: false });
        expect(host.innerHTML).toContain('checked');
    });
});
