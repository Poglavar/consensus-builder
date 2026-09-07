// Exercises the real lazy-click shim and mode-button updater across asynchronous 3D entry.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const viewer = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const lazyScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .find(match => match[1].includes('window.__ensure3DModeStack ='))[1];
const updateSource = viewer.slice(viewer.indexOf('    function updateModeButtonStates()'),
    viewer.indexOf('    // Walk-mode launcher state.'));
const clickSource = viewer.slice(viewer.indexOf('    // Wire the 3D button.'),
    viewer.indexOf('    // Wire the 2D button.'));

function fixture() {
    const buttons = new Map();
    const paints = [];
    const timers = [];
    let finishDownload;
    const download = new Promise(resolve => { finishDownload = resolve; });
    for (const id of ['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle', 'mode-walk-toggle']) {
        const classes = new Set();
        const handlers = [];
        buttons.set(id, {
            classes,
            classList: {
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
            },
            addEventListener(type, handler, capture = false) { handlers.push({ type, handler, capture }); },
            removeEventListener(type, handler) {
                const index = handlers.findIndex(entry => entry.type === type && entry.handler === handler);
                if (index >= 0) handlers.splice(index, 1);
            },
            click() {
                let stopped = false;
                const event = { preventDefault() {}, stopImmediatePropagation() { stopped = true; } };
                for (const entry of [...handlers].sort((a, b) => Number(b.capture) - Number(a.capture))) {
                    entry.handler(event);
                    if (stopped) break;
                }
                record();
            }
        });
    }
    const active = id => buttons.get(id).classes.has('active');
    const record = () => paints.push({ flat: active('mode-2d-toggle'), model: active('mode-3d-toggle'), photo: active('mode-realistic-toggle') });
    const context = vm.createContext({
        isActive: false, isTransitioning3D: false, renderingOverlayEl: null,
        appendBuildToken: path => path, realisticActive: () => false,
        toggleBtn: buttons.get('mode-3d-toggle'), setTimeout: callback => timers.push(callback),
        showRenderingOverlay() { context.renderingOverlayEl = {}; context.updateModeButtonStates(); record(); },
        enter3D() {
            context.isActive = true;
            context.isTransitioning3D = false;
            context.renderingOverlayEl = null;
            context.updateModeButtonStates();
            record();
        },
        document: {
            getElementById: id => buttons.get(id) || null,
            createElement: () => ({}),
            head: {
                appendChild(tag) {
                    if (tag.src === 'js/three-mode.js') {
                        vm.runInContext(updateSource + clickSource + '\nupdateModeButtonStates();', context);
                        record(); // The module's initial paint used to briefly select 2D again.
                        context.enterThreeMode = context.enter3D;
                    }
                    tag.onload();
                }
            }
        },
        whenThreeReady: () => download
    });
    context.window = context;
    vm.runInContext(lazyScript, context);
    return { context, buttons, paints, timers, finishDownload, active, record };
}

describe('map-mode entry', () => {
    it('keeps 3D selected from the first lazy click through module load and deferred scene entry', async () => {
        const f = fixture();
        f.buttons.get('mode-3d-toggle').click();
        expect(f.paints).toEqual([{ flat: false, model: true, photo: false }]);
        expect(f.buttons.get('mode-3d-toggle').classes.has('mode-btn-loading')).toBe(true);

        f.finishDownload(true);
        await f.context.__ensure3DModeStack();
        await Promise.resolve();
        expect(f.context.__pending3DMode).toBeNull();
        expect(f.context.isTransitioning3D).toBe(true);
        expect(f.timers).toHaveLength(1);
        f.timers.shift()();

        expect(f.paints.length).toBeGreaterThan(3);
        expect(f.paints.every(paint => !paint.flat && paint.model && !paint.photo)).toBe(true);
        expect(f.buttons.get('mode-3d-toggle').classes.has('mode-btn-loading')).toBe(false);
        f.context.isActive = false;
        f.context.updateModeButtonStates();
        expect(f.active('mode-2d-toggle')).toBe(true);
        expect(f.active('mode-3d-toggle')).toBe(false);
    });

    it('restores 2D if the 3D dependency fails to load', async () => {
        const f = fixture();
        f.buttons.get('mode-3d-toggle').click();
        f.finishDownload(false);
        await f.context.__ensure3DModeStack();
        await Promise.resolve();
        expect(f.active('mode-2d-toggle')).toBe(true);
        expect(f.active('mode-3d-toggle')).toBe(false);
        expect(f.buttons.get('mode-3d-toggle').classes.has('mode-btn-loading')).toBe(false);
        expect(f.timers).toHaveLength(0);
    });

    it('gives photo loading the selected button throughout its intermediate 3D scene', () => {
        const f = fixture();
        vm.runInContext(updateSource, f.context);
        f.context.__pending3DMode = 'photo';
        f.context.isTransitioning3D = true;
        f.context.renderingOverlayEl = {};
        f.context.updateModeButtonStates();
        expect(f.active('mode-realistic-toggle')).toBe(true);
        expect(f.active('mode-2d-toggle')).toBe(false);
        expect(f.active('mode-3d-toggle')).toBe(false);
        expect(f.buttons.get('mode-3d-toggle').classes.has('mode-btn-loading')).toBe(false);
        f.context.__pending3DMode = null;
        f.context.isActive = true;
        f.context.PhotorealMode = { isActive: () => true, isLoading: () => false };
        f.context.updateModeButtonStates();
        expect(f.active('mode-realistic-toggle')).toBe(true);
        expect(f.active('mode-3d-toggle')).toBe(false);
        expect(f.buttons.get('mode-3d-toggle').classes.has('mode-btn-loading')).toBe(false);
    });
});
