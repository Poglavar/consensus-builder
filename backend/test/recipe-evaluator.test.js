import { describe, expect, it } from 'vitest';
import { evaluateResolutionRecipe } from '../oracle/recipe-evaluator.js';

const register = { kind: 'public_register', address: 'register-1' };
const imagery = { kind: 'independent_imagery', address: 'imagery-1' };
const crowd = { kind: 'osm_provenance', address: 'osm-1' };

function recipe(policy) {
    return {
        eventType: 'building_completed',
        subject: { parcelUid: 'HR-1-2' },
        trustedAttesters: [register, imagery, crowd],
        outcomes: { completed: 'YES', absent: 'NO' },
        verification: { kind: 'lens_recipe', permissionless: true, evidencePolicy: policy }
    };
}

function event(id, outcome, attester, recordedAt = '2026-09-21T12:00:00Z') {
    return {
        id,
        eventType: 'building_completed',
        subject: { parcelUid: 'HR-1-2' },
        outcome,
        attester,
        observedAt: recordedAt,
        recordedAt,
        source: { hash: `sha256:${id}` }
    };
}

const subjectMatches = (candidate, declaration) => (
    candidate.subject?.parcelUid === declaration.subject.parcelUid
);

describe('resolution recipe evaluator', () => {
    it('resolves one authoritative fact under the default policy', () => {
        const result = evaluateResolutionRecipe({
            recipe: recipe(),
            evidence: [event('permit', 'completed', register)],
            subjectMatches,
            now: '2026-09-21T12:00:01Z'
        });
        expect(result).toMatchObject({
            status: 'resolved', decision: 'YES', outcome: 'completed',
            policy: { threshold: 1, challengeWindowSeconds: 0 },
            acceptedEvidence: ['permit']
        });
    });

    it('requires the declared threshold and attester kinds', () => {
        const declaration = recipe({
            threshold: 2,
            requiredAttesterKinds: ['independent_imagery', 'osm_provenance'],
            challengeWindowSeconds: 0
        });
        const oneSource = evaluateResolutionRecipe({
            recipe: declaration,
            evidence: [event('image', 'completed', imagery)],
            subjectMatches,
            now: '2026-09-21T12:10:00Z'
        });
        expect(oneSource.status).toBe('insufficient_evidence');

        const corroborated = evaluateResolutionRecipe({
            recipe: declaration,
            evidence: [event('image', 'completed', imagery), event('map', 'completed', crowd)],
            subjectMatches,
            now: '2026-09-21T12:10:00Z'
        });
        expect(corroborated).toMatchObject({ status: 'resolved', decision: 'YES' });
    });

    it('holds an otherwise valid decision through its challenge window', () => {
        const declaration = recipe({ threshold: 1, challengeWindowSeconds: 3600 });
        const pending = evaluateResolutionRecipe({
            recipe: declaration,
            evidence: [event('permit', 'completed', register)],
            subjectMatches,
            now: '2026-09-21T12:59:59Z'
        });
        expect(pending).toMatchObject({
            status: 'challenge_window', decision: null, proposedDecision: 'YES',
            readyAt: '2026-09-21T13:00:00.000Z'
        });
        const resolved = evaluateResolutionRecipe({
            recipe: declaration,
            evidence: [event('permit', 'completed', register)],
            subjectMatches,
            now: '2026-09-21T13:00:00Z'
        });
        expect(resolved.status).toBe('resolved');
    });

    it('fails closed when trusted sources support competing outcomes', () => {
        const result = evaluateResolutionRecipe({
            recipe: recipe(),
            evidence: [
                event('permit', 'completed', register),
                event('image', 'absent', imagery)
            ],
            subjectMatches,
            now: '2026-09-21T13:00:00Z'
        });
        expect(result).toMatchObject({ status: 'disputed', decision: null });
    });

    it('detects attester equivocation and never counts duplicate evidence twice', () => {
        const equivocation = evaluateResolutionRecipe({
            recipe: recipe(),
            evidence: [
                event('first', 'completed', register),
                event('second', 'absent', register)
            ],
            subjectMatches,
            now: '2026-09-21T13:00:00Z'
        });
        expect(equivocation).toMatchObject({ status: 'disputed', decision: null });
        expect(equivocation.rejectedEvidence).toContainEqual({ id: 'second', reason: 'attester_equivocation' });

        const duplicate = evaluateResolutionRecipe({
            recipe: recipe({ threshold: 2 }),
            evidence: [
                event('first', 'completed', register),
                event('retry', 'completed', register)
            ],
            subjectMatches,
            now: '2026-09-21T13:00:00Z'
        });
        expect(duplicate.status).toBe('insufficient_evidence');
        expect(duplicate.rejectedEvidence).toContainEqual({ id: 'retry', reason: 'duplicate_attester' });
    });

    it('rejects wrong subjects, untrusted attesters and adapter-invalid facts without counting them', () => {
        const wrongSubject = event('wrong-subject', 'completed', register);
        wrongSubject.subject.parcelUid = 'HR-other';
        const result = evaluateResolutionRecipe({
            recipe: recipe(),
            evidence: [
                wrongSubject,
                event('stranger', 'completed', { kind: 'public_register', address: 'unknown' }),
                event('bad-proof', 'completed', register)
            ],
            subjectMatches,
            verifyEvidence: candidate => candidate.id === 'bad-proof'
                ? { valid: false, reason: 'bad_source_hash' }
                : { valid: true },
            now: '2026-09-21T13:00:00Z'
        });
        expect(result.status).toBe('insufficient_evidence');
        expect(result.rejectedEvidence).toEqual([
            { id: 'wrong-subject', reason: 'subject_mismatch' },
            { id: 'stranger', reason: 'untrusted_attester' },
            { id: 'bad-proof', reason: 'bad_source_hash' }
        ]);
    });
});
