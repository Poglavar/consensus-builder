// simulation-agreements.js — owners' agreements inside the local simulation. Every design an agent
// draws is put to the owners of its parcels (the city for parcels no agent owns); simulated owners
// approve or refuse over the following turns, and a design every owner approved is executed on that
// turn's simulated date. A user-controlled owner is never decided for, so such a design waits out its
// deadline. Executing records the date only: nothing is applied or written to the design (the Agent
// city draws executed designs, agent-city.js). The list is saved with the game state and cleared by
// New game. Pure functions plus a module list; backend/test/frontend-simulation-agreements.test.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SimulationAgreements = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const CITY = 'city';
    // Per owner and turn. One owner executes about two designs in three; every extra owner is another hurdle.
    const DEFAULTS = Object.freeze({ approveChance: 0.2, refuseChance: 0.1, deadlineTurns: 10 });

    // Pure: the agreement over a new design. `ownersOf(parcelId)` names the owning agent or null.
    // The proposer approves its own land at once, so a design wholly on it executes on its first turn.
    function open({ proposalId, proposerId, parcelIds, ownersOf, turn, at }) {
        const approvals = {};
        (parcelIds || []).forEach(parcelId => {
            const owner = ownersOf(String(parcelId)) || CITY;
            approvals[owner] = owner === proposerId ? 'approved' : null;
        });
        return { proposalId: String(proposalId), proposerId, parcelIds: (parcelIds || []).map(String), approvals,
            status: 'open', openedTurn: turn, openedAt: at, closedTurn: null, closedAt: null };
    }

    function allApproved(agreement) {
        const decisions = Object.values(agreement.approvals);
        return decisions.length > 0 && decisions.every(decision => decision === 'approved');
    }

    function close(agreement, status, turn, at) {
        return { ...agreement, status, closedTurn: turn, closedAt: at };
    }

    // Pure: one turn of decisions over every open agreement. `rng()` draws in [0, 1);
    // `decides(ownerId)` is false for a user-controlled owner. Returns the new list and what
    // happened, in order: { type: 'approve' | 'refuse' | 'execute' | 'expire' | 'supersede', proposalId, ownerId? }.
    function decideTurn(agreements, { turn, at, rng, decides = () => true, options = {} }) {
        const { approveChance, refuseChance, deadlineTurns } = { ...DEFAULTS, ...options };
        const events = [];
        let list = agreements.map(agreement => {
            if (agreement.status !== 'open') return agreement;
            const approvals = { ...agreement.approvals };
            let refused = false;
            Object.keys(approvals).forEach(ownerId => {
                if (refused || approvals[ownerId] !== null || !decides(ownerId)) return;
                const roll = rng();
                if (roll < refuseChance) {
                    approvals[ownerId] = 'refused';
                    refused = true;
                    events.push({ type: 'refuse', proposalId: agreement.proposalId, ownerId });
                } else if (roll < refuseChance + approveChance) {
                    approvals[ownerId] = 'approved';
                    events.push({ type: 'approve', proposalId: agreement.proposalId, ownerId });
                }
            });
            const next = { ...agreement, approvals };
            if (refused) return close(next, 'refused', turn, at);
            if (allApproved(next)) {
                events.push({ type: 'execute', proposalId: agreement.proposalId });
                return close(next, 'executed', turn, at);
            }
            if (turn - agreement.openedTurn >= deadlineTurns) {
                events.push({ type: 'expire', proposalId: agreement.proposalId });
                return close(next, 'expired', turn, at);
            }
            return next;
        });
        // A design executed this turn takes its parcels: other open agreements over them lapse.
        const taken = new Set(list.filter(item => item.status === 'executed' && item.closedTurn === turn).flatMap(item => item.parcelIds));
        list = list.map(agreement => {
            if (agreement.status !== 'open' || !agreement.parcelIds.some(id => taken.has(id))) return agreement;
            events.push({ type: 'supersede', proposalId: agreement.proposalId });
            return close(agreement, 'superseded', turn, at);
        });
        return { agreements: list, events };
    }

    let list = [];
    return {
        CITY,
        DEFAULTS,
        open,
        decideTurn,
        allApproved,
        list: () => list,
        executed: () => list.filter(agreement => agreement.status === 'executed'),
        replace(next) { list = Array.isArray(next) ? next : []; },
        clear() { list = []; }
    };
});
