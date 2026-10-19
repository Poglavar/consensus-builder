// Unit tests for the depth-prepass renderer that keeps smooth building transparency stable.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    DEPTH_PREPASS_FLAG,
    DEFAULT_DEPTH_PREPASS_RENDER_ORDER,
    normalizeOpacity,
    opacityOf,
    configureColorMaterial,
    createDepthMaterial,
    attachDepthPrepass
} = require('../../frontend/js/three-smooth-transparency.js');

function cloneableMaterial(overrides = {}) {
    const material = {
        userData: {},
        transparent: false,
        opacity: 1,
        colorWrite: true,
        depthTest: true,
        depthWrite: true,
        depthFunc: 'less-equal',
        stencilWrite: false,
        alphaToCoverage: true,
        ...overrides
    };
    material.clone = () => cloneableMaterial({
        ...material,
        userData: { ...material.userData }
    });
    return material;
}

class FakeMesh {
    constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.children = [];
        this.userData = {};
        this.layers = { mask: 1 };
        this.frustumCulled = true;
    }

    add(child) {
        this.children.push(child);
    }
}

const colorOptions = {
    opacity: 0.5,
    equalDepth: 'equal',
    lessDepth: 'less',
    notEqualStencilFunc: 'not-equal',
    keepStencilOp: 'keep',
    replaceStencilOp: 'replace'
};

describe('three smooth transparency', () => {
    it('normalizes opacity and configures one smooth equal-depth color pass', () => {
        expect(normalizeOpacity(-1)).toBe(0);
        expect(normalizeOpacity(2)).toBe(1);
        const material = configureColorMaterial(cloneableMaterial(), colorOptions);

        expect(opacityOf(material)).toBe(0.5);
        expect(material.transparent).toBe(true);
        expect(material.depthWrite).toBe(false);
        expect(material.depthFunc).toBe('equal');
        expect(material.stencilWrite).toBe(true);
        expect(material.stencilFunc).toBe('not-equal');
        expect(material.stencilZPass).toBe('replace');
        expect(material.alphaToCoverage).toBe(false);
    });

    it('creates an invisible opaque material for the nearest-depth pass', () => {
        const source = configureColorMaterial(cloneableMaterial(), colorOptions);
        const depth = createDepthMaterial(source, { lessDepth: 'less' });

        expect(depth).not.toBe(source);
        expect(depth.userData[DEPTH_PREPASS_FLAG]).toBe(true);
        expect(depth.transparent).toBe(false);
        expect(depth.colorWrite).toBe(false);
        expect(depth.depthWrite).toBe(true);
        expect(depth.depthFunc).toBe('less');
        expect(opacityOf(depth)).toBe(1);
        expect(source.colorWrite).toBe(true);
    });

    it('attaches exactly one non-pickable depth mesh sharing the source geometry', () => {
        const geometry = { id: 'shared-geometry' };
        const material = configureColorMaterial(cloneableMaterial(), colorOptions);
        const mesh = new FakeMesh(geometry, material);
        const options = {
            lessDepth: 'less',
            createMesh: (childGeometry, childMaterial) => new FakeMesh(childGeometry, childMaterial)
        };

        const depthMesh = attachDepthPrepass(mesh, options);

        expect(depthMesh.geometry).toBe(geometry);
        expect(depthMesh.userData[DEPTH_PREPASS_FLAG]).toBe(true);
        expect(depthMesh.material.colorWrite).toBe(false);
        expect(depthMesh.renderOrder).toBe(DEFAULT_DEPTH_PREPASS_RENDER_ORDER);
        expect(mesh.children).toEqual([depthMesh]);
        expect(attachDepthPrepass(mesh, options)).toBeNull();
    });

    it('does not attach a prepass to an opaque material', () => {
        const mesh = new FakeMesh({}, cloneableMaterial());
        expect(attachDepthPrepass(mesh, {
            lessDepth: 'less',
            createMesh: (geometry, material) => new FakeMesh(geometry, material)
        })).toBeNull();
    });
});
