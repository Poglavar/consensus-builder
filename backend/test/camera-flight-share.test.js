// Flight transport verifies durable canonical publication and exact shared-route restoration.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const Share = require('../../frontend/js/camera-flight-share.js');
const CameraFlight = require('../../frontend/js/camera-flight.js');
const Cid = require('../../frontend/js/cid.js');
const MapShare = require('../../frontend/js/map-share.js');
const content = CameraFlight.create({ title: 'Courtyard flight', designCids: [],
    view: { at: '52.47,-1.88,18', mode: 'model', city: 'birmingham', language: 'en',
        camera: { targetLat: 52.47, targetLng: -1.88, headingDeg: 80, pitchRad: -.6, range: 200 },
        settings: { xray: '1', suggested: '1', suggestedExisting: '0', cutaway: 'all' } },
    frame: { lat: 52.47, lng: -1.88, datum: 'model-ground' },
    pose: { position: [0, 2, 0], quaternion: [0, 0, 0, 1] } });
content.route[0].holdSeconds = 2;
const cid = Cid.cidOfObject(content), row = { cid, content };
const bare = `https://app.example/flights/${cid}?backend=https%3A%2F%2Fapi.example`;
const hydrated = Share.restoreUrl(bare, content.view, MapShare);
function windowMock({ href = hydrated, fetch = vi.fn(async () => Response.json(row)) } = {}) {
    const location = new URL(href); location.replace = vi.fn();
    return { location, CameraFlight, Cid, MapShare, fetch,
        resolveFrontendBaseUrl: () => 'https://app.example', resolveBackendBaseUrl: () => 'https://api.example/',
        handleSharedDesignRoute: vi.fn(async () => ({ failed: [], omitted: [], blocked: false })),
        requestMapMode: vi.fn(async () => true), openCameraFlightEditor: vi.fn(async () => {}) };
}

describe('camera flight sharing', () => {
    it('recognizes only the flight route and hydrates settings once while preserving transport', () => {
        expect(Share.parsePath(`/flights/${cid}/`)).toBe(cid);
        expect(Share.parsePath(`/plans/${cid}`)).toBeNull();
        expect(Share.parsePath(`/flights/${cid}/extra`)).toBeNull();
        const url = new URL(hydrated);
        expect(url.searchParams.get('backend')).toBe('https://api.example');
        expect(url.searchParams.get('city')).toBe('birmingham'); expect(url.searchParams.get('lang')).toBe('en');
        expect(url.searchParams.get('xray')).toBe('1'); expect(url.searchParams.get('suggestedExisting')).toBe('0');
        expect(url.searchParams.get('cutaway')).toBe('all'); expect(url.searchParams.has('3d')).toBe(true);
        expect(Share.restoreUrl(hydrated, content.view, MapShare)).toBe(hydrated);
    });
    it('retains explicit URL overrides during saved-view hydration', () => {
        const url = new URL(Share.restoreUrl(bare + '&at=51,0,16&photo&city=london&lang=es&xray=0&cutaway=2', content.view, MapShare));
        expect(url.searchParams.get('at')).toBe('51,0,16'); expect(url.searchParams.has('3d')).toBe(false);
        expect(url.searchParams.get('city')).toBe('london'); expect(url.searchParams.get('lang')).toBe('es');
        expect(url.searchParams.get('xray')).toBe('0'); expect(url.searchParams.get('cutaway')).toBe('2');
    });
    it('creates the browser adapter before lazy dependencies exist without fetching', () => {
        const win = windowMock({ href: bare }); delete win.CameraFlight; delete win.Cid;
        const api = Share.browser(win); expect(win.fetch).not.toHaveBeenCalled(); expect(api.current).toBeNull();
        win.CameraFlight = CameraFlight; win.Cid = Cid;
        return expect(api.load(cid)).resolves.toEqual(row);
    });
    it('registers UMD globals without network or evaluator work at script startup', () => {
        const win = windowMock(); delete win.CameraFlight; delete win.Cid;
        const source = readFileSync(new URL('../../frontend/js/camera-flight-share.js', import.meta.url), 'utf8');
        vm.runInNewContext(source, { window: win });
        expect(win.CameraFlightShare).toBeDefined(); expect(typeof win.CameraFlightSharing.open).toBe('function');
        expect(win.fetch).not.toHaveBeenCalled();
    });
    it('reports save only after POST verification and durable GET, retaining backend override', async () => {
        const win = windowMock(), api = Share.browser(win);
        const saved = await api.save(content);
        expect(saved).toEqual({ ...row, link: bare }); expect(api.current).toEqual(row);
        expect(win.fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
            ['https://api.example/flights', 'POST'], [`https://api.example/flights/${cid}`, 'GET']]);
        expect(JSON.parse(win.fetch.mock.calls[0][1].body)).toEqual({ content });
        expect(win.fetch.mock.calls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true);
    });
    it('rejects invalid content before transport and invalid links before GET', async () => {
        const win = windowMock(), api = Share.browser(win);
        await expect(api.save({ ...content, title: '' })).rejects.toThrow();
        await expect(api.load('invalid')).rejects.toThrow('Invalid');
        expect(() => api.link('invalid')).toThrow('Invalid'); expect(win.fetch).not.toHaveBeenCalled();
    });
    it('rejects mismatched POST content before requesting readback', async () => {
        const win = windowMock({ fetch: vi.fn(async () => Response.json({ cid, content: { ...content, title: 'Changed' } })) });
        const api = Share.browser(win);
        await expect(api.save(content)).rejects.toThrow('does not match');
        expect(win.fetch).toHaveBeenCalledTimes(1); expect(api.current).toBeNull();
    });
    it.each([
        () => Response.json({ error: 'Not found' }, { status: 404 }),
        () => Response.json({ cid, content: { ...content, title: 'Changed' } }),
        () => Response.json({ cid: Cid.cidOfObject({ other: true }), content })
    ])('never reports a save whose durable readback failed or changed', async readback => {
        const win = windowMock({ fetch: vi.fn().mockResolvedValueOnce(Response.json(row)).mockImplementationOnce(readback) });
        const api = Share.browser(win);
        await expect(api.save(content)).rejects.toThrow(); expect(api.current).toBeNull();
    });
    it('preserves actionable service errors and explains non-JSON responses', async () => {
        const quota = windowMock({ fetch: async () => Response.json({ error: 'Quota exhausted', code: 'pinning-quota-exhausted', next: { action: 'Restore quota' } }, { status: 409 }) });
        await expect(Share.browser(quota).save(content)).rejects.toMatchObject({ message: 'Quota exhausted', code: 'pinning-quota-exhausted', next: { action: 'Restore quota' } });
        const unreadable = windowMock({ fetch: async () => new Response('<html>error</html>', { status: 503 }) });
        await expect(Share.browser(unreadable).load(cid)).rejects.toThrow('unreadable response');
    });
    it('loads before hydration then reloads before touching designs or the editor', async () => {
        const win = windowMock({ href: bare }), api = Share.browser(win);
        expect(await api.open()).toEqual({ redirecting: true });
        expect(win.fetch).toHaveBeenCalledTimes(1); expect(win.location.replace).toHaveBeenCalledWith(hydrated);
        expect(win.handleSharedDesignRoute).not.toHaveBeenCalled(); expect(win.openCameraFlightEditor).not.toHaveBeenCalled();
    });
    it('restores designs, waits for model readiness, then opens read-only with no autoplay', async () => {
        const win = windowMock(), events = [];
        let resolveMode;
        win.handleSharedDesignRoute.mockImplementation(async () => { events.push('designs'); return { failed: [], blocked: false }; });
        win.requestMapMode.mockImplementation(() => { events.push('model'); return new Promise(resolve => { resolveMode = resolve; }); });
        win.openCameraFlightEditor.mockImplementation(async () => { events.push('editor'); });
        const api = Share.browser(win), opening = api.open();
        await vi.waitFor(() => expect(win.requestMapMode).toHaveBeenCalledTimes(1));
        expect(win.openCameraFlightEditor).not.toHaveBeenCalled(); expect(api.current).toBeNull();
        resolveMode(true); await opening;
        expect(events).toEqual(['designs', 'model', 'editor']);
        expect(win.handleSharedDesignRoute).toHaveBeenCalledWith([], { frame: false, openDetails: false });
        expect(win.requestMapMode).toHaveBeenCalledWith('model', { restoreView: content.view.camera, fromUrl: true });
        expect(win.openCameraFlightEditor).toHaveBeenCalledWith({ record: content, readOnly: true, cid }); expect(api.current).toEqual(row);
    });
    it.each([{ blocked: true, failed: [] }, { failed: [{ cid }] }, { failed: [], omitted: [{ cid }] }])('stops when the selected composition could not be fully restored', async result => {
        const win = windowMock(); win.handleSharedDesignRoute.mockResolvedValue(result);
        const api = Share.browser(win);
        await expect(api.open()).rejects.toThrow('not fully restored');
        expect(win.requestMapMode).not.toHaveBeenCalled(); expect(win.openCameraFlightEditor).not.toHaveBeenCalled(); expect(api.current).toBeNull();
    });
    it('rejects failed model readiness and propagates editor failures', async () => {
        const win = windowMock(); win.requestMapMode.mockResolvedValue(false);
        await expect(Share.browser(win).open()).rejects.toThrow('model view'); expect(win.openCameraFlightEditor).not.toHaveBeenCalled();
        win.requestMapMode.mockResolvedValue(true); win.openCameraFlightEditor.mockRejectedValue(new Error('Interior unavailable'));
        const api = Share.browser(win); await expect(api.open()).rejects.toThrow('Interior unavailable'); expect(api.current).toBeNull();
    });
    it('ignores other routes without fetching', async () => {
        const win = windowMock({ href: 'https://app.example/' });
        await Share.browser(win).open(); expect(win.fetch).not.toHaveBeenCalled();
    });
});
