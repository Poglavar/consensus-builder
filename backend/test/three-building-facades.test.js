// Locks parcel-based design identity, wall-local metric mapping, shared toggles and resource ownership.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const facades = require('../../frontend/js/three-building-facades.js');
const screenDoor = require('../../frontend/js/three-screen-door.js');
const THREE = {
    Color: class { constructor(color) { this.color = color; } multiplyScalar(tone) { this.tone = tone; return this; } },
    Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } }
};

const polygon = points => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [points] } });
const rectangle = polygon([[15, 44], [15.001, 44], [15.001, 44.001], [15, 44.001], [15, 44]]);
const shader = () => ({ uniforms: {}, vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader: 'void main() {\n#include <color_fragment>\n#include <alphatest_fragment>\n#include <lights_phong_fragment>\n#include <opaque_fragment>\n}' });
const material = () => ({ userData: {}, onBeforeCompile() {}, customProgramCacheKey() { return 'phong'; } });

function declarationSource(name) {
    const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script' });
    const found = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    expect(found, `Expected one ${name} declaration`).toHaveLength(1);
    return source.slice(found[0].start, found[0].end);
}

describe('procedural building facades', () => {
    it('keeps a parcel design across volumes, proposals, regeneration and height changes', () => {
        const original = { ...rectangle, properties: { proposalId: 42, buildingIndex: 3, parcelId: '123/4' } };
        const changed = { ...original, id: 'another-volume',
            properties: { parcelId: '123/4', proposalId: 99, buildingIndex: 8, buildingId: 'new', variationSeed: 17 },
            geometry: polygon([[0, 0], [1, 0], [0, 1], [0, 0]]).geometry };
        const key = facades.buildingKey(original, 'zagreb');
        expect(facades.buildingKey(changed, 'zagreb')).toBe(key);
        const design = facades.buildingDesign(key, 19.8);
        expect(design).toEqual(facades.buildingDesign(key, 19.8));
        expect(facades.buildingDesign(key, 26.4)).toMatchObject({ seed: design.seed, style: design.style, bayWidth: design.bayWidth,
            windowStyle: design.windowStyle, shutters: design.shutters, shutterColor: design.shutterColor });
        expect(design.floorHeight).toBeCloseTo(3.3);
        expect(facades.buildingDesign(key, 35, 3.5).floorHeight).toBe(3.5);
        expect(facades.buildingKey(original, 'sibenik')).not.toBe(key);
        expect(facades.buildingKey({ ...original, properties: { ...original.properties, parcelId: '123/5' } }, 'zagreb')).not.toBe(key);
    });

    it('normalizes parcel IDs while retaining building identity when no parcel is known', () => {
        const withParcel = parcelId => ({ ...rectangle, properties: { parcelId } });
        expect(facades.buildingKey(withParcel(123), 'zagreb')).toBe(facades.buildingKey(withParcel(' 123 '), 'zagreb'));
        expect(facades.buildingKey(withParcel(0), 'zagreb')).not.toBe(facades.buildingKey(rectangle, 'zagreb'));
        const anonymous = { ...rectangle, properties: { proposalId: 42, buildingId: 'volume-a' } };
        expect(facades.buildingKey(anonymous)).not.toBe(facades.buildingKey({ ...anonymous,
            properties: { ...anonymous.properties, buildingId: 'volume-b' } }));
    });

    it('canonicalizes anonymous geometry regardless of ring start, winding or closing vertex', () => {
        const a = facades.buildingKey(rectangle);
        const ring = rectangle.geometry.coordinates[0].slice(0, -1);
        const reordered = [ring[2], ring[1], ring[0], ring[3], ring[2]];
        expect(facades.buildingKey(polygon(reordered))).toBe(a);
        expect(facades.buildingKey(polygon(ring))).toBe(a);
    });

    it('varies within the style grammar and rejects missing heights', () => {
        const designs = Array.from({ length: 50 }, (_, i) => facades.buildingDesign('building-' + i, 10));
        expect(new Set(designs.map(d => d.style)).size).toBe(3);
        expect(new Set(designs.map(d => d.bayWidth)).size).toBeGreaterThan(3);
        expect(designs.every(d => d.bayWidth >= 2.8 && d.bayWidth <= 3.6)).toBe(true);
        for (const height of [null, undefined, NaN, 0, -1]) expect(() => facades.buildingDesign('x', height)).toThrow();
    });

    it('reserves glass in Mixed for ten or more modelled storeys', () => {
        for (const storeyHeight of [3.3, 3.5, 4]) {
            const low = Array.from({ length: 100 }, (_, i) => facades.buildingDesign('tower-' + i, 9 * storeyHeight, storeyHeight));
            const tall = Array.from({ length: 100 }, (_, i) => facades.buildingDesign('tower-' + i, 10 * storeyHeight, storeyHeight));
            expect(low.every(d => !facades.STYLES[d.style].panelWidth)).toBe(true);
            expect(new Set(tall.map(d => facades.STYLES[d.style].id))).toEqual(new Set(facades.STYLES.map(s => s.id)));
        }
    });

    it('varies window families and shutter palettes without changing a building when its neighbours change', () => {
        const keys = Array.from({ length: 60 }, (_, i) => 'window-building-' + i);
        const designs = keys.map(key => facades.buildingDesign(key, 16.5));
        expect(new Set(designs.map(d => facades.WINDOW_STYLES[d.windowStyle].id)))
            .toEqual(new Set(['casement', 'sash', 'arched']));
        expect(designs.some(d => d.shutters)).toBe(true);
        expect(designs.some(d => !d.shutters)).toBe(true);
        expect(new Set(designs.filter(d => d.shutters).map(d => facades.SHUTTER_COLORS[d.shutterColor])).size).toBeGreaterThan(1);
        expect([...keys].reverse().map(key => facades.buildingDesign(key, 16.5)).reverse()).toEqual(designs);
    });

    it('varies glass tints between buildings on the same parcel and retains them across height and neighbour changes', () => {
        const buildings = Array.from({ length: 50 }, (_, i) => ({ ...rectangle,
            properties: { parcelId: 'shared-parcel', proposalId: 42, buildingIndex: i } }));
        const designFor = (building, height = 99) => facades.buildingDesign(facades.buildingKey(building), height, 3.3,
            facades.buildingIdentityKey(building));
        const designs = buildings.map(building => designFor(building));
        expect(new Set(designs.map(d => d.seed)).size).toBe(1);
        expect(new Set(designs.map(d => d.style)).size).toBe(6);
        expect(new Set(designs.map(d => d.glassColor)).size).toBeGreaterThan(4);
        expect(new Set(designs.map(d => `${d.glassColor}:${d.glassTone}`)).size).toBeGreaterThan(25);
        for (const [index, building] of buildings.entries()) {
            expect(designFor(building, 198)).toMatchObject({ glassColor: designs[index].glassColor, glassTone: designs[index].glassTone });
        }
        expect([...buildings].reverse().map(building => designFor(building)).reverse()).toEqual(designs);
    });

    it('uses original building identity for glass when preparing a parcel-owned mesh', () => {
        const owner = { ...rectangle, properties: { parcelId: 'shared-parcel' } };
        const building = { ...rectangle, properties: { proposalId: 42, buildingIndex: 7 } };
        const configureMaterial = vi.fn(value => value);
        const mesh = { material: material(), userData: {}, geometry: {
            attributes: { position: { array: [] }, normal: { array: [] } }, setAttribute: vi.fn()
        } };
        const context = { buildingFacades: { ...facades, configureMaterial }, facadeState: {},
            THREE: { Float32BufferAttribute: class {} } };
        vm.runInNewContext(declarationSource('prepareProceduralFacadeMeshes'), context);
        context.prepareProceduralFacadeMeshes([mesh], owner, 99, 3.3, 1, 'city', true, building);
        expect(configureMaterial.mock.calls[0][1]).toEqual(facades.buildingDesign(facades.buildingKey(owner, 'city'),
            99, 3.3, facades.buildingIdentityKey(building, 'city')));
        expect(mesh.userData.cbFacadeOwned).toBe(true);
    });

    it('joins triangulated walls into one metre-scaled span, leaving roof vertices untextured', () => {
        const positions = [
            100, 200, 0, 120, 200, 0, 120, 200, 9.9,
            100, 200, 0, 120, 200, 9.9, 100, 200, 9.9,
            100, 200, 9.9, 120, 200, 9.9, 110, 210, 9.9
        ];
        const normals = [...Array.from({ length: 6 }, () => [0, -1, 0]).flat(), ...Array.from({ length: 3 }, () => [0, 0, 1]).flat()];
        const coords = facades.wallCoordinates(positions, normals, 0.7);
        expect(Array.from(coords.slice(0, 6))).toEqual([0, 0, 14, 14, 0, 14]);
        expect(coords[7]).toBeCloseTo(9.9); // only XY needs Mercator correction
        expect(Array.from(coords.slice(18))).toEqual(Array(9).fill(0));
        const translated = positions.map((value, i) => value + (i % 3 === 0 ? 1234 : i % 3 === 1 ? -5432 : 0));
        expect(facades.wallCoordinates(translated, normals, 0.7)).toEqual(coords);
    });

    it('maps angled and courtyard walls using their own tangent, independently of winding', () => {
        const positions = [0, 0, 0, 3, 4, 0, 3, 4, 10, 0, 0, 0, 3, 4, 10, 0, 0, 10];
        const normals = Array.from({ length: 6 }, () => [0.8, -0.6, 0]).flat();
        const coords = facades.wallCoordinates(positions, normals);
        expect(coords[0]).toBe(0);
        expect(coords[3]).toBe(5);
        expect(coords[2]).toBe(5);
        const inward = facades.wallCoordinates(positions, normals.map(n => -n));
        expect(inward[0]).toBe(5);
        expect(inward[3]).toBe(0);
        expect(inward[2]).toBe(5);
    });

    it('composes with grain transparency and updates every compiled material through shared uniforms', () => {
        const state = facades.createState(THREE);
        const first = material(), second = material();
        screenDoor.configureMaterial(first, { coverage: 0.5 });
        facades.configureMaterial(first, facades.buildingDesign('a', 20), state, THREE);
        facades.configureMaterial(second, facades.buildingDesign('b', 20), state, THREE);
        const s1 = shader(), s2 = shader();
        first.onBeforeCompile(s1);
        second.onBeforeCompile(s2);
        expect(s1.fragmentShader).toContain('discard;');
        expect(s1.uniforms.cbScreenDoorCoverage.value).toBe(0.5);
        expect(s1.vertexShader).toContain('vCbFacade = cbFacadeCoord;');
        expect(s1.fragmentShader).toContain('diffuseColor.rgb = cbFacadeColor(diffuseColor.rgb);');
        expect(s1.fragmentShader).toContain('outgoingLight = cbFacadeReflection(outgoingLight, normalize(vViewPosition), normal);');
        expect(s1.fragmentShader).toContain('material.specularShininess = mix(material.specularShininess, 180.0, cbFacadeGlazing);');
        expect(s1.uniforms.cbFacadeEnabled).toBe(s2.uniforms.cbFacadeEnabled);
        const firstDesign = facades.buildingDesign('a', 20);
        expect(s1.uniforms.cbFacadeWindows.value).toMatchObject({ x: firstDesign.windowStyle, y: firstDesign.shutters ? 1 : 0 });
        expect(s1.uniforms.cbFacadeShutterColor.value.color).toBe(facades.SHUTTER_COLORS[firstDesign.shutterColor]);
        expect(s1.uniforms.cbFacadeGlassColor.value).toMatchObject({ color: facades.GLASS_COLORS[firstDesign.glassColor], tone: firstDesign.glassTone });
        const key = first.customProgramCacheKey();
        facades.setState(state, true, 'stone');
        expect(s1.uniforms.cbFacadeEnabled.value).toBe(1);
        expect(s2.uniforms.cbFacadeStyleOverride.value).toBe(1);
        for (const preset of ['glass-small', 'glass-medium', 'glass-large']) {
            facades.setState(state, true, preset);
            expect(first.transparent).toBe(false);
            expect(first.opacity).toBe(1);
            expect(first.depthWrite).toBe(true);
        }
        facades.setState(state, false, 'mixed');
        expect(s1.uniforms.cbFacadeEnabled.value).toBe(0);
        expect(s2.uniforms.cbFacadeStyleOverride.value).toBe(-1);
        expect(first.customProgramCacheKey()).toBe(key);
        expect(first.transparent).toBe(false);
        expect(first.depthWrite).toBe(true);
    });

    it('fails clearly if a Three upgrade removes a shader integration point', () => {
        expect(() => facades.patchShader({ vertexShader: '', fragmentShader: '' })).toThrow(/shader chunks/);
    });

    it('preserves masonry coverage across pixel footprints instead of widening the mortar with distance', () => {
        // Evaluate the actual scalar GLSL math, using JS equivalents of its built-ins. This
        // checks the area-preserving filter itself without a second implementation of it.
        const fragment = facades.patchShader(shader()).fragmentShader;
        const scalarFunctions = ['cbFacadeJointIntegral', 'cbFacadeJointCoverage'].map(name => {
            const declaration = fragment.match(new RegExp(`float ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
            expect(declaration, `Missing shader function ${name}`).not.toBeNull();
            return declaration[0].replace(/^float /, 'function ')
                .replace(/\bfloat (?=\w+\s*=)/g, 'let ')
                .replace(/\bfloat /g, '');
        }).join('\n');
        const context = {
            floor: Math.floor, max: Math.max,
            fract: x => x - Math.floor(x),
            clamp: (x, low, high) => Math.max(low, Math.min(high, x))
        };
        vm.runInNewContext(scalarFunctions, context);
        const coverage = (phase, footprint) => context.cbFacadeJointCoverage(phase, footprint, 0.07);
        expect(coverage(0.5, 0.01)).toBeCloseTo(1);
        expect(coverage(0, 0.01)).toBeCloseTo(0);
        for (const footprint of [0.01, 0.07, 0.25, 0.7, 1, 2.3, 4]) {
            const samples = Array.from({ length: 1000 }, (_, i) => coverage((i + 0.5) / 1000, footprint));
            expect(samples.every(value => value >= -1e-8 && value <= 1 + 1e-8)).toBe(true);
            expect(samples.reduce((sum, value) => sum + value, 0) / samples.length).toBeCloseTo(0.93, 4);
            expect(coverage(-3.72, footprint)).toBeCloseTo(coverage(8.28, footprint), 10);
        }
        // Glass mullions occupy a fixed metric width, even when several panels fit in a pixel.
        for (const panelWidth of [1, 1.6, 3.2]) {
            const gap = 0.055 / panelWidth;
            for (const footprint of [0.01, 0.1, 0.7, 2, 4]) {
                const samples = Array.from({ length: 2000 }, (_, i) => context.cbFacadeJointCoverage((i + 0.5) / 2000, footprint, gap));
                expect(samples.every(value => value >= -1e-8 && value <= 1 + 1e-8)).toBe(true);
                expect(samples.reduce((sum, value) => sum + value, 0) / samples.length).toBeCloseTo(1 - gap, 4);
            }
        }
    });

    it('constructs controls without overwriting saved preferences, then restores and saves user changes', () => {
        // Exercise the real viewer setter with storage/control collaborators, without a browser.
        const setter = declarationSource('setFacadeAppearance');
        const saved = new Map([['enabled', '1'], ['style', 'brick']]);
        const context = {
            buildingFacades: facades, facadeState: facades.createState(THREE),
            facadesEnabled: false, facadeStyle: 'mixed', facadeFloorLineMaterial: {},
            facadeCheckbox: {}, facadeStyleSelect: {}, facadeNote: {},
            FACADE_PREF_KEY: 'enabled', FACADE_STYLE_KEY: 'style',
            PersistentStorage: { setItem: (key, value) => saved.set(key, value) },
            frames: 0
        };
        // the view renders on demand: every appearance change must ask for a frame
        context.invalidateThreeView = () => { context.frames += 1; };
        vm.runInNewContext(setter + '\nsetFacadeAppearance(false, "mixed", false);', context);
        expect(saved.get('enabled')).toBe('1');
        expect(saved.get('style')).toBe('brick');
        context.setFacadeAppearance(saved.get('enabled') === '1', saved.get('style'), false);
        expect(context.facadeCheckbox.checked).toBe(true);
        expect(context.facadeStyleSelect).toMatchObject({ value: 'brick', disabled: false });
        expect(context.facadeFloorLineMaterial.visible).toBe(false);
        context.setFacadeAppearance(false, 'plaster');
        expect(saved.get('enabled')).toBe('0');
        expect(saved.get('style')).toBe('plaster');
        expect(context.facadeNote.hidden).toBe(true);
        expect(context.frames).toBe(3);
        for (const id of ['glass-small', 'glass-medium', 'glass-large']) {
            context.setFacadeAppearance(true, id);
            expect(saved.get('style')).toBe(id);
            expect(context.facadeStyleSelect).toMatchObject({ value: id, disabled: false });
            const selected = context.facadeState.cbFacadeStyleOverride.value;
            expect(facades.STYLES[selected].id).toBe(id);
            expect(context.facadeState.cbFacadePanels.value[selected]).toMatchObject({
                x: facades.STYLES[selected].panelWidth, y: facades.STYLES[selected].rowsPerStorey
            });
        }
    });

    it('disposes owned geometry and materials once, retaining imported and shared resources', () => {
        const node = (data = {}, children = []) => ({ ...data, children, traverse(fn) { fn(this); this.children.forEach(child => child.traverse(fn)); } });
        const geometry = { dispose: vi.fn() }, surface = { userData: { cbProceduralFacade: true }, dispose: vi.fn() };
        const sharedLine = { userData: {}, dispose: vi.fn() }, imported = { dispose: vi.fn() };
        const depth = { userData: {}, dispose: vi.fn() };
        const tree = node({}, [
            node({ userData: { cbFacadeOwned: true }, geometry, material: surface }, [
                node({ userData: { cbSmoothGhostDepthPrepass: true }, geometry, material: depth })
            ]),
            node({ userData: { cbFacadeOwned: true }, geometry, material: sharedLine }),
            node({ geometry: imported, material: imported })
        ]);
        facades.disposeGroup(tree.children);
        expect(geometry.dispose).toHaveBeenCalledTimes(1);
        expect(surface.dispose).toHaveBeenCalledTimes(1);
        expect(depth.dispose).toHaveBeenCalledTimes(1);
        expect(sharedLine.dispose).not.toHaveBeenCalled();
        expect(imported.dispose).not.toHaveBeenCalled();
    });
});
