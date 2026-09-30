// A society persona's own history, as the policies read it: which proposals it already bet NO on and
// the status of each of its pledges. Pure. Sources, in increasing authority: its checkpointed turns
// (consensus.agent_run summary.society), the chain (positions and pledge commitments actually held),
// then this invocation's dry-run turns, which wrote nothing anywhere else.

export function emptyHistory() {
    return { againstProposalIds: [], pledges: {} };
}

/** Fold acted society actions ({ type, side, proposalId }) into a history. */
export function applyActs(history, acts = []) {
    const against = new Set(history.againstProposalIds);
    const pledges = { ...history.pledges };
    for (const act of acts) {
        if (!act?.proposalId) continue;
        const id = String(act.proposalId);
        if (act.type === 'stake' && act.side === 'no') against.add(id);
        if (act.type === 'pledge') pledges[id] = { status: 'active' };
        if (act.type === 'revokePledge') pledges[id] = { status: 'revoked' };
    }
    return { againstProposalIds: Array.from(against), pledges };
}

/** Acted actions recorded in this persona's run rows, oldest first. */
export function actsFromRuns(runs = []) {
    return [...(runs || [])]
        .filter(run => run?.summary?.society?.acted && run.summary.society.action)
        .sort((a, b) => String(a.started_at || a.run_id).localeCompare(String(b.started_at || b.run_id)))
        .map(run => run.summary.society.action);
}

/**
 * @param {{ runs?: object[], chain?: { noPositionProposalIds?: string[], pledges?: Object<string,{status}> }, simulated?: object[] }} sources
 */
export function societyHistory({ runs = [], chain = {}, simulated = [] } = {}) {
    let history = applyActs(emptyHistory(), actsFromRuns(runs));
    history = {
        againstProposalIds: Array.from(new Set([...history.againstProposalIds, ...(chain.noPositionProposalIds || []).map(String)])),
        pledges: { ...history.pledges, ...(chain.pledges || {}) }
    };
    return applyActs(history, simulated);
}
