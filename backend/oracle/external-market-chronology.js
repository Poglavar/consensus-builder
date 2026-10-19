// Pure chronology checks for judge-facing market proofs. Transaction ordering proves whether a
// market was genuinely open before its evidence existed; economic settlement alone does not.

function unixSeconds(value, label, { optional = false } = {}) {
    if ((value === undefined || value === null || value === '') && optional) return null;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    const milliseconds = Date.parse(String(value || ''));
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.floor(milliseconds / 1000);
    throw new Error(`${label} must be a positive Unix timestamp or ISO date`);
}

function iso(value) {
    return new Date(value * 1000).toISOString();
}

export function classifyExternalMarketChronology(input = {}) {
    const created = unixSeconds(input.marketCreatedAt, 'marketCreatedAt');
    const yesStake = unixSeconds(input.yesStakeAt, 'yesStakeAt');
    const noStake = unixSeconds(input.noStakeAt, 'noStakeAt');
    const closes = unixSeconds(input.marketClosesAt, 'marketClosesAt');
    const evidence = unixSeconds(input.evidenceCreatedAt, 'evidenceCreatedAt');
    const resolved = unixSeconds(input.resolvedAt, 'resolvedAt');
    const claimed = unixSeconds(input.claimedAt, 'claimedAt', { optional: true });
    const sourceObserved = unixSeconds(input.sourceObservedAt, 'sourceObservedAt', { optional: true });
    const lastStake = Math.max(yesStake, noStake);

    const marketOrderValid = created <= Math.min(yesStake, noStake)
        && lastStake < closes
        && closes <= resolved
        && evidence <= resolved
        && (claimed === null || resolved <= claimed);
    if (!marketOrderValid) {
        return {
            classification: 'invalid',
            prospective: false,
            marketOrderValid: false,
            reason: 'Market creation, stakes, close, evidence, resolution and claim are not in a valid order.'
        };
    }

    const attestationAfterClose = evidence >= closes;
    const sourceTimeVerified = sourceObserved !== null && input.sourceTimeCommitted === true;
    const sourceAfterClose = sourceTimeVerified && sourceObserved >= closes;
    const classification = sourceAfterClose && attestationAfterClose
        ? 'prospective'
        : attestationAfterClose
            ? 'onchain_prospective_source_time_unverified'
            : 'retrospective_integration';

    return {
        classification,
        prospective: classification === 'prospective',
        marketOrderValid: true,
        attestationAfterClose,
        sourceTimeVerified,
        sourceAfterClose,
        timestamps: {
            marketCreatedAt: iso(created),
            yesStakeAt: iso(yesStake),
            noStakeAt: iso(noStake),
            lastStakeAt: iso(lastStake),
            marketClosesAt: iso(closes),
            evidenceCreatedAt: iso(evidence),
            sourceObservedAt: sourceObserved === null ? null : iso(sourceObserved),
            sourceTimeCommitted: sourceTimeVerified,
            resolvedAt: iso(resolved),
            claimedAt: claimed === null ? null : iso(claimed)
        },
        reason: classification === 'prospective'
            ? 'The source event and its on-chain attestation appeared only after trading closed.'
            : classification === 'onchain_prospective_source_time_unverified'
                ? 'The attestation appeared after close, but the source publication time is not committed by this schema.'
                : 'The attestation existed before this market opened; this proves integration and payout, not prediction.'
    };
}

export function assertProspectiveChronology(input) {
    const result = classifyExternalMarketChronology(input);
    if (result.classification !== 'prospective') throw new Error(result.reason);
    return result;
}
