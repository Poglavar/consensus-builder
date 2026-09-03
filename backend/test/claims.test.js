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

describe('cadastreParcelIdsOf', () => {
    it('prefers the published cadastreParcelIds stamp', () => {
        const proposal = {
            cadastreParcelIds: ['HR-339270-824', 'HR-339270-823/1'],
            parentParcelIds: ['HR-339270-9999#p-x-1'] // must be ignored when the stamp exists
        };
        expect(claims.cadastreParcelIdsOf(proposal)).toEqual(['HR-339270-824', 'HR-339270-823/1']);
    });

    it('does not reinterpret parent ids or opaque id spelling as cadastral provenance', () => {
        expect(claims.cadastreParcelIdsOf({
            parentParcelIds: ['HR-339270-824', 'HR-339270-6801']
        })).toEqual([]);
        expect(claims.cadastreParcelIdsOf({
            cadastreParcelIds: ['HR-339270-824#p-2aa4pazypet-2']
        })).toEqual(['HR-339270-824#p-2aa4pazypet-2']);
    });

    it('is empty for nothing', () => {
        expect(claims.cadastreParcelIdsOf(null)).toEqual([]);
        expect(claims.cadastreParcelIdsOf({})).toEqual([]);
    });
});

describe('dossierFor', () => {
    const proposals = [
        { proposalId: 'p-road', title: 'Road X', goal: 'road-track', applied: true, cadastreParcelIds: ['HR-1-100', 'HR-1-101'] },
        { proposalId: 'p-lake', title: 'Lake Y', goal: 'lake', applied: false, cadastreParcelIds: ['HR-1-100'] },
        { proposalId: 'p-far', title: 'Elsewhere', goal: 'park', applied: true, cadastreParcelIds: ['HR-1-999'] }
    ];

    it('collects every proposal whose base ancestry touches the parcel, applied first within one claim rank', () => {
        const dossier = claims.dossierFor('HR-1-100', proposals);
        expect(dossier.map(e => e.proposalId)).toEqual(['p-road', 'p-lake']);
        expect(dossier[0].kind).toBe('fabric');
        expect(dossier[1].kind).toBe('fabric');
    });

    it('projects a live parcel through explicit fabric provenance before matching', () => {
        globalThis.LiveParcelFabric = {
            get: id => String(id) === 'live-piece'
                ? { type: 'Feature', properties: { parcelId: 'live-piece', cadastreParcelIds: ['HR-1-100'] }, geometry: null }
                : null,
            explicitCadastreIds: feature => feature.properties.cadastreParcelIds
        };
        const dossier = claims.dossierFor('live-piece', proposals);
        expect(dossier.map(e => e.proposalId)).toEqual(['p-road', 'p-lake']);
        delete globalThis.LiveParcelFabric;
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
            cadastreParcelIds: ['HR-1', 'HR-2']
        };
        const options = { hasMaterializedOutput: () => true };
        expect(claims.formationReplacesCadastreParcel(road, 'HR-1', options)).toBe(true);
        expect(claims.formationReplacesCadastreParcel(road, 'HR-2', options)).toBe(true);
    });

    it('requires both a standing record and output materialized in this replay', () => {
        expect(claims.formationReplacesCadastreParcel({
            applied: false,
            cadastreParcelIds: ['HR-1']
        }, 'HR-1', { hasMaterializedOutput: () => true })).toBe(false);
        expect(claims.formationReplacesCadastreParcel({
            applied: true,
            cadastreParcelIds: ['HR-1']
        }, 'HR-1', { hasMaterializedOutput: () => false })).toBe(false);
    });
});

describe('shortParcelLabel', () => {
    it('drops the HR-<ko>- prefix and keeps the parcel number', () => {
        expect(claims.shortParcelLabel('HR-339270-823/1')).toBe('823/1');
        expect(claims.shortParcelLabel('not-a-parcel')).toBe('not-a-parcel');
    });
});
