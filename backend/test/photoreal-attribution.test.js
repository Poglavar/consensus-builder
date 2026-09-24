// Photo mode must credit Google's per-tile data providers on screen (Map Tiles API policy). The
// credit line is built from 3d-tiles-renderer's getAttributions() by a pure helper; this pins its
// shape: GoogleCloudAuthPlugin's '; '-joined string, Cesium ion html credits, dedupe, no markup.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attributionText } = require('../../frontend/js/photoreal-attribution.js');

describe('photoreal attributionText', () => {
    it('splits and dedupes the Google per-tile copyright string', () => {
        const list = [
            { type: 'string', value: 'Google; Airbus; Landsat / Copernicus' },
            { type: 'string', value: 'airbus;  Maxar Technologies ' }
        ];
        expect(attributionText(list)).toBe('Google; Airbus; Landsat / Copernicus; Maxar Technologies');
    });

    it('turns html credits into text and never passes markup through', () => {
        const list = [{ type: 'html', value: '<a href="https://x"><img src="logo.png"> Data &copy; Cesium&nbsp;ion</a><script>alert(1)</script>' }];
        const text = attributionText(list);
        expect(text).toBe('Data © Cesium ion alert(1)');
        expect(text).not.toMatch(/[<>]/);
    });

    it('skips logo images and empty values', () => {
        const list = [
            { type: 'image', value: 'https://example.com/google.png' },
            { type: 'string', value: '' },
            null,
            { type: 'string', value: null }
        ];
        expect(attributionText(list)).toBe('');
        expect(attributionText(undefined)).toBe('');
    });
});
