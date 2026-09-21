// Pure selection policy for a genuinely prospective court market. Chain adapters perform issuer,
// credential and schema verification before passing candidates here; this layer makes temporal and
// conflict handling deterministic and testable without RPC access.

function positiveTime(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function selectProspectiveCourtEvidence({
    candidates = [], parcelUid, yesOperation, noOperation, closesAt
} = {}) {
    const close = positiveTime(closesAt);
    if (!close) throw new Error('closesAt must be positive Unix seconds');
    if (!parcelUid || !yesOperation || !noOperation || yesOperation === noOperation) {
        throw new Error('parcel and two distinct operations are required');
    }

    const eligible = candidates.filter(candidate => {
        const fields = candidate?.evidence?.fields || {};
        return fields.parcelUid === parcelUid
            && [yesOperation, noOperation].includes(fields.operation)
            && positiveTime(fields.sourceObservedAt) >= close
            && positiveTime(candidate.firstSeenAt) >= close;
    }).sort((left, right) => (
        left.evidence.fields.sourceObservedAt - right.evidence.fields.sourceObservedAt
        || left.firstSeenAt - right.firstSeenAt
        || String(left.address).localeCompare(String(right.address))
    ));

    if (!eligible.length) return { status: 'waiting', selected: null, eligible: [] };
    const operations = new Set(eligible.map(candidate => candidate.evidence.fields.operation));
    if (operations.size > 1) return { status: 'conflict', selected: null, eligible };
    return { status: 'ready', selected: eligible[0], eligible };
}
