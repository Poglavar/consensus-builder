import { describe, expect, it } from 'vitest';
import { selectAlgorithmicPicks } from '../agents/algorithmic-picker.js';

function candidate(id, score, overrides = {}) {
    return {
        candidateId: `densifier-01:${id}`,
        parcelId: id,
        koName: 'RUDEŠ',
        score,
        gainEur: 100000,
        offerEur: 30000,
        builtGfaM2: 200,
        proposedGfaM2: 500,
        allowedFloors: 4,
        rule: { source: 'urban-rule' },
        ...overrides
    };
}

const persona = { name: 'densifier-01', dailyProposals: 1 };

describe('algorithmic proposal picker', () => {
    it('is stable for the same day and varies only among near-best candidates', () => {
        const candidates = [candidate('a', 1), candidate('b', 0.95), candidate('c', 0.91), candidate('d', 0.5)];
        const first = selectAlgorithmicPicks({ day: '2026-09-20', persona, candidates });
        const second = selectAlgorithmicPicks({ day: '2026-09-20', persona, candidates });

        expect(second).toEqual(first);
        expect(first.picks).toHaveLength(1);
        expect(['densifier-01:a', 'densifier-01:b', 'densifier-01:c']).toContain(first.picks[0].candidateId);
        expect(first.policy.competitiveCandidateIds).not.toContain('densifier-01:d');
    });

    it('requires an explicit urban rule and positive measured uplift', () => {
        const result = selectAlgorithmicPicks({
            day: '2026-09-20',
            persona,
            candidates: [
                candidate('default-rule', 1, { rule: { source: 'default' } }),
                candidate('no-uplift', 0.9, { proposedGfaM2: 200 }),
                candidate('eligible', 0.8)
            ]
        });
        expect(result.picks.map(pick => pick.candidateId)).toEqual(['densifier-01:eligible']);
        expect(result.policy.eligibleCandidateIds).toEqual(['densifier-01:eligible']);
    });

    it('writes its name and rationale only from candidate facts', () => {
        const result = selectAlgorithmicPicks({ day: '2026-09-20', persona, candidates: [candidate('2178', 1)] });
        expect(result.picks[0]).toMatchObject({
            name: 'Plan-led infill in RUDEŠ',
            rationale: expect.stringContaining('from 200 m² to 500 m²')
        });
        expect(result.picks[0].rationale).toContain('€30,000');
    });

    it('returns a valid no-pick result when every candidate fails the guardrails', () => {
        const result = selectAlgorithmicPicks({
            day: '2026-09-20', persona, candidates: [candidate('bad', 0, { gainEur: 0 })]
        });
        expect(result.picks).toEqual([]);
        expect(result.policy.eligibleCandidateIds).toEqual([]);
    });
});
