// Canonical chain locations of the configured proposal deployments (normalizeChainRef), as the agents'
// publication mirror names a minted proposal (agents/chain-publication.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';

const ADDRESS_FILE = fileURLToPath(new URL('../../frontend/contracts/addresses.json', import.meta.url));
const ADDRESSES = JSON.parse(readFileSync(ADDRESS_FILE, 'utf8'));
const SOLANA_PROGRAMS = Object.freeze({ devnet: PROPOSAL_PROGRAM_ID });
const MAX_UINT256 = (1n << 256n) - 1n;

// Contract and program identities come from this module's deployment allowlists; request data can
// select only one of those known deployments.

export function chainProofError(message, { code } = {}) {
    const error = new Error(message);
    error.status = 422;
    error.code = code || 'chain-proof-invalid';
    return error;
}

function normalizeEvmChainId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'bigint' && value > 0n) return value.toString();
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
        try { return BigInt(trimmed).toString(); } catch { return null; }
    }
    return /^\d+$/.test(trimmed) ? String(BigInt(trimmed)) : null;
}

export function normalizeChainRef(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
        throw chainProofError('A chain location is required.');
    }
    const type = String(ref.chainType || '').trim().toLowerCase();
    const rawChainId = ref.chainId == null ? '' : String(ref.chainId).trim();
    const contract = typeof ref.contract === 'string' ? ref.contract.trim() : '';
    const rawToken = ref.tokenId == null ? '' : String(ref.tokenId).trim();
    if (type === 'canton') {
        throw chainProofError('Canton proposal contracts are party-scoped and cannot be publicly mirrored without visibility authorization.', { code: 'chain-mirror-private' });
    }
    if (!['evm', 'solana'].includes(type) || !rawChainId || !contract || !rawToken) {
        throw chainProofError('Chain location must include a supported chainType, chainId, contract, and tokenId.');
    }
    if (type === 'evm') {
        const chainId = normalizeEvmChainId(rawChainId);
        if (!chainId || !ADDRESSES[chainId]?.ProposalNFT) throw chainProofError('Unsupported EVM proposal deployment.');
        if (!/^0x[0-9a-f]{40}$/i.test(contract) || contract.toLowerCase() !== ADDRESSES[chainId].ProposalNFT.toLowerCase()) {
            throw chainProofError('Proposal contract does not match the configured deployment.');
        }
        if (!/^\d{1,78}$/.test(rawToken)) throw chainProofError('EVM proposal tokenId must be an unsigned decimal integer.');
        const tokenId = BigInt(rawToken);
        if (tokenId > MAX_UINT256) throw chainProofError('EVM proposal tokenId exceeds uint256.');
        return { chainType: 'evm', chainId, contract: ADDRESSES[chainId].ProposalNFT, tokenId: tokenId.toString() };
    }
    const cluster = rawChainId.replace(/^solana-/, '').toLowerCase();
    if (!SOLANA_PROGRAMS[cluster]) throw chainProofError('Unsupported Solana proposal deployment.');
    let tokenId;
    try { tokenId = new PublicKey(rawToken).toBase58(); } catch { throw chainProofError('Solana tokenId must be a valid account address.'); }
    if (contract !== SOLANA_PROGRAMS[cluster]) throw chainProofError('Proposal program does not match the configured deployment.');
    return { chainType: 'solana', chainId: `solana-${cluster}`, contract: SOLANA_PROGRAMS[cluster], tokenId };
}
