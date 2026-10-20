const SHA256_RE = /^[0-9a-f]{64}$/;
const DIGITS_RE = /^[0-9]+$/;

export function planCommitmentError(row) {
    const slug = typeof row?.slug === 'string' && row.slug ? row.slug : '(unknown)';
    const invalid = () => Object.assign(
        new Error(`Plan "${slug}" has an invalid saved commitment; recreate it as a new plan revision.`),
        { code: 'plan-commitment-invalid', status: 422 },
    );

    const ids = row?.proposal_ids;
    if (!Array.isArray(ids) || ids.length === 0
        || !ids.every(id => typeof id === 'string' && DIGITS_RE.test(id))
        || new Set(ids).size !== ids.length) return invalid();

    const hashes = row?.member_hashes;
    if (hashes === null || typeof hashes !== 'object' || Array.isArray(hashes)
        || (Object.getPrototypeOf(hashes) !== Object.prototype && Object.getPrototypeOf(hashes) !== null)) return invalid();
    const keys = Object.keys(hashes);
    if (keys.length !== ids.length || !ids.every(id => Object.hasOwn(hashes, id)
        && typeof hashes[id] === 'string' && SHA256_RE.test(hashes[id]))) return invalid();
    if (typeof row?.plan_hash !== 'string' || !SHA256_RE.test(row.plan_hash)) return invalid();
    return null;
}

export function assertPlanCommitment(row) {
    const error = planCommitmentError(row);
    if (error) throw error;
    return row;
}
import { changedMembers, planHash } from './plan-hash.js';


// Minting must not turn an incomplete, missing or drifted member set into a new chain commitment.
export function assertPlanCurrent(row, members) {
    assertPlanCommitment(row);
    if (changedMembers(row.member_hashes, members).length) {
        throw Object.assign(new Error(`Plan "${row.slug}" has missing or changed members; publish forks and name a new plan revision.`),
            { code: 'plan-members-changed', status: 422 });
    }
    const byId = new Map(members.map(member => [String(member.id), member]));
    const expected = planHash(row.proposal_ids.map(id => ({ proposalId: byId.get(id).proposal_id, hash: row.member_hashes[id] })));
    if (expected !== row.plan_hash) {
        throw Object.assign(new Error(`Plan "${row.slug}" has an inconsistent saved commitment; recreate it as a new plan revision.`),
            { code: 'plan-commitment-invalid', status: 422 });
    }
    return row;
}
