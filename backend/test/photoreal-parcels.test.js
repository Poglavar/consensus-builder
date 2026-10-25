// Boundary drawing and source geometry remain available to shared 3D selection independently of visibility.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { projectFeatures, parcelsAt, texturePoint, windowSpan, patchShader, create } = require('../../frontend/js/photoreal-parcels.js');
const ring = (x, y, width = 10) => [[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]];
const feature = (id, coordinates, type = 'Polygon') => ({ type: 'Feature', properties: { parcelId: id }, geometry: { type, coordinates } });
const project = (lat, lng) => [lng, lat];
const bounds = [-100, -100, 100, 100];

describe('source parcel projection and picking', () => {
    it('projects longitude/latitude in the scene frame and excludes distant source parcels', () => {
        const result = projectFeatures([feature('near', [ring(0, 0)]), feature('far', [ring(500, 500)])],
            (lat, lng) => [lng * 2 + 5, lat * 3 - 7], bounds);
        expect(result.map(p => p.id)).toEqual(['near']);
        expect(result[0].polygons[0][0][0]).toEqual([5, -7]);
        expect(result[0].bounds).toEqual([5, -7, 25, 23]);
    });
    it('retains holes and disconnected parts for drawing and selection', () => {
        const result = projectFeatures([feature('multi', [[ring(0, 0, 20), ring(5, 5, 3)], [ring(40, 40)]], 'MultiPolygon')], project, bounds);
        expect(result[0].polygons).toHaveLength(2);
        expect(result[0].polygons[0]).toHaveLength(2);
        expect(parcelsAt(result, 2, 2).map(p => p.id)).toEqual(['multi']);
        expect(parcelsAt(result, 6, 6)).toEqual([]);
        expect(parcelsAt(result, 45, 45).map(p => p.id)).toEqual(['multi']);
        expect(parcelsAt(result, 30, 30)).toEqual([]);
    });
    it('preserves overlapping source outlines instead of silently choosing a cadastral identity', () => {
        const result = projectFeatures([feature('a', [ring(0, 0)]), feature('b', [ring(2, 2)])], project, bounds);
        expect(parcelsAt(result, 5, 5).map(p => p.id)).toEqual(['a', 'b']);
    });
    it('does not invent usable geometry from an invalid source coordinate or missing identity', () => {
        const broken = feature('broken', [ring(0, 0)]);
        broken.geometry.coordinates[0][1][0] = NaN;
        expect(projectFeatures([broken, feature(null, [ring(0, 0)]), { geometry: null }], project, bounds)).toEqual([]);
    });
    it('keeps north at the top of the canvas so CanvasTexture flipY matches scene Y', () => {
        expect(texturePoint(-100, 100, bounds, 2048)).toEqual([0, 0]);
        expect(texturePoint(100, -100, bounds, 2048)).toEqual([2048, 2048]);
        expect(texturePoint(0, 0, bounds, 2048)).toEqual([1024, 1024]);
    });
    it('refines line resolution near the camera without rebuilding for small orbit changes', () => {
        expect(windowSpan(100, 1)).toBe(200);
        expect(windowSpan(110, 1)).toBe(200);
        expect(windowSpan(400, 1)).toBe(800);
        expect(windowSpan(100 * 1.43, 1.43)).toBeCloseTo(200 * 1.43);
        expect(windowSpan(1, 1)).toBe(100);
        expect(windowSpan(10000, 1)).toBe(1600);
    });
    it('adds overlay ink after tile lighting while retaining the existing carve and shared uniforms', () => {
        const uniforms = { uParcelOn: { value: 0 }, uParcelOverlay: { value: null } };
        const shader = { uniforms: { uCorridorOn: { value: 1 } }, fragmentShader: '#include <common>\nvoid main(){ discard; #include <dithering_fragment> }' };
        patchShader(shader, uniforms);
        expect(shader.fragmentShader).toContain('discard;');
        expect(shader.fragmentShader).toContain('(vCorridorWorld.xy - uParcelMin) * uParcelInvSpan');
        expect(shader.fragmentShader.indexOf('gl_FragColor.rgb = mix')).toBeGreaterThan(shader.fragmentShader.indexOf('#include <dithering_fragment>'));
        uniforms.uParcelOn.value = 1;
        expect(shader.uniforms.uParcelOn.value).toBe(1);
        expect(shader.uniforms.uCorridorOn.value).toBe(1);
    });
});

function fixture({ pending = false, visible = true } = {}) {
    const nodes = new Map();
    function element() {
        const handlers = {};
        return { checked: true, hidden: true, textContent: '', handlers,
            classList: { add() {}, remove() {} }, parentNode: { appendChild() {} },
            addEventListener: (key, fn) => { handlers[key] = fn; },
            removeEventListener: (key, fn) => { if (handlers[key] === fn) delete handlers[key]; } };
    }
    for (const id of ['photo-parcels-visible', 'photo-parcels-status']) nodes.set(id, element());
    nodes.get('photo-parcels-visible').checked = visible;
    const context = { clearRect: vi.fn(), beginPath: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
        stroke: vi.fn(), fill: vi.fn() };
    const textures = [];
    const screen = element();
    let resolve;
    const response = { features: [feature('source-1', [ring(0, 0)]), feature('overlap-2', [ring(2, 2)])] };
    const source = pending ? new Promise(done => { resolve = done; }) : Promise.resolve(response);
    const root = {
        ...element(), document: { documentElement: {}, getElementById: id => nodes.get(id), createElement: () => ({ getContext: () => context }) },
        THREE: { CanvasTexture: class { constructor() { this.dispose = vi.fn(); textures.push(this); } }, Vector2: class { set() {} }, LinearFilter: 1 },
        MutationObserver: class { observe() {} disconnect() {} }, __photorealFrame: { mercatorScaleFactor: () => 1 },
        getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }), L: { latLngBounds: (sw, ne) => [sw, ne] },
        CadastralParcelRepository: { ensureBounds: vi.fn(() => source) }, turf: { area: () => 100 }, invalidateThreeView: vi.fn()
    };
    const internals = { originLatLng: () => ({ lat: 0 }), controls: { target: { x: 0, y: 0 } }, latLngToXY: project,
        camera: { position: { distanceTo: () => 400 } },
        xyToLatLng: (x, y) => ({ lat: y, lng: x }), renderer: { domElement: screen } };
    const overlay = create({ root, internals });
    return { root, nodes, screen, overlay, texture: textures[0], context, internals, response, finish: () => resolve(response) };
}

describe('photo overlay lifecycle', () => {
    it('supplies overlapping source geometry without owning any click or keyboard selection handlers', async () => {
        const f = fixture();
        await Promise.resolve();
        expect(f.overlay.uniforms.uParcelOn.value).toBe(1);
        expect(f.context.stroke).toHaveBeenCalled();
        expect(f.overlay.at(5, 5).map(parcel => parcel.id)).toEqual(['source-1', 'overlap-2']);
        expect(f.overlay.at(50, 50)).toEqual([]);
        expect(f.screen.handlers).toEqual({});
        expect(f.root.handlers).toEqual({});
        f.overlay.dispose();
        expect(f.overlay.at(5, 5)).toEqual([]);
    });
    it('toggles boundary ink while source geometry remains available for shared selection', async () => {
        const f = fixture({ visible: false });
        await Promise.resolve();
        expect(f.root.CadastralParcelRepository.ensureBounds).toHaveBeenCalledTimes(1);
        expect(f.overlay.uniforms.uParcelOn.value).toBe(0);
        expect(f.overlay.at(5, 5)).toHaveLength(2);
        const toggle = f.nodes.get('photo-parcels-visible');
        toggle.checked = true; toggle.handlers.change();
        await Promise.resolve();
        expect(f.overlay.uniforms.uParcelOn.value).toBe(1);
        toggle.checked = false; toggle.handlers.change();
        expect(f.overlay.uniforms.uParcelOn.value).toBe(0);
        expect(f.overlay.at(5, 5)).toHaveLength(2);
        f.overlay.dispose();
    });
    it('follows a moved camera target once, but does no repeated source work at rest', async () => {
        const f = fixture();
        await Promise.resolve();
        f.overlay.update(); f.overlay.update();
        expect(f.root.CadastralParcelRepository.ensureBounds).toHaveBeenCalledTimes(1);
        f.internals.controls.target.x = 300;
        f.overlay.update();
        await Promise.resolve();
        expect(f.root.CadastralParcelRepository.ensureBounds).toHaveBeenCalledTimes(2);
        f.overlay.dispose();
    });
    it('aborts pending source work and ignores its late result after leaving Photo view', async () => {
        const f = fixture({ pending: true });
        const signal = f.root.CadastralParcelRepository.ensureBounds.mock.calls[0][1].signal;
        f.overlay.dispose();
        f.finish(); await Promise.resolve();
        expect(signal.aborted).toBe(true);
        expect(f.texture.dispose).toHaveBeenCalledTimes(1);
        expect(f.context.stroke).not.toHaveBeenCalled();
        expect(f.overlay.uniforms.uParcelOverlay.value).toBeNull();
        expect(f.screen.handlers.click).toBeUndefined();
    });
    it('rebinds retained tile shaders to a fresh texture on Photo re-entry using the same uniform objects', async () => {
        const f = fixture();
        await Promise.resolve();
        const shader = { uniforms: {}, fragmentShader: '#include <common>\n#include <dithering_fragment>' };
        patchShader(shader, f.overlay.uniforms);
        f.overlay.dispose();
        expect(shader.uniforms.uParcelOverlay.value).toBeNull();
        const next = create({ root: f.root, internals: f.internals, pickSurface: f.pickSurface, uniforms: f.overlay.uniforms });
        await Promise.resolve();
        expect(shader.uniforms.uParcelOn.value).toBe(1);
        expect(shader.uniforms.uParcelOverlay.value).not.toBe(f.texture);
        next.dispose();
    });
});
