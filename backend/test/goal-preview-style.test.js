// Unit tests for frontend/js/proposals/goal-preview-style.js — the goal→preview-polygon style map.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { goalPreviewStyle } = require('../../frontend/js/proposals/goal-preview-style.js');

describe('goalPreviewStyle', () => {
    it('gives water a blue and a park a green', () => {
        expect(goalPreviewStyle('lake').fillColor).toBe('#3b82f6');
        expect(goalPreviewStyle('park').fillColor).toBe('#22c55e');
    });

    it('is case- and whitespace-insensitive', () => {
        expect(goalPreviewStyle('  LAKE ').fillColor).toBe('#3b82f6');
        expect(goalPreviewStyle('Road/Track')).toEqual(goalPreviewStyle('road-track'));
    });

    it('returns a full style triple for effect goals', () => {
        const s = goalPreviewStyle('square');
        expect(s).toMatchObject({ color: expect.any(String), fillColor: expect.any(String), fillOpacity: expect.any(Number) });
    });

    it('returns null for goals with no distinctive effect', () => {
        expect(goalPreviewStyle('reparcellization')).toBeNull();
        expect(goalPreviewStyle('as-is')).toBeNull();
        expect(goalPreviewStyle('ownership-transfer')).toBeNull();
        expect(goalPreviewStyle('')).toBeNull();
        expect(goalPreviewStyle(null)).toBeNull();
    });

    it('returns a fresh copy each call (callers may mutate)', () => {
        const a = goalPreviewStyle('lake');
        a.fillOpacity = 1;
        expect(goalPreviewStyle('lake').fillOpacity).toBe(0.38);
    });
});
