// Current-map links preserve the selected view without turning an informal set into an agreement.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { link, address, capture, createAddressSync, readCamera, arrivalOptions } = require('../../frontend/js/map-share.js');
const camera = { targetLat: 45, targetLng: 16, headingDeg: 90, pitchRad: -0.6, range: 300 };

describe('current-map sharing', () => {
    it.each(['2d', 'model', 'photo'])('preserves %s and location on an exact selection of designs', mode => {
        const url = new URL(link('https://app.example.test/designs/one,two?3d&city=old&lang=hr', {
            mode, at: '45,16,18', city: 'example', language: 'en', camera: mode === '2d' ? null : camera
        }));
        expect(url.pathname).toBe('/designs/one,two');
        expect(url.searchParams.get('at')).toBe('45,16,18');
        expect(url.searchParams.has('3d')).toBe(mode === 'model');
        expect(url.searchParams.has('photo')).toBe(mode === 'photo');
        expect(readCamera(url.searchParams.get('camera'))).toEqual(mode === '2d' ? null : camera);
    });
    it.each([null, '', '1,2', '91,2,0,-0.5,30', '1,2,0,1,30', '1,2,0,-0.5,0', 'a,2,0,-0.5,20'])('rejects invalid camera %s', value => {
        expect(readCamera(value)).toBeNull();
    });
    it('captures the view before a panel can change it', () => {
        expect(capture({ map: { getCenter: () => ({ lat: 45, lng: 16 }), getZoom: () => 18 },
            __mapModeState: { desired: 'photo' }, getThree3DGeoView: () => camera,
            i18n: { getLanguage: () => 'en' }, CityConfigManager: { getCurrentCityId: () => 'example' }
        })).toEqual({ mode: 'photo', at: '45,16,18', camera, rotate: false, city: 'example', language: 'en' });
    });
    it('keeps an explicit backend override so a preview link reads the same publications', () => {
        const context = capture({ map: { getCenter: () => ({ lat: 45, lng: 16 }), getZoom: () => 18 },
            location: { search: '?backend=https%3A%2F%2Fapi.example.test' } });
        expect(new URL(link('https://app.example.test/', context)).searchParams.get('backend')).toBe('https://api.example.test');
    });
    it('records camera and arrival rotation independently without carrying a private preview token', () => {
        const context = { mode: 'model', at: '45,16,18', camera, rotate: true };
        const base = 'https://app.example.test/designs/published?draft=private&camera=old&rotate=0';
        const rotating = new URL(link(base, context));
        expect(rotating.searchParams.has('draft')).toBe(false);
        expect(arrivalOptions(rotating.search)).toEqual({ restoreView: camera, rotate: true });
        const noCamera = new URL(link(base, { ...context, camera: null }));
        expect(arrivalOptions(noCamera.search)).toEqual({ restoreView: null, rotate: true });
        expect(arrivalOptions(new URL(link(base, { ...context, rotate: false })).search)).toEqual({ restoreView: camera, rotate: false });
        expect(arrivalOptions('?rotate=yes')).toEqual({ restoreView: null, rotate: false });
        expect(arrivalOptions('')).toEqual({ restoreView: null, rotate: false });
        expect(new URL(link(base, { mode: '2d', at: context.at, rotate: true })).searchParams.has('rotate')).toBe(false);
    });
    it('writes the current address while preserving draft, unrelated parameters, path, and hash', () => {
        const href = 'https://app.example.test/designs/one,two?draft=private&backend=https%3A%2F%2Fapi.example.test&panel=closed#proposal';
        const url = new URL(address(href, { mode: 'model', at: '45,16,18', camera }));
        expect(url.pathname).toBe('/designs/one,two');
        expect(url.hash).toBe('#proposal');
        expect(url.searchParams.get('draft')).toBe('private');
        expect(url.searchParams.get('backend')).toBe('https://api.example.test');
        expect(url.searchParams.get('panel')).toBe('closed');
        expect(url.searchParams.get('at')).toBe('45,16,18');
        expect(readCamera(url.searchParams.get('camera'))).toEqual(camera);
    });
    it('uses canonical view parameters and removes stale 3D aliases when returning to 2D', () => {
        const base = 'https://app.example.test/map?3d&photo&model&mode3d&real&rl&rw&camera=old&rotate=1';
        const twoD = new URL(address(base, { mode: '2d', at: '45,16,18' }));
        for (const key of ['3d', 'photo', 'model', 'mode3d', 'real', 'rl', 'rw', 'camera', 'rotate']) {
            expect(twoD.searchParams.has(key), key).toBe(false);
        }
        const model = new URL(address(base, { mode: 'model', at: '45,16,18', camera }));
        expect(model.searchParams.has('3d')).toBe(true);
        expect(model.searchParams.has('photo')).toBe(false);
        const photo = new URL(address(base, { mode: 'photo', at: '45,16,18', camera }));
        expect(photo.searchParams.has('photo')).toBe(true);
        expect(photo.searchParams.has('3d')).toBe(false);
    });
    it('captures the geographic 3D camera target as the address location and retains map zoom', () => {
        const context = capture({
            map: { getCenter: () => ({ lat: 10, lng: 20 }), getZoom: () => 18 },
            __mapModeState: { desired: 'model' }, getThree3DGeoView: () => camera
        });
        expect(context.at).toBe('45,16,18');
        expect(readCamera(new URL(address('https://app.example.test/map', context)).searchParams.get('camera'))).toEqual(camera);
    });
    it('falls back to the Leaflet center when no geographic 3D camera is available', () => {
        expect(capture({ map: { getCenter: () => ({ lat: 10, lng: 20 }), getZoom: () => 18 },
            __mapModeState: { desired: 'model' }, getThree3DGeoView: () => null }).at).toBe('10,20,18');
    });
    it('guards address writes until the map, workspace, and mode are ready', () => {
        const win = addressWindow();
        const sync = createAddressSync(win);
        win.map = null;
        sync.write();
        expect(win.history.replaceState).not.toHaveBeenCalled();
        win.map = addressMap();
        win.BrowserWorkspace = { status: 'loading' };
        sync.write();
        expect(win.history.replaceState).not.toHaveBeenCalled();
        win.BrowserWorkspace.status = 'ready';
        win.__mapModeState.pending = true;
        sync.write();
        expect(win.history.replaceState).not.toHaveBeenCalled();
        win.__mapModeState.pending = false;
        sync.write();
        expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    });
    it('does not rewrite history when the address already represents the current view', () => {
        const win = addressWindow();
        win.location.href = address(win.location.href, { mode: '2d', at: '45,16,18' });
        const sync = createAddressSync(win);
        sync.write();
        expect(win.history.replaceState).not.toHaveBeenCalled();
    });
    it('bounds scheduled writes and uses the latest camera view at the trailing callback', () => {
        const win = addressWindow();
        const sync = createAddressSync(win);
        sync.schedule();
        sync.schedule();
        expect(win.timers).toHaveLength(1);
        expect(win.timers[0].delay).toBe(250);
        win.getThree3DGeoView = () => ({ ...camera, targetLat: 46, targetLng: 17 });
        win.__mapModeState.desired = 'model';
        win.timers[0].callback();
        expect(win.history.replaceState).toHaveBeenCalledTimes(1);
        const written = new URL(win.history.replaceState.mock.calls[0][2], win.location.href);
        expect(written.searchParams.get('at')).toBe('46,17,18');
        expect(readCamera(written.searchParams.get('camera'))).toEqual({ ...camera, targetLat: 46, targetLng: 17 });
    });
});

function addressMap() {
    return { getCenter: () => ({ lat: 45, lng: 16 }), getZoom: () => 18 };
}

function addressWindow() {
    const win = {
        location: { href: 'https://app.example.test/map?draft=private&panel=closed#proposal', search: '?draft=private&panel=closed' },
        map: addressMap(),
        __mapModeState: { desired: '2d', pending: false },
        history: { state: { marker: true }, replaceState: vi.fn() },
        timers: [],
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            this.timers.push(timer);
            return timer;
        }
    };
    return win;
}
