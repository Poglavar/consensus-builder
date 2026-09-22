const DEFAULT_CASE_ID = 'hackathon-golden-borovje-2026';
const DEFAULT_PARCELS = ['HR-335550-1813/2', 'HR-335550-1813/3', 'HR-335550-1813/4'];

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function canonicalCaseConfig({ proposalId = DEFAULT_CASE_ID, parcels = DEFAULT_PARCELS } = {}) {
    const parcelIds = Array.from(new Set((Array.isArray(parcels) ? parcels : String(parcels).split(','))
        .map(clean).filter(Boolean)));
    if (parcelIds.length < 2) throw new Error('the canonical case must use at least two cadastral parcels');
    if (parcelIds.length > 8) throw new Error('the canonical case is capped at eight cadastral parcels');
    const id = clean(proposalId);
    if (!id) throw new Error('proposalId is required');
    return {
        proposalId: id,
        parcelIds,
        amounts: { donationUsdc: '0.05', pledgeUsdc: '0.10', yesUsdc: '0.01', noUsdc: '0.01' }
    };
}

export function canonicalProposalBody({ config, runId, proposer, mint, apiBase } = {}) {
    if (!config?.proposalId || !config?.parcelIds?.length) throw new Error('canonical case config is required');
    if (!mint?.proposalPda || !(mint.signature || mint.transactionHash)) throw new Error('mint evidence is required');
    const transactionHash = mint.transactionHash || mint.signature;
    const chainId = mint.chainId || 'solana-devnet';
    const contractAddress = mint.contractAddress || '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
    const name = 'Borovje three-parcel civic courtyard';
    const rationale = 'A compact real-parcel set demonstrates how proposal support and forecasts can coordinate in parallel before any outcome is known.';
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

export { DEFAULT_CASE_ID, DEFAULT_PARCELS };
