// The server-side effect hash (proposals/effect-hash.js) and the backfill's decision per row
// (scripts/stamp-effect-hashes.mjs): the stamp is the browser's own fingerprint, recomputed from the
// stored fields, never echoed from the uploader, and absent where only the browser can derive it.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { effectHashOf } from '../proposals/effect-hash.js';
import { decide } from '../scripts/stamp-effect-hashes.mjs';

const require = createRequire(import.meta.url);
const ownershipFlow = require('../../frontend/js/proposals/ownership-flow.js');

const square = (lng, lat, size = 0.001) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]]
});
const building = () => ({
    goal: 'single-building', geometry: square(16, 45.8), structureProposal: { geometry: square(16.002, 45.8) },
    ownershipFlow: [{ parcelId: 'HR-1', cededM2: 0, destination: 'owner' }]
});

describe('effectHashOf', () => {
    it('is the browser fingerprint of the stored fields, not the uploader\'s stamp', () => {
        const record = building();
        const expected = ownershipFlow.effectFingerprintOf(record);
        expect(expected).toMatch(/^e-/);
        expect(effectHashOf({ ...record, effectHash: 'e-uploader' })).toBe(expected);
    });

    it('leaves a content-only record and a legacy centre-line road to the browser', () => {
        expect(effectHashOf({ goal: 'urban-rule', cadastreParcelIds: ['HR-1'] })).toBeNull();
        const legacy = { goal: 'road-track', roadProposal: { definition: {
            points: [[16, 45.8], [16.001, 45.8]], width: 12,
            constructionFrame: { kind: 'legacy-centreline', migration: 'legacy-centreline-v1' }
        } } };
        expect(effectHashOf(legacy)).toBeNull();
    });
});

describe('stamp-effect-hashes decide', () => {
    it('stamps a missing hash, leaves a present one alone, and verifies on request', () => {
        const record = building();
        const hash = effectHashOf(record);
        expect(decide(record, null)).toEqual({ action: 'stamp', hash });
        expect(decide(record, hash)).toEqual({ action: 'already' });
        expect(decide(record, hash, { verify: true })).toEqual({ action: 'verified' });
        expect(decide(record, 'e-other', { verify: true })).toMatchObject({ action: 'mismatch', hash });
        expect(decide(record, 'e-other', { restamp: true })).toMatchObject({ action: 'restamp', hash });
        expect(decide(record, hash, { restamp: true })).toEqual({ action: 'verified' });
    });

    it('skips what the server cannot hash, naming why', () => {
        expect(decide({ goal: 'urban-rule' }, null)).toMatchObject({ action: 'skip' });
    });
});
