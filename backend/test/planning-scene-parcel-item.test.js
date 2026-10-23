// PlanningScene.parcelItemOf: the permitted massing item associated with a parcel reference.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parcelItemOf } = require('../../frontend/js/planning/scene.js');

const envelope = (parcelId, id = `src:${parcelId}`) => ({ id, role: 'permitted', parcelEnvelope: { bound: true },
    sourceEvidence: { parcelReference: { parcelId, sourceId: 'src' } }, source: { parcel: parcelId.split('-').pop() } });
const proposed = { id: 'p-1', role: 'proposed', sourceEvidence: { parcelReference: { parcelId: 'HR-1-2' } } };
const cached = (parcelId) => ({ id: `gup:${parcelId}`, role: 'permitted', source: { id: 'gup', parcel: parcelId }, sourceEvidence: {} });
const study = { id: 'study', study: true, parcelEnvelope: null, sourceEvidence: { parcelReference: { parcelId: 'HR-1-3' } } };

describe('parcelItemOf', () => {
    it('finds the parcel envelope by its parcel reference, whatever the id type', () => {
        const items = [proposed, envelope('HR-1-2'), envelope('HR-1-3'), study];
        expect(parcelItemOf(items, 'HR-1-3').id).toBe('src:HR-1-3');
        expect(parcelItemOf(items, 'HR-1-2').id).toBe('src:HR-1-2');
        expect(parcelItemOf([envelope('42')], 42).id).toBe('src:42');
    });

    it('falls back to the source\'s cached result for the parcel, and prefers the envelope when both exist', () => {
        expect(parcelItemOf([proposed, cached('HR-1-2')], 'HR-1-2').id).toBe('gup:HR-1-2');
        expect(parcelItemOf([cached('HR-1-2'), envelope('HR-1-2')], 'HR-1-2').id).toBe('src:HR-1-2');
        // A proposed record on the parcel is not its permitted massing.
        expect(parcelItemOf([{ ...proposed, source: { parcel: 'HR-1-2' } }], 'HR-1-2')).toBeNull();
    });

    it('answers null for a parcel without an envelope, a missing id or no items', () => {
        expect(parcelItemOf([proposed, study], 'HR-1-2')).toBeNull();
        expect(parcelItemOf([envelope('HR-1-2')], 'HR-9-9')).toBeNull();
        expect(parcelItemOf([envelope('HR-1-2')], null)).toBeNull();
        expect(parcelItemOf([envelope('HR-1-2')], '')).toBeNull();
        expect(parcelItemOf(null, 'HR-1-2')).toBeNull();
        expect(parcelItemOf([null, {}], 'HR-1-2')).toBeNull();
    });
});
