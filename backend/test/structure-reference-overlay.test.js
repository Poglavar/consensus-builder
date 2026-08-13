// Reference reconstructions must render official park/square geometry without simulating a new
// cadastral taking; ordinary authored structures keep the existing whole-parcel formation rule.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    structureNeedsDemolitionScan,
    structureNeedsGroundFormation,
    structureNeedsLiveParentResolution
} = require('../../frontend/js/proposals/apply/structures.js');

describe('structure reference overlays', () => {
    it('skips land formation only when the proposal explicitly opts into reference mode', () => {
        expect(structureNeedsGroundFormation('park', { referenceOnly: true })).toBe(false);
        expect(structureNeedsGroundFormation('square', { referenceOnly: true })).toBe(false);
        expect(structureNeedsGroundFormation('park', {})).toBe(true);
        expect(structureNeedsGroundFormation('square', {})).toBe(true);
    });

    it('keeps stations content-only regardless of the reconstruction flag', () => {
        expect(structureNeedsGroundFormation('station', {})).toBe(false);
        expect(structureNeedsGroundFormation('station', { referenceOnly: true })).toBe(false);
    });

    it('does not infer demolition beneath an archival reference overlay', () => {
        expect(structureNeedsDemolitionScan({ referenceOnly: true })).toBe(false);
        expect(structureNeedsDemolitionScan({})).toBe(true);
    });

    it('does not bind a reference overlay to mutable derived ground', () => {
        expect(structureNeedsLiveParentResolution({ referenceOnly: true })).toBe(false);
        expect(structureNeedsLiveParentResolution({})).toBe(true);
    });
});
