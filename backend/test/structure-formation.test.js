// Every park, square and lake follows one parcel-formation path; stations remain content on their
// corridor and therefore form no ground of their own.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { structureNeedsGroundFormation } = require('../../frontend/js/proposals/apply/structures.js');

describe('structure ground formation', () => {
    it('forms ground for every land-based structure kind', () => {
        expect(structureNeedsGroundFormation('park')).toBe(true);
        expect(structureNeedsGroundFormation('square')).toBe(true);
        expect(structureNeedsGroundFormation('lake')).toBe(true);
    });

    it('keeps stations content-only on their corridor', () => {
        expect(structureNeedsGroundFormation('station')).toBe(false);
    });
});
