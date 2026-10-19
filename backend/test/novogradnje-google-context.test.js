import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/novogradnje/google-context.js', import.meta.url), 'utf8');
const body = parse(source, { sourceType: 'script' }).program.body[0].expression.callee.body.body;
const declaration = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'attach');

function fixture(initialElevationM = 0, attributionText = 'Google · imagery provider') {
    const frames = new Map(), listeners = {}, timers = [];
    let sequence = 0, intersection;
    const element = (tagName = 'div') => ({ tagName: tagName.toUpperCase(), children: [], dataset: {}, append(...nodes) { this.children.push(...nodes); },
        setAttribute() {}, remove: vi.fn() });
    class Vector {
        constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
        clone() { return new Vector(this.x, this.y, this.z); }
        sub() { return this; }
        normalize() { return this; }
        copy() { return this; }
        addScaledVector() { return this; }
    }
    class Group {
        constructor() { this.position = new Vector(); this.rotation = { set: vi.fn() }; }
        add() {}
        updateMatrixWorld() {}
    }
    class Plugin { constructor(options) { this.options = options; } }
    class Decoder {
        setDecoderPath() { return this; }
        dispose = vi.fn();
    }
    let tiles;
    class Tiles {
        constructor() {
            tiles = this; this.group = new Group(); this.events = {}; this.plugins = [];
            this.lruCache = {}; this.parseQueue = {}; this.downloadQueue = {}; this.visibleTiles = new Set();
        }
        registerPlugin(plugin) { this.plugins.push(plugin); }
        addEventListener(name, callback) { this.events[name] = callback; }
        removeEventListener(name) { delete this.events[name]; }
        getAttributions() { return []; }
        setCamera = vi.fn();
        setResolutionFromRenderer = vi.fn();
        update = vi.fn();
        dispose = vi.fn();
    }
    const host = element(), document = { hidden: false, createElement: element,
        addEventListener(name, callback) { listeners[name] = callback; }, removeEventListener(name) { delete listeners[name]; } };
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    const context = vm.createContext({
        ION_TOKEN: 'public-browser-test', ASSET_ID: 2275207, document,
        root: { __siteModelGeometry: { localFrame: () => ({ origin: [16, 45] }) },
            __photorealFrame: { TILES_FRAME_EULER: { x: Math.PI / 2, y: 0, z: Math.PI, order: 'ZYX' } },
            PhotorealAttribution: { attributionText: () => attributionText } },
        performance: { now: () => 0 },
        requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
        cancelAnimationFrame: id => frames.delete(id),
        setTimeout: callback => { timers.push(callback); return 1; }, clearTimeout: vi.fn(),
        IntersectionObserver: class { constructor(callback) { intersection = callback; return observer; } }
    });
    const attach = vm.runInContext(`(${source.slice(declaration.start, declaration.end)})`, context);
    const controls = { target: new Vector(), update: vi.fn() }, camera = { position: new Vector(), updateProjectionMatrix: vi.fn(), updateMatrixWorld: vi.fn() };
    const scene = { add: vi.fn(), remove: vi.fn() }, render = vi.fn(), group = { visible: true };
    const dispose = attach(host, { model: {} }, () => true, [
        { TilesRenderer: Tiles }, { CesiumIonAuthPlugin: Plugin, ReorientationPlugin: Plugin, GLTFExtensionsPlugin: Plugin, TileCompressionPlugin: Plugin }, { DRACOLoader: Decoder }
    ], { THREE: { Group, Color: class {} }, scene, group, camera, renderer: {}, controls, render }, initialElevationM);
    return { tiles, host, frames, document, listeners, timers, observer, dispose, render, camera, controls, group,
        visibility: visible => intersection([{ isIntersecting: visible }]),
        frame: now => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(now); } };
}

describe('bounded Google context streaming', () => {
    it('uses survey elevation only for the initial camera and keeps the overlay hidden until the mesh is aligned', () => {
        const f = fixture(125);
        expect(f.camera.position.z).toBe(125);
        expect(f.controls.target.z).toBe(125);
        expect(f.group.visible).toBe(false);
        f.dispose();
    });

    it('does not align against cached global triangles before tiles are visible', () => {
        const f = fixture();
        const model = { updateMatrixWorld: vi.fn() };
        f.tiles.events['load-model']({ scene: model });
        f.frame(2001);
        expect(model.updateMatrixWorld).not.toHaveBeenCalled();
        expect(f.host.dataset.googleState).toBe('loading');
        expect(f.group.visible).toBe(false);
        f.dispose();
    });

    it('anchors at the footprint origin, caps camera reach and bounds streaming work', () => {
        const f = fixture();
        expect(f.tiles.plugins[1].options).toEqual({ lat: Math.PI / 4, lon: 16 * Math.PI / 180, height: 0 });
        expect(f.camera.far).toBe(420);
        expect(f.tiles.lruCache.maxSize).toBe(160);
        expect(f.tiles.downloadQueue.maxJobs).toBe(4);
        expect(f.tiles.parseQueue.maxJobs).toBe(2);
        f.dispose();
    });

    it('pauses frame updates offscreen and in hidden tabs, and resumes when visible', () => {
        const f = fixture();
        f.frame(1001);
        expect(f.tiles.update).toHaveBeenCalledOnce();
        expect(f.render).toHaveBeenCalledOnce();
        f.visibility(false); expect(f.frames.size).toBe(0);
        f.visibility(true); expect(f.frames.size).toBe(1);
        f.document.hidden = true; f.listeners.visibilitychange(); expect(f.frames.size).toBe(0);
        f.document.hidden = false; f.listeners.visibilitychange(); expect(f.frames.size).toBe(1);
        f.dispose();
    });

    it('shows attribution and a retryable failure state instead of an indefinitely blank canvas', () => {
        const f = fixture();
        f.frame(1001);
        expect(f.host.children[1].children[1].children[1].textContent).toBe('Google · imagery provider');
        for(let time=2001;time<=46001;time+=1000)f.frame(time);
        expect(f.host.dataset.googleState).toBe('error');
        expect(f.host.children[0].textContent).toContain('Odaberi Model');
        expect(f.frames.size).toBe(0);
        f.dispose();
    });

    it('shows one Google Maps logo and preserves the full attribution in a closed native disclosure', () => {
        const attribution = 'Google · © 2026 Google · Airbus, Maxar Technologies';
        const f = fixture(0, attribution);
        f.frame(1001);
        const credit = f.host.children[1];
        expect(credit.className).toBe('context-google-credit');
        expect(credit.children.map(node => node.tagName)).toEqual(['IMG', 'DETAILS']);
        const [logo, sources] = credit.children;
        expect(logo.src).toBe('/novogradnje/google-maps-logo.svg');
        expect(logo.alt).toBe('Google Maps');
        expect(sources.className).toBe('context-google-sources');
        expect(sources.open).not.toBe(true);
        expect(sources.hidden).toBe(false);
        expect(sources.children.map(node => node.tagName)).toEqual(['SUMMARY', 'SPAN']);
        expect(sources.children[0].textContent).toBe('Izvori podataka');
        expect(sources.children[1].className).toBe('context-google-copyrights');
        expect(sources.children[1].textContent).toBe(attribution);
        f.dispose();
    });

    it('hides the source disclosure when no attribution text is available', () => {
        const f = fixture(0, '');
        f.frame(1001);
        const sources = f.host.children[1].children[1];
        expect(sources.hidden).toBe(true);
        expect(sources.children[1].textContent).toBe('');
        f.dispose();
    });

    it('disposes tile resources, observers, listeners and pending animation frames', () => {
        const f = fixture(); f.dispose();
        expect(f.tiles.dispose).toHaveBeenCalledOnce();
        expect(f.frames.size).toBe(0);
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
        expect(f.listeners).toEqual({});
        expect(f.tiles.events).toEqual({});
        expect(f.host.children.every(node => node.remove.mock.calls.length === 1)).toBe(true);
    });
});
