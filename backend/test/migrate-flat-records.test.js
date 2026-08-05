// The flatten core of the §15a migration: parent declarations go to base cadastral ids, deduped;
// consent fields and child bookkeeping are never touched; legacy underscore-form ids pass through.
import { describe, it, expect } from 'vitest';
import { flattenIdList, flattenProposalObject } from '../scripts/migrate-flat-records.js';

describe('flattenIdList', () => {
    it('strips derived suffixes and dedupes, preserving order', () => {
        expect(flattenIdList([
            'HR-339270-823/1#p-1mkonr8j4t2-1',
            'HR-339270-823/2',
            'HR-339270-823/1',            // duplicate of the first once flattened
            'HR-339270-6804/1#p-2g0teu3onpu-2'
        ])).toEqual(['HR-339270-823/1', 'HR-339270-823/2', 'HR-339270-6804/1']);
    });

    it('returns null when nothing changes (idempotent re-run)', () => {
        expect(flattenIdList(['HR-1', 'HR-2'])).toBeNull();
        expect(flattenIdList(null)).toBeNull();
    });

    it('leaves government-roads underscore-form ids untouched', () => {
        expect(flattenIdList(['HR-335649-371_proposal_2', 'HR-1#p-abc-1']))
            .toEqual(['HR-335649-371_proposal_2', 'HR-1']);
    });
});

describe('flattenProposalObject', () => {
    it('flattens top-level and sub-payload parent lists plus the reparcellization pool, in place', () => {
        const record = {
            parentParcelIds: ['HR-1#a-1'],
            roadProposal: { parentParcelIds: ['HR-2#b-2', 'HR-2'], childParcelIds: ['HR-2#me-1'] },
            reparcellization: { parentParcelIds: ['HR-3#c-3'], parcelIds: ['HR-4#d-4'] },
            ownerAcceptances: { 'HR-1#a-1': { accepted: true } }
        };
        const paths = flattenProposalObject(record);
        expect(paths).toEqual([
            'parentParcelIds',
            'roadProposal.parentParcelIds',
            'reparcellization.parentParcelIds',
            'reparcellization.parcelIds'
        ]);
        expect(record.parentParcelIds).toEqual(['HR-1']);
        expect(record.roadProposal.parentParcelIds).toEqual(['HR-2']);
        // Child bookkeeping and consent stay byte-identical.
        expect(record.roadProposal.childParcelIds).toEqual(['HR-2#me-1']);
        expect(record.ownerAcceptances).toEqual({ 'HR-1#a-1': { accepted: true } });
    });

    it('reports nothing for an already-flat record', () => {
        expect(flattenProposalObject({ parentParcelIds: ['HR-1'], buildingProposal: { parentParcelIds: ['HR-2'] } }))
            .toEqual([]);
    });
});

import { dropForeignChildIds, syntheticTokenOf } from '../scripts/migrate-flat-records.js';

describe('dropForeignChildIds (dead-generation snapshots)', () => {
    it('drops child ids minted under a foreign token, keeps its own and base ids', () => {
        expect(dropForeignChildIds([
            'HR-339270-823/1#p-2g0teu3onpu-1',   // dead predecessor generation
            'HR-339270-823/1#c-3g5b9q1ch9176-2', // own mint
            'HR-339270-824'                       // base id (defensive)
        ], 'c-3g5b9q1ch9176')).toEqual([
            'HR-339270-823/1#c-3g5b9q1ch9176-2',
            'HR-339270-824'
        ]);
    });

    it('returns null when every child is its own (idempotent re-run)', () => {
        expect(dropForeignChildIds(['HR-1#c-abc-1', 'HR-1#c-abc-2'], 'c-abc')).toBeNull();
        expect(dropForeignChildIds(null, 'c-abc')).toBeNull();
    });

    it('sanitizes the token exactly as the identity subsystem does', () => {
        expect(syntheticTokenOf('p-a#b c!')).toBe('p-abc');
        expect(dropForeignChildIds(['HR-1#p-abc-1'], 'p-a#b c!')).toBeNull();
    });
});
