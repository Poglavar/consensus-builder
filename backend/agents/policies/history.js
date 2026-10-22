// A society persona's own history, as the policies read it: which agreements it already bet NO or YES
// on, which market positions it already claimed, and the status of each of its pledges, all keyed by
// agreement CID. Pure. Sources, in increasing authority: its checkpointed turns (consensus.agent_run
// summary.society), the chain (positions and pledge commitments actually held), then this invocation's
// dry-run turns, which wrote nothing anywhere else.

export function emptyHistory() {
    return { againstCids: [], forCids: [], claimedPositions: [], pledges: {} };
}

/** `<agreementCid>:<side>`, the key of one claimed market position in `claimedPositions`. */
export function positionKey(agreementCid, side) {
    return `${agreementCid}:${side}`;
}

/** Fold acted society actions ({ type, side, agreementCid }) into a history. */
export function applyActs(history, acts = []) {
    const against = new Set(history.againstCids);
    const backed = new Set(history.forCids || []);
    const claimed = new Set(history.claimedPositions || []);
    const pledges = { ...history.pledges };
    for (const act of acts) {
        if (!act?.agreementCid) continue;
        const cid = String(act.agreementCid);
        if (act.type === 'stake' && act.side === 'no') against.add(cid);
        if (act.type === 'stake' && act.side === 'yes') backed.add(cid);
        if (act.type === 'claim' && act.side) claimed.add(positionKey(cid, act.side));
        if (act.type === 'pledge') pledges[cid] = { status: 'active' };
        if (act.type === 'revokePledge') pledges[cid] = { status: 'revoked' };
    }
    return { againstCids: Array.from(against), forCids: Array.from(backed), claimedPositions: Array.from(claimed), pledges };
}

/** Acted actions recorded in this persona's run rows, oldest first. */
export function actsFromRuns(runs = []) {
    return [...(runs || [])]
        .filter(run => run?.summary?.society?.acted && run.summary.society.action)
        .sort((a, b) => String(a.started_at || a.run_id).localeCompare(String(b.started_at || b.run_id)))
        .map(run => run.summary.society.action);
}

/**
 * @param {{ runs?: object[], chain?: { noPositionCids?: string[], yesPositionCids?: string[],
 *           pledges?: Object<string,{status}> }, simulated?: object[] }} sources
 */
export function societyHistory({ runs = [], chain = {}, simulated = [] } = {}) {
    let history = applyActs(emptyHistory(), actsFromRuns(runs));
    history = {
        againstCids: Array.from(new Set([...history.againstCids, ...(chain.noPositionCids || []).map(String)])),
        forCids: Array.from(new Set([...history.forCids, ...(chain.yesPositionCids || []).map(String)])),
        claimedPositions: history.claimedPositions,
        pledges: { ...history.pledges, ...(chain.pledges || {}) }
    };
    return applyActs(history, simulated);
}
