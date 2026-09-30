// Configuration for the manual canonical hackathon cases: one real parcel set per terminal outcome.
// The cancelled case proves refund/void/NO; the executed case proves accept/release/fulfil/YES.
const DEFAULT_CASE_ID = 'hackathon-golden-borovje-2026';
const DEFAULT_PARCELS = ['HR-335550-1813/2', 'HR-335550-1813/3', 'HR-335550-1813/4'];
const DEFAULT_EXECUTED_CASE_ID = 'hackathon-executed-borovje-2026';
const DEFAULT_EXECUTED_PARCELS = ['HR-335550-1813/6', 'HR-335550-1813/8'];
const OUTCOMES = ['cancelled', 'executed'];

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
    }
};

// Terminal action names, in execution order, for the dry-run plan and the docs.
const TERMINAL_ACTIONS = {
    cancelled: ['cancel', 'resolve', 'refund_donation', 'void_pledge', 'claim_no'],
    executed: ['certify_parcels', 'accept_parcels', 'resolve', 'release_donations', 'fulfill_pledge', 'claim_yes']
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

export { DEFAULT_CASE_ID, DEFAULT_PARCELS, DEFAULT_EXECUTED_CASE_ID, DEFAULT_EXECUTED_PARCELS, OUTCOMES };
