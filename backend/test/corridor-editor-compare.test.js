// The cross-section editor's "Before / after" chip (dividers.md, M4): present for a placed road
// that can be compared, pressed while the comparison runs, absent while drawing.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corridorEditorCompareHtml } = require('../../frontend/js/corridor-editor.js');

describe('corridorEditorCompareHtml', () => {
    it('offers the toggle only for a placed road the session can compare, with its pressed state', () => {
        const idle = corridorEditorCompareHtml({ mode: 'proposal', canCompare: true, active: false, label: 'Prije / Poslije' });
        expect(idle).toContain('class="corridor-editor-indicator corridor-editor-compare btn-compare-proposal"');
        expect(idle).toContain('aria-pressed="false"');
        expect(idle).toContain('Prije / Poslije');
        expect(corridorEditorCompareHtml({ mode: 'proposal', canCompare: true, active: true })).toContain('aria-pressed="true"');
        expect(corridorEditorCompareHtml({ mode: 'drawing', canCompare: true, active: false })).toBe('');
        expect(corridorEditorCompareHtml({ mode: 'proposal', canCompare: false })).toBe('');
        expect(corridorEditorCompareHtml()).toBe('');
    });
});
