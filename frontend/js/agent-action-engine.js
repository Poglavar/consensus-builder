// One action contract for simulated agents, LLM-controlled agents, and humans. Decision providers
// choose an action; handlers execute it; every outcome becomes the same structured activity event.
(function attachAgentActionEngine(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentActionEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function agentActionEngineFactory() {
    'use strict';

    let sequence = 0;

    function controllerFor(actor) {
        if (actor?.controller) return String(actor.controller);
        if (actor?.userControlled) return 'human';
        if (actor?.aiControlled) return 'algorithm';
        return 'human';
    }

    function normalizeActor(actor = {}) {
        const id = actor.id ?? actor.wallet ?? actor.name;
        if (!id) throw new Error('actor id, wallet, or name is required');
        const controller = controllerFor(actor);
        return {
            id: String(id),
            name: String(actor.name || actor.persona || id),
            kind: controller === 'human' ? 'human' : 'agent',
            controller,
            wallet: actor.wallet || actor.walletAddress || actor.walletAddresses?.[0] || null,
            avatarIndex: Number.isInteger(actor.avatarIndex) ? actor.avatarIndex : null
        };
    }

    function normalizeAction(action = {}) {
        if (!action || typeof action !== 'object') throw new Error('action must be an object');
        const type = String(action.type || '').trim();
        if (!type) throw new Error('action.type is required');
        return { ...action, type };
    }

    function entityFromAction(action) {
        if (action.proposalId) return { type: 'proposal', id: String(action.proposalId) };
        if (action.parcelId) return { type: 'parcel', id: String(action.parcelId) };
        return null;
    }

    function defaultMessage(actor, action) {
        const proposal = action.proposalId ? ` proposal ${action.proposalId}` : '';
        const amount = action.amount ? ` ${action.amount} USDC` : '';
        if (action.type === 'create') return `${actor.name} created${proposal}.`;
        if (action.type === 'publish') return `${actor.name} published${proposal} through x402.`;
        if (action.type === 'stake') return `${actor.name} staked${amount}${proposal ? ` on${proposal}` : ''}.`;
        if (action.type === 'donate') return `${actor.name} donated${amount}${proposal ? ` to${proposal}` : ''}.`;
        if (action.type === 'pledge') return `${actor.name} pledged${amount}${proposal ? ` to${proposal}` : ''}.`;
        return `${actor.name} ${action.type}.`;
    }

    function createActivityEvent({ actor, action, outcome, source = 'simulation', occurredAt, recordedAt, turn = null } = {}) {
        const normalizedActor = normalizeActor(actor);
        const normalizedAction = normalizeAction(action);
        const result = typeof outcome === 'string' ? { ok: true, messageHtml: outcome } : (outcome || { ok: true });
        const now = new Date().toISOString();
        sequence += 1;
        const httpFailed = Number.isFinite(Number(result.status)) && Number(result.status) >= 400;
        return {
            id: result.id || `${source}:${normalizedActor.id}:${Date.now()}:${sequence}`,
            source,
            actor: normalizedActor,
            action: normalizedAction,
            entity: result.entity || entityFromAction(normalizedAction),
            ok: result.ok !== false && !httpFailed,
            message: result.message || (result.messageHtml ? null : defaultMessage(normalizedActor, normalizedAction)),
            messageHtml: result.messageHtml || null,
            transaction: result.transaction || result.signature || result.transactionHash || result.stakeSignature || result.receipt?.transaction || null,
            occurredAt: occurredAt || now,
            recordedAt: recordedAt || now,
            turn
        };
    }

    function createEngine({ decisionProviders = {}, actionHandlers = {}, onActivity = null } = {}) {
        const deciders = { ...decisionProviders };
        const handlers = { ...actionHandlers };
        return {
            registerDecisionProvider(name, provider) {
                if (typeof provider !== 'function') throw new Error('decision provider must be a function');
                deciders[name] = provider;
            },
            registerActionHandler(type, handler) {
                if (typeof handler !== 'function') throw new Error('action handler must be a function');
                handlers[type] = handler;
            },
            async run(actor, context = {}) {
                const normalizedActor = normalizeActor(actor);
                const decide = deciders[normalizedActor.controller];
                if (typeof decide !== 'function') throw new Error(`no decision provider for ${normalizedActor.controller}`);
                const action = normalizeAction(await decide(actor, context));
                const handler = handlers[action.type] || handlers['*'];
                if (typeof handler !== 'function') throw new Error(`no action handler for ${action.type}`);
                const outcome = await handler(actor, action, context);
                const activity = createActivityEvent({
                    actor: normalizedActor, action, outcome,
                    source: context.source || 'simulation',
                    occurredAt: context.occurredAt,
                    recordedAt: context.recordedAt,
                    turn: context.turn ?? null
                });
                if (typeof onActivity === 'function') await onActivity(activity, context);
                return { action, outcome, activity };
            }
        };
    }

    function includesQuery(event, query) {
        if (!query) return true;
        const haystack = [
            event.actor?.name, event.actor?.id, event.actor?.wallet,
            event.action?.type, event.entity?.id, event.message, event.text,
            event.transaction, event.runId, event.model, event.batchId
        ].filter(Boolean).join(' ').toLocaleLowerCase();
        return haystack.includes(String(query).trim().toLocaleLowerCase());
    }

    function matchesActivity(event, filter = 'all') {
        if (!event) return false;
        if (typeof filter === 'string') {
            if (filter === 'all') return true;
            if (filter === 'live' || filter === 'simulation') return event.source === filter;
            if (filter === 'human' || filter === 'agent' || filter === 'system') return event.actor?.kind === filter;
            if (filter === 'algorithm' || filter === 'llm') return event.actor?.controller === filter;
            if (filter === 'success') return event.ok !== false;
            if (filter === 'failed') return event.ok === false;
            return event.action?.type === filter;
        }
        const source = filter.source || 'all';
        const actor = filter.actor || filter.controller || 'all';
        const action = filter.action || 'all';
        const status = filter.status || 'all';
        if (source !== 'all' && event.source !== source) return false;
        if (actor !== 'all') {
            if (actor === 'human' || actor === 'agent' || actor === 'system') {
                if (event.actor?.kind !== actor) return false;
            } else if (event.actor?.controller !== actor) return false;
        }
        if (action !== 'all' && event.action?.type !== action) return false;
        if (status === 'success' && event.ok === false) return false;
        if (status === 'failed' && event.ok !== false) return false;
        return includesQuery(event, filter.query);
    }

    function mergeActivities(...lists) {
        const byId = new Map();
        lists.flat().filter(Boolean).forEach(event => byId.set(event.id || `${event.recordedAt}:${event.message || event.text}`, event));
        return Array.from(byId.values()).sort((left, right) => {
            const a = Date.parse(left.recordedAt || left.occurredAt || 0) || 0;
            const b = Date.parse(right.recordedAt || right.occurredAt || 0) || 0;
            return a - b;
        });
    }

    return { normalizeActor, normalizeAction, createActivityEvent, createEngine, matchesActivity, mergeActivities };
});
