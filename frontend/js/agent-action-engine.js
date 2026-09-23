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
            event.action?.type, event.entity?.id, event.message, event.messageHtml,
            event.transaction, event.runId, event.model, event.batchId
        ].filter(Boolean).join(' ').toLocaleLowerCase();
        return haystack.includes(String(query).trim().toLocaleLowerCase());
    }

    // The explorer's whole filter vocabulary. Every surface (map dialog, per-agent log, deep links)
    // speaks this one shape; `proposalIds` is how a parcel set is expressed, because events reference
    // proposals and the caller resolves which proposals share a set.
    const EMPTY_ACTIVITY_FILTER = Object.freeze({
        source: 'combined', kind: 'all', controller: 'all', action: 'all', status: 'all',
        actorId: null, proposalId: null, runId: null, parcelSet: null, proposalIds: null, query: ''
    });

    function activityProposalId(event) {
        if (event?.entity?.type === 'proposal' && event.entity.id) return String(event.entity.id);
        return event?.action?.proposalId ? String(event.action.proposalId) : null;
    }

    function matchesActivity(event, filter = {}) {
        if (!event) return false;
        const f = { ...EMPTY_ACTIVITY_FILTER, ...filter };
        if (f.source !== 'combined' && event.source !== f.source) return false;
        if (f.kind !== 'all' && event.actor?.kind !== f.kind) return false;
        if (f.controller !== 'all' && event.actor?.controller !== f.controller) return false;
        if (f.action !== 'all' && event.action?.type !== f.action) return false;
        if (f.status === 'success' && event.ok === false) return false;
        if (f.status === 'failed' && event.ok !== false) return false;
        if (f.actorId && String(event.actor?.id) !== String(f.actorId)) return false;
        if (f.proposalId && activityProposalId(event) !== String(f.proposalId)) return false;
        if (f.runId && String(event.runId || '') !== String(f.runId)) return false;
        if (Array.isArray(f.proposalIds) && !f.proposalIds.includes(activityProposalId(event))) return false;
        return includesQuery(event, f.query);
    }

    // `?activity=<dimension>:<value>` deep links into the explorer, e.g. proposal:abc or actor:wallet.
    const LINK_DIMENSIONS = Object.freeze({ actor: 'actorId', proposal: 'proposalId', run: 'runId', parcelSet: 'parcelSet' });

    function parseActivityLink(value) {
        const text = typeof value === 'string' ? value : '';
        const separator = text.indexOf(':');
        const field = LINK_DIMENSIONS[text.slice(0, separator)];
        const id = text.slice(separator + 1);
        return separator > 0 && field && id ? { [field]: id } : null;
    }

    function activityLinkFor(dimension, id) {
        if (!LINK_DIMENSIONS[dimension] || id === null || id === undefined || id === '') throw new Error(`unsupported activity link ${dimension}`);
        return `activity=${encodeURIComponent(`${dimension}:${id}`)}`;
    }

    // Live, simulation and combined are adapters behind one load(); the explorer never branches on
    // where events came from. A failing adapter is reported, not silently treated as "no activity".
    // `context` (the active filter) lets an adapter narrow its own query, e.g. server-side scope.
    function createActivitySource(adapters = {}) {
        return {
            async load(source = 'combined', context = {}) {
                const names = source === 'combined' ? Object.keys(adapters) : [source];
                const failures = [];
                const lists = await Promise.all(names.map(async name => {
                    if (typeof adapters[name] !== 'function') throw new Error(`unknown activity source ${name}`);
                    try { return await adapters[name](context); }
                    catch (error) { failures.push({ source: name, error: error.message }); return []; }
                }));
                return { events: mergeActivities(...lists), failures };
            }
        };
    }

    function mergeActivities(...lists) {
        const byId = new Map();
        lists.flat().filter(Boolean).forEach(event => byId.set(event.id || `${event.recordedAt}:${event.message || event.messageHtml}`, event));
        return Array.from(byId.values()).sort((left, right) => {
            const a = Date.parse(left.recordedAt || left.occurredAt || 0) || 0;
            const b = Date.parse(right.recordedAt || right.occurredAt || 0) || 0;
            return a - b;
        });
    }

    return {
        EMPTY_ACTIVITY_FILTER, activityLinkFor, activityProposalId, createActivityEvent, createActivitySource, createEngine,
        matchesActivity, mergeActivities, normalizeAction, normalizeActor, parseActivityLink
    };
});
