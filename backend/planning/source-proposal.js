// Attach the same source-proposal contract used by the browser, without storing another copy.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { stableStringify } from '../plans/plan-hash.js';
const require = createRequire(import.meta.url);
const contract = require('../../frontend/js/planning/source-proposal.js');
export const sourceRevision = record => createHash('sha256').update(stableStringify(record)).digest('hex');
export function withSourceProposal(item) {
    const proposal = contract.fromRepresentation(item);
    return { ...item, proposalId: proposal?.proposalId || null, proposal };
}
