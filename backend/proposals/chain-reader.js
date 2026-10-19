// Read proposal commitments and observed lifecycle from configured deployments for verified mirrors.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, JsonRpcProvider } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID, readProposalLens, readProposalSite } from '../oracle/proposal-lifecycle.js';

const require = createRequire(import.meta.url);
const { decodeProposalStatus } = require('../../frontend/js/proposals/chain-status.js');
const ADDRESS_FILE = fileURLToPath(new URL('../../frontend/contracts/addresses.json', import.meta.url));
const ADDRESSES = JSON.parse(readFileSync(ADDRESS_FILE, 'utf8'));
const EVM_RPCS = Object.freeze({
    '31337': 'http://localhost:8545',
    '84532': 'https://sepolia.base.org',
    '11155111': 'https://ethereum-sepolia-rpc.publicnode.com'
});
const PROPOSAL_ABI = Object.freeze([
    'function getProposal(uint256 proposalId) view returns (string[] parcelIds, bool isConditional, string imageURI, bool acceptancePossible, uint8 status, uint256 ethBalance, uint256 tokenBalance, uint256 acceptanceCount, uint256 expiryTimestamp, uint256 expiringPercentage)',
    'function getLens(uint256 proposalId) view returns (address[])',
    'function ownerOf(uint256 tokenId) view returns (address)'
]);
const SOLANA_PROGRAMS = Object.freeze({ devnet: PROPOSAL_PROGRAM_ID });
const MAX_PARCELS = 10_000;
const MAX_STRING_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_UINT256 = (1n << 256n) - 1n;

// Read the fields a server mirror needs directly from the minting chain. RPC endpoints
// and contract/program identities come from this module's deployment allowlists or server config;
// request data can select only one of those known deployments.

export function chainProofError(message, { unavailable = false, code } = {}) {
    const error = new Error(message);
    error.status = unavailable ? 503 : 422;
    error.code = code || (unavailable ? 'chain-proof-unavailable' : 'chain-proof-invalid');
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

function normalizeStringList(values, field) {
    if (!Array.isArray(values) || values.length > MAX_PARCELS) throw chainProofError(`On-chain ${field} is invalid.`);
    const result = values.map(value => {
        if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
            throw chainProofError(`On-chain ${field} contains an invalid value.`);
        }
        return value;
    });
    if (new Set(result).size !== result.length) throw chainProofError(`On-chain ${field} contains duplicates.`);
    return result;
}

function readLifecycleStatus(code) {
    const status = decodeProposalStatus(code);
    if (status === 'Unknown') throw chainProofError('On-chain proposal lifecycle is missing or unknown.');
    return status;
}

function decodeSolanaProposalPrefix(input) {
    const data = Buffer.from(input || []);
    const discriminator = createHash('sha256').update('account:Proposal').digest().subarray(0, 8);
    if (data.length < 8 || !data.subarray(0, 8).equals(discriminator)) throw chainProofError('Solana account is not a Proposal account.');
    let offset = 8;
    const need = n => { if (!Number.isSafeInteger(n) || n < 0 || offset + n > data.length) throw chainProofError('Solana Proposal account is truncated.'); };
    const u32 = () => { need(4); const n = data.readUInt32LE(offset); offset += 4; return n; };
    const string = () => {
        const length = u32();
        if (length > MAX_STRING_BYTES) throw chainProofError('Solana Proposal string exceeds the size limit.');
        need(length);
        const bytes = data.subarray(offset, offset + length); offset += length;
        const value = bytes.toString('utf8');
        if (!Buffer.from(value, 'utf8').equals(bytes)) throw chainProofError('Solana Proposal contains invalid UTF-8.');
        return value;
    };
    need(8 + 32); offset += 8 + 32; // proposal sequence number, then owner
    const parcelsCount = u32();
    if (parcelsCount > MAX_PARCELS) throw chainProofError('Solana Proposal parcel list exceeds the size limit.');
    const cadastreParcelIds = [];
    for (let i = 0; i < parcelsCount; i++) cadastreParcelIds.push(string());
    need(1);
    const conditionalByte = data[offset++];
    if (conditionalByte > 1) throw chainProofError('Solana Proposal conditional flag is invalid.');
    const metadataUri = string();
    if (!metadataUri) throw chainProofError('Solana Proposal metadata URI is missing.');
    need(2); // acceptance_possible, then ProposalStatus
    const lifecycleStatus = readLifecycleStatus(data[offset + 1]);
    return { cadastreParcelIds: normalizeStringList(cadastreParcelIds, 'parcel list'), isConditional: conditionalByte === 1,
        metadataUri, metadataEndOffset: offset, lifecycleStatus };
}

function validateSolanaSiteTail(input, metadataEndOffset) {
    const data = Buffer.from(input || []);
    let offset = metadataEndOffset;
    const need = n => { if (offset + n > data.length) throw new Error('Solana Proposal account ended early'); };
    const u32 = () => { need(4); const n = data.readUInt32LE(offset); offset += 4; return n; };
    const skipStrings = count => {
        if (count > MAX_PARCELS) throw new Error('Solana Proposal vector exceeds the size limit');
        for (let i = 0; i < count; i++) {
            const length = u32();
            if (length > MAX_STRING_BYTES) throw new Error('Solana Proposal string exceeds the size limit');
            need(length); offset += length;
        }
    };
    need(1 + 1 + 24); // acceptance_possible, status, and three u64 values
    offset += 1 + 1 + 24;
    skipStrings(u32()); // accepted_parcels
    const lensCount = u32();
    if (lensCount > MAX_PARCELS) throw new Error('Solana Proposal lens exceeds the size limit');
    need(lensCount * 32 + 2 + 32 + 3); // lens, bump/verdict, hash, and v3 flags/version
    offset += lensCount * 32 + 2;
    const openGroundByte = data[offset + 32];
    const openGroundClearedByte = data[offset + 33];
    const layoutVersion = data[offset + 34];
    if (openGroundByte > 1 || openGroundClearedByte > 1) throw new Error('Solana Proposal site flags are malformed');
    return layoutVersion;
}

function boundedFetch(timeoutMs) {
    return (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function rpcUnavailable() {
    return chainProofError('The configured chain reader is temporarily unavailable.', { unavailable: true });
}

async function readEvmProposal(ref, options) {
    const env = options.env || process.env;
    const rpcUrl = env[`EVM_RPC_URL_${ref.chainId}`] || EVM_RPCS[ref.chainId];
    if (!rpcUrl) throw chainProofError('No RPC reader is configured for this EVM deployment.', { unavailable: true });
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    let provider;
    try {
        if (options.evmProviderFactory) provider = await options.evmProviderFactory(rpcUrl, ref.chainId);
        else {
            const request = new FetchRequest(rpcUrl);
            request.timeout = timeoutMs;
            provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
        }
        const network = await provider.getNetwork();
        if (normalizeEvmChainId(network.chainId) !== ref.chainId) throw chainProofError('RPC network does not match the requested EVM deployment.');
        let contract;
        if (options.evmContractFactory) contract = await options.evmContractFactory(ref.contract, provider, PROPOSAL_ABI);
        else contract = new Contract(ref.contract, PROPOSAL_ABI, provider);
        const [proposal, lens, owner] = await Promise.all([
            contract.getProposal(BigInt(ref.tokenId)),
            contract.getLens(BigInt(ref.tokenId)),
            contract.ownerOf(BigInt(ref.tokenId))
        ]);
        const cadastreParcelIds = normalizeStringList(Array.from(proposal.parcelIds || proposal[0] || []), 'parcel list');
        const metadataUri = String(proposal.imageURI ?? proposal[2] ?? '');
        if (!metadataUri) throw chainProofError('EVM Proposal metadata URI is missing.');
        if (typeof (proposal.isConditional ?? proposal[1]) !== 'boolean') throw chainProofError('EVM Proposal conditional flag is invalid.');
        if (!Array.isArray(lens)) throw chainProofError('EVM Proposal lens is invalid.');
        return { ref, cadastreParcelIds, metadataUri, lens: lens.map(String), isConditional: proposal.isConditional ?? proposal[1],
            owner: String(owner), lifecycleStatus: readLifecycleStatus(proposal.status ?? proposal[4]) };
    } catch (error) {
        if (error?.status) throw error;
        throw rpcUnavailable();
    } finally {
        try { provider?.destroy?.(); } catch { /* best-effort close of the default RPC provider */ }
    }
}

async function readSolanaProposal(ref, options) {
    const env = options.env || process.env;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const endpoint = env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    try {
        let connection;
        if (options.solanaConnectionFactory) connection = await options.solanaConnectionFactory(endpoint, ref.chainId);
        else connection = new Connection(endpoint, { commitment: 'confirmed', fetch: boundedFetch(timeoutMs) });
        const genesisHash = await connection.getGenesisHash();
        // getGenesisHash returns the full base58 hash, not the shortened CAIP-2 chain reference.
        if (genesisHash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw chainProofError('RPC network does not match Solana devnet.');
        const info = await connection.getAccountInfo(new PublicKey(ref.tokenId), 'confirmed');
        if (!info?.data) throw chainProofError('Solana Proposal account was not found.');
        const owner = info.owner?.toBase58 ? info.owner.toBase58() : String(info.owner || '');
        if (owner !== ref.contract) throw chainProofError('Solana account is not owned by the configured ProposalNFT program.');
        const prefix = decodeSolanaProposalPrefix(info.data);
        let lens;
        let site;
        let layoutVersion;
        try {
            lens = readProposalLens(info.data);
            site = readProposalSite(info.data);
            layoutVersion = validateSolanaSiteTail(info.data, prefix.metadataEndOffset);
        } catch {
            throw chainProofError('Solana Proposal account has a malformed or truncated consent/site record.');
        }
        return {
            ref,
            ...prefix,
            lens: normalizeStringList(lens, 'lens'),
            owner: new PublicKey(Buffer.from(info.data).subarray(16, 48)).toBase58(),
            siteHash: site.siteHash,
            openGround: site.openGround,
            layoutVersion
        };
    } catch (error) {
        if (error?.status) throw error;
        throw rpcUnavailable();
    }
}

export async function readChainProposal(input, options = {}) {
    const ref = normalizeChainRef(input);
    return ref.chainType === 'evm' ? readEvmProposal(ref, options) : readSolanaProposal(ref, options);
}

export const CHAIN_READER_CONFIG = Object.freeze({ evmRpcs: EVM_RPCS, solanaPrograms: SOLANA_PROGRAMS });
