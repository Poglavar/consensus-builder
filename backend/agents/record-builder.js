// Turns a planned candidate plus the model's pick into the POST body for /agent/proposals. Pure:
// turf is injected and nothing here talks to the network. The shape mirrors what the app itself
// stores for a single freeform building (local proposal 660), so an agent's proposal loads, renders
// and measures in the UI exactly like a human's.
//
// `author` is deliberately ABSENT: the paid route binds it to the wallet the facilitator verified,
// and a body that names a different author is refused before any USDC moves.

/**
 * @param {Object} args
 * @param {Object} args.candidate  one entry from planner.js planCandidates()
 * @param {Object} args.pick       { proposalId, name, rationale } — the id is the orchestrator's
 * @param {Object} args.persona    the persona that proposed it
 * @param {string} args.runId      the run this belongs to, kept on the record for the ledger
 * @param {string} args.city       city code, e.g. 'zagreb'
 * @param {Object} [args.onchain]  { transactionHash, proposalId (the PDA), chainId, contractAddress }
 * @param {Object} args.turf       injected turf, for the bounds
 */
export function buildProposalRecord({ candidate, pick, persona, runId, city, onchain = null, turf }) {
    if (!candidate || !candidate.massing || !candidate.massing.geometry) {
        throw new Error('buildProposalRecord: candidate.massing must be a geometry-bearing feature.');
    }
    if (!pick || !pick.proposalId) {
        throw new Error('buildProposalRecord: pick.proposalId is set by the orchestrator and is required.');
    }
    if (!turf || typeof turf.bbox !== 'function') {
        throw new Error('buildProposalRecord: turf must be injected (bounds come from turf.bbox).');
    }

    const personaName = persona && persona.name ? String(persona.name) : 'agent';
    const massingProps = candidate.massing.properties || {};
    const height = massingProps.height ?? null;
    const floors = massingProps.floors ?? null;
    const blockName = `Parcel ${candidate.parcelId}`;
    const name = pick.name;
    const rationale = pick.rationale;

    const building = {
        type: 'Feature',
        geometry: candidate.massing.geometry,
        properties: {
            type: 'proposedBuildingSingle',
            block: blockName,
            height,
            floors,
            title: name,
            author: personaName,
            rotation: 0
        }
    };

    const record = {
        proposalId: pick.proposalId,
        city,
        type: 'building',
        goal: 'single',
        typologyType: 'single',
        primaryType: 'Urban Rule',
        name,
        title: name,
        description: rationale,
        agent: {
            persona: personaName,
            rationale,
            run_id: runId
        },
        cadastreParcelIds: [candidate.parcelId],
        offer: candidate.offerEur,
        offerCurrency: 'EUR', // the offer is derived from the € gain at priceEurPerM2; market stakes are the USDC side,
        isConditional: true,
        disbursementMode: 'conditional',
        facets: { landUse: 'single', parcels: 'as-is', ownership: 'to-me' },
        buildingProposal: {
            blockName,
            typologyType: 'single',
            parameters: {
                height,
                floors,
                rotation: 0,
                typology: 'single',
                // The rule the envelope was derived from, so the massing can be re-derived from the
                // record rather than only re-read off it.
                rule: candidate.normalizedRule ?? null
            }
        },
        geometry: { buildings: [building] },
        bounds: turf.bbox(candidate.massing)
    };

    // Minted: the fields frontend/js/proposals/chain.js reads. isProposalMinted() is satisfied by
    // isMinted alone, but getProposalNftInfo() needs contract + tokenId to build the explorer link,
    // and it reads `nft` first and `onchain` second — so both are written, from one source.
    if (onchain) {
        if (!onchain.proposalId || !onchain.transactionHash) {
            throw new Error('buildProposalRecord: onchain needs proposalId (the PDA) and transactionHash — a minted record without them would point nowhere');
        }
        record.onchain = {
            transactionHash: onchain.transactionHash ?? null,
            proposalId: onchain.proposalId ?? null,
            chainId: onchain.chainId ?? null,
            contractAddress: onchain.contractAddress ?? null
        };
        record.nft = {
            chain: onchain.chainId ?? null,
            contract: onchain.contractAddress ?? null,
            tokenId: onchain.proposalId ?? null
        };
        record.isMinted = true;
        record.tokenId = onchain.proposalId ?? null;
    }

    return record;
}
