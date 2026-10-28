// Furniture models and lamps (frontend/js/furniture-models.js): the kinds each structure offers, the
// asset limits, the record shape under decorationDesign.models, lamp records, the instance transform
// the night glow and market stalls; plus the glTF summary (model-upload.js) and lamp clipping to a carved body.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FurnitureModels = require('../../frontend/js/furniture-models.js');
const ModelUpload = require('../../frontend/js/model-upload.js');
const ProposalApplyStructures = require('../../frontend/js/proposals/apply/structures.js');
const turf = require('@turf/turf');

const coordinate = value => (Array.isArray(value) && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
    ? [Number(value[0]), Number(value[1])] : null);

describe('furniture kinds', () => {
    it('offers benches, market stalls, trees, lamps and play equipment in parks, and the rest in squares', () => {
        expect(FurnitureModels.kindsFor('park')).toEqual(['bench', 'stall', 'tree', 'lamp', 'swing', 'seesaw', 'slide']);
        expect(FurnitureModels.ARRAY_BY_KIND.swing).toBe('swings');
        expect(FurnitureModels.kindsFor('square')).toEqual(['bench', 'statue', 'fountain', 'stall', 'tree', 'lamp']);
        expect(FurnitureModels.kindsFor('lake')).toEqual([]);
        expect(FurnitureModels.ARRAY_BY_KIND.lamp).toBe('lamps');
        expect(FurnitureModels.isKind('lamp')).toBe(true);
        expect(FurnitureModels.isKind('rocket')).toBe(false);
    });
});

describe('validateModelSummary', () => {
    const ok = { triangles: 4000, textures: [{ width: 1024, height: 512 }], bytes: 1024 * 1024 };
    it('accepts a model within every limit', () => {
        expect(FurnitureModels.validateModelSummary(ok)).toEqual({ ok: true });
    });
    it.each([
        ['empty', { ...ok, triangles: 0 }],
        ['triangles', { ...ok, triangles: 5001 }],
        ['bytes', { ...ok, bytes: 4 * 1024 * 1024 + 1 }],
        ['texture', { ...ok, textures: [{ width: 512, height: 2048 }] }]
    ])('refuses with code %s', (code, summary) => {
        const result = FurnitureModels.validateModelSummary(summary);
        expect(result.ok).toBe(false);
        expect(result.code).toBe(code);
    });
    it('reports the limit that was missed', () => {
        expect(FurnitureModels.validateModelSummary({ ...ok, triangles: 9000 }).detail).toEqual({ triangles: 9000, max: 5000 });
    });
});

describe('normalizeModels', () => {
    it('drops unknown kinds, kinds the structure does not offer and empty urls, and trims names', () => {
        const long = 'x'.repeat(200);
        expect(FurnitureModels.normalizeModels({
            bench: { url: ' /models/a.glb ', name: `  ${long}  ` },
            statue: { url: '/models/s.glb' },
            stall: { url: '/models/stall.glb' },
            lamp: { url: '   ' },
            rocket: { url: '/models/r.glb' },
            tree: { url: 42 }
        }, 'park')).toEqual({ bench: { url: '/models/a.glb', name: 'x'.repeat(120) }, stall: { url: '/models/stall.glb' } });
        expect(FurnitureModels.normalizeModels({ statue: { url: '/models/s.glb', name: ' ' } }, 'square')).toEqual({ statue: { url: '/models/s.glb' } });
    });
    it('returns null when nothing remains', () => {
        expect(FurnitureModels.normalizeModels({ lamp: {} }, 'park')).toBeNull();
        expect(FurnitureModels.normalizeModels(null, 'square')).toBeNull();
    });
});

describe('normalizeLamps', () => {
    it('keeps valid points, accepts bare positions and folds the bearing into [0, 360)', () => {
        expect(FurnitureModels.normalizeLamps([
            { coordinate: [15.9, 45.8], bearing: 450 },
            { coordinate: [15.91, 45.81], bearing: -30 },
            [15.92, 45.82],
            { coordinate: ['x', 1] },
            null
        ], coordinate)).toEqual([
            { coordinate: [15.9, 45.8], bearing: 90 },
            { coordinate: [15.91, 45.81], bearing: 330 },
            { coordinate: [15.92, 45.82], bearing: 0 }
        ]);
        expect(FurnitureModels.normalizeLamps(undefined, coordinate)).toEqual([]);
    });
});

describe('market stalls', () => {
    it('normalizes stalls like benches and keeps only a valid hex canopy colour', () => {
        expect(FurnitureModels.normalizeStalls([
            [15.9, 45.8],
            { coordinate: [15.91, 45.81], bearing: 370, color: ' #D64545 ' },
            { coordinate: [15.92, 45.82], bearing: 10, color: 'red' },
            { coordinate: [15.93, 45.83], color: '#abc' },
            { coordinate: ['x', 1] }
        ], coordinate)).toEqual([
            { coordinate: [15.9, 45.8], bearing: 0 },
            { coordinate: [15.91, 45.81], bearing: 10, color: '#d64545' },
            { coordinate: [15.92, 45.82], bearing: 10 },
            { coordinate: [15.93, 45.83], bearing: 0 }
        ]);
        expect(FurnitureModels.normalizeStalls(null, coordinate)).toEqual([]);
    });

    it('colours a canopy with its own colour, else the palette by placement index', () => {
        const palette = FurnitureModels.STALL_PALETTE;
        expect(palette.length).toBeGreaterThan(1);
        expect(FurnitureModels.stallColor({ color: '#123456' }, 3)).toBe('#123456');
        expect(FurnitureModels.stallColor({}, 0)).toBe(palette[0]);
        expect(FurnitureModels.stallColor([15.9, 45.8], 1)).toBe(palette[1]);
        expect(FurnitureModels.stallColor({}, palette.length + 2)).toBe(palette[2]);
        palette.forEach(color => expect(color).toMatch(/^#[0-9a-f]{6}$/));
    });
});

describe('instanceTransform', () => {
    it('turns the model +X toward the bearing, as the default bench does, and scales only XY by k', () => {
        // The default bench uses rotation.z = (90 - bearing) degrees: bearing 0 (north) -> +X turned to +Y.
        for (const bearing of [0, 45, 90, 180, 270]) {
            const t = FurnitureModels.instanceTransform({ x: 10, y: 20, z: 0.06, bearingDeg: bearing, k: 1.4 });
            expect(t.rotationZ).toBeCloseTo(((90 - bearing) * Math.PI) / 180, 12);
            expect(t.position).toEqual([10, 20, 0.06]);
            expect(t.scale).toEqual([1.4, 1.4, 1]);
        }
        const north = FurnitureModels.instanceTransform({ x: 0, y: 0, bearingDeg: 0 });
        expect(Math.cos(north.rotationZ)).toBeCloseTo(0, 12);
        expect(Math.sin(north.rotationZ)).toBeCloseTo(1, 12);
        const east = FurnitureModels.instanceTransform({ x: 0, y: 0, bearingDeg: 90 });
        expect(east.rotationZ).toBeCloseTo(0, 12);
    });
});

describe('lampGlowStrength', () => {
    it('is off by day and with the sun layer off, and eases in over the first 6 degrees of night', () => {
        expect(FurnitureModels.lampGlowStrength(null)).toBe(0);
        expect(FurnitureModels.lampGlowStrength(undefined)).toBe(0);
        expect(FurnitureModels.lampGlowStrength(30)).toBe(0);
        expect(FurnitureModels.lampGlowStrength(0)).toBe(0);
        expect(FurnitureModels.lampGlowStrength(-3)).toBeCloseTo(0.5, 12);
        expect(FurnitureModels.lampGlowStrength(-6)).toBe(1);
        expect(FurnitureModels.lampGlowStrength(-40)).toBe(1);
    });
});

describe('ModelUpload.modelSummary', () => {
    it('sums indexed and unindexed mesh triangles and lists each texture image once', () => {
        const image = { width: 512, height: 256 };
        const shared = { map: { image }, normalMap: { image } };
        const scene = {
            children: [
                { isMesh: true, geometry: { index: { count: 36 } }, material: shared, children: [] },
                { children: [{ isMesh: true, geometry: { index: null, attributes: { position: { count: 9 } } }, material: [shared, { map: { image: { naturalWidth: 2048, naturalHeight: 64 } } }] }] },
                { isMesh: false, geometry: { index: { count: 3000 } } }
            ]
        };
        const summary = ModelUpload.modelSummary(scene, 1234);
        expect(summary).toEqual({ triangles: 15, textures: [{ width: 512, height: 256 }, { width: 2048, height: 64 }], bytes: 1234 });
        expect(FurnitureModels.validateModelSummary(summary).code).toBe('texture');
    });
});

describe('lamps on a carved structure', () => {
    it('keeps lamps on the remaining ground, drops the rest and keeps the models', () => {
        const ground = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
        const kept = ProposalApplyStructures.decorationsOnGround({
            lamps: [{ coordinate: [0.5, 0.5], bearing: 10 }, { coordinate: [2, 2], bearing: 0 }],
            stalls: [{ coordinate: [0.25, 0.75], bearing: 0, color: '#2f9e6b' }, { coordinate: [-1, 0.5], bearing: 0 }, [0.5, 0.25], [3, 3]],
            models: { lamp: { url: '/models/l.glb' } },
            version: 2
        }, ground, turf);
        expect(kept.lamps).toEqual([{ coordinate: [0.5, 0.5], bearing: 10 }]);
        expect(kept.stalls).toEqual([{ coordinate: [0.25, 0.75], bearing: 0, color: '#2f9e6b' }, [0.5, 0.25]]);
        expect(kept.models).toEqual({ lamp: { url: '/models/l.glb' } });
    });

    it('keeps a fenced area only when its ring is still on the ground, and a whole-park fence always', () => {
        const ground = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
        const inside = { fence: 'mesh', use: 'play', gates: [[0.2, 0.1]], ring: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.1]] };
        const across = { fence: 'mesh', use: 'dog', gates: [[0.9, 0.5]], ring: [[0.8, 0.4], [1.2, 0.4], [1.2, 0.6], [0.8, 0.4]] };
        const whole = { fence: 'plinth', use: 'none', gates: [[0.5, 0]] };
        const kept = ProposalApplyStructures.decorationsOnGround({ enclosures: [inside, across, whole], swings: [{ coordinate: [0.2, 0.2], bearing: 0 }, { coordinate: [2, 2], bearing: 0 }] }, ground, turf);
        expect(kept.enclosures).toEqual([inside, whole]);
        expect(kept.swings).toEqual([{ coordinate: [0.2, 0.2], bearing: 0 }]);
    });

    it('gives an uploaded park or square empty lamp and stall lists', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
        const upload = { modelUrl: '/models/site.glb', modelName: 'site.glb' };
        expect(ProposalApplyStructures.structureFromModelUpload('park', geometry, upload).decorationDesign.lamps).toEqual([]);
        expect(ProposalApplyStructures.structureFromModelUpload('park', geometry, upload).decorationDesign.stalls).toEqual([]);
        expect(ProposalApplyStructures.structureFromModelUpload('square', geometry, upload).decorationDesign.lamps).toEqual([]);
    });
});
