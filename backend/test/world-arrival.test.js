// Globe arrival (frontend/js/world/arrival.js): a city or feed pick dives into 3D on a proposal only
// when there is one and the city has 3D buildings to stand it among; the city's proposal is the
// newest row of GET /proposals/summary.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const arrival = createRequire(import.meta.url)('../../frontend/js/world/arrival.js');

describe('globe arrival decision', () => {
    it('dives into 3D for a proposal in a city with 3D buildings', () => {
        expect(arrival.plan({ proposalId: 'p-1', buildingsSource: 'gdi_building_3d' })).toEqual({ dive3D: true });
        expect(arrival.plan({ proposalId: 'p-1', buildingsSource: 'overture' })).toEqual({ dive3D: true });
        // Zagreb has no buildings block: the default provider (map-core.js reads it the same way).
        expect(arrival.plan({ proposalId: 'p-1', buildingsSource: undefined })).toEqual({ dive3D: true });
    });

    it('stays in 2D without a proposal or without 3D buildings', () => {
        expect(arrival.plan({ proposalId: null, buildingsSource: 'overture' })).toEqual({ dive3D: false });
        expect(arrival.plan({ proposalId: '', buildingsSource: 'overture' })).toEqual({ dive3D: false });
        expect(arrival.plan({ proposalId: 'p-1', buildingsSource: 'none' })).toEqual({ dive3D: false });
    });
});

describe('latest proposal from the summary payload', () => {
    it('takes the first (newest) row and prefers the uploader proposalId', () => {
        const payload = { proposals: [{ id: 41, proposalId: 'road-7' }, { id: 40, proposalId: 'park-2' }], count: 2 };
        expect(arrival.latestProposalId(payload)).toBe('road-7');
    });

    it('falls back to the row id and returns null for an empty city', () => {
        expect(arrival.latestProposalId({ proposals: [{ id: 41, proposalId: null }] })).toBe('41');
        expect(arrival.latestProposalId({ proposals: [] })).toBeNull();
        expect(arrival.latestProposalId(null)).toBeNull();
    });
});
