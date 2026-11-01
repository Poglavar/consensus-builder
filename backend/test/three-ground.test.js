// Ground renderer (frontend/js/three-ground.js) against a stub THREE: the four meshes it mounts in
// draw order, the stencil lid and the holes it cuts, the normals it uploads, the metric scale and
// clean disposal.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, designSurface, COLORS, OFFSET, MAX_DESIGN_RANK, ORDER, STENCIL_BIT, PARCEL_BIT, PAVE_SLAB_M } = require('../../frontend/js/three-ground.js');
const { readFileSync } = require('node:fs');
const { buildGroundGeometry } = require('../../frontend/js/life/ground-geometry.js');

function stubThree() {
    const disposed = [];
    class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } }
    class BufferGeometry {
        constructor() { this.attributes = {}; this.index = null; }
        setAttribute(name, attribute) { this.attributes[name] = attribute; }
        setIndex(attribute) { this.index = attribute; }
        computeBoundingSphere() { this.boundingSphere = true; }
        dispose() { disposed.push('geometry'); }
    }
    class Group {
        constructor() { this.children = []; this.scale = { set: (x, y, z) => { this.scale.x = x; this.scale.y = y; this.scale.z = z; } }; }
        add(o) { this.children.push(o); }
        remove(o) { this.children = this.children.filter(c => c !== o); }
    }
    class Mesh { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.userData = {}; } }
    class Material { constructor(params) { Object.assign(this, params); } dispose() { disposed.push('material'); } }
    class MeshLambertMaterial extends Material { }
    class MeshBasicMaterial extends Material { }
    const THREE = {
        BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial, MeshBasicMaterial,
        NotEqualStencilFunc: 'not-equal', EqualStencilFunc: 'equal', GreaterStencilFunc: 'greater', AlwaysStencilFunc: 'always', KeepStencilOp: 'keep', ReplaceStencilOp: 'replace', DoubleSide: 'double'
    };
    return { THREE, disposed };
}

const result = () => buildGroundGeometry({ bounds: [-10, -10, 10, 10], carriageways: [{ pts: [[-10, 0], [10, 0]], halfWidth: 3, drop: 0.15, lanes: [{ offset: -1.5, dir: 1 }, { offset: 1.5, dir: -1 }] }] });
const byName = (layer, name) => layer.group.children.find(m => m.name === name);

describe('three-ground', () => {
    it('mounts lid, roadbed, kerb, markings and pavement in draw order in a metric group', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE, k: 1.4 });
        expect([layer.group.scale.x, layer.group.scale.y, layer.group.scale.z]).toEqual([1.4, 1.4, 1]);
        layer.setGeometry(result());
        expect(layer.group.children.map(m => m.name)).toEqual(['ground-lid', 'ground-roadbed', 'ground-kerb', 'ground-markings', 'ground-pavement']);
        expect(layer.group.children.map(m => m.renderOrder)).toEqual([ORDER.lid, ORDER.roadbed, ORDER.kerb, ORDER.markings, ORDER.pavement]);
        expect(byName(layer, 'ground-markings').material.color).toBe(COLORS.markings);
        // Lane lines are pulled forward of the asphalt they lie on…
        expect(byName(layer, 'ground-markings').material.polygonOffsetFactor).toBeLessThan(byName(layer, 'ground-roadbed').material.polygonOffsetFactor);
        // …and every coloured ground surface sits behind building faces (factor 1, units 1 in
        // three-mode.js), or a wall seen at an angle lost its foot to the paving.
        for (const mesh of layer.group.children.filter(m => m.material.colorWrite !== false)) {
            expect(mesh.material.polygonOffset, mesh.name).toBe(true);
            expect(mesh.material.polygonOffsetFactor, mesh.name).toBeGreaterThan(1);
            expect(mesh.material.polygonOffsetUnits, mesh.name).toBeGreaterThan(1);
        }
        expect(ORDER.lid).toBeLessThan(ORDER.pavement);
        const roadbed = byName(layer, 'ground-roadbed');
        expect(roadbed.material.color).toBe(COLORS.asphalt);
        expect(roadbed.userData.isGround).toBe(true);
        expect(roadbed.geometry.index.array).toBeInstanceOf(Uint32Array);
        const normals = roadbed.geometry.attributes.normal.array;
        for (let i = 0; i < normals.length; i += 3) expect([normals[i], normals[i + 1], normals[i + 2]]).toEqual([0, 0, 1]);
        expect(layer.stats().drawCalls).toBe(5);
        expect(layer.stats().ways).toBe(1);
        expect(layer.stats().markingM).toBe(20);
        expect(layer.stats().kerbM).toBe(52); // 20 m each side plus two 6 m dead-end caps
    });

    it('draws the lid into the stencil only and cuts holes in every pavement-level material', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(result());
        const lid = byName(layer, 'ground-lid').material;
        expect(lid.colorWrite).toBe(false);
        expect(lid.depthWrite).toBe(false);
        expect(lid.depthTest).toBe(false);
        expect(lid.stencilWrite).toBe(true);
        expect(lid.stencilFunc).toBe('always');
        expect(lid.stencilZPass).toBe('replace');
        expect(lid.stencilRef).toBe(STENCIL_BIT);
        expect(lid.stencilWriteMask).toBe(STENCIL_BIT);
        // The lid shares the roadbed's triangles at pavement level.
        expect(byName(layer, 'ground-lid').geometry.index.array).toBe(byName(layer, 'ground-roadbed').geometry.index.array);
        const slab = { needsUpdate: false };
        layer.cutHoles(slab);
        expect(slab.stencilWrite).toBe(true);
        expect(slab.stencilWriteMask).toBe(0);
        expect(slab.stencilFuncMask).toBe(STENCIL_BIT);
        expect(slab.stencilRef).toBe(STENCIL_BIT);
        expect(slab.stencilFunc).toBe('not-equal');
        expect(slab.stencilZPass).toBe('keep');
        expect(slab.needsUpdate).toBe(true);
        // The ghost pass tests NotEqual 1 under a full mask: this bit must not collide with its ref.
        expect(STENCIL_BIT & 1).toBe(0);
    });

    it('layers flat ground by claims: each claim takes only unclaimed pixels, the background what is left', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(result());
        const parcel = layer.parcelSurface({});
        const background = byName(layer, 'ground-pavement');
        expect(background.renderOrder).toBeGreaterThan(0);
        // Pushed behind building faces, which does not change the claims' layering by stencil.
        expect(background.material.polygonOffsetFactor).toBe(parcel.polygonOffsetFactor);
        expect(background.material.stencilFunc).toBe('equal');
        expect(background.material.stencilWriteMask).toBe(0);
        expect(parcel.stencilFunc).toBe('greater');
        expect(parcel.stencilZPass).toBe('replace');
        expect(parcel.stencilWriteMask).toBe(PARCEL_BIT);
        const passes = (material, stencil) => {
            const ref = material.stencilRef & material.stencilFuncMask, value = stencil & material.stencilFuncMask;
            if (material.stencilFunc === 'greater') return ref > value;
            return material.stencilFunc === 'equal' ? ref === value : ref !== value;
        };
        expect(passes(parcel, 0)).toBe(true);
        // Not over the sunk roadbed, and not where an earlier claim (ground cover) already drew.
        for (const occupied of [STENCIL_BIT, PARCEL_BIT, PARCEL_BIT | STENCIL_BIT]) expect(passes(parcel, occupied)).toBe(false);
        // What a claim writes is the claim bit.
        expect(parcel.stencilRef & parcel.stencilWriteMask).toBe(PARCEL_BIT);
        // Ground cover claims before the parcels, the background after them.
        expect(ORDER.cover).toBeLessThan(0);
        expect(ORDER.cover).toBeGreaterThan(ORDER.lid);
        // Real-world water claims before the ground cover, so a canal is never grassed or paved over.
        expect(ORDER.water).toBeGreaterThan(ORDER.lid);
        expect(ORDER.water).toBeLessThan(-7); // three-mode's most specific cover, lawn, is -7
        expect(passes(background.material, 0)).toBe(true);
        for (const occupied of [PARCEL_BIT, STENCIL_BIT, PARCEL_BIT | STENCIL_BIT]) {
            expect(passes(background.material, occupied)).toBe(false);
        }
        expect(PARCEL_BIT & (STENCIL_BIT | 1)).toBe(0);
    });

    it('uploads the kerb with its own horizontal normals on a two-sided material', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(result());
        const kerb = byName(layer, 'ground-kerb');
        expect(kerb.material.side).toBe('double');
        expect(kerb.material.color).toBe(COLORS.kerb);
        const normals = kerb.geometry.attributes.normal.array;
        expect(normals.length).toBe(kerb.geometry.attributes.position.array.length);
        for (let i = 0; i < normals.length; i += 3) {
            expect(normals[i + 2]).toBe(0);
            expect(Math.hypot(normals[i], normals[i + 1])).toBeCloseTo(1, 9);
        }
    });

    it('paves the pavement in its shader and can pave a scene-unit material scaled back to metres', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE, k: 1.25 });
        const compile = material => {
            const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
            material.onBeforeCompile(shader);
            return shader;
        };
        layer.setGeometry(result());
        const pavement = compile(byName(layer, 'ground-pavement').material);
        expect(pavement.uniforms.uPaveScale.value).toBe(1);
        expect(pavement.uniforms.uPaveSlab.value).toBe(PAVE_SLAB_M);
        expect(pavement.vertexShader).toContain('vPaveXY = transformed.xy * uPaveScale;');
        expect(pavement.fragmentShader).toContain('diffuseColor.rgb *=');
        expect(pavement.fragmentShader).toContain('fwidth(slab)');
        expect(pavement.fragmentShader).toContain('(tint - 0.5) * detail');
        const slab = { userData: {} };
        layer.paveTexture(slab, 1 / 1.25);
        expect(compile(slab).uniforms.uPaveScale.value).toBeCloseTo(0.8, 12);
        expect(slab.customProgramCacheKey()).toBe('cb-pave');
        expect(slab.needsUpdate).toBe(true);
    });

    it('skips empty parts and clears on null', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(buildGroundGeometry({ bounds: [0, 0, 1, 1], carriageways: [] }));
        expect(layer.group.children.map(m => m.name)).toEqual(['ground-pavement']);
        layer.setGeometry(buildGroundGeometry({ bounds: null, carriageways: [{ pts: [[0, 0], [10, 0]], halfWidth: 3 }] }));
        expect(layer.group.children.map(m => m.name)).toEqual(['ground-lid', 'ground-roadbed']);
        layer.setGeometry(null);
        expect(layer.group.children).toEqual([]);
        expect(layer.stats().drawCalls).toBe(0);
    });

    it('disposes geometries on replace and materials on dispose', () => {
        const { THREE, disposed } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(result());
        layer.setGeometry(result());
        expect(disposed.filter(d => d === 'geometry')).toHaveLength(5);
        layer.dispose();
        expect(disposed.filter(d => d === 'geometry')).toHaveLength(10);
        expect(disposed.filter(d => d === 'material')).toHaveLength(5);
        expect(layer.group.children).toEqual([]);
    });

    it('lays a design\'s ground over the city\'s ground and behind every building face, in rank order', () => {
        const at = rank => designSurface({}, rank).polygonOffsetFactor;
        for (let rank = 1; rank <= MAX_DESIGN_RANK; rank++) {
            const material = designSurface({}, rank);
            expect(material.polygonOffset).toBe(true);
            // Building faces are pushed by 1 (three-mode.js makeBuildingMaterial): a design's ground
            // never comes in front of them, so it never covers the foot of a wall standing on it.
            expect(material.polygonOffsetFactor).toBeGreaterThan(1);
            expect(material.polygonOffsetUnits).toBe(material.polygonOffsetFactor);
            expect(material.polygonOffsetFactor).toBeLessThan(OFFSET.ground);
        }
        expect(at(4)).toBeLessThan(at(2));
        expect(at(99)).toBe(at(MAX_DESIGN_RANK));
        expect(at(0)).toBe(at(1));
    });

    it('leaves no ground surface pulled toward the camera, where it would cover the foot of walls', () => {
        // A negative polygon offset puts a surface in front of building faces too. What is left:
        // planning envelope tiers (volumes), the draft and surroundings previews shown while
        // drawing, and the green cover whose claim (parcelSurface) replaces the offset it is built with.
        const files = ['three-mode.js', 'three-site-ground.js', 'three-buildout.js', 'three-life.js', 'three-ground.js', 'three-fountains.js'];
        const pulled = files.flatMap(file => readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8')
            .split('\n').filter(line => /polygonOffsetFactor\s*[:=]\s*-/.test(line)).map(line => `${file}: ${line.trim()}`));
        expect(pulled).toHaveLength(4);
        expect(pulled.every(line => line.startsWith('three-mode.js'))).toBe(true);
    });
});
