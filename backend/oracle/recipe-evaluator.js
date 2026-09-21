// Deterministic Lens/recipe evaluator. Source adapters remain responsible for source-specific
// validation; this module decides whether independently verified evidence satisfies the recipe's
// trusted-attester, agreement and challenge-window policy.

function positiveInteger(value, label, fallback) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
    return value;
}

function timestamp(value, label) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    const parsed = Date.parse(String(value || ''));
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO date`);
    return parsed;
}

function identity(attester = {}) {
    return [attester.kind, attester.address, attester.credential || ''].join(':');
}

function trustedAttester(eventAttester, trustedAttesters) {
    return trustedAttesters.find(trusted => trusted.kind === eventAttester?.kind
        && trusted.address === eventAttester?.address
        && (!trusted.credential || trusted.credential === eventAttester?.credential)) || null;
}

function evidenceId(event, index) {
    return event.id || event.source?.hash || `evidence-${index + 1}`;
}

function policyFor(recipe) {
    const policy = recipe.verification?.evidencePolicy || {};
    const threshold = positiveInteger(policy.threshold, 'evidencePolicy.threshold', 1);
    if (threshold < 1) throw new Error('evidencePolicy.threshold must be at least 1');
    const challengeWindowSeconds = positiveInteger(
        policy.challengeWindowSeconds,
        'evidencePolicy.challengeWindowSeconds',
        0
    );
    const requiredAttesterKinds = policy.requiredAttesterKinds || [];
    if (!Array.isArray(requiredAttesterKinds)
        || requiredAttesterKinds.some(kind => typeof kind !== 'string' || !kind.trim())) {
        throw new Error('evidencePolicy.requiredAttesterKinds must contain non-empty strings');
    }
    return { threshold, challengeWindowSeconds, requiredAttesterKinds: [...new Set(requiredAttesterKinds)] };
}

function thresholdReachedAt(rows, threshold, requiredKinds) {
    const times = rows.map(row => row.acceptedAt).sort((a, b) => a - b);
    if (times.length < threshold) return null;
    const requiredTimes = requiredKinds.map(kind => {
        const matching = rows.filter(row => row.attester.kind === kind).map(row => row.acceptedAt);
        return matching.length ? Math.min(...matching) : null;
    });
    if (requiredTimes.some(value => value === null)) return null;
    return Math.max(times[threshold - 1], ...requiredTimes);
}

export function evaluateResolutionRecipe({
    recipe,
    evidence = [],
    now = new Date(),
    subjectMatches = () => true,
    verifyEvidence = () => ({ valid: true, reason: null })
} = {}) {
    if (!recipe?.eventType || !recipe?.outcomes || !Array.isArray(recipe.trustedAttesters)) {
        throw new Error('recipe is missing eventType, outcomes or trustedAttesters');
    }
    if (!Array.isArray(evidence)) throw new Error('evidence must be an array');
    const policy = policyFor(recipe);
    const nowMs = timestamp(now, 'now');
    const accepted = [];
    const rejected = [];
    const seenAttesters = new Map();

    evidence.forEach((event, index) => {
        const id = evidenceId(event, index);
        let reason = null;
        const trusted = trustedAttester(event?.attester, recipe.trustedAttesters);
        if (event?.eventType !== recipe.eventType) reason = 'event_type_mismatch';
        else if (!subjectMatches(event, recipe)) reason = 'subject_mismatch';
        else if (!Object.hasOwn(recipe.outcomes, event.outcome)) reason = 'unsupported_outcome';
        else if (!trusted) reason = 'untrusted_attester';
        else {
            const adapter = verifyEvidence(event, recipe) || {};
            if (adapter.valid !== true) reason = adapter.reason || 'adapter_rejected';
        }
        if (reason) {
            rejected.push({ id, reason });
            return;
        }

        let acceptedAt;
        try {
            acceptedAt = timestamp(event.recordedAt || event.observedAt, `${id}.recordedAt`);
        } catch {
            rejected.push({ id, reason: 'invalid_timestamp' });
            return;
        }
        const attesterId = identity(event.attester);
        const previousOutcome = seenAttesters.get(attesterId);
        if (previousOutcome && previousOutcome !== event.outcome) {
            rejected.push({ id, reason: 'attester_equivocation' });
            accepted.forEach(row => {
                if (row.attesterId === attesterId) row.equivocated = true;
            });
            return;
        }
        if (previousOutcome) {
            rejected.push({ id, reason: 'duplicate_attester' });
            return;
        }
        seenAttesters.set(attesterId, event.outcome);
        accepted.push({
            id,
            outcome: event.outcome,
            mappedOutcome: recipe.outcomes[event.outcome],
            attester: trusted,
            attesterId,
            acceptedAt,
            equivocated: false
        });
    });

    const usable = accepted.filter(row => !row.equivocated);
    const equivocation = accepted.some(row => row.equivocated);
    const byOutcome = Object.keys(recipe.outcomes).map(outcome => {
        const rows = usable.filter(row => row.outcome === outcome);
        return {
            outcome,
            mappedOutcome: recipe.outcomes[outcome],
            count: rows.length,
            evidenceIds: rows.map(row => row.id),
            thresholdReachedAt: thresholdReachedAt(rows, policy.threshold, policy.requiredAttesterKinds)
        };
    });
    const qualified = byOutcome.filter(group => group.thresholdReachedAt !== null);
    const competingOutcomes = byOutcome.filter(group => group.count > 0).length;

    if (equivocation || qualified.length > 1 || competingOutcomes > 1) {
        return {
            status: 'disputed',
            decision: null,
            policy,
            outcomes: byOutcome,
            acceptedEvidence: usable.map(row => row.id),
            rejectedEvidence: rejected,
            reason: equivocation
                ? 'A trusted attester issued conflicting outcomes.'
                : 'Trusted evidence supports competing outcomes.'
        };
    }
    if (!qualified.length) {
        return {
            status: 'insufficient_evidence',
            decision: null,
            policy,
            outcomes: byOutcome,
            acceptedEvidence: usable.map(row => row.id),
            rejectedEvidence: rejected,
            reason: 'No outcome satisfies the declared evidence policy.'
        };
    }

    const winner = qualified[0];
    const readyAtMs = winner.thresholdReachedAt + policy.challengeWindowSeconds * 1000;
    const readyAt = new Date(readyAtMs).toISOString();
    if (nowMs < readyAtMs) {
        return {
            status: 'challenge_window',
            decision: null,
            proposedDecision: winner.mappedOutcome,
            proposedOutcome: winner.outcome,
            readyAt,
            policy,
            outcomes: byOutcome,
            acceptedEvidence: winner.evidenceIds,
            rejectedEvidence: rejected,
            reason: 'The evidence threshold is met, but its challenge window is still open.'
        };
    }
    return {
        status: 'resolved',
        decision: winner.mappedOutcome,
        outcome: winner.outcome,
        readyAt,
        policy,
        outcomes: byOutcome,
        acceptedEvidence: winner.evidenceIds,
        rejectedEvidence: rejected,
        reason: 'The declared Lens, evidence threshold and challenge window are satisfied.'
    };
}
