// Attach the same source-proposal contract used by the browser, without storing another copy.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const contract = require('../../frontend/js/planning/source-proposal.js');
// JSON with object keys sorted at every depth, so equal content always hashes equal.
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
export const sourceRevision = record => createHash('sha256').update(stableStringify(record)).digest('hex');
export function withSourceProposal(item) {
    const proposal = contract.fromRepresentation(item);
    return { ...item, proposalId: proposal?.proposalId || null, proposal };
}
