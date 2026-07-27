// Unit tests for the frontend's parcel-id normalisation helpers (pure string coercion — no DOM).
// These used to live in e2e/tests/reparcellization.spec.ts, which booted Chromium to check that a
// whitespace-padded id gets trimmed.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureParcelId, getParcelId } = require('../../frontend/js/parcels/parcel-id.js');

describe('ensureParcelId', () => {
    it('reads parcelId, parcel_id and id, in that order of preference', () => {
        expect(ensureParcelId({ properties: { parcelId: 'HR-335754-1234' } })).toBe('HR-335754-1234');
        expect(ensureParcelId({ properties: { parcel_id: 'HR-335754-5678' } })).toBe('HR-335754-5678');
        expect(ensureParcelId({ properties: { id: 'HR-335754-9999' } })).toBe('HR-335754-9999');
        expect(ensureParcelId({ properties: { parcelId: 'A', parcel_id: 'B', id: 'C' } })).toBe('A');
    });

    it('trims surrounding whitespace', () => {
        expect(ensureParcelId({ properties: { parcelId: '  HR-335754-1234  ' } })).toBe('HR-335754-1234');
    });

    it('writes the normalised id back onto the properties, filling in `id` when absent', () => {
        const props = { parcel_id: '  HR-335754-5678 ' };
        ensureParcelId({ properties: props });
        expect(props.parcelId).toBe('HR-335754-5678');
        expect(props.id).toBe('HR-335754-5678');
    });

    it('does not overwrite an existing `id`', () => {
        const props = { parcelId: 'HR-1', id: 'legacy-id' };
        ensureParcelId({ properties: props });
        expect(props.id).toBe('legacy-id');
    });

    it('returns null when there is no usable id', () => {
        expect(ensureParcelId(null)).toBeNull();
        expect(ensureParcelId({ properties: {} })).toBeNull();
        expect(ensureParcelId({ properties: { parcelId: '   ' } })).toBeNull();
    });
});

describe('getParcelId', () => {
    it('accepts a GeoJSON feature', () => {
        expect(getParcelId({ properties: { parcelId: 'ABC-123' } })).toBe('ABC-123');
    });

    it('accepts a bare properties object', () => {
        expect(getParcelId({ parcelId: 'DEF-456' })).toBe('DEF-456');
    });

    it('passes a string through, trimmed', () => {
        expect(getParcelId('GHI-789')).toBe('GHI-789');
        expect(getParcelId('  GHI-789  ')).toBe('GHI-789');
    });

    it('coerces a numeric id to a string', () => {
        expect(getParcelId({ parcelId: 12345 })).toBe('12345');
    });

    it('returns null for null and undefined', () => {
        expect(getParcelId(null)).toBeNull();
        expect(getParcelId(undefined)).toBeNull();
    });
});
