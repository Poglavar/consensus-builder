// Grass pattern (frontend/js/three-grass.js): it patches a ground material's shader with the
// world-position noise in true metres, per variant, and survives the clones the display modes make;
// vacant plots (three-site-ground.js) wear the wild variant.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { grassTexture, COLORS } = require('../../frontend/js/three-grass.js');
const { buildVacantPlots } = require('../../frontend/js/three-site-ground.js');

const shaderStub = () => ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}'
});

describe('grassTexture', () => {
    it('adds the metre-scaled position and the lawn pattern to the shader', () => {
        const material = grassTexture({ userData: {} }, 1 / 1.43, 'lawn');
        const shader = shaderStub();
        material.onBeforeCompile(shader);
        expect(shader.uniforms.uGrassScale.value).toBeCloseTo(1 / 1.43, 9);
        expect(shader.vertexShader).toContain('vGrassXY = transformed.xy * uGrassScale;');
        expect(shader.fragmentShader).toContain('float cbGrassNoise(vec2 p)');
        expect(shader.fragmentShader).toContain('fwidth(gxy)');
        expect(shader.fragmentShader).toMatch(/#include <color_fragment>\n\nvec2 gxy = vGrassXY;/);
        expect(shader.fragmentShader).not.toContain('soil');
        expect(material.customProgramCacheKey()).toBe('cb-grass-lawn');
        expect(material.needsUpdate).toBe(true);
    });

    it('shows bare soil in the wild variant and falls back to lawn for an unknown one', () => {
        const wild = grassTexture({}, 1, 'wild');
        const shader = shaderStub();
        wild.onBeforeCompile(shader);
        expect(shader.fragmentShader).toContain('soil');
        expect(wild.customProgramCacheKey()).toBe('cb-grass-wild');
        expect(grassTexture({}, 1, 'moss').customProgramCacheKey()).toBe('cb-grass-lawn');
        expect(grassTexture({}, NaN).userData.cbGrass.scale.value).toBe(1);
    });

    it('uses natural lawn and dry-meadow base colours', () => {
        expect(COLORS.lawn).toBe(0x557f2f);
        expect(COLORS.wild).toBe(0x9a9c62);
    });
});

describe('vacant plots', () => {
    it('lay their ground with the wild grass in the plot metres', () => {
        class Material { constructor(params) { Object.assign(this, params); this.userData = {}; } }
        class Group { constructor() { this.children = []; this.userData = {}; } add(child) { this.children.push(child); } }
        const THREE = {
            MeshLambertMaterial: Material, LineBasicMaterial: Material, BufferGeometry: class { setAttribute() { } },
            Float32BufferAttribute: class { }, LineSegments: class { constructor() { this.userData = {}; } }
        };
        const meshes = [];
        const target = new Group();
        buildVacantPlots({
            THREE, target, metresPerUnit: 0.7, project: c => c,
            features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] } }],
            polygonMeshes: (feature, material) => { const mesh = { material, userData: {} }; meshes.push(mesh); return [mesh]; },
            ownMaterial: () => { }, ownGeometry: () => { }
        });
        expect(meshes).toHaveLength(1);
        expect(meshes[0].userData.isVacantPlot).toBe(true);
        expect(meshes[0].material.color).toBe(COLORS.wild);
        expect(meshes[0].material.userData.cbGrass).toMatchObject({ variant: 'wild', scale: { value: 0.7 } });
    });
});
