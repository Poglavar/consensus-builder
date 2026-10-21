// Ground renderer (frontend/js/three-ground.js) against a stub THREE: the two meshes it mounts,
// the up-facing normals and index it uploads, the metric scale and clean disposal.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, COLORS } = require('../../frontend/js/three-ground.js');
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
    class MeshLambertMaterial { constructor(params) { Object.assign(this, params); } dispose() { disposed.push('material'); } }
    return { THREE: { BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial }, disposed };
}

const result = () => buildGroundGeometry({ bounds: [-10, -10, 10, 10], carriageways: [{ pts: [[-10, 0], [10, 0]], halfWidth: 3 }] });

describe('three-ground', () => {
    it('mounts the pavement plane and the roadbed as two up-facing meshes in a metric group', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE, k: 1.4 });
        expect([layer.group.scale.x, layer.group.scale.y, layer.group.scale.z]).toEqual([1.4, 1.4, 1]);
        layer.setGeometry(result());
        expect(layer.group.children.map(m => m.name)).toEqual(['ground-pavement', 'ground-roadbed']);
        const roadbed = layer.group.children[1];
        expect(roadbed.material.color).toBe(COLORS.asphalt);
        expect(roadbed.userData.isGround).toBe(true);
        expect(roadbed.geometry.index.array).toBeInstanceOf(Uint32Array);
        const normals = roadbed.geometry.attributes.normal.array;
        for (let i = 0; i < normals.length; i += 3) expect([normals[i], normals[i + 1], normals[i + 2]]).toEqual([0, 0, 1]);
        expect(layer.stats().drawCalls).toBe(2);
        expect(layer.stats().ways).toBe(1);
    });

    it('skips an empty roadbed and clears on null', () => {
        const { THREE } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(buildGroundGeometry({ bounds: [0, 0, 1, 1], carriageways: [] }));
        expect(layer.group.children.map(m => m.name)).toEqual(['ground-pavement']);
        layer.setGeometry(null);
        expect(layer.group.children).toEqual([]);
        expect(layer.stats().drawCalls).toBe(0);
    });

    it('disposes geometries on replace and materials on dispose', () => {
        const { THREE, disposed } = stubThree();
        const layer = create({ THREE });
        layer.setGeometry(result());
        layer.setGeometry(result());
        expect(disposed.filter(d => d === 'geometry')).toHaveLength(2);
        layer.dispose();
        expect(disposed.filter(d => d === 'geometry')).toHaveLength(4);
        expect(disposed.filter(d => d === 'material')).toHaveLength(2);
        expect(layer.group.children).toEqual([]);
    });
});
