// Pure selection policy for a genuinely prospective court market. Chain adapters perform issuer,
// credential and schema verification before passing candidates here; this layer makes temporal and
// conflict handling deterministic and testable without RPC access.

function positiveTime(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireRecipe({ parcelUid, yesOperation, noOperation }) {
    if (!parcelUid || !yesOperation || !noOperation || yesOperation === noOperation) {
        throw new Error('parcel and two distinct operations are required');
    }
}

function matchesRecipe(fields = {}, { parcelUid, yesOperation, noOperation }) {
    return fields.parcelUid === parcelUid && [yesOperation, noOperation].includes(fields.operation);
}

/**
 * The candidates for one market out of a program-account listing. Decoding and issuer checks are
 * local, so only an attestation for this market's parcel and operations costs further RPC (its
 * first-seen time), and those lookups run one at a time: the listing holds every court attestation
 * under the schema, and verifying each in parallel was ~340 throttled calls every hour (2026-10-10).
 * A record that fails `decode` (not a court attestation, wrong issuer) is skipped; a `firstSeen`
 * failure is thrown, because silently dropping a candidate could hide a conflicting outcome.
 *
 * @param {{address:string, account:object}[]} accounts
 * @param {(account:object, address:string) => object} decode  verified evidence, or throws
 * @param {(address:string) => Promise<{signature:string, blockTime:number}>} firstSeen
 */
export async function collectProspectiveCandidates({
    accounts = [], decode, firstSeen, parcelUid, yesOperation, noOperation
} = {}) {
    requireRecipe({ parcelUid, yesOperation, noOperation });
    const candidates = [];
    for (const { address, account } of accounts) {
        let evidence;
        try {
            evidence = decode(account, address);
        } catch {
            continue;
        }
        if (!matchesRecipe(evidence?.fields, { parcelUid, yesOperation, noOperation })) continue;
        const first = await firstSeen(address);
        candidates.push({ address, evidence, firstSeenAt: first.blockTime, firstSeenSignature: first.signature });
    }
    return candidates;
}

export function selectProspectiveCourtEvidence({
    candidates = [], parcelUid, yesOperation, noOperation, closesAt
} = {}) {
    const close = positiveTime(closesAt);
    if (!close) throw new Error('closesAt must be positive Unix seconds');
    requireRecipe({ parcelUid, yesOperation, noOperation });

    const eligible = candidates.filter(candidate => {
        const fields = candidate?.evidence?.fields || {};
        return matchesRecipe(fields, { parcelUid, yesOperation, noOperation })
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
