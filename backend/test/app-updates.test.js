import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';
import { testI18n } from './helpers/i18n.js';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../frontend/js/ui/app-updates.js', import.meta.url), 'utf8');
function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key), values };
}
function fixture(extra = {}) {
    const document = makeDocument(), handlers = {}, intervals = [];
    document.readyState = 'complete'; document.visibilityState = 'visible'; document.baseURI = 'https://example.test/';
    document.body.innerHTML = `<button id="app-update-check"></button><section id="app-update-notice"><button data-app-update-reload></button><button id="app-update-later"></button></section>
        ${['app-running-build','app-deployed-at','app-update-state','app-update-last-checked','app-update-blocked','app-update-reload-hint'].map(id => `<p id="${id}"></p>`).join('')}`;
    const latest = { version: 1, component: 'urbangametheory-frontend', buildId: 'deploy-13', buildNumber: 13, generatedAt: '2026-10-27T12:00:00Z' };
    const context = { document, URL, AbortController, console,
        __BUILD_INFO: { buildId: 'deploy-12', buildNumber: 12, generatedAt: '2026-10-27T11:00:00Z' },
        ReleaseUpdates: require('../../frontend/js/release-updates.js'), BusyControl: require('../../frontend/js/ui/busy-control.js'),
        i18n: testI18n(), CbFormat: { formatDateTime: value => value.toISOString() },
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({ ...latest }) })),
        setTimeout: vi.fn(() => 7), clearTimeout: vi.fn(), setInterval: vi.fn((fn, ms) => { intervals.push(fn); return ms; }), clearInterval: vi.fn(),
        addEventListener: (name, fn) => { handlers[name] = fn; }, removeEventListener: (name, fn) => { if (handlers[name] === fn) delete handlers[name]; }, location: { reload: vi.fn() },
        __mapEditLock: { isHeld: vi.fn(() => false) }, MapShell: { isBlockingDialogOpen: () => false },
        sessionStorage: memoryStorage(), ...extra };
    context.window = context; vm.createContext(context); vm.runInContext(source, context);
    return { ...context, handlers, intervals, latest, window: context, el: id => document.getElementById(id) };
}
const settled = async h => vi.waitFor(() => expect(h.window.AppUpdates.snapshot().status).toBe('available'));
describe('app update page wiring', () => {
    it('polls every five minutes only while visible and checks on return', async () => {
        const h = fixture(); await settled(h);
        expect(h.setInterval).toHaveBeenCalledWith(expect.any(Function), 300000);
        expect(h.fetch.mock.calls[0][0]).toMatch(/^https:\/\/example.test\/release.json\?check=\d+$/);
        expect(h.fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
        h.document.visibilityState = 'hidden'; h.intervals[0](); h.handlers.focus();
        expect(h.fetch).toHaveBeenCalledTimes(1);
        h.document.visibilityState = 'visible'; h.document.dispatchEvent({ type: 'visibilitychange' });
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2)); await settled(h);
        h.intervals[0](); await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(3));
        h.handlers.pagehide(); expect(h.clearInterval).toHaveBeenCalledWith(300000);
        expect(h.clearTimeout).toHaveBeenCalled();
    });
    it('dismisses one release, retains Settings access, and announces a subsequent release', async () => {
        const h = fixture(); await settled(h);
        expect(h.el('app-update-notice').hidden).toBe(false);
        h.el('app-update-later').click(); expect(h.el('app-update-notice').hidden).toBe(true);
        await h.window.AppUpdates.check(); expect(h.el('app-update-notice').hidden).toBe(true);
        h.latest.buildId = 'deploy-14'; h.latest.buildNumber = 14;
        await h.window.AppUpdates.check(); expect(h.el('app-update-notice').hidden).toBe(false);
        expect(h.document.querySelector('[data-app-update-reload]').hidden).toBe(false);
    });
    it('never auto-reloads and blocks an explicit reload while editing or busy', async () => {
        const h = fixture(); await settled(h);
        expect(h.location.reload).not.toHaveBeenCalled();
        const reload = h.document.querySelector('[data-app-update-reload]');
        h.__mapEditLock.isHeld.mockReturnValue(true); reload.click();
        expect(h.location.reload).not.toHaveBeenCalled();
        expect(h.el('app-update-blocked').textContent).toContain('Finish or cancel');
        h.__mapEditLock.isHeld.mockReturnValue(false);
        h.el('app-update-check').setAttribute('aria-busy', 'true'); reload.click();
        expect(h.location.reload).not.toHaveBeenCalled();
        h.el('app-update-check').removeAttribute('aria-busy'); reload.click();
        expect(h.location.reload).toHaveBeenCalledTimes(1);
    });
});

describe('resume after "Update now"', () => {
    const KEY = 'cb.updateResume';
    const stack = { selectedKind: 'designs', expanded: 'designs', sections: [{ kind: 'designs', instances: [{ id: 'd-1' }, { id: 'd-2' }], selectedIndex: 1 }] };
    it('writes the current pose to the address and records the open 2D stack before reloading', async () => {
        const write = vi.fn();
        const h = fixture({ MapShare: { createAddressSync: () => ({ write }) }, location: { reload: vi.fn(), pathname: '/plans/abc' },
            ClickStack: { isOpen: () => true, current: () => stack, point: () => ({ lat: 45.8, lng: 15.98 }) },
            __clickStackModel: { selectedInstance: (s, kind) => s.sections.find(x => x.kind === kind).instances[1] } });
        await settled(h);
        h.document.querySelector('[data-app-update-reload]').click();
        expect(write).toHaveBeenCalledTimes(1);
        expect(h.location.reload).toHaveBeenCalledTimes(1);
        expect(JSON.parse(h.sessionStorage.getItem(KEY))).toMatchObject({ pathname: '/plans/abc', point: [45.8, 15.98], selected: { designs: 'd-2' } });
    });
    it('reopens the recorded stack once it can, consumes the record, and yields to the person', async () => {
        const record = { version: 1, savedAt: Date.now(), pathname: '/', mode: '2d', point: [45.8, 15.98], selected: { designs: 'd-2' }, selectedKind: 'designs', expanded: 'designs' };
        const resume = vi.fn(() => false);
        const h = fixture({ sessionStorage: memoryStorage({ [KEY]: JSON.stringify(record) }), location: { reload: vi.fn(), pathname: '/' },
            ClickStack: { resume }, L: { latLng: (lat, lng) => ({ lat, lng }) } });
        expect(h.sessionStorage.getItem(KEY)).toBeNull();
        expect(resume).toHaveBeenCalledWith({ lat: 45.8, lng: 15.98 }, expect.objectContaining({ selected: { designs: 'd-2' } }));
        expect(h.window.UpdateResume.pending()).toBe(true);
        resume.mockReturnValue(true);
        h.handlers.parcelDataLoaded();
        expect(resume).toHaveBeenCalledTimes(2);
        expect(h.window.UpdateResume.pending()).toBe(false);
        const late = fixture({ sessionStorage: memoryStorage({ [KEY]: JSON.stringify(record) }), location: { reload: vi.fn(), pathname: '/' },
            ClickStack: { resume: vi.fn(() => false) }, L: { latLng: (lat, lng) => ({ lat, lng }) } });
        late.document.dispatchEvent({ type: 'pointerdown' });
        expect(late.window.UpdateResume.pending()).toBe(false);
    });
});
