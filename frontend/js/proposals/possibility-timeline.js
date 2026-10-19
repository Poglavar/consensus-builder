// Pure evidence-to-timeline policy for proposal Details. It merges the shared activity envelope and
// oracle event without caring whether an actor is human, algorithmic or LLM-controlled.
(function attachProposalPossibilityTimeline(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalPossibilityTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalPossibilityTimelineFactory() {
    'use strict';

    const ACTIONS = {
        proposed: new Set(['create', 'publish']),
        backed: new Set(['donate', 'pledge', 'fulfillPledge', 'releaseDonations']),
        forecast: new Set(['createMarket', 'stake']),
        realized: new Set(['resolve', 'claim'])
    };

    function eventTime(event) {
        return Date.parse(event?.occurredAt || event?.recordedAt || event?.observedAt || '') || 0;
    }

    function matchesProposal(event, ids) {
        const id = event?.entity?.id || event?.action?.proposalId || event?.subject?.id;
        return Boolean(id && ids.has(String(id)));
    }

    function firstAction(events, ids, accepted) {
        return [...(events || [])].filter(event => matchesProposal(event, ids)
            && accepted.has(event?.action?.type))
            .sort((left, right) => eventTime(left) - eventTime(right))[0] || null;
    }

    function actorLabel(event) {
        return event?.actor?.name || event?.actor?.id || null;
    }

    function activityEvidence(event) {
        if (!event) return null;
        return {
            actor: actorLabel(event),
            action: event.action?.type || null,
            amount: event.action?.amount || null,
            side: event.action?.side || null,
            occurredAt: event.occurredAt || event.recordedAt || null,
            transaction: event.transaction || null
        };
    }

    function oracleEvidence(event) {
        if (!event) return null;
        return {
            actor: event.attester?.address || null,
            action: event.outcome === 'executed' ? 'resolved YES' : event.outcome === 'cancelled' ? 'resolved NO' : event.outcome || 'attested',
            occurredAt: event.observedAt || event.recordedAt || null,
            transaction: event.source?.transaction || null,
            sourceUrl: event.source?.transactionUrl || event.source?.url || null,
            sourceHash: event.source?.hash || null
        };
    }

    function stage(id, title, description, evidence, status) {
        return { id, title, description, evidence, status };
    }

    function build({ proposalId, proposalAccount, createdAt = null, events = [], oracleEvents = [] } = {}) {
        const ids = new Set([proposalId, proposalAccount].filter(Boolean).map(String));
        const proposed = firstAction(events, ids, ACTIONS.proposed);
        const backed = firstAction(events, ids, ACTIONS.backed);
        const forecast = firstAction(events, ids, ACTIONS.forecast);
        const activityResolution = firstAction(events, ids, ACTIONS.realized);
        const oracle = [...(oracleEvents || [])].filter(event => event?.eventType === 'proposal_lifecycle'
            && matchesProposal(event, ids)).sort((left, right) => eventTime(left) - eventTime(right))[0] || null;
        const proposalEvidence = activityEvidence(proposed) || {
            actor: null, action: 'proposal recorded', occurredAt: createdAt, transaction: null
        };
        const resultEvidence = oracleEvidence(oracle) || activityEvidence(activityResolution);
        const stages = [
            stage('proposed', 'Proposed', 'A possible change was attached to exact land.', proposalEvidence, 'complete'),
            stage('backed', 'Backed', 'A donation or public commitment supports it.', activityEvidence(backed), backed ? 'complete' : 'current'),
            stage('forecast', 'Forecast', 'YES and NO express whether it will execute.', activityEvidence(forecast), forecast ? 'complete' : backed ? 'current' : 'pending'),
            stage('realized', 'Resolved', 'The declared public evidence rule decides what happened.', resultEvidence, resultEvidence ? 'complete' : forecast && backed ? 'current' : 'pending')
        ];
        return {
            complete: stages.every(item => item.status === 'complete'),
            current: stages.find(item => item.status === 'current')?.id || (resultEvidence ? null : 'realized'),
            stages
        };
    }

    return { build, matchesProposal };
});
