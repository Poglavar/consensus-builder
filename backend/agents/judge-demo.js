// Pure presentation model for the one-command judge walkthrough. The CLI supplies public HTTP
// evidence; this module only decides whether it is coherent enough to present.

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
            { label: 'Agent capability and x402 terms', url: manifest?.publicProof?.agentCapabilities || null },
            { label: 'Unified human + agent activity', url: manifest?.surfaces?.actors || null },
            { label: `Prospective market · ${marketState || 'unavailable'}`, url: prospective?.marketUrl || null },
            { label: 'Court oracle aggregate', url: manifest?.publicProof?.courtOracle || null }
        ]
    };
}
