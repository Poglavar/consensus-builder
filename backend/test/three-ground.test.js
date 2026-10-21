// Ground renderer (frontend/js/three-ground.js) against a stub THREE: the four meshes it mounts in
// draw order, the stencil lid and the holes it cuts, the normals it uploads, the metric scale and
// clean disposal.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, COLORS, ORDER, STENCIL_BIT } = require('../../frontend/js/three-ground.js');
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
        NotEqualStencilFunc: 'not-equal', AlwaysStencilFunc: 'always', KeepStencilOp: 'keep', ReplaceStencilOp: 'replace', DoubleSide: 'double'
    };
    return { THREE, disposed };
}

const result = () => buildGroundGeometry({ bounds: [-10, -10, 10, 10], carriageways: [{ pts: [[-10, 0], [10, 0]], halfWidth: 3, drop: 0.15 }] });
const byName = (layer, name) => layer.group.children.find(m => m.name === name);

describe('three-ground', () => {
    it('mounts lid, roadbed, kerb and pavement in draw order in a metric group', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE, k: 1.4 });
        expect([layer.group.scale.x, layer.group.scale.y, layer.group.scale.z]).toEqual([1.4, 1.4, 1]);
        layer.setGeometry(result());
        expect(layer.group.children.map(m => m.name)).toEqual(['ground-lid', 'ground-roadbed', 'ground-kerb', 'ground-pavement']);
        expect(layer.group.children.map(m => m.renderOrder)).toEqual([ORDER.lid, ORDER.roadbed, ORDER.kerb, ORDER.pavement]);
        expect(ORDER.lid).toBeLessThan(ORDER.pavement);
        const roadbed = byName(layer, 'ground-roadbed');
        expect(roadbed.material.color).toBe(COLORS.asphalt);
        expect(roadbed.userData.isGround).toBe(true);
        expect(roadbed.geometry.index.array).toBeInstanceOf(Uint32Array);
        const normals = roadbed.geometry.attributes.normal.array;
        for (let i = 0; i < normals.length; i += 3) expect([normals[i], normals[i + 1], normals[i + 2]]).toEqual([0, 0, 1]);
        expect(layer.stats().drawCalls).toBe(4);
        expect(layer.stats().ways).toBe(1);
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
        [byName(layer, 'ground-pavement').material, slab].forEach(material => {
            expect(material.stencilWrite).toBe(true);
            expect(material.stencilWriteMask).toBe(0);
            expect(material.stencilFuncMask).toBe(STENCIL_BIT);
            expect(material.stencilRef).toBe(STENCIL_BIT);
            expect(material.stencilFunc).toBe('not-equal');
            expect(material.stencilZPass).toBe('keep');
        });
        expect(slab.needsUpdate).toBe(true);
        // The ghost pass tests NotEqual 1 under a full mask: this bit must not collide with its ref.
        expect(STENCIL_BIT & 1).toBe(0);
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
        expect(disposed.filter(d => d === 'geometry')).toHaveLength(4);
        layer.dispose();
        expect(disposed.filter(d => d === 'geometry')).toHaveLength(8);
        expect(disposed.filter(d => d === 'material')).toHaveLength(4);
        expect(layer.group.children).toEqual([]);
    });
});
