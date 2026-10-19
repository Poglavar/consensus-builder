import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
    checkCandidateBinding, preflightCandidates, prioritizedPlannedCandidates
} from '../agents/candidate-preflight.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

function candidate(id, overrides = {}) {
    return {
        candidateId: `densifier-01:${id}`,
        parcelId: id,
        massing: {
            type: 'Feature',
            properties: { floors: 3, height: 9 },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] }
        },
        offerEur: 100,
        normalizedRule: null,
        ...overrides
    };
}

const persona = { name: 'densifier-01' };
const context = { db: {}, persona, runId: 'test-run', city: 'cape_town', turf };
const bindingOk = async () => ({ ok: true, binding: { coverage: 'complete' } });

describe('candidate binding preflight', () => {
    it('rejects a bad candidate, keeps a later good one, and records missing parcel counts without widening', async () => {
        const bad = candidate('bad-parcel');
        const good = candidate('good-parcel');
        const calls = [];
        const result = await preflightCandidates({
            ...context, rankedCandidates: [bad, good], limit: 1, scanLimit: 2,
            checkBinding: async (_db, record, declared, options) => {
                calls.push({ record, declared, options });
                return record.cadastreParcelIds[0] === bad.parcelId
                    ? { ok: false, code: 'undeclared-parcels', error: 'Site reaches into four more parcels.', missing: [{}, {}, {}, {}], extra: [] }
                    : { ok: true, binding: { coverage: 'complete' } };
            }
        });

        expect(result.candidates).toEqual([good]);
        expect(result.rejected).toEqual([{
            candidateId: bad.candidateId, code: 'undeclared-parcels',
            reason: 'Site reaches into four more parcels.', missing: 4, extra: 0
        }]);
        expect(result.scanned).toBe(2);
        expect(calls[0].declared).toEqual([bad.parcelId]);
        expect(calls[0].record.cadastreParcelIds).toEqual([bad.parcelId]);
        expect(calls[0].options.city).toBe('cape_town');
        expect('site' in calls[0].options).toBe(false);
        expect(calls[0].record.proposalId).toBe(`preflight-${bad.candidateId}`);
    });

    it('preserves ranked accepted order and stops at the candidate limit', async () => {
        const ranked = [candidate('a'), candidate('b'), candidate('c')];
        const checker = vi.fn(bindingOk);
        const result = await preflightCandidates({
            ...context, rankedCandidates: ranked, limit: 2, scanLimit: 3, checkBinding: checker
        });
        expect(result.candidates).toEqual(ranked.slice(0, 2));
        expect(result.rejected).toEqual([]);
        expect(result.scanned).toBe(2);
        expect(checker).toHaveBeenCalledTimes(2);
    });

    it('keeps the existing rule-backed preference before filtering', () => {
        const defaultRule = candidate('default', { rule: { source: 'default' } });
        const backedA = candidate('backed-a', { rule: { source: 'urban-rule' } });
        const backedB = candidate('backed-b', { rule: { source: 'urban-rule' } });
        expect(prioritizedPlannedCandidates([defaultRule, backedA, backedB])).toEqual([backedA, backedB]);
        expect(prioritizedPlannedCandidates([defaultRule])).toEqual([defaultRule]);
    });

    it('propagates binding transport errors and stops scanning instead of accepting candidates', async () => {
        const ranked = [candidate('a'), candidate('b')];
        const checker = vi.fn(async () => { throw new Error('database connection reset'); });
        await expect(preflightCandidates({
            ...context, rankedCandidates: ranked, limit: 1, scanLimit: 2, checkBinding: checker
        })).rejects.toThrow('database connection reset');
        expect(checker).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unknown', { ok: true, binding: { coverage: 'unknown' } }],
        ['partial', { ok: true, binding: { coverage: 'partial' } }],
        ['missing', { ok: true }]
    ])('rejects %s coverage and continues scanning to a complete candidate', async (_label, incomplete) => {
        const first = candidate('incomplete');
        const second = candidate('complete');
        const checker = vi.fn(async (_db, record) => record.cadastreParcelIds[0] === first.parcelId
            ? incomplete
            : { ok: true, binding: { coverage: 'complete' } });

        const result = await preflightCandidates({
            ...context, rankedCandidates: [first, second], limit: 1, scanLimit: 2, checkBinding: checker
        });

        expect(result.candidates).toEqual([second]);
        expect(result.rejected).toEqual([expect.objectContaining({
            candidateId: first.candidateId,
            code: 'agent-cadastre-incomplete',
            reason: `Autonomous proposals require complete cadastre binding; checker reported ${incomplete.binding?.coverage ?? 'missing'} coverage.`
        })]);
        expect(result.scanned).toBe(2);
        expect(checker).toHaveBeenCalledTimes(2);
    });

    it('rebuilds the actual selected record for the final check and keeps its single declared parcel', async () => {
        const pick = { proposalId: 'agent-test', name: 'Test building', rationale: 'Test rationale.' };
        let observed;
        await checkCandidateBinding({
            ...context, candidate: candidate('selected'), pick,
            checkBinding: async (_db, record, declared) => {
                observed = { record, declared };
                return { ok: true, binding: { coverage: 'complete' } };
            }
        });
        expect(observed.record.proposalId).toBe(pick.proposalId);
        expect(observed.record.cadastreParcelIds).toEqual(['selected']);
        expect(observed.declared).toEqual(['selected']);
    });

    it('passes the explicit non-default NYC source into canonical binding', async () => {
        const nyc = candidate('US-NYC-BBL-1001440001', {
            parcelSourceId: 'us-nyc-dof-digital-tax-map'
        });
        let observed;
        await checkCandidateBinding({
            ...context, candidate: nyc, city: 'new_york',
            checkBinding: async (_db, record, declared, options) => {
                observed = { record, declared, options };
                return { ok: true, binding: { coverage: 'complete' } };
            }
        });
        expect(observed.record.cadastreParcelIds).toEqual(['US-NYC-BBL-1001440001']);
        expect(observed.declared).toEqual(['US-NYC-BBL-1001440001']);
        expect(observed.options).toEqual({ city: 'new_york', parcelSourceId: 'us-nyc-dof-digital-tax-map' });
    });

    it.each([
        ['unknown', { ok: true, binding: { coverage: 'unknown' } }],
        ['partial', { ok: true, binding: { coverage: 'partial' } }],
        ['absent binding', { ok: true }]
    ])('refuses the final selected record when the checker reports %s coverage', async (_label, response) => {
        const result = await checkCandidateBinding({
            ...context, candidate: candidate('selected'), pick: { proposalId: 'agent-selected' },
            checkBinding: async () => response
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('agent-cadastre-incomplete');
        expect(result.error).toMatch(/Autonomous proposals require complete cadastre binding/);
    });

    it('preserves explicit checker failures unchanged', async () => {
        const failure = { ok: false, code: 'unknown-coverage', error: 'The canonical check failed.' };
        const result = await checkCandidateBinding({
            ...context, candidate: candidate('selected'), pick: { proposalId: 'agent-selected' },
            checkBinding: async () => failure
        });
        expect(result).toBe(failure);
    });
});
