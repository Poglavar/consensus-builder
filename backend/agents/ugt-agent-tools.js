// Shared action surface for external agents (plan-design-agreement.md, M3). The stdio MCP server
// (mcp-server.mjs) is one caller; tests or another controller can call the same functions. Designs and
// agreements are pinned and indexed through publication-client.js, agreements minted and funded through
// agreement-minter.js, and markets, pledges and donations take the agreement's chain account as their
// subject (bettor.js, pledger.js, donor.js, lifecycle-actions.js): the adapters the deterministic
// runners use, never a second execution path.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MCP_LOCAL_TOOLS, MCP_HOSTED_TOOLS } from './mcp-catalog.js';
import { createMcpAgreementTools } from './mcp-ground.js';
import { createMcpDraftTools } from './mcp-drafts.js';
import { createMcpReadTools } from './mcp-read-tools.js';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { buyOracleFact, createOracleFactClient, fetchOracleFactChallenge } from './oracle-fact-client.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { createRpcConnection } from '../solana/rpc.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { createPaidClient } from './x402-client.js';
import { fetchLensMembers, parseLensList } from './lens-directory-client.js';
import { requestOwnershipAttestation } from './lens-ownership-client.js';
import { createIndexClient } from './publication-client.js';
import { AGREEMENT_SCHEMA, DESIGN_SCHEMA, agreementObject, cidOfObject, designObject, isParcelLayout } from './agreement-objects.js';
import {
    AGREEMENT_PROGRAM_ID, AGREEMENT_STATUS, agreementAccountOf, fundAgreement, mintAgreement, readAgreementAccount
} from './agreement-minter.js';
import {
    claimAgreementMarket, claimExternalMarket, fulfillPledge, refundDonation, releaseDonations, resolveAgreementMarket,
    resolveExternalMarket, revokePledge, voidPledge
} from './lifecycle-actions.js';

const require = createRequire(import.meta.url);
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
agreementClient.configure({ web3: require('@solana/web3.js') });

const DEFAULT_API_BASE = 'https://api.urbangametheory.xyz';
// The API's write guard admits only the app's origins; index writes are sent as the app's.
const DEFAULT_APP_ORIGIN = 'https://urbangametheory.xyz';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
// The cluster the index records a mint on (routes/agreements.js POST /agreements/:cid/onchain).
const AGREEMENT_CLUSTER = 'devnet';
const SIDE = Object.freeze({ no: 0, yes: 1 });
// How many places a refused object lists where it differs from its published form.
const MAX_DIFFERENCES = 5;

// stdout carries the MCP transport, so everything this surface logs goes to stderr.
const log = message => console.error(`[${new Date().toISOString()}] [ugt-tools] ${message}`);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

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

function cleanBase(value, fallback = DEFAULT_API_BASE) {
    return String(value || fallback).replace(/\/+$/, '');
}

function withQuery(base, pathname, query = {}) {
    const url = new URL(pathname, `${cleanBase(base)}/`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
}

async function readJson(fetchImpl, url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
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

// A whole number of lamports as a decimal string (agreement-minter.js reads it as u64).
function wholeLamports(value, label) {
    const text = typeof value === 'bigint' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d+$/.test(text)) throw new Error(`${label} must be a whole number of lamports as a decimal string, for example "0"`);
    return text;
}

// A base58 wallet in its one canonical spelling, or null.
function walletOf(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
        return new PublicKey(value).toBase58() === value ? value : null;
    } catch {
        return null;
    }
}

// Where an object differs from its published form: a few paths, each with the published value, so
// the caller can correct it in one go.
function differences(given, expected, at = '', found = []) {
    if (found.length >= MAX_DIFFERENCES) return found;
    if (isPlainObject(given) && isPlainObject(expected)) {
        for (const key of [...new Set([...Object.keys(given), ...Object.keys(expected)])].sort()) {
            differences(given[key], expected[key], at ? `${at}.${key}` : key, found);
        }
    } else if (Array.isArray(given) && Array.isArray(expected) && given.length === expected.length) {
        given.forEach((item, index) => differences(item, expected[index], `${at}[${index}]`, found));
    } else if (JSON.stringify(given) !== JSON.stringify(expected)) {
        const shown = expected === undefined ? 'absent' : JSON.stringify(expected);
        found.push(`${at || 'the object'} (published: ${shown.length > 80 ? `${shown.slice(0, 77)}...` : shown})`);
    }
    return found;
}

/**
 * A design/v1 object exactly as the app publishes it, and its CID. It is published again from its
 * local-design view (designObject: DesignRecord.published, then validate; authoredAt is a local record's
 * createdAt), and refused unless that gives the same CID, so what is pinned is what the app would pin.
 */
function publishedDesign(content, label = 'design') {
    if (!isPlainObject(content) || content.schema !== DESIGN_SCHEMA) throw new Error(`${label} must be a ${DESIGN_SCHEMA} object`);
    const rebuilt = designObject({ ...content, createdAt: content.authoredAt });
    const cid = cidOfObject(content);
    if (rebuilt.cid !== cid) {
        throw new Error(`${label} is not in its published ${DESIGN_SCHEMA} form; it differs at ${differences(content, rebuilt.content).join('; ')}`);
    }
    return { content, cid };
}

/**
 * An agreement/v1 object exactly as the app publishes it, and its CID: rebuilt from its parts through
 * agreementObject (AgreementRecord.validate, then published), which refuses what the agreement dialog
 * would refuse, and refused unless the rebuilt object has the same CID.
 */
function publishedAgreement(content) {
    if (!isPlainObject(content) || content.schema !== AGREEMENT_SCHEMA) throw new Error(`agreement must be an ${AGREEMENT_SCHEMA} object`);
    if (content.sponsor != null && !walletOf(content.sponsor)) {
        throw new Error('agreement.sponsor must be the base58 wallet that will mint it, or null');
    }
    const inputs = isPlainObject(content.inputs) ? content.inputs : {};
    const rebuilt = agreementObject({
        title: content.title ?? null,
        author: content.author ?? null,
        sponsor: content.sponsor ?? null,
        city: content.city ?? null,
        createdAt: content.createdAt ?? null,
        designs: content.designs,
        parcels: inputs.parcels,
        openGroundM2: inputs.openGroundM2,
        outputs: content.outputs,
        allocations: content.allocations,
        money: content.money,
        rule: content.rule,
        deadline: content.deadline ?? null
    });
    const cid = cidOfObject(content);
    if (rebuilt.cid !== cid) {
        throw new Error(`agreement is not in its published ${AGREEMENT_SCHEMA} form; it differs at ${differences(content, rebuilt.content).join('; ')}`);
    }
    return { content, cid };
}

/**
 * Build the common tool implementation. The returned functions are deliberately transport-free:
 * the stdio MCP server is one caller, and tests or another controller can call the same surface.
 */
export function createUrbanGameTheoryTools({
    mode = 'local',
    env = process.env,
    fetchImpl = globalThis.fetch,
    resolveDraftReference,
    createConnection = (rpcUrl) => createRpcConnection(rpcUrl, 'confirmed'),
    dependencies = {}
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    const apiBase = cleanBase(env.UGT_API_BASE || env.AGENT_API_BASE);
    const appOrigin = cleanBase(env.UGT_APP_ORIGIN, DEFAULT_APP_ORIGIN);
    const rpcUrl = env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
    const live = enabled(env.UGT_MCP_LIVE);
    const maxUsdcPerAction = String(env.UGT_MCP_MAX_USDC_PER_ACTION || '0.25');
    const impl = {
        createPaidClient,
        createOracleFactClient,
        buyOracleFact,
        fetchOracleFactChallenge,
        ensurePledgeBookAndSet,
        ensureDonationEscrowAndDonate,
        ensureMarketAndStake,
        refundDonation,
        revokePledge,
        voidPledge,
        releaseDonations,
        fulfillPledge,
        resolveAgreementMarket,
        claimAgreementMarket,
        resolveExternalMarket,
        claimExternalMarket,
        sendAndConfirmPolling,
        fetchLensMembers,
        requestOwnershipAttestation,
        createIndexClient,
        mintAgreement,
        fundAgreement,
        readAgreementAccount,
        ...dependencies
    };
    let connection = null;
    let signing = null;
    let indexClient = null;

    function requireLive(confirm) {
        if (mode !== 'local') throw new Error('Hosted MCP cannot sign or pay');
        if (!live) throw new Error('live actions are disabled; set UGT_MCP_LIVE=1 to enable index writes and devnet transactions');
        if (confirm !== true) throw new Error('confirm must be true for a write, a paid or a signed action');
    }

    // Chain reads need no key; signing loads UGT_AGENT_KEYPAIR on first use.
    function chain() {
        connection ??= createConnection(rpcUrl);
        return connection;
    }

    function signer() {
        if (mode !== 'local') throw new Error('Hosted MCP cannot sign or pay');
        if (!signing) {
            const secretKey = loadSecretKey(env.UGT_AGENT_KEYPAIR);
            signing = { secretKey, keypair: Keypair.fromSecretKey(secretKey), connection: chain() };
        }
        return signing;
    }

    function index() {
        indexClient ??= impl.createIndexClient({ apiBase, origin: appOrigin, fetchImpl, log });
        return indexClient;
    }

    async function indexedAgreement(agreementCid) {
        const agreement = await index().getAgreement(agreementCid);
        if (!agreement) throw new Error(`agreement ${agreementCid} is not in the index; propose it first (ugt_propose_agreement)`);
        return agreement;
    }

    const companion = createMcpReadTools({ apiBase, appOrigin, fetchImpl });
    const drafts = createMcpDraftTools({ read: companion, appOrigin, resolveDraftReference });
    function requirePublish(confirm) {
        if (confirm !== true) throw new Error('confirm must be true: publishing is public and permanent');
    }

    return {
        ...companion,
        ...drafts,
        ...createMcpAgreementTools({ read: companion, drafts, appOrigin }),
        config: {
            apiBase,
            appOrigin,
            rpcUrl,
            cluster: 'solana-devnet',
            agreementProgram: AGREEMENT_PROGRAM_ID,
            liveActionsEnabled: live,
            keypairConfigured: Boolean(env.UGT_AGENT_KEYPAIR),
            maxUsdcPerAction,
            usdcMint: USDC_DEVNET
        },

        capabilities: async () => {
            let manifest;
            try { manifest = { ...await readJson(fetchImpl, `${apiBase}/docs/agents.json`), upstream: { available: true } }; }
            catch (error) {
                if (mode !== 'local') throw error;
                manifest = { upstream: { available: false, code: error.code || 'api-unavailable', next: { tool: 'ugt_chain_agreements', arguments: {} } } };
            }
            return { ...manifest, mode, cluster: 'solana-devnet', agreementProgram: AGREEMENT_PROGRAM_ID, tools: mode === 'hosted' ? MCP_HOSTED_TOOLS : MCP_LOCAL_TOOLS, toolPhases: { reads: 'implemented', approvalLinks: 'mint, fund, decide accept, execute, cancel, expire, bet', drafts: 'implemented with complete cadastral ground; unsurveyed/open-ground agreement derivation requires the app', publication: 'implemented; permanent and public' }, hostedEndpoint: `${appOrigin}/mcp`, unsignedPublication: { confirm: true, requiresKey: false, permanent: true } };
        },

        getActivity: ({ limit = 100, actor, source, action } = {}) => readJson(
            fetchImpl,
            withQuery(apiBase, '/agent/activity', { limit, actor, source, action })
        ),

        listAgreements: async ({ city, design, parcel, limit = 20 } = {}) => {
            const result = await index().listAgreements({ city, design, parcel, limit });
            return { ...result, agreements: result.agreements.map(row => ({ ...row, previewUrl: `${appOrigin}/agreements/${row.cid}` })) };
        },
        async listChainAgreements({ limit = 20 } = {}) {
            const accounts = await chain().getProgramAccounts(new PublicKey(AGREEMENT_PROGRAM_ID), { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: Buffer.from(agreementClient.ACCOUNT_DISCRIMINATORS.Agreement).toString('base64'), encoding: 'base64' } }] });
            return { agreements: accounts.slice(0, limit).map(row => {
                const value = agreementClient.readAgreement(row.account.data, row.pubkey.toBase58());
                if (!value || agreementAccountOf(value.cid, value.authority) !== value.address) throw new Error('Invalid agreement program account');
                return { ...value, previewUrl: `${appOrigin}/agreements/${value.cid}` };
            }), count: accounts.length, truncated: accounts.length > limit };
        },
        getChainAgreement: ({ agreementAccount }) => impl.readAgreementAccount(chain(), { account: agreementAccount }),
        async betOnAccount({ agreementAccount, side, amountUsdc, confirm }) {
            requireLive(confirm);
            if (!['yes', 'no'].includes(side)) throw new Error('side must be yes or no');
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            const state = await impl.readAgreementAccount(connection, { account: agreementAccount });
            if (!state || state.status !== AGREEMENT_STATUS.active || state.deadline > 0 && state.deadline * 1000 <= Date.now()) throw new Error('Only an active agreement before its deadline accepts stakes');
            return impl.ensureMarketAndStake({ connection, ownerKeypair: keypair, subject: agreementAccount, stakeMint: USDC_DEVNET, side: SIDE[side], amountAtomic, sendAndConfirm: impl.sendAndConfirmPolling });
        },

        // The index row, the chain account its sponsor and CID derive, and that account as the chain
        // holds it now (null until the sponsor mints it).
        async getAgreement({ agreementCid } = {}) {
            const agreement = await indexedAgreement(agreementCid);
            const sponsor = walletOf(agreement.content?.sponsor);
            if (!sponsor || agreement.content?.rule?.binding === false) return { agreement, sponsor, account: null, minted: false, accountState: null, previewUrl: `${appOrigin}/agreements/${agreementCid}` };
            const accountState = await impl.readAgreementAccount(chain(), { cid: agreementCid, sponsor });
            return { agreement, sponsor, account: agreementAccountOf(agreementCid, sponsor), minted: Boolean(accountState), accountState, previewUrl: `${appOrigin}/agreements/${agreementCid}` };
        },

        getSupport: ({ agreementAccount } = {}) => readJson(
            fetchImpl,
            `${apiBase}/agent/pledges/${encodeURIComponent(agreementAccount)}`
        ),

        getOracleEvents: ({ agreementAccount, limit = 20 } = {}) => readJson(
            fetchImpl,
            withQuery(apiBase, '/oracle/events', { subject: agreementAccount, limit })
        ),

        async listAttesters({ kind } = {}) {
            const members = await impl.fetchLensMembers({ apiBase, fetchImpl });
            return { members: kind ? members.filter(member => member.kind === kind) : members };
        },

        // Challenge → sign with UGT_AGENT_KEYPAIR → POST /lens/ownership on the member's own service.
        // Signing a challenge moves nothing; only the x402 payment of a priced member needs the live gate.
        async requestOwnership({ serviceUrl, parcelUid, confirm } = {}) {
            const { secretKey } = signer();
            return impl.requestOwnershipAttestation({
                serviceUrl, parcelUid, secretKey, fetchImpl,
                pay: async ({ challenge, paymentId, url, init }) => {
                    requireLive(confirm);
                    assertChallengeUnderCap(challenge, maxUsdcPerAction, 'ownership attestation');
                    const { paidFetch } = await impl.createPaidClient({ secretKey, paymentId, rpcUrl, fetchImpl });
                    return paidFetch(url, init);
                }
            });
        },

        // Store private feedback through the same API as the human form.
        async submitFeedback({ kind = 'bug', message, pageUrl, reportId, confirm } = {}) {
            if (confirm !== true) throw Object.assign(new Error('confirm must be true to send feedback.'), { code: 'confirmation-required' });
            reportId ||= randomUUID();
            try { return await companion.request('/feedback', {}, { kind, message, pageUrl, reportId, source: 'mcp' }); }
            catch (error) {
                error.next = { action: 'Retry this report with the same reportId to avoid a duplicate.', tool: 'ugt_submit_feedback',
                    arguments: { kind, message, pageUrl, reportId, confirm: true } };
                throw error;
            }
        },

        // Pin and index one design/v1 object. The index derives its binding (the parcels its site takes)
        // and answers the row. A parcel layout is indexed only with its agreement.
        async publishDesign({ design, parcelSourceId = null, confirm } = {}) {
            requirePublish(confirm);
            const { content, cid } = publishedDesign(design);
            if (isParcelLayout(content)) {
                throw new Error(`design ${cid} is a parcel layout: a layout is published only with the agreement that settles its land; pass it to ugt_propose_agreement in designs: [{ content }]`);
            }
            const published = await index().publishDesign(content, { parcelSourceId });
            if (published.cid !== cid) throw new Error(`the index filed design ${published.cid}, not ${cid}`);
            const row = await index().getDesign(cid);
            if (!row || row.cid !== cid || !row.content || cidOfObject(row.content) !== cid) throw new Error('Published design could not be read back with matching content');
            return { cid, created: published.created, row, previewUrl: `${appOrigin}/designs/${cid}` };
        },

        // Pin the carried designs and the agreement/v1 object, then index the agreement with them. The
        // index requires its inputs to be exactly the union of its designs' bindings.
        async proposeAgreement({ agreement, designs = [], confirm } = {}) {
            requirePublish(confirm);
            const { content, cid } = publishedAgreement(agreement);
            const linked = new Set(content.designs.map(entry => entry.cid));
            const carried = (Array.isArray(designs) ? designs : []).map((entry, at) => publishedDesign(entry?.content, `designs[${at}].content`));
            const stray = carried.find(entry => !linked.has(entry.cid));
            if (stray) throw new Error(`design ${stray.cid} is carried, but the agreement does not link it`);
            if (new Set(carried.map(entry => entry.cid)).size !== carried.length) throw new Error('a design is carried twice');
            const client = index();
            for (const entry of carried) await client.pin('design', entry.content);
            const published = await client.publishAgreement(content, { designs: carried });
            if (published.cid !== cid) throw new Error(`the index filed agreement ${published.cid}, not ${cid}`);
            const row = await client.getAgreement(cid);
            if (!row || row.cid !== cid || !row.content || cidOfObject(row.content) !== cid) throw new Error('Published agreement could not be read back with matching content');
            const sponsor = content.sponsor ?? null;
            return {
                cid,
                created: published.created,
                carried: carried.map(entry => entry.cid),
                sponsor,
                account: sponsor ? agreementAccountOf(cid, sponsor) : null,
                row,
                previewUrl: `${appOrigin}/agreements/${cid}`,
                approvalUrl: content.rule.binding && sponsor ? `${appOrigin}/agreements/${cid}?act=mint` : null
            };
        },

        // Create the agreement's account as its sponsor and fund the escrow to `lamports` (also the escrow
        // execution requires), then record the account in the index. Repeating it creates nothing twice.
        // Only a binding owners' agreement is minted: a community or owner vote is a poll in the index.
        async mintAgreement({ agreementCid, lamports, confirm } = {}) {
            requireLive(confirm);
            const required = wholeLamports(lamports, 'lamports');
            const { content } = await indexedAgreement(agreementCid);
            if (content.rule?.electorate !== 'owners' || content.rule?.binding !== true) {
                throw new Error(`agreement ${agreementCid} is a non-binding ${content.rule?.electorate ?? 'unknown'} vote: it is a poll in the index and is never minted`);
            }
            const { keypair, connection } = signer();
            const self = keypair.publicKey.toBase58();
            if (content.sponsor !== self) {
                throw new Error(`agreement ${agreementCid} names sponsor ${content.sponsor ?? 'none'}, not this agent's wallet ${self}: only its sponsor can create its account`);
            }
            const lens = parseLensList(content.rule?.lens || []);
            if (lens.length !== 1) throw new Error(`the agreement program takes one lens key, but rule.lens holds ${lens.length}`);
            if (lens[0] === self) throw new Error(`rule.lens names only this agent's own key ${self}: a sponsor cannot attest its own agreement`);
            const minted = await impl.mintAgreement({
                connection, sponsorKeypair: keypair, cid: agreementCid, lens: lens[0], deadline: content.deadline ?? null,
                lamports: required, openGround: Number(content.inputs?.openGroundM2) > 0,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
            const recorded = await index().recordOnchain(agreementCid, {
                chain: 'solana', cluster: AGREEMENT_CLUSTER, account: minted.account, signature: minted.createSignature
            });
            return { ...minted, onchain: recorded.onchain ?? null };
        },

        // Top the escrow up to `targetLamports` as the sponsor; a target already held signs nothing.
        async fundAgreement({ agreementCid, targetLamports, confirm } = {}) {
            requireLive(confirm);
            const target = wholeLamports(targetLamports, 'targetLamports');
            const { keypair, connection } = signer();
            return impl.fundAgreement({
                connection, sponsorKeypair: keypair, cid: agreementCid, targetLamports: target,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        // Stake devnet USDC on whether the agreement executes: its market's subject is the agreement's
        // account (PDA of its sponsor and CID), which must be minted, Active and before its deadline.
        async betOnAgreement({ agreementCid, side, amountUsdc, confirm } = {}) {
            requireLive(confirm);
            const normalizedSide = String(side || '').toLowerCase();
            if (!(normalizedSide in SIDE)) throw new Error('side must be yes or no');
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { content } = await indexedAgreement(agreementCid);
            const sponsor = walletOf(content?.sponsor);
            if (!sponsor) throw new Error(`agreement ${agreementCid} names no sponsor wallet, so it has no chain account to bet on`);
            const { keypair, connection } = signer();
            const state = await impl.readAgreementAccount(connection, { cid: agreementCid, sponsor });
            if (!state) throw new Error(`agreement ${agreementCid} is not minted yet; its sponsor mints it first (ugt_mint_agreement)`);
            if (state.status !== AGREEMENT_STATUS.active) throw new Error(`agreement ${state.address} is ${state.status}; its market takes no more stakes`);
            if (state.deadline > 0 && state.deadline * 1000 <= Date.now()) {
                throw new Error(`agreement ${state.address} is past its deadline; its market takes no more stakes`);
            }
            const result = await impl.ensureMarketAndStake({
                connection, ownerKeypair: keypair, subject: state.address,
                stakeMint: USDC_DEVNET, side: SIDE[normalizedSide], amountAtomic,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
            return { agreementCid, agreementAccount: state.address, side: normalizedSide, amountUsdc, ...result };
        },

        inspectVerifiedFact: ({ agreementAccount, marketAccount } = {}) => impl.fetchOracleFactChallenge({
            baseUrl: apiBase, subject: agreementAccount, marketAccount, fetchImpl
        }),

        async buyVerifiedFact({ agreementAccount, marketAccount, confirm } = {}) {
            requireLive(confirm);
            const challenge = await impl.fetchOracleFactChallenge({
                baseUrl: apiBase, subject: agreementAccount, marketAccount, fetchImpl
            });
            assertChallengeUnderCap(challenge, maxUsdcPerAction, 'verified fact');
            const { secretKey } = signer();
            const { payerAddress, paidFetch } = await impl.createOracleFactClient({ secretKey, rpcUrl, fetchImpl });
            const result = await impl.buyOracleFact({ baseUrl: apiBase, subject: agreementAccount, marketAccount, paidFetch });
            return { payerAddress, ...result };
        },

        async pledge({ agreementAccount, amountUsdc, confirm } = {}) {
            requireLive(confirm);
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            return impl.ensurePledgeBookAndSet({
                connection, pledgerKeypair: keypair, subject: agreementAccount, amountAtomic,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async donate({ agreementAccount, amountUsdc, operationId, confirm } = {}) {
            requireLive(confirm);
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            return impl.ensureDonationEscrowAndDonate({
                connection, donorKeypair: keypair, subject: agreementAccount, amountAtomic,
                operationId, sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async refundDonation({ agreementAccount, operationId, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.refundDonation({
                connection, donorKeypair: keypair, subject: agreementAccount, operationId,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async voidPledge({ agreementAccount, pledger, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.voidPledge({
                connection, feePayerKeypair: keypair, subject: agreementAccount, pledger,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async revokePledge({ agreementAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.revokePledge({
                connection, pledgerKeypair: keypair, subject: agreementAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async releaseDonations({ agreementAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.releaseDonations({
                connection, releaserKeypair: keypair, subject: agreementAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async fulfillPledge({ agreementAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.fulfillPledge({
                connection, pledgerKeypair: keypair, subject: agreementAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async resolve({ agreementAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.resolveAgreementMarket({
                connection, resolverKeypair: keypair, subject: agreementAccount,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async claim({ agreementAccount, side, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.claimAgreementMarket({
                connection, claimerKeypair: keypair, subject: agreementAccount, side,
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
