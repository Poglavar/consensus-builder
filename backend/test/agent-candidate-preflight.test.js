// Candidate binding preflight: the design a pick would publish is bound as the index binds it (its
// building footprint, derived, nothing declared), and only a candidate whose design binds exactly its
// own parcel with complete cadastral coverage is kept; provider timeouts retry the identical read.
import { describe, expect, it, vi } from 'vitest';
import {
    bindingRejection, checkCandidateBinding, preflightCandidates, prioritizedPlannedCandidates
} from '../agents/candidate-preflight.js';

const FOOTPRINT = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.9703, 45.8], [15.9703, 45.8002], [15.97, 45.8002], [15.97, 45.8]]] };

function candidate(id, overrides = {}) {
    return {
        candidateId: `densifier-01:${id}`,
        parcelId: id,
        massing: { type: 'Feature', properties: { floors: 3, height: 9 }, geometry: FOOTPRINT },
        offer: 100,
        normalizedRule: null,
        ...overrides
    };
}

const persona = { name: 'densifier-01' };
const context = { db: { tag: 'db' }, persona, city: 'cape_town' };
const binds = (parcelIds, coverage = 'complete') => ({ ok: true, binding: { coverage, parcels: parcelIds.map(parcelId => ({ parcelId, overlapM2: 50, intrusionM: 2 })) } });

describe('candidate binding preflight', () => {
    it('binds the design footprint as the index does: derived, nothing declared, no cadastre ids', async () => {
        const calls = [];
        const result = await checkCandidateBinding({
            ...context, candidate: candidate('HR-1'),
            checkBinding: async (db, shape, declared, options) => {
                calls.push({ db, shape, declared, options });
                return binds(['HR-1']);
            }
        });
        expect(result).toEqual({ ok: true, binding: binds(['HR-1']).binding, parcelIds: ['HR-1'] });
        expect(calls).toHaveLength(1);
        const [{ db, shape, declared, options }] = calls;
        expect(db).toBe(context.db);
        expect(declared).toEqual([]);
        expect(options).toEqual({ city: 'cape_town', parcelSourceId: null, derive: true });
        // The footprint is the candidate's massing, as the published design carries it.
        expect(shape.geometry.buildings).toHaveLength(1);
        expect(shape.geometry.buildings[0].geometry).toEqual(FOOTPRINT);
        expect(shape.buildingProposal).toMatchObject({ typologyType: 'single', parameters: { floors: 3, height: 9 } });
        expect(shape).toMatchObject({ roadProposal: null, structureProposal: null, parcelLayout: null });
        expect(JSON.stringify(shape)).not.toMatch(/cadastreParcelIds|proposalId/);
    });

    it('rejects a design that binds more than its parcel, then keeps a later good candidate', async () => {
        const wide = candidate('wide');
        const good = candidate('good');
        let calls = 0;
        const result = await preflightCandidates({
            ...context, rankedCandidates: [wide, good], limit: 1, scanLimit: 2,
            checkBinding: async () => {
                calls += 1;
                return calls === 1 ? binds(['wide', 'neighbour']) : binds(['good']);
            }
        });
        expect(result.candidates).toEqual([good]);
        expect(result.rejected).toEqual([{
            candidateId: wide.candidateId, code: 'agent-binding-not-candidate',
            reason: 'The building binds neighbour, wide, not exactly wide.', bound: 2
        }]);
        expect(result.scanned).toBe(2);
    });

    it('rejects a design that binds another single parcel', async () => {
        const result = await checkCandidateBinding({ ...context, candidate: candidate('mine'), checkBinding: async () => binds(['other']) });
        expect(result).toMatchObject({ ok: false, code: 'agent-binding-not-candidate', parcelIds: ['other'] });
    });

    it('preserves ranked accepted order and stops at the candidate limit', async () => {
        const ranked = [candidate('a'), candidate('b'), candidate('c')];
        let next = 0;
        const checker = vi.fn(async () => binds([ranked[next++].parcelId]));
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
        const checker = vi.fn(async () => { throw Object.assign(new Error('database connection reset'), { code: 'ECONNRESET' }); });
        await expect(preflightCandidates({
            ...context, rankedCandidates: [candidate('a'), candidate('b')], limit: 1, scanLimit: 2, checkBinding: checker
        })).rejects.toThrow('database connection reset');
        expect(checker).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unknown', binds(['incomplete'], 'unknown'), 'unknown'],
        ['partial', binds(['incomplete'], 'partial'), 'partial'],
        ['missing', { ok: true }, 'missing']
    ])('rejects %s coverage and continues scanning to a complete candidate', async (_label, incomplete, coverage) => {
        const first = candidate('incomplete');
        const second = candidate('complete');
        let calls = 0;
        const result = await preflightCandidates({
            ...context, rankedCandidates: [first, second], limit: 1, scanLimit: 2,
            checkBinding: async () => (calls++ === 0 ? incomplete : binds(['complete']))
        });
        expect(result.candidates).toEqual([second]);
        expect(result.rejected).toEqual([{
            candidateId: first.candidateId, code: 'agent-cadastre-incomplete',
            reason: `Autonomous agreements need complete cadastral coverage; the binding is ${coverage}.`,
            bound: incomplete.binding ? 1 : 0
        }]);
        expect(result.scanned).toBe(2);
    });

    it('passes the explicit non-default NYC source into the binding', async () => {
        const nyc = candidate('US-NYC-BBL-1001440001', { parcelSourceId: 'us-nyc-dof-digital-tax-map' });
        let observed;
        const result = await checkCandidateBinding({
            ...context, candidate: nyc, city: 'new_york',
            checkBinding: async (_db, _shape, declared, options) => {
                observed = { declared, options };
                return binds(['US-NYC-BBL-1001440001']);
            }
        });
        expect(result.ok).toBe(true);
        expect(observed).toEqual({ declared: [], options: { city: 'new_york', parcelSourceId: 'us-nyc-dof-digital-tax-map', derive: true } });
    });

    it('passes an explicit checker refusal through with no bound parcels', async () => {
        const failure = { ok: false, status: 400, code: 'footprint-outside-site', error: 'The canonical check failed.' };
        const result = await checkCandidateBinding({ ...context, candidate: candidate('selected'), checkBinding: async () => failure });
        expect(result).toEqual({ ...failure, parcelIds: [] });
        expect(bindingRejection(candidate('selected'), result)).toEqual({
            candidateId: 'densifier-01:selected', code: 'footprint-outside-site', reason: 'The canonical check failed.', bound: 0
        });
    });

    it('refuses a checker answer without a boolean verdict', async () => {
        await expect(checkCandidateBinding({ ...context, candidate: candidate('x'), checkBinding: async () => ({ binding: {} }) }))
            .rejects.toThrow('binding checker returned no boolean result for densifier-01:x');
        await expect(checkCandidateBinding({ ...context, candidate: candidate('x') })).rejects.toThrow('checkBinding must be injected');
    });

    it('retries only the identical local binding read after a provider timeout', async () => {
        const selected = candidate('GB-HMLR-LONDON-123', { parcelSourceId: 'gb-hmlr-city-of-london' });
        const checker = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Parcel provider timed out.'), { status: 504, code: 'parcel-source-unavailable' }))
            .mockResolvedValueOnce(binds(['GB-HMLR-LONDON-123']));
        const logged = [];
        const result = await checkCandidateBinding({
            ...context, candidate: selected, checkBinding: checker,
            retryOptions: { retryDelaysMs: [0, 0] }, log: value => logged.push(value)
        });
        expect(result.ok).toBe(true);
        expect(checker).toHaveBeenCalledTimes(2);
        expect(checker.mock.calls[0]).toEqual(checker.mock.calls[1]);
        expect(checker.mock.calls[0][1]).toBe(checker.mock.calls[1][1]);
        expect(logged.join('\n')).toMatch(/gb-hmlr-city-of-london.*attempt 1\/3/);
    });

    it('stops candidate scanning after a persistently incomplete provider read', async () => {
        const counts = { matched: 190, returned: 190, received: 189 };
        const checker = vi.fn(async () => { throw Object.assign(new Error('matched=190 returned=190 received=189'), {
            status: 502, code: 'parcel-source-unavailable', parcelCounts: counts
        }); });
        await expect(preflightCandidates({
            ...context, rankedCandidates: [candidate('a'), candidate('b')], limit: 1, checkBinding: checker,
            retryOptions: { retryDelaysMs: [0, 0] }
        })).rejects.toMatchObject({ attempts: 3, parcelCounts: counts, message: expect.stringMatching(/received=189/) });
        expect(checker).toHaveBeenCalledTimes(3);
        // Every attempt read the same candidate's design.
        expect(new Set(checker.mock.calls.map(call => call[1])).size).toBe(1);
    });

    it.each(['parcel-source-blocked', 'parcel-source-rate-limited'])('does not retry local %s errors', async code => {
        const checker = vi.fn(async () => { throw Object.assign(new Error('provider refused'), { status: 502, code }); });
        await expect(checkCandidateBinding({
            ...context, candidate: candidate('a'), checkBinding: checker, retryOptions: { retryDelaysMs: [0, 0] }
        })).rejects.toMatchObject({ code, attempts: 1 });
        expect(checker).toHaveBeenCalledOnce();
    });
});
