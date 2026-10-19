// Pure presentation model for the one-command judge walkthrough. The CLI supplies public HTTP
// evidence; this module only decides whether it is coherent enough to present.

// The attester directory is served beside the manifest; a manifest that names it wins.
function lensDirectoryUrl(manifest) {
    if (manifest?.publicProof?.lensMembers) return manifest.publicProof.lensMembers;
    try {
        return manifest?.publicProof?.manifest ? new URL('/lenses/members', manifest.publicProof.manifest).toString() : null;
    } catch {
        return null;
    }
}

export function buildJudgeDemo({ audit, manifest, prospective } = {}) {
    const marketState = prospective?.state;
    const marketVisible = ['open', 'checking_evidence', 'awaiting_evidence', 'settled'].includes(marketState);
    const ready = audit?.status === 'verified' && Boolean(manifest?.hackathon?.branch) && marketVisible;
    return {
        status: ready ? 'ready' : 'incomplete',
        title: manifest?.title || 'Hyperstition: Markets for Possible Cities',
        thesis: manifest?.thesis || null,
        proofSummary: audit?.summary || { pass: 0, warn: 0, fail: 1 },
        marketState: marketState || 'unavailable',
        steps: [
            { label: 'Pitch', url: manifest?.surfaces?.pitch || null },
            { label: 'Live demo', url: manifest?.surfaces?.demo || null },
            { label: 'Hackathon proof manifest', url: manifest?.publicProof?.manifest || null },
            { label: 'Canonical multi-parcel case', url: manifest?.publicProof?.canonicalCase || null },
            { label: 'Executed case (market paid YES)', url: manifest?.publicProof?.executedCase || null },
            { label: 'Attested case (lens member attested ownership, owners signed)', url: manifest?.publicProof?.attestedCase || null },
            { label: 'Lens member directory (who may attest)', url: lensDirectoryUrl(manifest) },
            { label: 'Agent capability and x402 terms', url: manifest?.publicProof?.agentCapabilities || null },
            { label: 'Unified human + agent activity', url: manifest?.surfaces?.actors || null },
            { label: `Prospective market · ${marketState || 'unavailable'}`, url: prospective?.marketUrl || null },
            { label: 'Court oracle aggregate', url: manifest?.publicProof?.courtOracle || null }
        ]
    };
}
