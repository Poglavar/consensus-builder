// The cross-section editor's treatment of buildings this road already demolished, when a width
// change touches them again. Records WITHOUT a remainder are full demolitions — nothing stands,
// excluded from detection like tunnelled buildings. Records WITH a remainder left the building
// standing: a widening into it must be DETECTED (painted amber, own indicator) but must not block
// Apply — the demolition was consented and apply-time re-carving deepens it (road-drawing).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corridorEditorPartitionDemolitions } = require('../../frontend/js/corridor-editor.js');

describe('corridorEditorPartitionDemolitions', () => {
    it('excludes full demolitions and marks partial ones (remainder standing) as re-cuttable', () => {
        const { excluded, recut } = corridorEditorPartitionDemolitions([
            { id: 'gone', geometry: {} },
            { id: 'half', geometry: {}, remainder: { type: 'Polygon', coordinates: [] } }
        ]);
        expect([...excluded]).toEqual(['gone']);
        expect([...recut]).toEqual(['half']);
    });

    it('coerces ids to strings so they match the string ids detection hits carry', () => {
        const { excluded, recut } = corridorEditorPartitionDemolitions([
            { id: 42 },
            { id: 7, remainder: {} }
        ]);
        expect(excluded.has('42')).toBe(true);
        expect(recut.has('7')).toBe(true);
    });

    it('ignores empty, id-less and missing record lists', () => {
        expect(corridorEditorPartitionDemolitions(null).excluded.size).toBe(0);
        const { excluded, recut } = corridorEditorPartitionDemolitions([null, { remainder: {} }, { geometry: {} }]);
        expect(excluded.size).toBe(0);
        expect(recut.size).toBe(0);
    });
});
