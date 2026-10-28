import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalizeDecorations,
    boundaryFeature,
    reshapeBoundary,
    hasExplicitDecorationDesign,
    translateCoordinateCollection
} = require('../../frontend/js/structure-geometry-editor.js');

describe('structure geometry editor data normalization', () => {
    it('upgrades a legacy square fountain and normalizes bench bearings', () => {
        const normalized = normalizeDecorations('square', {
            fountain: [15.9, 45.8],
            benches: [{ coordinate: [15.91, 45.81], bearing: -15 }]
        });

        expect(normalized.fountains).toEqual([[15.9, 45.8]]);
        expect(normalized.benches).toEqual([{ coordinate: [15.91, 45.81], bearing: 345 }]);
    });

    it('keeps only valid park point and path coordinates', () => {
        const normalized = normalizeDecorations('park', {
            trees: [[15.9, 45.8], ['bad', 45.8]],
            paths: [[[15.9, 45.8], [15.91, 45.81]], [[15.9, 45.8]]]
        });

        // A bare position becomes a tree record with the look its position hashes to.
        expect(normalized.trees).toEqual([{ coordinate: [15.9, 45.8], kind: expect.any(String), heightM: expect.any(Number) }]);
        expect(normalized.paths).toEqual([[[15.9, 45.8], [15.91, 45.81]]]);
    });

    it('normalizes park benches as first-class point objects', () => {
        const normalized = normalizeDecorations('park', {
            benches: [{ coordinate: [15.9, 45.8], bearing: 400 }, [15.91, 45.81], { coordinate: ['bad', 45.8] }]
        });

        expect(normalized.benches).toEqual([
            { coordinate: [15.9, 45.8], bearing: 40 },
            { coordinate: [15.91, 45.81], bearing: 0 }
        ]);
    });

    it('normalizes square statues as plain coordinates and stalls as bearing records', () => {
        const normalized = normalizeDecorations('square', {
            stalls: [[15.9, 45.8], ['bad', 45.8], { coordinate: [15.91, 45.81], bearing: -45, color: '#2D7DD2' }],
            statues: [[15.92, 45.82], null]
        });

        // A generated square's bare stall position becomes a record facing north.
        expect(normalized.stalls).toEqual([{ coordinate: [15.9, 45.8], bearing: 0 }, { coordinate: [15.91, 45.81], bearing: 315, color: '#2d7dd2' }]);
        expect(normalized.statues).toEqual([[15.92, 45.82]]);
    });

    it('gives parks market stalls too', () => {
        expect(normalizeDecorations('park', { stalls: [{ coordinate: [15.9, 45.8], bearing: 90, color: 'red' }] }).stalls)
            .toEqual([{ coordinate: [15.9, 45.8], bearing: 90 }]);
        expect(normalizeDecorations('park', {}).stalls).toEqual([]);
    });

    it('normalizes lamps and furniture models with the shared FurnitureModels rules', () => {
        const park = normalizeDecorations('park', {
            lamps: [{ coordinate: [15.9, 45.8], bearing: -90 }, { coordinate: ['bad', 45.8] }, [15.91, 45.81]],
            models: { bench: { url: ' /models/b.glb ', name: '  Oak bench  ' }, statue: { url: '/models/s.glb' }, lamp: { url: '' } }
        });
        expect(park.lamps).toEqual([{ coordinate: [15.9, 45.8], bearing: 270 }, { coordinate: [15.91, 45.81], bearing: 0 }]);
        // A park has no statues; an empty url is no model.
        expect(park.models).toEqual({ bench: { url: '/models/b.glb', name: 'Oak bench' } });

        const square = normalizeDecorations('square', { models: { statue: { url: '/models/s.glb' }, rocket: { url: '/x.glb' } } });
        expect(square.models).toEqual({ statue: { url: '/models/s.glb' } });
        expect(square.lamps).toEqual([]);
        // No models: the key is absent rather than an empty object.
        expect(normalizeDecorations('square', { models: { bench: { url: ' ' } } })).not.toHaveProperty('models');
        expect(normalizeDecorations('park', {})).not.toHaveProperty('models');
    });

    it('counts lamps and models as an explicit saved design', () => {
        expect(hasExplicitDecorationDesign('park', { lamps: [] })).toBe(true);
        expect(hasExplicitDecorationDesign('square', { models: {} })).toBe(true);
    });

    it('accepts polygon features and rejects point geometry as boundaries', () => {
        const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(boundaryFeature({ type: 'Feature', properties: {}, geometry: polygon })).toEqual({ type: 'Feature', properties: {}, geometry: polygon });
        expect(boundaryFeature({ type: 'Point', coordinates: [0, 0] })).toBeNull();
    });

    it('treats an explicitly emptied design as saved, but not a legacy empty object', () => {
        expect(hasExplicitDecorationDesign('park', { trees: [], paths: [], version: 3 })).toBe(true);
        expect(hasExplicitDecorationDesign('square', { fountains: [] })).toBe(true);
        expect(hasExplicitDecorationDesign('park', {})).toBe(false);
        expect(hasExplicitDecorationDesign('square', null)).toBe(false);
    });

    it('translates an entire path or area without changing its shape', () => {
        const source = [[15.9, 45.8], [15.91, 45.81], [15.92, 45.8]];
        const moved = translateCoordinateCollection(source, 0.02, -0.01);

        [[15.92, 45.79], [15.93, 45.8], [15.94, 45.79]].forEach((expected, index) => {
            expect(moved[index][0]).toBeCloseTo(expected[0], 10);
            expect(moved[index][1]).toBeCloseTo(expected[1], 10);
        });
        expect(source).toEqual([[15.9, 45.8], [15.91, 45.81], [15.92, 45.8]]);
    });
});


describe('shared structure boundary editing', () => {
    const turf=require('@turf/turf'), shape=require('../../frontend/js/single-building-geometry.js');
    const outer=[[0,0],[.003,0],[.003,.003],[0,.003],[0,0]];
    const hole=[[.001,.001],[.002,.001],[.002,.002],[.001,.002],[.001,.001]];
    const boundary=turf.polygon([outer,hole]);
    it('supports arbitrary concave shapes, insertion and removal while preserving holes and the source', () => {
        const before=JSON.stringify(boundary);
        const ring=[[0,0],[.0015,-.001],[.003,0],[.003,.003],[0,.003]];
        const next=reshapeBoundary(boundary,ring,shape,turf);
        expect(next.geometry.coordinates[0]).toHaveLength(6);
        expect(next.geometry.coordinates[1]).toEqual(hole);
        expect(JSON.stringify(boundary)).toBe(before);
        expect(reshapeBoundary(next,outer,shape,turf)).toEqual(boundary);
    });
    it('rejects self-crossing outlines, undersized rings and holes outside the edited boundary', () => {
        for(const ring of [ [[0,0],[.003,.003],[.003,0],[0,.003]], [[0,0],[.003,0]], [[0,0],[.0005,0],[.0005,.0005],[0,.0005]] ]) {
            expect(reshapeBoundary(boundary,ring,shape,turf)).toBeNull();
        }
    });
});
