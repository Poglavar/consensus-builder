// Deterministic, zero-model-spend policy for a supporter persona. It only considers active,
// minted proposals by somebody else, then uses a stable daily hash to avoid always supporting the
// first API row. The returned rationale is stored beside the signed activity.
import { createHash } from 'node:crypto';

function stableNumber(value) {
    return createHash('sha256').update(String(value)).digest().readUInt32BE(0);
}

function proposalAccount(proposal = {}) {
    return proposal.onchain?.proposalId || proposal.onchainData?.proposalId || null;
}

function normalizedActions(persona = {}) {
    const configured = persona.support?.actions;
    const actions = Array.isArray(configured) && configured.length ? configured : ['pledge'];
    const allowed = actions.map(action => String(action).toLowerCase())
        .filter(action => ['pledge', 'donate', 'stake'].includes(action));
    if (!allowed.length) throw new Error(`${persona.name || 'supporter'} has no valid support actions`);
    return allowed;
}

export function eligibleSupportProposals(proposals, { wallet = null, personaName = null } = {}) {
    return (proposals || []).filter(proposal => {
        if (String(proposal?.lifecycleStatus || '').toLowerCase() !== 'active') return false;
        if (!proposalAccount(proposal)) return false;
        if (wallet && String(proposal.author || '') === String(wallet)) return false;
        if (personaName && String(proposal.agent?.persona || '') === String(personaName)) return false;
        return true;
    });
}

export function selectSupportAction({ day, persona, proposals, wallet = null } = {}) {
    if (!day) throw new Error('day is required');
    if (!persona?.name) throw new Error('persona.name is required');
    const eligible = eligibleSupportProposals(proposals, { wallet, personaName: persona.name });
    if (!eligible.length) {
        return { selected: null, eligibleProposalIds: [], reason: 'No active minted proposal by another actor was available.' };
    }
    const ranked = eligible.map(proposal => ({
        proposal,
        rank: stableNumber(`${day}:${persona.name}:${proposal.proposalId || proposal.id}`)
    })).sort((left, right) => left.rank - right.rank);
    const proposal = ranked[0].proposal;
    const actions = normalizedActions(persona);
    const type = actions[stableNumber(`${day}:${persona.name}:action`) % actions.length];
    const amount = String(persona.support?.amountUsdc || '0.10');
    const selected = {
        type,
        amount,
        side: type === 'stake' ? 'yes' : null,
        proposalId: String(proposal.proposalId || proposal.id),
        proposalAccount: proposalAccount(proposal),
        proposalName: proposal.name || proposal.title || String(proposal.proposalId || proposal.id),
        rationale: `Selected deterministically from ${eligible.length} active minted proposal${eligible.length === 1 ? '' : 's'} by other actors; ${type} records visible support without using an LLM.`
    };
    return {
        selected,
        eligibleProposalIds: eligible.map(item => String(item.proposalId || item.id)),
        reason: selected.rationale
    };
}

export { proposalAccount, stableNumber };
