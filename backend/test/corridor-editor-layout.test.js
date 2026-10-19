// The docked cross-section editor points the map at the road it edits; the fitBounds padding must
// reserve the panel's own edge — right dock on desktop, bottom dock on mobile — so the road lands
// in the viewport the panel leaves free. The dock side is read off the panel rectangle itself
// (full-viewport-wide panel = bottom dock), so these tests pin that inference too.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corridorEditorFitPadding } = require('../../frontend/js/corridor-editor.js');

describe('corridorEditorFitPadding', () => {
    it('reserves the panel width on the right for a side-docked (desktop) panel', () => {
        const padding = corridorEditorFitPadding(1440, { width: 480, height: 900 });
        expect(padding.topLeft).toEqual([40, 40]);
        expect(padding.bottomRight).toEqual([520, 40]);
    });

    it('reserves the panel height at the bottom for a full-width (mobile) panel', () => {
        const padding = corridorEditorFitPadding(390, { width: 390, height: 400 });
        expect(padding.topLeft).toEqual([40, 40]);
        expect(padding.bottomRight).toEqual([40, 440]);
    });

    it('degrades to plain margins when the panel could not be measured', () => {
        const padding = corridorEditorFitPadding(1440, null);
        expect(padding.topLeft).toEqual([40, 40]);
        expect(padding.bottomRight).toEqual([40, 40]);
    });
});
