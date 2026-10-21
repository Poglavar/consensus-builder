// The server index mirror of an agent mint: POST /proposals/mirror with the mint's canonical chain
// reference; the server re-reads the chain and IPFS, never this runner's record. The agents' design
// mint (the prepared record, its binding and its pinned metadata) went with the design mint path
// (plan-design-agreement.md, M2): agents mint agreements in M3, and run.mjs refuses new mints until then.
import { createHash } from 'node:crypto';
import { createRetryingFetch } from '../utils/retrying-fetch.js';
import { normalizeChainRef } from '../proposals/chain-reader.js';

export async function mirrorAgentPublication({ apiBase, mint, fetchImpl = fetch, retryOptions = {} }) {
    if (!/^ipfs:\/\//.test(mint.metadataUri || '')) {
        throw new Error('This earlier mint has no portable immutable metadata; it cannot be mirrored.');
    }
    const chainRef = normalizeChainRef({ chainType: 'solana', chainId: mint.chainId || 'solana-devnet',
        contract: mint.contractAddress, tokenId: mint.proposalPda });
    const expectedId = `chain_${createHash('sha256').update(JSON.stringify(chainRef)).digest('hex')}`;
    // This POST is safe to replay: its body is a canonical chain reference and the server
    // verifies an existing row before returning the same mirror on a duplicate request.
    const retryFetch = createRetryingFetch({ timeoutMs: 60_000, ...retryOptions, fetchImpl,
        retryMethods: new Set(['POST']), requestLabel: () => 'proposal-mirror' });
    const response = await retryFetch(`${apiBase.replace(/\/$/, '')}/proposals/mirror`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://urbangametheory.xyz' },
        body: JSON.stringify({ chainRef }), signal: AbortSignal.timeout(60_000)
    });
    const body = await response.json();
    if (![201, 409].includes(response.status) || !Number.isInteger(body.id) || body.id < 1
        || body.proposalId !== expectedId || body.code === 'chain-mirror-conflict') {
        throw new Error(`Chain mirror HTTP ${response.status}: ${body.code || body.error || 'unavailable'}`);
    }
    return { id: body.id, proposalId: body.proposalId, status: response.status, method: 'chain-mirror' };
}
