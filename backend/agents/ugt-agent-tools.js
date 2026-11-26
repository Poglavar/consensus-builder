// Shared action surface for external agents (plan-design-agreement.md, M3). The stdio MCP server
// (mcp-server.mjs) is one caller; tests or another controller can call the same functions. Designs and
// agreements are pinned and indexed through publication-client.js, agreements minted and funded through
// agreement-minter.js, and markets, pledges and donations take the agreement's chain account as their
// subject (bettor.js, pledger.js, donor.js, lifecycle-actions.js): the adapters the deterministic
// runners use, never a second execution path.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createMcpDiscoveryTools } from './mcp-discovery.js';
import { trustedMetadata } from './mcp-results.js';
import { createMcpAgreementTools } from './mcp-ground.js';
import { createMcpDraftTools } from './mcp-drafts.js';
import { createMcpPlanTools } from './mcp-plan.js';
import { createMcpNamedPlanTools } from './mcp-named-plans.js';
import { createMcpReadTools } from './mcp-read-tools.js';
import { createMcpNavigation } from './mcp-navigation.js';
import { createMcpAssetTools } from './mcp-assets.js';
import { createMcpComparison } from './mcp-compare.js';
import { createMcpValidationTools } from './mcp-validation.js';
import { createMcpVotingTools } from './mcp-voting.js';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { buyAgreementShares, openAgreementMarket, sellAgreementShares, usdcToAtomic } from './bettor.js';
import { buyOracleFact, createOracleFactClient, fetchOracleFactChallenge } from './oracle-fact-client.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { createRpcConnection } from '../solana/rpc.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { createPaidClient } from './x402-client.js';
import { fetchLensMembers } from './lens-directory-client.js';
import { requestOwnershipAttestation } from './lens-ownership-client.js';
import { createIndexClient } from './publication-client.js';
import { canonicalBytes } from '../cid.js';
import { AGREEMENT_SCHEMA, DESIGN_SCHEMA, agreementObject, cidOfObject, designObject, isCid } from './agreement-objects.js';
import {
    AGREEMENT_PROGRAM_ID, AGREEMENT_STATUS, agreementAccountOf, executeAgreement, expireAgreement, fundAgreement, mintAgreement, mintTermsOf,
    readAgreementAccount, recordAgreementDecision
} from './agreement-minter.js';
import { anchorParcels, apartmentQualification, cancelAgreement, confirmAsLensMember, refundContributions } from './chain-actions.js';
import { listApartments, readRoundInventory, reserveApartment, roundAccepting, roundStats } from './apartment-actions.js';
import {
    acceptOffer, cancelOffer, createOfferOnChain, createOnchainRecorder, expireOffer, fundOffer, releaseOffer
} from './property-offer-signer.js';
import {
    claimAgreementMarket, claimExternalMarket, confirmFunding, fulfillPledge, reclaimAgreementMarketSeed, refundDonation, releaseDonations, resolveAgreementMarket,
    resolveExternalMarket, revokePledge, voidPledge
} from './lifecycle-actions.js';

const require = createRequire(import.meta.url);
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const parcelAnchor = require('../../frontend/js/parcels/parcel-anchor.js');
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

function selectedMarket(address) {
    if (!address || new PublicKey(address).toBase58() !== address) throw new Error('Select a marketAddress from ugt_markets.');
    return address;
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

// The account carries the lens set, threshold and contribution target the published agreement mints with.
const sameMintTerms = (account, terms) => account.lenses.join() === terms.lenses.join() && account.lensThreshold === terms.lensThreshold
    && account.fundingMint === terms.fundingMint && account.requiredFunding === terms.requiredFunding;

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
function publishedAgreement(content, plan) {
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
        plan,
        designs: (plan?.content?.designCids || []).map(cid => ({ cid })),
        parcels: inputs.parcels,
        openGroundM2: inputs.openGroundM2,
        outputs: content.outputs,
        allocations: content.allocations,
        money: content.money,
        rule: content.rule,
        deadline: content.deadline ?? null,
        consultation: content.consultation ?? null,
        funding: content.funding ?? null
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
        buyAgreementShares,
        sellAgreementShares,
        openAgreementMarket,
        refundDonation,
        revokePledge,
        voidPledge,
        releaseDonations,
        confirmFunding,
        fulfillPledge,
        resolveAgreementMarket,
        claimAgreementMarket,
        reclaimAgreementMarketSeed,
        resolveExternalMarket,
        claimExternalMarket,
        sendAndConfirmPolling,
        fetchLensMembers,
        requestOwnershipAttestation,
        createIndexClient,
        mintAgreement,
        fundAgreement,
        readAgreementAccount,
        executeAgreement,
        expireAgreement,
        recordAgreementDecision,
        cancelAgreement,
        confirmAsLensMember,
        refundContributions,
        anchorParcels,
        listApartments,
        readRoundInventory,
        apartmentQualification,
        reserveApartment,
        createOfferOnChain,
        acceptOffer,
        fundOffer,
        releaseOffer,
        cancelOffer,
        expireOffer,
        pinWithPinata: options => require('../../frontend/js/ipfs-own-key.js').pinWithPinata(options),
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

    // Anchors for `anchorIds` signed by this agent: the parcel's page on the configured app origin as
    // the URI, several per transaction, existing anchors skipped (cost nothing). Ids that cannot seed an
    // anchor come back in `skipped` instead of failing the batch.
    async function anchorTargetsSigned(anchorIds) {
        const { parcels, skipped } = parcelAnchor.anchorTargets(anchorIds, { base: appOrigin });
        const { keypair, connection } = signer();
        const anchors = parcels.length
            ? await impl.anchorParcels({ connection, payerKeypair: keypair, parcels, sendAndConfirm: impl.sendAndConfirmPolling })
            : { parcels: [], transactions: 0 };
        return { ...anchors, skipped, explorer: anchors.parcels.map(row => `https://explorer.solana.com/address/${row.anchor}?cluster=devnet`) };
    }

    // The exact canonical bytes a mint references: the agreement, its plan and the plan's designs, each
    // checked against its CID (for pinning with the agent's own key).
    async function mintContentObjects(agreementCid, content) {
        const plan = await companion.request(`/plans/${content.planCid}`);
        if (plan?.cid !== content.planCid || cidOfObject(plan.content) !== content.planCid) throw new Error(`plan ${content.planCid} of agreement ${agreementCid} could not be read as published`);
        const designs = await index().getDesigns(plan.content.designCids);
        const objects = [{ kind: 'agreement', cid: agreementCid, content }, { kind: 'plan', cid: plan.cid, content: plan.content },
            ...plan.content.designCids.map(cid => ({ kind: 'design', cid, content: designs.get(cid)?.content }))];
        return objects.map(object => {
            if (!object.content || cidOfObject(object.content) !== object.cid) throw new Error(`${object.kind} ${object.cid} of agreement ${agreementCid} could not be read as published`);
            return { kind: object.kind, cid: object.cid, bytes: canonicalBytes(object.content) };
        });
    }

    async function indexedAgreement(agreementCid) {
        const agreement = await index().getAgreement(agreementCid);
        if (!agreement) throw new Error(`agreement ${agreementCid} is not in the index; propose it first (ugt_propose_agreement)`);
        return agreement;
    }

    // A published property offer's chain step, as the offer panel takes it with a wallet: the offer as the
    // index serves it (the signer checks its CID and the chain account against its terms), the service of
    // the lens member it names, and the index write the panel makes after each confirmed transaction.
    async function offerStep(operation, cid, extra = {}) {
        const row = await companion.request(`/property-offers/${encodeURIComponent(cid)}`);
        const { keypair, connection } = signer();
        let lensServiceUrl;
        if (operation === 'createOfferOnChain' || operation === 'acceptOffer') {
            const member = (await impl.fetchLensMembers({ apiBase, fetchImpl })).find(row2 => row2.key === row.content?.lens);
            if (!member?.serviceUrl) throw new Error(`the lens member ${row.content?.lens ?? '(none)'} this offer names has no registered decision service`);
            lensServiceUrl = member.serviceUrl;
        }
        return impl[operation]({ connection, keypair, row: { cid: row.cid, content: row.content, onchain: row.onchain ?? null }, lensServiceUrl, fetchImpl,
            recordOnchain: createOnchainRecorder({ apiBase, appOrigin, fetchImpl }), sendAndConfirm: impl.sendAndConfirmPolling, ...extra });
    }

    // An indexed binding agreement, checked against its CID, with the chain account its sponsor and CID derive.
    async function chainAgreement(agreementCid) {
        const agreement = verifiedRow(await indexedAgreement(agreementCid), agreementCid, 'agreement');
        const sponsor = walletOf(agreement.content?.sponsor);
        if (!sponsor) throw new Error(`agreement ${agreementCid} names no sponsor wallet, so it has no chain account`);
        return { agreement, sponsor, account: agreementAccountOf(agreementCid, sponsor) };
    }

    // A minted apartment round (agreement panel, funding section): its index row, the account its sponsor
    // and CID derive, the Agreement account read from the chain, and whether it still takes listings and
    // reservations (Active and before its deadline).
    async function apartmentRound(agreementCid) {
        const { agreement, sponsor, account } = await chainAgreement(agreementCid);
        if (!agreement.content.funding?.apartments) throw Object.assign(new Error(`agreement ${agreementCid} offers no apartments`), { code: 'not-apartment-round' });
        const { keypair, connection } = signer();
        const value = await impl.readAgreementAccount(connection, { cid: agreementCid, sponsor });
        if (!value) throw Object.assign(new Error(`agreement ${agreementCid} is not minted on the current agreement program`), { code: 'not-minted' });
        return { agreement, sponsor, account, value, keypair, connection, accepting: roundAccepting(value) };
    }
    const roundClosed = agreementCid => Object.assign(new Error(`The apartment round ${agreementCid} is closed: it is not Active on chain or its deadline has passed.`), { code: 'round-closed' });

    const companion = createMcpReadTools({ apiBase, appOrigin, fetchImpl });
    const drafts = createMcpDraftTools({ read: companion, appOrigin, resolveDraftReference, resolvePlan: value => namedPlanTools.resolvePlan(value) });
    const agreements = createMcpAgreementTools({ read: companion, drafts, appOrigin });
    function requirePublish(confirm) {
        if (confirm !== true) throw Object.assign(new Error('confirm must be true: publishing is public and permanent'), { code: 'confirmation-required' });
    }

    const agreementPlans = createMcpPlanTools({ read: companion, drafts, agreements, appOrigin, resolveDraftReference });
    const referenceInput = value => typeof value === 'string' || Boolean(value?.draftRef);
    const checkRevision = (cid, expectedCid, required) => {
        if (required && !expectedCid) throw Object.assign(new Error('Reference publication requires expectedCid from inspection.'), { code: 'expected-cid-required' });
        if (expectedCid && expectedCid !== cid) throw Object.assign(new Error('The supplied expectedCid does not match the resolved immutable revision.'), { code: 'revision-mismatch', field: 'expectedCid', currentCid: cid, expectedCid });
    };
    const verifiedRow = (row, cid, kind) => {
        if (!row || row.cid !== cid || !row.content || cidOfObject(row.content) !== cid) throw Object.assign(new Error(`Published ${kind} could not be read back with matching content`), { code: 'cid-mismatch' });
        return row;
    };
    function publicationError(error, state, tool, args) {
        const inspect = state.kind === 'design' ? { tool: 'ugt_inspect_design', arguments: { design: args.design } }
            : { tool: 'ugt_inspect_agreement', arguments: { plan: args.agreement } };
        const next = state.stage === 'resolve'
            ? { ...inspect, action: 'Inspect this reference and correct the reported fields. Confirm the exact returned CID before publication.' }
            : { tool, arguments: args, action: 'Retry this same confirmed immutable revision. The index will be checked before any publication write.' };
        return Object.assign(error, { code: error.code || 'publication-failed', cid: state.cid,
            stage: error.stage || state.stage, publishedCids: [...new Set([...state.publishedCids, ...(error.publishedCids || [])])],
            indexed: error.indexed ?? state.indexed, url: state.cid ? `${appOrigin}/${state.kind}s/${state.cid}` : null,
            next });
    }
    async function agreementSource(value, expectedCid) {
        if (!referenceInput(value)) {
            const artifact = value?.draftArtifact || value;
            const content = artifact.agreement || artifact.content || artifact;
            let plan = artifact.plan || (content.planCid ? await companion.request(`/plans/${content.planCid}`) : null);
            if (plan?.schema === 'plan/v1') plan = { cid: cidOfObject(plan), content: plan };
            if (plan?.content == null && plan?.plan) plan = { cid: plan.cid, content: plan.plan };
            return { ...publishedAgreement(content, plan), designs: artifact.designs || [], plan,
                designSources: artifact.designSources || {}, parcelSourceId: artifact.parcelSourceId };
        }
        if (!expectedCid) checkRevision(null, expectedCid, true);
        const reference = typeof value === 'string' ? value : value.draftRef;
        let cid = isCid(reference) ? reference : null;
        if (!cid) {
            try {
                const url = new URL(reference);
                if (url.origin === new URL(appOrigin).origin && /^\/agreements\/baf(?:krei|ybei)[a-z2-7]{52}\/?$/.test(url.pathname)) cid = url.pathname.split('/')[2];
            } catch { /* Private reference validation belongs to its server-side resolver. */ }
        }
        let artifact;
        if (cid) artifact = await companion.getAgreement({ agreementCid: cid });
        else {
            if (!resolveDraftReference) throw Object.assign(new Error('Private agreement references require their hosting server.'), { code: 'draft-reference-unavailable' });
            artifact = await resolveDraftReference(reference);
        }
        const content = artifact.agreement || artifact.content;
        let plan = artifact.plan || (content?.planCid ? await companion.request(`/plans/${content.planCid}`) : null);
        if (plan?.schema === 'plan/v1') plan = { cid: cidOfObject(plan), content: plan };
        if (plan?.content == null && plan?.plan) plan = { cid: plan.cid, content: plan.plan };
        const checked = publishedAgreement(content, plan);
        checkRevision(checked.cid, expectedCid, true);
        if ((cid && cid !== checked.cid) || (value?.cid && value.cid !== checked.cid) || (artifact.cid && artifact.cid !== checked.cid)) throw Object.assign(new Error('The agreement reference content differs from its CID.'), { code: 'cid-mismatch' });
        return { ...checked, plan, designs: artifact.designs || [], designSources: artifact.designSources || {}, parcelSourceId: artifact.parcelSourceId };
    }

    const actions = {
        async exportDraft({ draftRef }) {
            if (!resolveDraftReference) throw Object.assign(new Error('Use the exact draftArtifact returned by the local client.'), { code: 'draft-reference-unavailable' });
            const artifact = await resolveDraftReference(draftRef);
            return { cid: cidOfObject(artifact.design || artifact.plan || artifact.agreement), artifact, publication: 'private',
                next: trustedMetadata({ action: 'Save this exact artifact. Supply it as canonical input to restore the draft after its reference expires.' }) };
        },
        ...companion,
        ...createMcpNavigation({ read: companion }),
        ...createMcpVotingTools({ read: companion }),
        ...drafts,
        ...agreements,
        // With includeAvailability, an apartment round's states and counts by the browser's model
        // (ApartmentRound), over the API's chain inventory and the round's own chain status and deadline.
        async inspectAgreement(args = {}) {
            const result = await agreementPlans.inspectPlan(args);
            const availability = result.investorReview?.availability;
            if (availability?.status !== 'confirmed') return result;
            const chainAccount = await impl.readAgreementAccount(chain(), { cid: result.cid, sponsor: result.investorReview.payout });
            return { ...result, apartmentStats: roundStats({ funding: result.funding, units: availability.units, chainAccount }) };
        },
        editAgreement: agreementPlans.editAgreement,
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

        capabilities: createMcpDiscoveryTools({ read: companion, mode, appOrigin }).capabilities,

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
        async openMarket({ agreementAccount, liquidityUsdc, closesAt, external, trustedAttester, confirm }) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            const publishRecipe = async (data, expectedCid) => {
                const response = await fetchImpl(apiBase + '/markets/recipes', { method: 'POST', signal: AbortSignal.timeout(30000),
                    headers: { 'Content-Type': 'application/json', Origin: appOrigin }, body: JSON.stringify(data) });
                if (!response.ok || (await response.json()).cid !== expectedCid) throw new Error('Could not publish the exact market recipe.');
            };
            return impl.openAgreementMarket({ connection, creatorKeypair: keypair, subject: agreementAccount, b: usdcToAtomic(liquidityUsdc),
                closesAt, external, trustedAttester, publishRecipe, maxSeedAtomic: usdcToAtomic(maxUsdcPerAction), sendAndConfirm: impl.sendAndConfirmPolling });
        },
        async betOnAccount({ agreementAccount, marketAddress, side, amountUsdc, confirm }) {
            requireLive(confirm);
            if (!['yes', 'no'].includes(side)) throw new Error('side must be yes or no');
            const amountAtomic = positiveAmount(amountUsdc, maxUsdcPerAction);
            const { keypair, connection } = signer();
            return impl.buyAgreementShares({ connection, ownerKeypair: keypair, subject: agreementAccount, marketAddress: selectedMarket(marketAddress), stakeMint: USDC_DEVNET, side: SIDE[side], amountAtomic, sendAndConfirm: impl.sendAndConfirmPolling });
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

        // Index one design/v1 object. The index derives its binding (the parcels its site takes)
        // and answers the row.
        async publishDesign({ design, parcelSourceId = null, expectedCid, confirm } = {}) {
            requirePublish(confirm);
            const args = { design, parcelSourceId, ...(expectedCid ? { expectedCid } : {}), confirm };
            const state = { kind: 'design', cid: expectedCid || null, stage: 'resolve', publishedCids: [], indexed: false };
            try {
                const reference = referenceInput(design);
                if (reference && !expectedCid) checkRevision(null, expectedCid, true);
                const resolved = reference ? await drafts.resolveDesignSource(design) : null;
                const { content, cid } = publishedDesign(resolved ? resolved.content : design);
                state.cid = cid; checkRevision(cid, expectedCid, reference);
                parcelSourceId ||= resolved?.parcelSourceId || null;
                state.stage = 'lookup';
                const existing = await index().getDesign(cid);
                if (existing) {
                    verifiedRow(existing, cid, 'design'); state.indexed = true;
                    return { cid, created: false, row: existing, publication: 'published', url: `${appOrigin}/designs/${cid}`, previewUrl: `${appOrigin}/designs/${cid}` };
                }
                state.stage = 'index-design';
                const published = await index().publishDesign(content, { parcelSourceId });
                if (published.cid !== cid) throw Object.assign(new Error(`the index filed design ${published.cid}, not ${cid}`), { code: 'cid-mismatch' });
                state.publishedCids.push(cid); state.indexed = true; state.stage = 'readback';
                const row = verifiedRow(await index().getDesign(cid), cid, 'design');
                return { cid, created: published.created, row, publication: 'published', url: `${appOrigin}/designs/${cid}`, previewUrl: `${appOrigin}/designs/${cid}` };
            } catch (error) { throw publicationError(error, state, 'ugt_publish_design', args); }
        },

        async proposeAgreement({ agreement, designs = [], expectedCid, confirm } = {}) {
            requirePublish(confirm);
            const args = { agreement, designs, ...(expectedCid ? { expectedCid } : {}), confirm };
            const state = { kind: 'agreement', cid: expectedCid || null, stage: 'resolve', publishedCids: [], indexed: false };
            try {
                const source = await agreementSource(agreement, expectedCid), { content, cid } = source;
                state.cid = cid; checkRevision(cid, expectedCid, referenceInput(agreement));
                const plan = source.plan;
                if (!plan || cidOfObject(plan.content) !== plan.cid || plan.cid !== content.planCid) throw Object.assign(new Error('The agreement plan does not match its plan CID.'), { code: 'plan-cid-mismatch' });
                const linked = new Set(plan.content.designCids);
                const carried = [];
                const crowdfunding = content.rule?.electorate === 'investors';
                const client = index();
                for (const input of [...source.designs, ...designs]) {
                    const bytes = input?.untrusted?.design || input?.untrusted?.content || input?.design || input?.content || input;
                    const memberCid = isCid(input) ? input : bytes?.schema === DESIGN_SCHEMA ? cidOfObject(bytes) : null;
                    if (input?.cid && memberCid && input.cid !== memberCid) throw new Error('The supplied design differs from its claimed CID.');
                    const indexed = crowdfunding && memberCid ? await client.getDesign(memberCid) : null;
                    const resolved = indexed ? verifiedRow(indexed, memberCid, 'design') : await drafts.resolveDesignSource(input);
                    const row = indexed ? { cid: memberCid, content: resolved.content } : publishedDesign(resolved.content, 'carried design');
                    if (!linked.has(row.cid)) throw new Error(`design ${row.cid} is carried, but the agreement does not link it`);
                    if (carried.some(entry => entry.cid === row.cid)) throw new Error('a design is carried twice');
                    const parcelSourceId = resolved.parcelSourceId || input?.parcelSourceId || source.designSources?.[row.cid] || null;
                    if (crowdfunding && !indexed && !parcelSourceId) {
                        throw Object.assign(new Error(`Design ${row.cid} needs an explicit parcelSourceId before this investor agreement can index it.`), {
                            code: 'parcel-source-required', field: 'parcelSourceId',
                            next: { tool: 'ugt_list_sources', arguments: { city: resolved.content.city, abstraction: 'parcels' }, action: 'Choose the source used for this design, then retry with that parcelSourceId.' }
                        });
                    }
                    carried.push(crowdfunding && parcelSourceId ? { ...row, parcelSourceId } : row);
                }
                state.stage = 'lookup';
                const existing = await client.getAgreement(cid);
                let row, created;
                if (existing) { row = verifiedRow(existing, cid, 'agreement'); created = false; state.indexed = true; }
                else {
                    // Carried designs are indexed with the agreement, in one transaction.
                    state.stage = 'index-agreement';
                    const published = await client.publishAgreement(content, { plan, designs: carried });
                    if (published.cid !== cid) throw Object.assign(new Error(`the index filed agreement ${published.cid}, not ${cid}`), { code: 'cid-mismatch' });
                    state.publishedCids.push(cid); state.indexed = true; state.stage = 'readback';
                    row = verifiedRow(await client.getAgreement(cid), cid, 'agreement'); created = published.created;
                }
                const sponsor = content.sponsor ?? null;
                return { cid, created, carried: carried.map(entry => entry.cid), sponsor,
                    account: sponsor ? agreementAccountOf(cid, sponsor) : null, row, publication: 'published',
                    url: `${appOrigin}/agreements/${cid}`, previewUrl: `${appOrigin}/agreements/${cid}`,
                    approvalUrl: content.rule.binding && sponsor ? `${appOrigin}/agreements/${cid}?act=mint` : null,
                    investorReview: content.rule.electorate === 'investors' ? {
                        contract: content.funding?.contract?.name ?? null,
                        targetUsdcAtomic: content.funding?.targetUsdcAtomic ?? null,
                        action: content.funding?.apartments
                            ? 'Review the unit drawing and contract. The developer’s lens must qualify the buyer before they deposit USDC to reserve that apartment.'
                            : 'Review the attached immutable contract before any investor donation.'
                    } : null };
            } catch (error) { throw publicationError(error, state, 'ugt_propose_agreement', args); }
        },

        // Create the agreement's account as its sponsor and fund the escrow to `lamports` (also the escrow
        // execution requires), then record the account in the index. Repeating it creates nothing twice.
        // Binding owners and investor crowdfunding agreements use the same agreement account. Polls do not.
        async mintAgreement({ agreementCid, lamports, confirm } = {}) {
            requireLive(confirm);
            const required = wholeLamports(lamports, 'lamports');
            const { content } = await indexedAgreement(agreementCid);
            if (cidOfObject(content) !== agreementCid) throw new Error(`indexed agreement ${agreementCid} does not match its content hash; refusing to mint`);
            if (!['owners', 'investors'].includes(content.rule?.electorate) || content.rule?.binding !== true) {
                throw new Error(`agreement ${agreementCid} is a non-binding ${content.rule?.electorate ?? 'unknown'} vote: it is a poll in the index and is never minted`);
            }
            if (content.rule?.electorate === 'investors' && required !== '0') {
                throw new Error('A crowdfunding agreement has no native execution escrow: mint it with lamports "0". Investor USDC stays in the donation escrow.');
            }
            const { keypair, connection } = signer();
            const self = keypair.publicKey.toBase58();
            if (content.sponsor !== self) {
                throw new Error(`agreement ${agreementCid} names sponsor ${content.sponsor ?? 'none'}, not this agent's wallet ${self}: only its sponsor can create its account`);
            }
            // The lens set and threshold are frozen at mint; any key may be a member, this agent's own included
            // (the people who enter the agreement judge its lens). Crowdfunding also commits its devnet USDC
            // target, which the program confirms itself (confirm_funding).
            const lensIssue = agreementRecord.lensRuleError(content.rule);
            if (lensIssue) throw new Error(`agreement ${agreementCid}: ${lensIssue}`);
            // Content before the mint (docs/blockchain-flows.md Flow 2): our server pins it, or, when it
            // cannot and UGT_PINATA_JWT is set, this agent pins it with that own key. A provider confirms
            // each CID, or nothing is signed.
            try {
                await index().pinForMint(agreementCid);
            } catch (error) {
                if (!env.UGT_PINATA_JWT) throw error;
                const objects = await mintContentObjects(agreementCid, content);
                await impl.pinWithPinata({ objects, jwt: env.UGT_PINATA_JWT, fetchImpl });
            }
            // Every input parcel anchored before the account exists (docs/blockchain-flows.md Flow 3), as the
            // agreement panel's Mint does; anchored ones cost nothing, an id that cannot seed one is reported.
            const anchors = await anchorTargetsSigned((content.inputs?.parcels || []).map(parcel => parcel.parcelId));
            const minted = await impl.mintAgreement({
                connection, sponsorKeypair: keypair, cid: agreementCid, ...mintTermsOf(content), deadline: content.deadline ?? null,
                lamports: required, openGround: Number(content.inputs?.openGroundM2) > 0,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
            const recorded = await index().recordOnchain(agreementCid, {
                chain: 'solana', cluster: AGREEMENT_CLUSTER, account: minted.account, signature: minted.createSignature
            });
            return { ...minted, onchain: recorded.onchain ?? null, inputAnchors: { parcels: anchors.parcels, skipped: anchors.skipped } };
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
        async betOnAgreement({ agreementCid, marketAddress, side, amountUsdc, confirm } = {}) {
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
            const result = await impl.buyAgreementShares({
                connection, ownerKeypair: keypair, subject: state.address, marketAddress: selectedMarket(marketAddress),
                stakeMint: USDC_DEVNET, side: SIDE[normalizedSide], amountAtomic,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
            return { agreementCid, agreementAccount: state.address, side: normalizedSide, amountUsdc, ...result };
        },
        buyAgreementSharesOnAgreement(args = {}) { return this.betOnAgreement(args); },

        async sellAgreementSharesOnAgreement({ agreementCid, marketAddress, side, shares, confirm } = {}) {
            requireLive(confirm);
            const normalizedSide = String(side || '').toLowerCase();
            if (!(normalizedSide in SIDE)) throw new Error('side must be yes or no');
            const sharesAtomic = usdcToAtomic(shares);
            if (sharesAtomic <= 0n) throw new Error('shares must be positive');
            const { content } = await indexedAgreement(agreementCid);
            const sponsor = walletOf(content?.sponsor);
            if (!sponsor) throw new Error(`agreement ${agreementCid} names no sponsor wallet, so it has no chain account to trade`);
            const { keypair, connection } = signer();
            const state = await impl.readAgreementAccount(connection, { cid: agreementCid, sponsor });
            if (!state) throw new Error('The agreement must be minted to sell shares.');
            const result = await impl.sellAgreementShares({ connection, ownerKeypair: keypair, subject: state.address, marketAddress: selectedMarket(marketAddress),
                stakeMint: USDC_DEVNET, side: SIDE[normalizedSide], sharesAtomic, sendAndConfirm: impl.sendAndConfirmPolling });
            return { agreementCid, agreementAccount: state.address, side: normalizedSide, shares, ...result };
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
            // Ordinary agreement donations remain chain-only. When the subject decodes as a
            // published crowdfunding agreement, however, bind the spend to its immutable terms
            // before creating the USDC escrow position.
            const account = await impl.readAgreementAccount(connection, { account: agreementAccount });
            if (!account) throw new Error('The agreement must be minted before it can receive a contribution.');
            const indexed = await index().getAgreement(account.cid);
            if (indexed) {
                const { content } = verifiedRow(indexed, account.cid, 'agreement');
                if (content.rule?.electorate === 'investors') {
                    const expectedDeadline = Math.floor(Date.parse(content.deadline) / 1000);
                    if (account.status !== AGREEMENT_STATUS.active || account.deadline < Math.floor(Date.now() / 1000)) {
                        throw new Error(`Crowdfunding agreement ${account.cid} is closed or past its deadline.`);
                    }
                    if (agreementAccount !== agreementAccountOf(account.cid, content.sponsor) || account.authority !== content.sponsor
                        || account.payout !== content.sponsor || account.deadline !== expectedDeadline
                        || !sameMintTerms(account, mintTermsOf(content))
                        || account.openGround !== false || account.requiredLamports !== 0n) {
                        throw new Error(`Crowdfunding agreement ${account.cid} account terms differ from its published terms.`);
                    }
                }
            }
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

        // Record that a crowdfunding target is met (confirm_funding). Permissionless: this wallet pays the fee.
        async confirmFunding({ agreementAccount, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.confirmFunding({
                connection, payerKeypair: keypair, subject: agreementAccount,
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

        async resolve({ agreementAccount, marketAddress, evidence = [], confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.resolveAgreementMarket({
                connection, resolverKeypair: keypair, subject: agreementAccount, marketAddress: selectedMarket(marketAddress), evidence,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        async claim({ agreementAccount, marketAddress, side, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.claimAgreementMarket({
                connection, claimerKeypair: keypair, subject: agreementAccount, marketAddress: selectedMarket(marketAddress), side,
                sendAndConfirm: impl.sendAndConfirmPolling
            });
        },

        // ---- an agreement's chain steps a person takes in the agreement panel ----------------------
        // Execute (permissionless): the satisfied, funded agreement pays its escrow to its payout.
        async executeAgreement({ agreementCid, confirm } = {}) {
            requireLive(confirm);
            const { account } = await chainAgreement(agreementCid);
            const { keypair, connection } = signer();
            return { agreementCid, account, ...await impl.executeAgreement({ connection, payerKeypair: keypair, account, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // Expire (permissionless) after the deadline: the escrow returns to the sponsor.
        async expireAgreement({ agreementCid, confirm } = {}) {
            requireLive(confirm);
            const { account } = await chainAgreement(agreementCid);
            const { keypair, connection } = signer();
            return { agreementCid, account, ...await impl.expireAgreement({ connection, signerKeypair: keypair, account, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // Cancel, as the sponsor, before the lens's decision is recorded.
        async cancelAgreement({ agreementCid, confirm } = {}) {
            requireLive(confirm);
            const { sponsor } = await chainAgreement(agreementCid);
            const { keypair, connection } = signer();
            if (keypair.publicKey.toBase58() !== sponsor) throw new Error(`only agreement ${agreementCid}'s sponsor ${sponsor} can cancel it, not this agent's wallet ${keypair.publicKey.toBase58()}`);
            return { agreementCid, ...await impl.cancelAgreement({ connection, sponsorKeypair: keypair, cid: agreementCid, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // The agent's key is one of the agreement's lens members: state its decision, as "Confirm as lens
        // member" does in the agreement panel. Owner agreements count the relayed signed decisions first.
        async confirmAsLensMember({ agreementCid, confirm } = {}) {
            requireLive(confirm);
            const { agreement } = await chainAgreement(agreementCid);
            const receipts = agreement.content.rule?.electorate === 'investors' ? null
                : (await companion.request(`/agreements/${agreementCid}/decisions`)).decisions;
            const { keypair, connection } = signer();
            return { agreementCid, ...await impl.confirmAsLensMember({ connection, memberKeypair: keypair, agreement, receipts, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // Record (permissionless) a lens member's AgreementDecision-v1 attestation already on Solana.
        async recordLensDecision({ agreementCid, attestation, confirm } = {}) {
            requireLive(confirm);
            const { account } = await chainAgreement(agreementCid);
            const { keypair, connection } = signer();
            return { agreementCid, account, ...await impl.recordAgreementDecision({ connection, payerKeypair: keypair, account, attestation, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // Take back this wallet's contributions to a cancelled or expired agreement (apartment deposits included).
        async refundContributions({ agreementCid, confirm } = {}) {
            requireLive(confirm);
            const { agreement } = await chainAgreement(agreementCid);
            const { keypair, connection } = signer();
            return { agreementCid, ...await impl.refundContributions({ connection, donorKeypair: keypair, agreement, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // ---- an apartment round's listing and reservation (the funding section's) -------------------------
        // As the round's developer (its sponsor): list every unit not yet listed; the first listing opens
        // the round's USDC escrow. Everything listed already is a replay.
        async listApartments({ agreementCid, confirm } = {}) {
            requireLive(confirm);
            const { agreement, sponsor, account, keypair, connection, accepting } = await apartmentRound(agreementCid);
            const developer = keypair.publicKey.toBase58();
            if (developer !== sponsor) throw Object.assign(new Error(`only the round's developer ${sponsor} lists its apartments, not this agent's wallet ${developer}`), { code: 'developer-required' });
            if (!accepting) {
                const rows = await impl.readRoundInventory(connection, { account, content: agreement.content });
                if (rows.some(row => row.status === 'unlisted')) throw roundClosed(agreementCid);
            }
            return { agreementCid, account, ...await impl.listApartments({ connection, developerKeypair: keypair, account, content: agreement.content, sendAndConfirm: impl.sendAndConfirmPolling }) };
        },

        // As a buyer: read this wallet's qualification for the unit from the round's lens members, then
        // pay the unit's deposit and reserve it in one transaction. A unit this wallet holds is a replay.
        async reserveApartment({ agreementCid, unitId, confirm } = {}) {
            requireLive(confirm);
            const { agreement, sponsor, account, value, keypair, connection, accepting } = await apartmentRound(agreementCid);
            const { content } = agreement;
            const buyer = keypair.publicKey.toBase58();
            const offer = (await impl.readRoundInventory(connection, { account, content })).find(row => row.unitId === unitId);
            if (!offer) throw Object.assign(new Error(`unit ${unitId} is not offered by agreement ${agreementCid}`), { code: 'unknown-unit' });
            const reserve = qualification => impl.reserveApartment({ connection, buyerKeypair: keypair, account, content, unitId, qualification, sendAndConfirm: impl.sendAndConfirmPolling });
            if (offer.status === 'reserved' && offer.buyer === buyer) return { agreementCid, account, unitId, ...await reserve(null) };
            if (!accepting) throw roundClosed(agreementCid);
            if (offer.status !== 'available') throw Object.assign(new Error(`unit ${unitId} is ${offer.status}, not available`), { code: 'unit-unavailable' });
            if (BigInt(offer.deposit) > usdcToAtomic(maxUsdcPerAction)) {
                throw new Error(`unit ${unitId}'s deposit (${agreementRecord.formatUsdc(BigInt(offer.deposit))} USDC) exceeds UGT_MCP_MAX_USDC_PER_ACTION (${maxUsdcPerAction} USDC)`);
            }
            const members = await impl.fetchLensMembers({ apiBase, fetchImpl });
            const qualification = await impl.apartmentQualification({ cid: agreementCid, sponsor, lenses: value.lenses, members, offer, buyer, fetchImpl });
            return { agreementCid, account, unitId, qualification: qualification.address, ...await reserve(qualification) };
        },

        // Anchor parcels on parcel_nft as the parcel panel's "Anchor on chain" does: the same anchor id
        // (ParcelAnchor.anchorIdOf), the parcel's page on UGT_APP_ORIGIN as its URI, several anchors per
        // transaction, existing ones skipped. An id that cannot seed an anchor is reported in `skipped`.
        async anchorParcels({ city, parcelSourceId, parcelIds, confirm } = {}) {
            requireLive(confirm);
            const { features } = await companion.parcels({ city, parcelSourceId, parcelIds });
            const anchorIds = features.map(feature => {
                const anchorId = parcelAnchor.anchorIdOf(feature);
                if (!anchorId) throw new Error(`parcel ${feature.id ?? '(no id)'} has no anchor id`);
                return anchorId;
            });
            return anchorTargetsSigned(anchorIds);
        },

        // ---- a published property offer's chain steps (the offer panel's) -------------------------------
        async mintPropertyOffer({ cid, confirm } = {}) { requireLive(confirm); return offerStep('createOfferOnChain', cid); },
        async acceptPropertyOffer({ cid, candidate, confirm } = {}) { requireLive(confirm); return offerStep('acceptOffer', cid, { candidate }); },
        async fundPropertyOffer({ cid, confirm } = {}) { requireLive(confirm); return offerStep('fundOffer', cid); },
        async releasePropertyOffer({ cid, confirm } = {}) { requireLive(confirm); return offerStep('releaseOffer', cid); },
        async cancelPropertyOffer({ cid, confirm } = {}) { requireLive(confirm); return offerStep('cancelOffer', cid); },
        async expirePropertyOffer({ cid, confirm } = {}) { requireLive(confirm); return offerStep('expireOffer', cid); },

        // The market's opener takes back what its resolved market's payouts leave of the LMSR seed
        // (reclaim_seed), as the bet dialog's "Take back my stake" does for a wallet.
        async reclaimSeed({ agreementAccount, marketAddress, confirm } = {}) {
            requireLive(confirm);
            const { keypair, connection } = signer();
            return impl.reclaimAgreementMarketSeed({
                connection, creatorKeypair: keypair, subject: agreementAccount, marketAddress: selectedMarket(marketAddress),
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
    const namedPlanTools = createMcpNamedPlanTools({ read: companion, drafts, appOrigin, resolveDraftReference,
        publishDesign: args => actions.publishDesign(args) });
    agreements.setPlanResolver(namedPlanTools.resolvePlan);
    Object.assign(actions, namedPlanTools);
    Object.assign(actions, createMcpAssetTools({ read: companion, drafts, plans: actions, appOrigin, apiBase, fetchImpl, resolveDraftReference }));
    // Every authored design is placed in the agent's working plan, its applied map (docs/agent-working-plan.md).
    // The result keeps the design's own fields and adds the plan revision, the placement and its consequences.
    const placing = (method, beforeOf = () => null) => {
        const author = actions[method];
        return async ({ plan, displace = false, replaceDesignCid = null, ...args }) => {
            if (replaceDesignCid != null) {
                if (!plan) throw Object.assign(new Error('Replacing a design needs its current working plan.'), {
                    code: 'replace-plan-required', next: { tool: 'ugt_inspect_plan', action: 'Inspect the current plan and use its draftRef.' }
                });
                const current = await namedPlanTools.resolvePlan(plan);
                if (!current.designs.some(row => row.cid === replaceDesignCid)) throw Object.assign(new Error('The replacement target is not a member of this working-plan revision.'), {
                    code: 'replace-design-not-found', next: { tool: 'ugt_inspect_plan', action: 'Inspect the current plan and retry with an exact current design CID.' }
                });
            }
            const drafted = await author({ ...args, plan });
            const rows = drafted.designs || [drafted];
            const placed = await namedPlanTools.placeDesigns({ plan, displace, replaceDesignCid,
                designs: rows.map(row => ({ cid: row.cid, content: row.design, parcelSourceId: row.parcelSourceId,
                    before: replaceDesignCid || beforeOf(row, args) })) });
            // Joining the plan's roads can revise the placed design itself; its preview follows the placed revision.
            const final = placed.placement.status === 'placed'
                ? await Promise.all(rows.map((row, index) => placed.designs[index].cid === row.cid ? row
                    : drafts.designResult(placed.designs[index].content, row.parcelSourceId)))
                : rows;
            // Junctions are the plan's now: neighbours revised by this placement are in consequences.junctions.
            const own = ({ changes, revisedCorridors, ...row }) => row;
            const { designs, ...rest } = own(drafted);
            return { ...(designs ? { ...rest, designs: final.map(own) } : own(final[0])),
                plan: placed.plan, placement: placed.placement, consequences: placed.consequences };
        };
    };
    for (const method of ['draftRoad', 'draftTrack', 'draftStation', 'draftBuilding', 'draftSpace', 'draftParcelLayout', 'draftUrbanRule', 'importDesign']) actions[method] = placing(method);
    actions.editDesign = placing('editDesign', (_row, args) => args.expectedCid);
    actions.modifyDesign = placing('modifyDesign', row => row.design.origin?.cid || null);
    Object.assign(actions, createMcpValidationTools({ read: companion, drafts, plans: actions }));
    // Crowdfunding progress under ugt_compare's backing, read from the chain (funding-progress.js).
    const readFunding = agreements => require('../../frontend/js/solana/funding-progress.js').readProgress(agreements, {
        connectionFor: async () => chain(), web3: require('@solana/web3.js'), agreementClient, record: agreementRecord,
        pledgeClient: require('../../frontend/js/solana/pledge-client.js').configure({ web3: require('@solana/web3.js') }) });
    actions.compare = createMcpComparison({ read: companion, resolveDesign: drafts.resolveDesign, plans: actions, appOrigin, resolveDraftReference, readFunding });
    return actions;
}
