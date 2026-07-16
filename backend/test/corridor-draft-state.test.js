import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    CorridorDraftValidationError,
    createCorridorDraftState,
    validateCorridorDraftState,
    reduceCorridorDraft,
    compileCorridorDefinition
} = require('../../frontend/js/corridor-draft-state.js');

const point = (lat, lng) => ({ lat, lng });

describe('corridor draft state', () => {
    it('normalizes legacy flat centerlines and aligns stable segment ids', () => {
        const state = createCorridorDraftState({
            kind: 'road',
            points: [[15.97, 45.81], [15.98, 45.82]],
            segmentIds: [],
            width: 10
        });

        expect(state.segments).toEqual([[
            point(45.81, 15.97),
            point(45.82, 15.98)
        ]]);
        expect(state.segmentIds).toEqual(['s1']);
        expect(validateCorridorDraftState(state, { requireDrawable: true })).toMatchObject({ ok: true });
    });

    it('rejects an explicitly malformed aligned-state contract', () => {
        const malformed = {
            ...createCorridorDraftState({ segments: [[point(1, 2), point(3, 4)]] }),
            segmentIds: []
        };
        const validation = validateCorridorDraftState(malformed, { requireDrawable: true });
        expect(validation.ok).toBe(false);
        expect(validation.errors.map(error => error.code)).toContain('segment-id-misalignment');
    });

    it('reduces edits immutably and advances revision', () => {
        const initial = createCorridorDraftState({
            segments: [[point(1, 1), point(2, 2)]],
            segmentIds: ['existing'],
            revision: 4
        });
        const added = reduceCorridorDraft(initial, {
            type: 'ADD_SEGMENT',
            segmentId: 'branch',
            points: [point(2, 2), point(3, 3)]
        });
        const extended = reduceCorridorDraft(added, {
            type: 'APPEND_POINT',
            point: point(4, 4)
        });
        const undone = reduceCorridorDraft(extended, { type: 'UNDO' });

        expect(initial.segments).toHaveLength(1);
        expect(added.segmentIds).toEqual(['existing', 'branch']);
        expect(extended.segments[1]).toHaveLength(3);
        expect(undone.segments[1]).toHaveLength(2);
        expect(undone.revision).toBe(7);
    });

    it('removes a cancelled stub and its profile override together', () => {
        const state = createCorridorDraftState({
            segments: [[point(1, 1)]],
            segmentIds: ['stub'],
            segmentProfiles: { stub: { strips: [{ type: 'driving', width: 3 }] } },
            activeIndex: 0,
            hasStarted: true,
            strokeBaseCount: 0
        });
        const cancelled = reduceCorridorDraft(state, { type: 'CANCEL_STROKE' });

        expect(cancelled.segments).toEqual([]);
        expect(cancelled.segmentIds).toEqual([]);
        expect(cancelled.segmentProfiles).toEqual({});
        expect(cancelled.hasStarted).toBe(false);
        expect(cancelled.revision).toBe(state.revision + 1);
    });

    it('records cancelling an established active stroke even when no point is removed', () => {
        const state = createCorridorDraftState({
            segments: [[point(1, 1), point(2, 2)]],
            activeIndex: 0,
            hasStarted: true,
            strokeBaseCount: 2
        });
        const cancelled = reduceCorridorDraft(state, { type: 'CANCEL_STROKE' });

        expect(cancelled.segments).toEqual(state.segments);
        expect(cancelled.hasStarted).toBe(false);
        expect(cancelled.activeIndex).toBe(-1);
        expect(cancelled.revision).toBe(state.revision + 1);
    });
});

describe('corridor definition compiler', () => {
    it('produces the canonical deterministic definition without mutating its source', () => {
        const source = {
            kind: 'track',
            segments: [[point(45.81, 15.97), point(45.82, 15.98)]],
            segmentIds: ['rail-a'],
            profile: { strips: [{ type: 'rail', width: 3.5, gauge: 1435 }] },
            width: 99,
            sidewalkWidth: null,
            segmentProfiles: {
                'rail-a': { strips: [{ type: 'rail', width: 3.5, gauge: 1435 }] },
                orphan: { strips: [{ type: 'driving', width: 4 }] }
            },
            tunnels: [{ edgeKey: 'a' }],
            demolishedBuildings: [{ id: 'b-1' }],
            trackSpeed: 50,
            trackMinRadius: 25,
            metadata: { source: 'test' }
        };
        const before = JSON.stringify(source);

        const first = compileCorridorDefinition(source, { requireDrawable: true });
        const second = compileCorridorDefinition(source, { requireDrawable: true });

        expect(first).toEqual(second);
        expect(JSON.stringify(source)).toBe(before);
        expect(first.width).toBe(3.5);
        expect(first.points).toEqual(first.segments);
        expect(first.points).not.toBe(first.segments);
        expect(first.segmentProfiles).toHaveProperty('rail-a');
        expect(first.segmentProfiles).not.toHaveProperty('orphan');
        expect(first.metadata).toMatchObject({
            source: 'test',
            type: 'track',
            isCorridor: true,
            isTrack: true,
            isRoad: false,
            trackSpeed: 50,
            trackMinRadius: 25
        });
    });

    it('preserves unrelated previous-definition fields while replacing compiled state', () => {
        const definition = compileCorridorDefinition({
            kind: 'road',
            segments: [[point(1, 2), point(3, 4)]],
            profile: { strips: [{ type: 'driving', width: 3 }] }
        }, {
            previousDefinition: { importedTag: 'keep', metadata: { imported: true, trackSpeed: 99 } },
            requireDrawable: true
        });

        expect(definition.importedTag).toBe('keep');
        expect(definition.metadata.imported).toBe(true);
        expect(definition.metadata.trackSpeed).toBeUndefined();
        expect(definition.metadata).toMatchObject({ type: 'road', isRoad: true, isTrack: false });
    });

    it('allows an incomplete autosave but refuses to compile it as a finishable corridor', () => {
        expect(compileCorridorDefinition({ kind: 'road', width: 10 }, { requireDrawable: false }).points).toEqual([]);
        expect(() => compileCorridorDefinition({ kind: 'road', width: 10 }, { requireDrawable: true }))
            .toThrow(CorridorDraftValidationError);
    });

    it('requires a width before a drawable centerline can be finished', () => {
        expect(() => compileCorridorDefinition({
            kind: 'road',
            segments: [[point(1, 2), point(3, 4)]]
        }, { requireDrawable: true })).toThrow(CorridorDraftValidationError);
    });
});
