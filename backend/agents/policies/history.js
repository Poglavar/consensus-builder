// A society persona's own history, as the policies read it: which proposals it already bet NO or YES
// on, which market positions it already claimed, and the status of each of its pledges. Pure.
// Sources, in increasing authority: its checkpointed turns (consensus.agent_run summary.society), the
// chain (positions and pledge commitments actually held), then this invocation's dry-run turns, which
// wrote nothing anywhere else.

export function emptyHistory() {
    return { againstProposalIds: [], forProposalIds: [], claimedPositions: [], pledges: {} };
}

/** `<proposalId>:<side>`, the key of one claimed market position in `claimedPositions`. */
export function positionKey(proposalId, side) {
    return `${proposalId}:${side}`;
}

/** Fold acted society actions ({ type, side, proposalId }) into a history. */
export function applyActs(history, acts = []) {
    const against = new Set(history.againstProposalIds);
    const backed = new Set(history.forProposalIds || []);
    const claimed = new Set(history.claimedPositions || []);
    const pledges = { ...history.pledges };
    for (const act of acts) {
        if (!act?.proposalId) continue;
        const id = String(act.proposalId);
        if (act.type === 'stake' && act.side === 'no') against.add(id);
        if (act.type === 'stake' && act.side === 'yes') backed.add(id);
        if (act.type === 'claim' && act.side) claimed.add(positionKey(id, act.side));
        if (act.type === 'pledge') pledges[id] = { status: 'active' };
        if (act.type === 'revokePledge') pledges[id] = { status: 'revoked' };
    }
    return { againstProposalIds: Array.from(against), forProposalIds: Array.from(backed), claimedPositions: Array.from(claimed), pledges };
}

/** Acted actions recorded in this persona's run rows, oldest first. */
export function actsFromRuns(runs = []) {
    return [...(runs || [])]
        .filter(run => run?.summary?.society?.acted && run.summary.society.action)
        .sort((a, b) => String(a.started_at || a.run_id).localeCompare(String(b.started_at || b.run_id)))
        .map(run => run.summary.society.action);
}

/**
 * @param {{ runs?: object[], chain?: { noPositionProposalIds?: string[], yesPositionProposalIds?: string[],
 *           pledges?: Object<string,{status}> }, simulated?: object[] }} sources
 */
export function societyHistory({ runs = [], chain = {}, simulated = [] } = {}) {
    let history = applyActs(emptyHistory(), actsFromRuns(runs));
    history = {
        againstProposalIds: Array.from(new Set([...history.againstProposalIds, ...(chain.noPositionProposalIds || []).map(String)])),
        forProposalIds: Array.from(new Set([...history.forProposalIds, ...(chain.yesPositionProposalIds || []).map(String)])),
        claimedPositions: history.claimedPositions,
        pledges: { ...history.pledges, ...(chain.pledges || {}) }
    };
    return applyActs(history, simulated);
}
