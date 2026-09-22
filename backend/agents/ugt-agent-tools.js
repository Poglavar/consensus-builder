// Shared action surface for external agents. MCP, deterministic runners and future controllers
// should delegate to these existing x402 and Solana adapters rather than inventing another agent
// execution path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { buyOracleFact, createOracleFactClient, fetchOracleFactChallenge } from './oracle-fact-client.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { createPaidClient, fetchChallenge, paymentIdForProposal, postAgentProposal } from './x402-client.js';
import {
    acceptProposal, cancelProposal, claimExternalMarket, claimProposalMarket, fulfillPledge,
    refundDonation, releaseDonations, resolveExternalMarket, resolveProposalMarket, revokePledge,
    voidPledge
} from './lifecycle-actions.js';

const DEFAULT_API_BASE = 'https://api.urbangametheory.xyz';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE = Object.freeze({ no: 0, yes: 1 });

function enabled(value) {
    return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function expandHome(filePath) {
    return filePath?.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function loadSecretKey(filePath) {
    if (!filePath) throw new Error('UGT_AGENT_KEYPAIR is required for paid or signed tools');
    const value = JSON.parse(fs.readFileSync(expandHome(filePath), 'utf8'));
    const secretKey = Uint8Array.from(value);
    if (secretKey.length !== 64) throw new Error(`UGT_AGENT_KEYPAIR must contain a 64-byte Solana keypair, got ${secretKey.length}`);
    return secretKey;
}

function cleanBase(value) {
    return String(value || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function withQuery(base, pathname, query = {}) {
    const url = new URL(pathname, `${cleanBase(base)}/`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
}

async function readJson(fetchImpl, url) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const text = await response.text();
    let body = text;
    if (text) {
        try { body = JSON.parse(text); } catch { /* retain proxy text */ }
    }
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    return body;
}

function positiveAmount(amountUsdc, maximum) {
    const atomic = usdcToAtomic(amountUsdc);
    if (atomic <= 0n) throw new Error('amountUsdc must be positive');
    const maximumAtomic = usdcToAtomic(maximum);
    if (atomic > maximumAtomic) throw new Error(`amountUsdc exceeds UGT_MCP_MAX_USDC_PER_ACTION (${maximum} USDC)`);
    return atomic;
}

function assertChallengeUnderCap(challenge, maximum, label) {
    const capAtomic = usdcToAtomic(maximum);
    const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
    if (!accepts.length) throw new Error(`${label} x402 challenge has no accepted payment`);
    for (const payment of accepts) {
        let amount;
        try { amount = BigInt(payment.amount); } catch { throw new Error(`${label} x402 challenge has an invalid amount`); }
        if (amount <= 0n) throw new Error(`${label} x402 challenge amount must be positive`);
        if (amount > capAtomic) {
            throw new Error(`${label} x402 price exceeds UGT_MCP_MAX_USDC_PER_ACTION (${maximum} USDC)`);
        }
    }
}

/**
 * Build the common tool implementation. The returned functions are deliberately transport-free:
 * the stdio MCP server is one caller, and tests or another controller can call the same surface.
 */
export function createUrbanGameTheoryTools({
    env = process.env,
    fetchImpl = globalThis.fetch,
    createConnection = (rpcUrl) => new Connection(rpcUrl, 'confirmed'),
    dependencies = {}
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    const apiBase = cleanBase(env.UGT_API_BASE || env.AGENT_API_BASE);
    const rpcUrl = env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
    const live = enabled(env.UGT_MCP_LIVE);
    const maxUsdcPerAction = String(env.UGT_MCP_MAX_USDC_PER_ACTION || '0.25');
    const impl = {
        createPaidClient,
        fetchChallenge,
        postAgentProposal,
        createOracleFactClient,
        buyOracleFact,
        fetchOracleFactChallenge,
        ensurePledgeBookAndSet,
        ensureDonationEscrowAndDonate,
        ensureMarketAndStake,
        acceptProposal,
        cancelProposal,
        refundDonation,
        revokePledge,
        voidPledge,
        releaseDonations,
        fulfillPledge,
        resolveProposalMarket,
        claimProposalMarket,
        resolveExternalMarket,
        claimExternalMarket,
        sendAndConfirmPolling,
        ...dependencies
    };
    let signing = null;

    function requireLive(confirm) {
        if (!live) throw new Error('live actions are disabled; set UGT_MCP_LIVE=1 to enable devnet writes');
        if (confirm !== true) throw new Error('confirm must be true for a paid or signed devnet action');
    }

    function signer() {
        if (!signing) {
            const secretKey = loadSecretKey(env.UGT_AGENT_KEYPAIR);
            signing = {
                secretKey,
                keypair: Keypair.fromSecretKey(secretKey),
                connection: createConnection(rpcUrl)
            };
        }
        return signing;
    }

    return {
        config: {
            apiBase,
            rpcUrl,
            cluster: 'solana-devnet',
            liveActionsEnabled: live,
            keypairConfigured: Boolean(env.UGT_AGENT_KEYPAIR),
            maxUsdcPerAction,
            usdcMint: USDC_DEVNET
        },

        capabilities: () => readJson(fetchImpl, `${apiBase}/docs/agents.json`),

        listProposals: ({ city = 'zagreb', lifecycle = 'Active', limit = 20, author } = {}) => readJson(
            fetchImpl,
            withQuery(apiBase, '/proposals/summary', { city, lifecycle, limit, author })
        ),

        getActivity: ({ limit = 100, actor, source, action } = {}) => readJson(
            fetchImpl,
            withQuery(apiBase, '/agent/activity', { limit, actor, source, action })
        ),

        getSupport: ({ proposalAccount } = {}) => readJson(
            fetchImpl,
            `${apiBase}/agent/pledges/${encodeURIComponent(proposalAccount)}`
        ),

        getOracleEvents: ({ proposalAccount, limit = 20 } = {}) => readJson(
            fetchImpl,
            withQuery(apiBase, '/oracle/events', { subject: proposalAccount, limit })
        ),

        inspectVerifiedFact: ({ proposalAccount, marketAccount } = {}) => impl.fetchOracleFactChallenge({
            baseUrl: apiBase, proposalAccount, marketAccount, fetchImpl
        }),

        async buyVerifiedFact({ proposalAccount, marketAccount, confirm } = {}) {
            requireLive(confirm);
            const challenge = await impl.fetchOracleFactChallenge({
                baseUrl: apiBase, proposalAccount, marketAccount, fetchImpl
            });
            assertChallengeUnderCap(challenge, maxUsdcPerAction, 'verified fact');
            const { secretKey } = signer();
            const { payerAddress, paidFetch } = await impl.createOracleFactClient({ secretKey, rpcUrl, fetchImpl });
            const result = await impl.buyOracleFact({ baseUrl: apiBase, proposalAccount, marketAccount, paidFetch });
            return { payerAddress, ...result };
        },

        async submitProposal({ proposal, confirm } = {}) {
            requireLive(confirm);
            if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('proposal must be an object');
            if (!Array.isArray(proposal.cadastreParcelIds) || !proposal.cadastreParcelIds.length) {
                throw new Error('proposal.cadastreParcelIds must contain at least one parcel id');
            }
            const proposalId = String(proposal.proposalId || '').trim();
            if (!proposalId) throw new Error('proposal.proposalId is required for idempotent x402 payment');
            const challenge = await impl.fetchChallenge({ baseUrl: apiBase, body: proposal, fetchImpl });
            assertChallengeUnderCap(challenge, maxUsdcPerAction, 'proposal');
            const { secretKey } = signer();
            const { payerAddress, paidFetch } = await impl.createPaidClient({
                secretKey, paymentId: paymentIdForProposal(proposalId), rpcUrl, fetchImpl
            });
            const result = await impl.postAgentProposal({ baseUrl: apiBase, paidFetch, body: proposal });
            return { payerAddress, ...result };
        },

        async pledge({ proposalAccount, amountUsdc, confirm } = {}) {
            requireLive(confirm);
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            return impl.ensurePledgeBookAndSet({
                connection, pledgerKeypair: keypair, proposalPda: proposalAccount, amountAtomic,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async donate({ proposalAccount, amountUsdc, operationId, confirm } = {}) {
            requireLive(confirm);
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            return impl.ensureDonationEscrowAndDonate({
                connection, donorKeypair: keypair, proposalPda: proposalAccount, amountAtomic,
                operationId, sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async forecast({ proposalAccount, side, amountUsdc, confirm } = {}) {
            requireLive(confirm);
            const normalizedSide = String(side || '').toLowerCase();
            if (!(normalizedSide in SIDE)) throw new Error('side must be yes or no');
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            return impl.ensureMarketAndStake({
                connection, ownerKeypair: keypair, proposalPda: proposalAccount,
                stakeMint: USDC_DEVNET, side: SIDE[normalizedSide], amountAtomic,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async cancel({ proposalAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.cancelProposal({
                connection, ownerKeypair: keypair, proposalAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async accept({ proposalAccount, parcelId, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.acceptProposal({
                connection, accepterKeypair: keypair, proposalAccount, parcelId,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async refundDonation({ proposalAccount, operationId, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.refundDonation({
                connection, donorKeypair: keypair, proposalAccount, operationId,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async voidPledge({ proposalAccount, pledger, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.voidPledge({
                connection, feePayerKeypair: keypair, proposalAccount, pledger,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async revokePledge({ proposalAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.revokePledge({
                connection, pledgerKeypair: keypair, proposalAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async releaseDonations({ proposalAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.releaseDonations({
                connection, releaserKeypair: keypair, proposalAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async fulfillPledge({ proposalAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.fulfillPledge({
                connection, pledgerKeypair: keypair, proposalAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async resolve({ proposalAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.resolveProposalMarket({
                connection, resolverKeypair: keypair, proposalAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async claim({ proposalAccount, side, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.claimProposalMarket({
                connection, claimerKeypair: keypair, proposalAccount, side,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async resolveExternal({ recipeHash, attestation, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.resolveExternalMarket({
                connection, resolverKeypair: keypair, recipeHash, attestation,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async claimExternal({ recipeHash, side, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.claimExternalMarket({
                connection, claimerKeypair: keypair, recipeHash, side,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        }
    };
}
