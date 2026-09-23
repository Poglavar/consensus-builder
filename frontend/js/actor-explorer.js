// Neutral profiles and run drill-downs for the unified activity event envelope. The model layer is
// DOM-free so the main map can feed it human, algorithmic and LLM events without a second runtime.
(function attachActorExplorer(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ActorExplorer = api;
})(typeof window !== 'undefined' ? window : globalThis, function actorExplorerFactory(root) {
    'use strict';

    const ACTION_LABELS = Object.freeze({
        create: 'Created', publish: 'Published', donate: 'Donated', pledge: 'Pledged',
        stake: 'Bet / stake', createMarket: 'Opened market', resolve: 'Resolved market',
        claim: 'Claimed winnings', revokePledge: 'Revoked pledge', fulfillPledge: 'Fulfilled pledge',
        refundMyDonations: 'Refunded donation', releaseDonations: 'Released donations',
        vote: 'Voted', run_status: 'Run status'
    });

    function string(value, fallback = '') {
        return value === null || value === undefined ? fallback : String(value);
    }

    function actorKey(actor = {}) {
        return [actor.kind || 'human', actor.controller || 'human', actor.wallet || actor.id || actor.name || 'unknown'].join(':');
    }

    function isoTime(value) {
        const date = new Date(value || 0);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function normalizeEvent(input = {}) {
        const rawActor = input.actor || {};
        const controller = string(rawActor.controller || (rawActor.kind === 'human' ? 'human' : 'algorithm'));
        const actor = {
            id: string(rawActor.id || rawActor.wallet || rawActor.name || 'unknown'),
            name: string(rawActor.name || rawActor.persona || rawActor.id || rawActor.wallet || 'Unknown actor'),
            kind: string(rawActor.kind || (controller === 'human' ? 'human' : 'agent')),
            controller,
            wallet: rawActor.wallet ? string(rawActor.wallet) : null
        };
        const action = input.action || {};
        const occurredAt = isoTime(input.occurredAt || input.recordedAt);
        return {
            id: string(input.id || `${actorKey(actor)}:${occurredAt || 'unknown'}:${action.type || 'activity'}`),
            actor,
            actorKey: actorKey(actor),
            action: { ...action, type: string(action.type || 'activity') },
            entity: input.entity || null,
            source: string(input.source || 'local'),
            ok: input.ok !== false,
            occurredAt,
            recordedAt: isoTime(input.recordedAt || input.occurredAt),
            message: input.message ? string(input.message) : '',
            transaction: input.transaction ? string(input.transaction) : null,
            runId: input.runId ? string(input.runId) : null,
            model: input.model ? string(input.model) : null,
            modelCostUsd: Number.isFinite(Number(input.modelCostUsd)) ? Number(input.modelCostUsd) : null,
            batchId: input.batchId ? string(input.batchId) : null,
            rationale: input.rationale ? string(input.rationale) : null,
            provenance: input.provenance && typeof input.provenance === 'object' ? input.provenance : null
        };
    }

    function newestFirst(events) {
        return [...(events || [])].map(normalizeEvent).sort((left, right) =>
            (Date.parse(right.recordedAt || right.occurredAt || 0) || 0) - (Date.parse(left.recordedAt || left.occurredAt || 0) || 0));
    }

    function buildActorProfiles(events) {
        const profiles = new Map();
        newestFirst(events).forEach(event => {
            let profile = profiles.get(event.actorKey);
            if (!profile) {
                profile = {
                    key: event.actorKey, actor: event.actor, activityCount: 0, actions: {}, proposalIds: new Set(),
                    runIds: new Set(), transactionCount: 0, _costKeys: new Set(), modelCostUsd: 0, latestAt: null
                };
                profiles.set(event.actorKey, profile);
            }
            profile.activityCount += 1;
            profile.actions[event.action.type] = (profile.actions[event.action.type] || 0) + 1;
            if (event.entity?.type === 'proposal' && event.entity.id) profile.proposalIds.add(string(event.entity.id));
            if (event.runId) profile.runIds.add(event.runId);
            if (event.transaction) profile.transactionCount += 1;
            const costKey = event.runId || `${event.model || ''}:${event.batchId || ''}:${event.id}`;
            if (event.modelCostUsd !== null && !profile._costKeys.has(costKey)) {
                profile._costKeys.add(costKey);
                profile.modelCostUsd += event.modelCostUsd;
            }
            if (!profile.latestAt || Date.parse(event.recordedAt || 0) > Date.parse(profile.latestAt || 0)) profile.latestAt = event.recordedAt;
        });
        return Array.from(profiles.values()).map(profile => ({
            ...profile,
            proposalIds: Array.from(profile.proposalIds), runIds: Array.from(profile.runIds),
            modelCostUsd: Number(profile.modelCostUsd.toFixed(6))
        })).sort((left, right) => Date.parse(right.latestAt || 0) - Date.parse(left.latestAt || 0));
    }

    function filterEvents(events, { query = '', controller = 'all', actorKey: selectedActor = null } = {}) {
        const term = string(query).trim().toLocaleLowerCase();
        return newestFirst(events).filter(event => {
            if (controller !== 'all' && event.actor.controller !== controller) return false;
            if (selectedActor && event.actorKey !== selectedActor) return false;
            if (!term) return true;
            return [event.actor.name, event.actor.id, event.actor.wallet, event.action.type, event.entity?.id,
                event.message, event.transaction, event.runId, event.model, event.rationale]
                .filter(Boolean).join(' ').toLocaleLowerCase().includes(term);
        });
    }

    function eventDetail(event) {
        const item = normalizeEvent(event);
        return {
            action: ACTION_LABELS[item.action.type] || item.action.type,
            actor: item.actor.name,
            proposalId: item.entity?.type === 'proposal' ? string(item.entity.id) : null,
            rationale: item.rationale,
            runId: item.runId,
            model: item.model,
            modelCostUsd: item.modelCostUsd,
            batchId: item.batchId,
            transaction: item.transaction,
            provenance: item.provenance,
            ok: item.ok
        };
    }

    function escapeHtml(value) {
        return string(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    // One activity row for every surface. Rows look identical for humans, algorithms and LLMs; who or
    // what acted is provenance and only appears once Details is opened. Simulation `messageHtml` is
    // app-authored markup (agent/proposal/parcel links); every other field is escaped.
    // `translate(key, fallback, params)` lets the map localize labels; the standalone page has no i18n.
    function activityRowHtml(event = {}, { translate = (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => string(params[name])) } = {}) {
        const tr = (key, fallback, params) => translate(`gameDialogs.log.row.${key}`, fallback, params);
        const body = event.source === 'simulation' && event.messageHtml
            ? event.messageHtml
            : escapeHtml(event.message || `${event.actor?.name || 'Someone'} ${event.action?.type || 'acted'}.`);
        const when = isoTime(event.occurredAt);
        const turn = event.source === 'simulation' && event.turn !== null && event.turn !== undefined ? `${escapeHtml(tr('turn', 'Turn {{turn}}', { turn: event.turn }))} · ` : '';
        const timestamp = when ? `<time datetime="${when}">${turn}${escapeHtml(formatWhen(when))}</time>` : '';
        const proposalLink = event.entity?.type === 'proposal' && event.entity.id
            ? `<a href="#" data-proposal-id="${escapeHtml(event.entity.id)}" class="proposal-link proposal-link-clickable">${escapeHtml(tr('openProposal', 'Open proposal'))}</a>`
            : '';
        const transactionLink = event.transaction
            ? `<a href="https://explorer.solana.com/tx/${encodeURIComponent(event.transaction)}?cluster=devnet" target="_blank" rel="noopener">${escapeHtml(tr('transaction', 'Transaction ↗'))}</a>`
            : '';
        const details = [
            tr('source', 'Source: {{value}}', { value: event.source || 'unknown' }),
            tr('controller', 'Controller: {{value}}', { value: event.actor?.controller || 'unknown' }),
            tr('action', 'Action: {{value}}', { value: event.action?.type || 'unknown' }),
            event.ok === false ? tr('resultFailed', 'Result: failed') : tr('resultSuccess', 'Result: success')
        ].map(escapeHtml).join(' · ');
        // Scope buttons drill into actor → proposal → parcel set → run; the host explorer handles them.
        const scope = (field, value, label) => value
            ? `<button type="button" class="activity-scope-link" data-activity-scope="${field}" data-activity-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
            : '';
        const proposalId = event.entity?.type === 'proposal' && event.entity.id ? event.entity.id : event.action?.proposalId;
        const actorDetails = [event.actor?.wallet, event.actor?.id].filter(Boolean).map(escapeHtml).join(' · ');
        const actorScope = scope('actorId', event.actor?.id, event.actor?.name || event.actor?.id || tr('actorFallback', 'Actor'));
        const entityDetails = event.entity?.id ? `<span>${escapeHtml(event.entity.type || 'entity')}: ${escapeHtml(event.entity.id)}</span>` : '';
        const proposalScope = proposalId
            ? `<span>${scope('proposalId', proposalId, tr('scopeProposal', 'All activity on this proposal'))}${scope('parcelSetOf', proposalId, tr('scopeLand', 'All activity on this land'))}</span>`
            : '';
        const modelDetails = event.model
            ? `<span>${escapeHtml(tr('model', 'Model:'))} ${escapeHtml(event.model)}${Number.isFinite(event.modelCostUsd) ? ` · $${escapeHtml(event.modelCostUsd.toFixed(4))}` : ''}</span>`
            : '';
        return `<article class="log-entry activity-entry${event.ok === false ? ' is-failed' : ''}" data-source="${escapeHtml(event.source)}">
        <div class="activity-entry-main">${body}</div>
        <div class="activity-entry-links">${timestamp}${proposalLink}${transactionLink}</div>
        <details class="activity-entry-meta"><summary>${escapeHtml(tr('details', 'Details'))}</summary><span>${details}</span><span>${escapeHtml(tr('actor', 'Actor:'))} ${actorScope}${actorDetails ? ` · ${actorDetails}` : ''}</span>${entityDetails}${proposalScope}${modelDetails}${event.runId ? `<span>${escapeHtml(tr('run', 'Run'))} ${scope('runId', event.runId, event.runId)}</span>` : ''}${event.batchId ? `<span>${escapeHtml(tr('batch', 'Batch'))} ${escapeHtml(event.batchId)}</span>` : ''}</details>
    </article>`;
    }

    // Events an actor performed, plus simulation events whose markup links to that actor.
    function eventsInvolvingActor(events, actorId) {
        const id = string(actorId);
        if (!id) return [];
        const link = `data-agent-id="${id}"`;
        return (events || []).filter(event => string(event?.actor?.id) === id
            || (typeof event?.messageHtml === 'string' && event.messageHtml.includes(link)));
    }

    function runCostTotal(run = {}) {
        return (Array.isArray(run.costs) ? run.costs : []).reduce((sum, cost) => sum + (Number(cost.usd) || 0), 0);
    }

    function text(doc, tag, value, className = '') {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        node.textContent = value;
        return node;
    }

    function short(value, length = 10) {
        const source = string(value);
        return source.length <= length ? source : `${source.slice(0, 5)}…${source.slice(-4)}`;
    }

    function formatUsd(value) {
        return Number.isFinite(value) ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : '—';
    }

    function formatWhen(value) {
        const date = value ? new Date(value) : null;
        return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'unknown time';
    }

    function backendBase() {
        if (typeof root?.getBackendBase === 'function') return String(root.getBackendBase()).replace(/\/$/, '');
        const configured = root?.document?.querySelector?.('meta[name="consensus-api-base"]')?.content;
        if (configured) return String(configured).replace(/\/$/, '');
        const hostname = root?.location?.hostname || '';
        if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3000';
        return 'https://api.urbangametheory.xyz';
    }

    function mount(element, { events = [], loadRun = null } = {}) {
        if (!element || !root?.document) throw new Error('ActorExplorer.mount needs an element and a document');
        const doc = root.document;
        let allEvents = newestFirst(events);
        let state = { query: '', controller: 'all', actorKey: null };
        element.replaceChildren();
        const filters = doc.createElement('div'); filters.className = 'ae-filters';
        const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Search actor, proposal, run or transaction'; search.setAttribute('aria-label', search.placeholder);
        const controller = doc.createElement('select'); controller.setAttribute('aria-label', 'Actor controller');
        [['all', 'All actors'], ['human', 'Humans'], ['algorithm', 'Algorithms'], ['llm', 'LLM agents']].forEach(([value, label]) => {
            const option = text(doc, 'option', label); option.value = value; controller.append(option);
        });
        const clear = text(doc, 'button', 'Clear selection', 'ae-button ae-button-quiet'); clear.type = 'button';
        filters.append(search, controller, clear);
        const profiles = doc.createElement('section'); profiles.className = 'ae-profiles'; profiles.setAttribute('aria-label', 'Actor profiles');
        const activity = doc.createElement('section'); activity.className = 'ae-activity'; activity.setAttribute('aria-label', 'Activity');
        const detail = doc.createElement('aside'); detail.className = 'ae-run-detail'; detail.setAttribute('aria-live', 'polite');
        element.append(filters, profiles, activity, detail);

        function renderRun(run) {
            detail.replaceChildren();
            detail.append(text(doc, 'h2', `Run ${run.id}`, 'ae-section-title'));
            detail.append(text(doc, 'p', `${run.persona} · ${run.status} · ${run.stage || 'started'}`, 'ae-muted'));
            detail.append(text(doc, 'p', `${run.model || 'No model recorded'} · ${formatUsd(runCostTotal(run))} exact cost`, 'ae-muted'));
            (run.picks || []).forEach(pick => {
                const block = doc.createElement('div'); block.className = 'ae-rationale';
                block.append(text(doc, 'strong', pick.name || pick.proposalId || 'Proposal'));
                if (pick.rationale) block.append(text(doc, 'p', pick.rationale));
                block.append(text(doc, 'small', `Proposal ${pick.proposalId || 'not recorded'}`));
                detail.append(block);
            });
            (run.costs || []).forEach(cost => detail.append(text(doc, 'p', `${cost.item}: ${cost.model} · ${formatUsd(Number(cost.usd))}`, 'ae-provenance')));
        }

        async function openRun(runId) {
            if (!runId || typeof loadRun !== 'function') return;
            detail.replaceChildren(text(doc, 'p', 'Loading run provenance…', 'ae-muted'));
            try { renderRun(await loadRun(runId)); }
            catch (error) { detail.replaceChildren(text(doc, 'p', `Could not load run: ${error.message}`, 'ae-error')); }
        }

        function render() {
            const visible = filterEvents(allEvents, state);
            profiles.replaceChildren(text(doc, 'h2', 'Actors', 'ae-section-title'));
            const cards = doc.createElement('div'); cards.className = 'ae-profile-grid';
            buildActorProfiles(visible).forEach(profile => {
                const card = doc.createElement('button'); card.type = 'button'; card.className = 'ae-profile-card';
                card.classList.toggle('is-selected', state.actorKey === profile.key);
                card.append(text(doc, 'strong', profile.actor.name), text(doc, 'span', `${profile.actor.kind} · ${profile.actor.controller}`, 'ae-tag'));
                card.append(text(doc, 'span', `${profile.activityCount} activities · ${profile.proposalIds.length} proposals · ${profile.transactionCount} transactions`, 'ae-muted'));
                if (profile.actor.wallet) card.append(text(doc, 'code', short(profile.actor.wallet), 'ae-wallet'));
                if (profile.modelCostUsd) card.append(text(doc, 'span', `${formatUsd(profile.modelCostUsd)} model cost`, 'ae-muted'));
                card.addEventListener('click', () => { state.actorKey = state.actorKey === profile.key ? null : profile.key; render(); });
                cards.append(card);
            });
            if (!cards.childElementCount) cards.append(text(doc, 'p', 'No actors match this filter.', 'ae-empty'));
            profiles.append(cards);

            activity.replaceChildren(text(doc, 'h2', `Activity (${visible.length})`, 'ae-section-title'));
            const list = doc.createElement('ol'); list.className = 'ae-list';
            visible.forEach(event => {
                const item = doc.createElement('li'); item.className = event.ok ? 'ae-event' : 'ae-event is-failed';
                const heading = `${event.actor.name} · ${ACTION_LABELS[event.action.type] || event.action.type}`;
                item.append(text(doc, 'strong', heading));
                item.append(text(doc, 'span', event.message || `${event.action.type} ${event.entity?.id || ''}`, 'ae-event-message'));
                item.append(text(doc, 'time', formatWhen(event.recordedAt), 'ae-muted'));
                const meta = doc.createElement('div'); meta.className = 'ae-meta';
                if (event.entity?.id) {
                    const proposal = text(doc, 'a', `Proposal ${event.entity.id}`, 'ae-link');
                    proposal.href = `/proposals/${encodeURIComponent(event.entity.id)}`;
                    meta.append(proposal);
                }
                if (event.transaction) {
                    const transaction = text(doc, 'a', `tx ${short(event.transaction)}`, 'ae-link ae-wallet');
                    transaction.href = `https://explorer.solana.com/tx/${encodeURIComponent(event.transaction)}?cluster=devnet`;
                    transaction.target = '_blank'; transaction.rel = 'noopener';
                    meta.append(transaction);
                }
                if (event.runId) {
                    const run = text(doc, 'button', `run ${short(event.runId)}`, 'ae-link'); run.type = 'button'; run.addEventListener('click', () => openRun(event.runId)); meta.append(run);
                }
                if (event.model) meta.append(text(doc, 'span', `${event.model}${event.modelCostUsd !== null ? ` · ${formatUsd(event.modelCostUsd)}` : ''}`, 'ae-tag'));
                item.append(meta);
                const evidence = eventDetail(event);
                if (evidence.rationale || evidence.transaction || evidence.provenance) {
                    const more = doc.createElement('details'); more.append(text(doc, 'summary', 'Evidence'));
                    if (evidence.rationale) more.append(text(doc, 'p', evidence.rationale));
                    if (evidence.transaction) more.append(text(doc, 'p', `Transaction: ${evidence.transaction}`, 'ae-provenance'));
                    if (evidence.provenance) more.append(text(doc, 'pre', JSON.stringify(evidence.provenance, null, 2), 'ae-provenance'));
                    item.append(more);
                }
                list.append(item);
            });
            if (!list.childElementCount) list.append(text(doc, 'li', 'No activity matches this filter.', 'ae-empty'));
            activity.append(list);
        }
        search.addEventListener('input', () => { state.query = search.value; render(); });
        controller.addEventListener('change', () => { state.controller = controller.value; state.actorKey = null; render(); });
        clear.addEventListener('click', () => { state.actorKey = null; search.value = ''; state.query = ''; controller.value = 'all'; state.controller = 'all'; render(); });
        render();
        return { setEvents(next) { allEvents = newestFirst(next); render(); }, getEvents() { return [...allEvents]; } };
    }

    async function boot() {
        const element = root?.document?.getElementById('actor-explorer');
        if (!element) return;
        const base = backendBase();
        const response = await fetch(`${base}/agent/activity?limit=250`);
        if (!response.ok) throw new Error(`activity API returned ${response.status}`);
        const payload = await response.json();
        mount(element, {
            events: payload.events || [],
            loadRun: async runId => {
                const runResponse = await fetch(`${base}/agent/runs/${encodeURIComponent(runId)}`);
                if (!runResponse.ok) throw new Error(`run API returned ${runResponse.status}`);
                return (await runResponse.json()).run;
            }
        });
    }

    if (root?.document) {
        const start = () => boot().catch(error => {
            const element = root.document.getElementById('actor-explorer');
            if (element) element.textContent = `Could not load activity: ${error.message}`;
        });
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
        else start();
    }

    return { ACTION_LABELS, activityRowHtml, actorKey, backendBase, buildActorProfiles, eventDetail, eventsInvolvingActor, filterEvents, mount, newestFirst, normalizeEvent, runCostTotal };
});
