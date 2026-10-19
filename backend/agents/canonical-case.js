// Configuration for the manual canonical hackathon cases: one real parcel set per terminal outcome.
// The cancelled case proves refund/void/NO; the executed case proves accept/release/fulfil/YES; the
// attested case (v3, lens-model.md) is the same YES path through a lens member's ownership attestations.
const DEFAULT_CASE_ID = 'hackathon-golden-borovje-2026';
const DEFAULT_PARCELS = ['HR-335550-1813/2', 'HR-335550-1813/3', 'HR-335550-1813/4'];
const DEFAULT_EXECUTED_CASE_ID = 'hackathon-executed-borovje-2026';
const DEFAULT_EXECUTED_PARCELS = ['HR-335550-1813/6', 'HR-335550-1813/8'];
const DEFAULT_ATTESTED_CASE_ID = 'hackathon-attested-borovje-2026';
// Same two real parcels as the executed case: their devnet-recorded owner rows
// (consensus.lens_devnet_owner) are what the notary attests.
const DEFAULT_ATTESTED_PARCELS = DEFAULT_EXECUTED_PARCELS;
const OUTCOMES = ['cancelled', 'executed', 'attested'];

const CASE_DEFAULTS = {
    cancelled: {
        id: DEFAULT_CASE_ID,
        parcels: DEFAULT_PARCELS,
        name: 'Borovje three-parcel civic courtyard',
        rationale: 'A compact real-parcel set demonstrates how proposal support and forecasts can coordinate in parallel before any outcome is known.'
    },
    executed: {
        id: DEFAULT_EXECUTED_CASE_ID,
        parcels: DEFAULT_EXECUTED_PARCELS,
        name: 'Borovje two-parcel civic infill',
        rationale: 'A second compact real-parcel set proves the other terminal path: the wallet holding the devnet ownership certificate of every listed parcel accepts, the proposal executes on-chain, and the market pays the YES side from that public state.'
    },
    attested: {
        id: DEFAULT_ATTESTED_CASE_ID,
        parcels: DEFAULT_ATTESTED_PARCELS,
        name: 'Borovje two-parcel attested consent',
        rationale: 'The proposal names a notary as its lens. The notary attests each recorded owner wallet, every owner signs its own acceptance, the last signature executes the proposal on-chain, and the market pays YES from that state.'
    }
};

// Terminal action names, in execution order, for the dry-run plan and the docs.
const TERMINAL_ACTIONS = {
    cancelled: ['cancel', 'resolve', 'refund_donation', 'void_pledge', 'claim_no'],
    executed: ['certify_parcels', 'accept_parcels', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes'],
    attested: ['anchor_parcels', 'attest_ownership', 'accept_with_attestations', 'verify_executed', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes']
};

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function canonicalCaseConfig({ proposalId, parcels, outcome = 'cancelled', name, rationale } = {}) {
    const terminalOutcome = clean(outcome).toLowerCase() || 'cancelled';
    if (!OUTCOMES.includes(terminalOutcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`);
    const defaults = CASE_DEFAULTS[terminalOutcome];
    const source = parcels === undefined || parcels === null ? defaults.parcels : parcels;
    const parcelIds = Array.from(new Set((Array.isArray(source) ? source : String(source).split(','))
        .map(clean).filter(Boolean)));
    if (parcelIds.length < 2) throw new Error('the canonical case must use at least two cadastral parcels');
    if (parcelIds.length > 8) throw new Error('the canonical case is capped at eight cadastral parcels');
    const id = proposalId === undefined || proposalId === null ? defaults.id : clean(proposalId);
    if (!id) throw new Error('proposalId is required');
    return {
        proposalId: id,
        parcelIds,
        outcome: terminalOutcome,
        name: clean(name) || defaults.name,
        rationale: clean(rationale) || defaults.rationale,
        amounts: { donationUsdc: '0.05', pledgeUsdc: '0.10', yesUsdc: '0.01', noUsdc: '0.01' }
    };
}

export function canonicalTerminalActions(outcome = 'cancelled') {
    const key = clean(outcome).toLowerCase() || 'cancelled';
    if (!TERMINAL_ACTIONS[key]) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`);
    return [...TERMINAL_ACTIONS[key]];
}

export function canonicalProposalBody({ config, runId, proposer, mint, apiBase } = {}) {
    if (!config?.proposalId || !config?.parcelIds?.length) throw new Error('canonical case config is required');
    if (!mint?.proposalPda || !(mint.signature || mint.transactionHash)) throw new Error('mint evidence is required');
    const transactionHash = mint.transactionHash || mint.signature;
    const chainId = mint.chainId || 'solana-devnet';
    const contractAddress = mint.contractAddress || '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
    const name = config.name || CASE_DEFAULTS.cancelled.name;
    const rationale = config.rationale || CASE_DEFAULTS.cancelled.rationale;
    return {
        proposalId: config.proposalId,
        city: 'zagreb',
        type: 'parcel',
        goal: 'parcel',
        name,
        title: name,
        description: rationale,
        cadastreParcelIds: config.parcelIds,
        isConditional: true,
        disbursementMode: 'conditional',
        facets: { landUse: 'civic', parcels: 'as-is', ownership: 'to-city' },
        agent: {
            persona: proposer.name,
            controller: 'algorithm',
            rationale,
            run_id: runId
        },
        onchain: { transactionHash, proposalId: mint.proposalPda, chainId, contractAddress },
        nft: { chain: chainId, contract: contractAddress, tokenId: mint.proposalPda },
        isMinted: true,
        tokenId: mint.proposalPda,
        sourceUrl: `${String(apiBase).replace(/\/$/, '')}/hackathon/cases/${encodeURIComponent(config.proposalId)}`
    };
}

// ---- canonical case v3 (outcome "attested", lens-model.md) --------------------------------------

export const LENS_V2_FLAG = 'LENS_V2_DEPLOYED';

/**
 * The live v3 case needs proposal_nft/parcel_nft lens model v2 on devnet. Until an operator states
 * it is deployed (LENS_V2_DEPLOYED=1), a live run is refused before anything is read or signed.
 */
export function assertAttestedLiveAllowed(env = {}) {
    if (String(env[LENS_V2_FLAG] ?? '').trim() === '1') return;
    throw new Error(
        '--outcome attested --live is refused: lens model v2 (accept_with_attestations, settle_with_verdict, ownerless ' +
        'mint_parcel) is built and tested on localnet but NOT deployed to devnet (blockchain/solana/README.md ' +
        `"Lens model v2 — NOT deployed"). Deploy proposal_nft and parcel_nft v2, register the notary schemas, then rerun with ${LENS_V2_FLAG}=1. ` +
        'Use --dry-run to print the full plan.'
    );
}

/** Checkpoint key of one (parcel, owner) attestation or acceptance. */
export function ownerKey(parcelUid, owner) {
    return `${parcelUid}|${owner}`;
}

/**
 * Every step of canonical case v3, in execution order, each marked `done` from the run checkpoint
 * (`caseState`, the summary.canonicalCase the runner writes). Pure: the dry run prints it, the live
 * runner executes the steps that are not done, and a resumed run skips exactly what the checkpoint
 * holds. One ParcelOwnership-v1 attestation and one accept_with_attestations signature per recorded
 * owner; the last signature executes the proposal, then the market resolves YES.
 *
 * @param {{ config: object, notaryKey: string|null, owners: Record<string, { wallets: string[], ownerCount: number, source: string }>, caseState?: object }} options
 */
export function attestedCaseSteps({ config, notaryKey, owners, caseState = {} } = {}) {
    if (config?.outcome !== 'attested') throw new Error('attestedCaseSteps needs an attested canonical case config');
    const lens = notaryKey ? [notaryKey] : [];
    const state = caseState || {};
    const steps = [
        { action: 'mint', lens, parcels: config.parcelIds, note: 'lens = [notary-01]; the proposer is not in its own lens', done: Boolean(state.mint?.proposalPda) },
        { action: 'x402_publish', done: Boolean(state.publish?.proposalId) },
        { action: 'donate', amountUsdc: config.amounts.donationUsdc, done: Boolean(state.donation) },
        { action: 'pledge', amountUsdc: config.amounts.pledgeUsdc, done: Boolean(state.pledge) },
        { action: 'forecast_yes', amountUsdc: config.amounts.yesUsdc, done: Boolean(state.yes) },
        { action: 'forecast_no', amountUsdc: config.amounts.noUsdc, done: Boolean(state.no) }
    ];
    for (const parcelUid of config.parcelIds) {
        steps.push({ action: 'anchor_parcel', parcelUid, pda: ['parcel', parcelUid], note: 'existing anchor replays; a missing one is minted ownerless', done: Boolean(state.anchors?.[parcelUid]) });
    }
    const attestations = [];
    const acceptances = [];
    for (const parcelUid of config.parcelIds) {
        const set = owners?.[parcelUid];
        if (!set?.wallets?.length) throw new Error(`no recorded owner wallets for parcel ${parcelUid}`);
        if (!Number.isInteger(set.ownerCount) || set.ownerCount < 1) throw new Error(`parcel ${parcelUid} has no valid ownerCount`);
        if (set.wallets.length !== set.ownerCount) {
            throw new Error(`parcel ${parcelUid} lists ${set.wallets.length} owner wallet(s) but ownerCount ${set.ownerCount}; every attested owner must sign`);
        }
        for (const owner of set.wallets) {
            const id = ownerKey(parcelUid, owner);
            attestations.push({
                action: 'attest_ownership', member: notaryKey, schema: 'ParcelOwnership-v1',
                parcelUid, owner, ownerCount: set.ownerCount, ownersFrom: set.source,
                via: 'POST /lens/challenge → owner signs → POST /lens/ownership (x402)',
                done: Boolean(state.attestations?.[id]?.address)
            });
            acceptances.push({
                action: 'accept_with_attestations', parcelUid, owner, signer: owner, member: notaryKey,
                tallyPda: ['consent', '<proposal>', parcelUid], recordPda: ['acceptance', '<proposal>', parcelUid, owner],
                done: Boolean(state.ownerAcceptances?.[id])
            });
        }
    }
    steps.push(...attestations, ...acceptances,
        { action: 'verify_executed', expect: `status Executed once every parcel's tally reaches its ownerCount (${acceptances.length} signature(s))`, done: Boolean(state.executed) },
        { action: 'resolve', expect: 'YES', done: Boolean(state.resolution) },
        { action: 'release_donations', done: Boolean(state.release) },
        { action: 'fulfill_pledge', done: Boolean(state.fulfilment) },
        { action: 'claim_yes', done: Boolean(state.claim) });
    return steps;
}

/** The v3 plan for the dry run: the lens and every step. Pure. */
export function attestedCasePlan({ config, notaryKey, owners, caseState } = {}) {
    if (config?.outcome !== 'attested') throw new Error('attestedCasePlan needs an attested canonical case config');
    return { lens: notaryKey ? [notaryKey] : [], steps: attestedCaseSteps({ config, notaryKey, owners, caseState }) };
}

export { DEFAULT_ATTESTED_CASE_ID, DEFAULT_ATTESTED_PARCELS, DEFAULT_CASE_ID, DEFAULT_PARCELS, DEFAULT_EXECUTED_CASE_ID, DEFAULT_EXECUTED_PARCELS, OUTCOMES };
