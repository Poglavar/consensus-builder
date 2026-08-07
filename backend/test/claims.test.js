// claims.js — the pure half of the claims model (rethink-proposals.md §13): claim ranking, the
// base-parcel breadcrumb projection, and the dossier ("every proposal claiming this ground").

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let claims;

beforeAll(() => {
    globalThis.turf = require('@turf/turf');
    claims = require('../../frontend/js/proposals/claims.js');
});

describe('claim kinds and ranks', () => {
    it('ranks content above fabric above ground', () => {
        expect(claims.claimRank('content')).toBeGreaterThan(claims.claimRank('fabric'));
        expect(claims.claimRank('fabric')).toBeGreaterThan(claims.claimRank('ground'));
        expect(claims.claimRank('nonsense')).toBe(0);
    });

    it('classifies goals: fabric-changers vs content vs the null claim', () => {
        expect(claims.claimKindForGoal('road-track')).toBe('fabric');
        expect(claims.claimKindForGoal('reparcellization')).toBe('fabric');
        expect(claims.claimKindForGoal('decide-later')).toBe('fabric');
        expect(claims.claimKindForGoal('park')).toBe('fabric');
        expect(claims.claimKindForGoal('single')).toBe('fabric');
        expect(claims.claimKindForGoal('urban-rule')).toBe('content');
        expect(claims.claimKindForGoal('')).toBe('ground');
        expect(claims.claimKindForGoal(null)).toBe('ground');
    });
});

describe('baseParcelIdsOf', () => {
    it('prefers the published cadastreParcelIds stamp', () => {
        const proposal = {
            cadastreParcelIds: ['HR-339270-824', 'HR-339270-823/1'],
            parentParcelIds: ['HR-339270-9999#p-x-1'] // must be ignored when the stamp exists
        };
        expect(claims.baseParcelIdsOf(proposal)).toEqual(['HR-339270-824', 'HR-339270-823/1']);
    });

    it('falls back to the roots of every declared parent list', () => {
        const proposal = {
            parentParcelIds: ['HR-339270-824#p-2aa4pazypet-2'],
            roadProposal: { parentParcelIds: ['HR-339270-823/1#p-a-1#p-b-2', 'HR-339270-6801'] }
        };
        expect(claims.baseParcelIdsOf(proposal)).toEqual([
            'HR-339270-824', 'HR-339270-823/1', 'HR-339270-6801'
        ]);
    });

    it('is empty for nothing', () => {
        expect(claims.baseParcelIdsOf(null)).toEqual([]);
        expect(claims.baseParcelIdsOf({})).toEqual([]);
    });
});

describe('dossierFor', () => {
    const proposals = [
        { proposalId: 'p-road', title: 'Road X', goal: 'road-track', applied: true, cadastreParcelIds: ['HR-1-100', 'HR-1-101'] },
        { proposalId: 'p-lake', title: 'Lake Y', goal: 'lake', applied: false, parentParcelIds: ['HR-1-100#p-road-1'] },
        { proposalId: 'p-far', title: 'Elsewhere', goal: 'park', applied: true, cadastreParcelIds: ['HR-1-999'] }
    ];

    it('collects every proposal whose base ancestry touches the parcel, applied first within one claim rank', () => {
        const dossier = claims.dossierFor('HR-1-100', proposals);
        expect(dossier.map(e => e.proposalId)).toEqual(['p-road', 'p-lake']);
        expect(dossier[0].kind).toBe('fabric');
        expect(dossier[1].kind).toBe('fabric');
    });

    it('projects a derived parcel id to its root before matching', () => {
        const dossier = claims.dossierFor('HR-1-100#p-road-7#p-sub-2', proposals);
        expect(dossier.map(e => e.proposalId)).toEqual(['p-road', 'p-lake']);
    });

    it('honours a caller-supplied applied-state accessor', () => {
        const dossier = claims.dossierFor('HR-1-100', proposals, { isApplied: () => true });
        expect(dossier.every(e => e.applied)).toBe(true);
    });
});

describe('formationReplacesCadastreParcel', () => {
    it('hides every consumed root even when the single corridor child is named after another root', () => {
        const road = {
            proposalId: 'road',
            applied: true,
            cadastreParcelIds: ['HR-1', 'HR-2'],
            childParcelIds: ['HR-1#road-1']
        };
        expect(claims.formationReplacesCadastreParcel(road, 'HR-1')).toBe(true);
        expect(claims.formationReplacesCadastreParcel(road, 'HR-2')).toBe(true);
    });

    it('requires both a standing record and children derived in this replay', () => {
        expect(claims.formationReplacesCadastreParcel({
            applied: false,
            cadastreParcelIds: ['HR-1'],
            childParcelIds: ['HR-1#road-1']
        }, 'HR-1')).toBe(false);
        expect(claims.formationReplacesCadastreParcel({
            applied: true,
            cadastreParcelIds: ['HR-1'],
            childParcelIds: []
        }, 'HR-1')).toBe(false);
    });
});

describe('shortParcelLabel', () => {
    it('drops the HR-<ko>- prefix and keeps the parcel number', () => {
        expect(claims.shortParcelLabel('HR-339270-823/1')).toBe('823/1');
        expect(claims.shortParcelLabel('not-a-parcel')).toBe('not-a-parcel');
    });
});
