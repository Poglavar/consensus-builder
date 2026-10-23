// Neutral profiles and run drill-downs for the unified activity event envelope. The model layer is
// DOM-free so the main map can feed it human, algorithmic and LLM events without a second runtime.
(function attachActorExplorer(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ActorExplorer = api;
})(typeof window !== 'undefined' ? window : globalThis, function actorExplorerFactory(root) {
    'use strict';

    // The action vocabulary: every type the live feed (backend/routes/agent-activity.js) emits, which is
    // designs and agreements from the index, the agreement, market and pledge programs' instructions,
    // the agent runs' recorded activities (run.mjs, support-run.mjs, society-run.mjs through the
    // AgentActionEngine; the settlement phase adds decide and lens-decision) and run status, plus
    // create, the local design a simulation agent makes. The explorer's action filter is built from it,
    // so a type missing here could never be filtered for.
    const ACTION_LABELS = Object.freeze({
        create: 'Created', design: 'Published design', propose: 'Proposed agreement', mint: 'Minted',
        fund: 'Funded escrow', decide: 'Owner decision', 'lens-decision': 'Lens decision', attest: 'Recorded decision',
        execute: 'Executed', cancel: 'Cancelled', expire: 'Expired',
        createMarket: 'Opened market', stake: 'Bet / stake', resolve: 'Resolved market', claim: 'Claimed winnings',
        donate: 'Donated', pledge: 'Pledged', revokePledge: 'Revoked pledge', fulfillPledge: 'Fulfilled pledge',
        voidPledge: 'Voided pledge', refundMyDonations: 'Refunded donation', releaseDonations: 'Released donations',
        run_status: 'Run status'
    });
    // What an event can be about, by its entity type, and the words its link and scope use.
    const ENTITY_LABELS = Object.freeze({ agreement: 'Agreement', design: 'Design' });
    const shortCid = value => {
        const text = string(value);
        return text.length > 20 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text;
    };

    // Filter options for the action vocabulary, labelled through the host translator when it has one.
    function actionOptions(translate = (_key, fallback) => fallback) {
        return Object.keys(ACTION_LABELS).map(type => ({
            value: type,
            label: translate(`gameDialogs.log.actions.${type}`, ACTION_LABELS[type])
        }));
    }

    function string(value, fallback = '') {
        return value === null || value === undefined ? fallback : String(value);
    }

    function actorKey(actor = {}) {
        // A person can use an algorithmic run and an LLM run with the same wallet. Controller is
        // provenance of an event, not a second identity, so it must not split their profile.
        return actor.wallet || actor.id || actor.name || 'unknown';
    }

    function isoTime(value) {
        const date = new Date(value || 0);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function normalizeEvent(input = {}) {
        const rawActor = input.actor || {};
        const controller = string(rawActor.controller || (rawActor.kind === 'human' ? 'human' : 'unknown'));
        const actor = {
            id: string(rawActor.id || rawActor.wallet || rawActor.name || 'unknown'),
            name: string(rawActor.name || rawActor.persona || rawActor.id || rawActor.wallet || 'Unknown actor'),
            kind: string(rawActor.kind || (controller === 'human' ? 'human' : controller === 'unknown' ? 'unknown' : 'agent')),
            controller,
            wallet: rawActor.wallet ? string(rawActor.wallet) : null
        };
        const action = input.action || {};
        const occurredAt = isoTime(input.occurredAt || input.recordedAt);
        return {
            id: string(input.id || `${actorKey(actor)}:${occurredAt || 'unknown'}:${action.type || 'activity'}`),
            actor,
            actorKey: actorKey(actor),
            cityId: input.cityId ?? null,
            location: input.location ?? null,
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
                    key: event.actorKey, actor: event.actor, activityCount: 0, actions: {}, agreementCids: new Set(),
                    runIds: new Set(), transactionCount: 0, _costKeys: new Set(), modelCostUsd: 0, latestAt: null
                };
                profiles.set(event.actorKey, profile);
            }
            profile.activityCount += 1;
            profile.actions[event.action.type] = (profile.actions[event.action.type] || 0) + 1;
            if (event.entity?.type === 'agreement' && event.entity.id) profile.agreementCids.add(string(event.entity.id));
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
            agreementCids: Array.from(profile.agreementCids), runIds: Array.from(profile.runIds),
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
            agreementCid: item.entity?.type === 'agreement' ? string(item.entity.id) : null,
            designCid: item.entity?.type === 'design' ? string(item.entity.id) : null,
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
    // app-authored markup (agent/local design/parcel links); every other field is escaped.
    // `translate(key, fallback, params)` lets the map localize labels; the standalone page has no i18n.
    function activityRowHtml(event = {}, { translate = (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => string(params[name])) } = {}) {
        const tr = (key, fallback, params) => translate(`gameDialogs.log.row.${key}`, fallback, params);
        const body = event.source === 'simulation' && event.messageHtml
            ? event.messageHtml
            : escapeHtml(event.message || `${event.actor?.name || 'Someone'} ${event.action?.type || 'acted'}.`);
        const when = isoTime(event.occurredAt);
        const turn = event.source === 'simulation' && event.turn !== null && event.turn !== undefined ? `${escapeHtml(tr('turn', 'Turn {{turn}}', { turn: event.turn }))} · ` : '';
        const timestamp = when ? `<time datetime="${when}">${turn}${escapeHtml(formatWhen(when))}</time>` : '';
        // Opening an agreement or a design runs script (the host handles .activity-entity-link), so it
        // is a button that looks like a link; the transaction leaves the app and carries the external mark.
        const entityType = event.entity?.type;
        const entityLink = ENTITY_LABELS[entityType] && event.entity.id
            ? `<button type="button" class="cb-link activity-entity-link" data-entity-type="${escapeHtml(entityType)}" data-entity-id="${escapeHtml(event.entity.id)}">${escapeHtml(entityType === 'agreement' ? tr('openAgreement', 'Open agreement') : tr('openDesign', 'Open design'))}</button>`
            : '';
        const transactionLink = event.transaction
            ? `<a class="cb-link cb-link--external" href="https://explorer.solana.com/tx/${encodeURIComponent(event.transaction)}?cluster=devnet" target="_blank" rel="noopener noreferrer">${escapeHtml(tr('transaction', 'Transaction'))}</a>`
            : '';
        const sourceBadge = event.source === 'simulation'
            ? `<span class="cb-badge">${escapeHtml(translate('gameDialogs.log.actors.sourceSimulation', 'Simulation'))}</span>`
            : '';
        const details = [
            tr('source', 'Source: {{value}}', { value: event.source || 'unknown' }),
            tr('controller', 'Controller: {{value}}', { value: event.actor?.controller || 'unknown' }),
            tr('action', 'Action: {{value}}', { value: event.action?.type || 'unknown' }),
            event.ok === false ? tr('resultFailed', 'Result: failed') : tr('resultSuccess', 'Result: success')
        ].map(escapeHtml).join(' · ');
        // Scope buttons drill into actor → agreement → run; the host explorer handles them.
        const scope = (field, value, label) => value
            ? `<button type="button" class="cb-link activity-scope-link" data-activity-scope="${field}" data-activity-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
            : '';
        const agreementCid = entityType === 'agreement' && event.entity.id ? event.entity.id : event.action?.agreementCid;
        const actorDetails = [event.actor?.wallet, event.actor?.id].filter(Boolean).map(escapeHtml).join(' · ');
        const actorScope = scope('actorId', event.actor?.id, event.actor?.name || event.actor?.id || tr('actorFallback', 'Actor'));
        const entityDetails = event.entity?.id ? `<span>${escapeHtml(entityType || 'entity')}: ${escapeHtml(event.entity.id)}</span>` : '';
        const agreementScope = agreementCid
            ? `<span class="activity-scope-links">${scope('agreementCid', agreementCid, tr('scopeAgreement', 'All activity on this agreement'))}</span>`
            : '';
        const modelDetails = event.model
            ? `<span>${escapeHtml(tr('model', 'Model:'))} ${escapeHtml(event.model)}${Number.isFinite(event.modelCostUsd) ? ` · ${escapeHtml(formatUsd(event.modelCostUsd, 4))}` : ''}</span>`
            : '';
        return `<article class="log-entry activity-entry${event.ok === false ? ' is-failed' : ''}" data-source="${escapeHtml(event.source)}">
        <div class="activity-entry-main">${body}</div>
        <div class="activity-entry-links">${timestamp}${sourceBadge}${entityLink}${transactionLink}</div>
        <details class="activity-entry-meta"><summary>${escapeHtml(tr('details', 'Details'))}</summary><span>${details}</span><span>${escapeHtml(tr('actor', 'Actor:'))} ${actorScope}${actorDetails ? ` · ${actorDetails}` : ''}</span>${entityDetails}${agreementScope}${modelDetails}${event.runId ? `<span>${escapeHtml(tr('run', 'Run'))} ${scope('runId', event.runId, event.runId)}</span>` : ''}${event.batchId ? `<span>${escapeHtml(tr('batch', 'Batch'))} ${escapeHtml(event.batchId)}</span>` : ''}</details>
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

    function translatorOf(translate) {
        return typeof translate === 'function' ? translate : (_key, fallback, params = {}) =>
            fallback.replace(/\{\{(\w+)\}\}/g, (_match, name) => string(params[name]));
    }

    function actorKindLabel(kind, t) {
        const labels = { human: ['actorKindHuman', 'Person'], agent: ['actorKindAgent', 'Agent'], system: ['actorKindSystem', 'System'] };
        const entry = labels[kind];
        return entry ? t(`gameDialogs.log.actors.${entry[0]}`, entry[1])
            : t('gameDialogs.log.actors.actorKindUnknown', 'Unknown type');
    }

    function controllerLabel(controller, t) {
        const labels = { human: ['controllerHuman', 'Person'], algorithm: ['controllerAlgorithm', 'Algorithm'], llm: ['controllerLlm', 'LLM agent'] };
        const entry = labels[controller];
        return entry ? t(`gameDialogs.log.actors.${entry[0]}`, entry[1])
            : t('gameDialogs.log.actors.controllerUnknown', 'Unknown controller');
    }

    function short(value, length = 10) {
        const source = string(value);
        return source.length <= length ? source : `${source.slice(0, 5)}…${source.slice(-4)}`;
    }

    // Model costs and times go through the shared formatter (js/format.js) where the page loads it:
    // "0.0039 USD", amount then code. actor-explorer.html and the unit tests run without it.
    function formatUsd(value, digits) {
        if (!Number.isFinite(value)) return '—';
        const places = digits === undefined ? (value < 0.01 ? 4 : 2) : digits;
        return typeof CbFormat !== 'undefined'
            ? CbFormat.formatMoney(value, 'USD', { maxFractionDigits: places, minFractionDigits: places })
            : `$${value.toFixed(places)}`;
    }

    function formatWhen(value) {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return 'unknown time';
        return typeof CbFormat !== 'undefined' ? CbFormat.formatDateTime(date) : date.toLocaleString();
    }

    function backendBase() {
        if (typeof root?.getBackendBase === 'function') return String(root.getBackendBase()).replace(/\/$/, '');
        const configured = root?.document?.querySelector?.('meta[name="consensus-api-base"]')?.content;
        if (configured) return String(configured).replace(/\/$/, '');
        const hostname = root?.location?.hostname || '';
        if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3000';
        return 'https://api.urbangametheory.xyz';
    }

    // openEntity({ type, id }): when the host can open an agreement or a design in place (the map), an
    // event's entity is a button that calls it; the standalone page has no opener, so there it is a
    // plain label.
    function mount(element, { events = [], loadRun = null, openEntity = null, showFilters = true, onVisibleCount = null, translate = null, onSelectActor = null, showActivityWithoutActor = false } = {}) {
        if (!element || !root?.document) throw new Error('ActorExplorer.mount needs an element and a document');
        const doc = root.document;
        const t = translatorOf(translate);
        let allEvents = newestFirst(events);
        let state = { query: '', controller: 'all', actorKey: null };
        let selectedActor = null;
        let runRequest = 0;
        let runDetail = null;
        element.replaceChildren();
        const filters = doc.createElement('div'); filters.className = 'ae-filters';
        const search = doc.createElement('input'); search.type = 'search';
        const controller = doc.createElement('select');
        [['all', 'controllerAll', 'All controllers'], ['human', 'controllerHuman', 'Person'], ['algorithm', 'controllerAlgorithm', 'Algorithm'], ['llm', 'controllerLlm', 'LLM agent']].forEach(([value, key, fallback]) => {
            const option = text(doc, 'option', t(`gameDialogs.log.actors.${key}`, fallback)); option.value = value; controller.append(option);
        });
        const clear = text(doc, 'button', '', 'btn'); clear.type = 'button';
        filters.append(search, controller, clear);
        const profiles = doc.createElement('section'); profiles.className = 'ae-profiles';
        const activity = doc.createElement('section'); activity.className = 'ae-activity';
        const detail = doc.createElement('aside'); detail.className = 'ae-run-detail'; detail.setAttribute('aria-live', 'polite');
        if (showFilters) element.append(filters);
        element.append(profiles, activity, detail);

        function renderRun(run) {
            detail.replaceChildren();
            detail.append(text(doc, 'h2', t('gameDialogs.log.actors.runTitle', 'Run {{id}}', { id: run.id }), 'ae-section-title'));
            detail.append(text(doc, 'p', t('gameDialogs.log.actors.runSummary', '{{persona}} · {{status}} · {{stage}}', {
                persona: run.persona || t('gameDialogs.log.actors.unknownPersona', 'Unknown actor'),
                status: t(`gameDialogs.log.actors.runStatus.${run.status || 'unknown'}`, run.status || t('gameDialogs.log.actors.unknownStatus', 'Unknown status')),
                stage: run.stage || t('gameDialogs.log.actors.runStageStarted', 'Started')
            }), 'ae-muted'));
            detail.append(text(doc, 'p', t('gameDialogs.log.actors.runCost', '{{model}} · {{amount}} exact cost', {
                model: run.model || t('gameDialogs.log.actors.noModel', 'No model recorded'),
                amount: formatUsd(runCostTotal(run))
            }), 'ae-muted'));
            (run.picks || []).forEach(pick => {
                const block = doc.createElement('div'); block.className = 'ae-rationale';
                block.append(text(doc, 'strong', pick.name || pick.candidateId || t('gameDialogs.log.actors.pick', 'Pick')));
                if (pick.rationale) block.append(text(doc, 'p', pick.rationale));
                block.append(text(doc, 'small', t('gameDialogs.log.actors.pickEntities', 'Agreement {{agreement}} · design {{design}}', {
                    agreement: pick.agreementCid || t('gameDialogs.log.actors.notProposed', 'not proposed'),
                    design: pick.designCid || t('gameDialogs.log.actors.notPublished', 'not published')
                })));
                detail.append(block);
            });
            (run.costs || []).forEach(cost => detail.append(text(doc, 'p', t('gameDialogs.log.actors.costItem', '{{item}}: {{model}} · {{amount}}', {
                item: cost.item || t('gameDialogs.log.actors.cost', 'Cost'), model: cost.model || t('gameDialogs.log.actors.noModel', 'No model recorded'), amount: formatUsd(Number(cost.usd))
            }), 'ae-provenance')));
        }

        function renderRunDetail() {
            detail.replaceChildren();
            if (!runDetail) return;
            if (runDetail.state === 'loading') {
                detail.append(text(doc, 'p', t('gameDialogs.log.actors.runLoading', 'Loading run details…'), 'ae-muted'));
            } else if (runDetail.state === 'error') {
                detail.append(text(doc, 'p', t('gameDialogs.log.actors.runError', 'Could not load run: {{error}}', { error: runDetail.error }), 'ae-error'));
            } else if (runDetail.run) renderRun(runDetail.run);
        }

        async function openRun(runId) {
            if (!runId || typeof loadRun !== 'function') return null;
            const request = ++runRequest;
            const currentRunId = String(runId);
            runDetail = { state: 'loading', runId: currentRunId };
            render();
            // The detail sits below the whole activity list; without this the click looked dead.
            const reveal = () => { if (typeof detail.scrollIntoView === 'function') detail.scrollIntoView({ block: 'start' }); };
            reveal();
            try {
                const run = await loadRun(currentRunId);
                if (request !== runRequest || runDetail?.runId !== currentRunId) return null;
                runDetail = { state: 'ready', runId: currentRunId, run };
                render();
                reveal();
                return run;
            }
            catch (error) {
                if (request !== runRequest || runDetail?.runId !== currentRunId) return null;
                runDetail = { state: 'error', runId: currentRunId, error: error.message };
                render();
                reveal();
                return null;
            }
        }

        function render() {
            const visible = filterEvents(allEvents, state);
            if (typeof onVisibleCount === 'function') onVisibleCount(visible.length);
            profiles.replaceChildren(text(doc, 'h2', t('gameDialogs.log.actors.title', 'Actors'), 'ae-section-title'));
            const cards = doc.createElement('div'); cards.className = 'ae-profile-grid';
            // Each profile is a selectable row (cb-option); the chosen actor is the pressed one.
            const profilesForView = buildActorProfiles(visible);
            if (state.actorKey && !profilesForView.some(profile => profile.key === state.actorKey) && selectedActor) {
                profilesForView.push({ key: state.actorKey, actor: selectedActor, retained: true });
            }
            profilesForView.forEach(profile => {
                const card = doc.createElement('button'); card.type = 'button'; card.className = 'cb-option';
                card.setAttribute('aria-pressed', state.actorKey === profile.key ? 'true' : 'false');
                const body = doc.createElement('span'); body.className = 'cb-option__text';
                const actorType = actorKindLabel(profile.actor.kind, t);
                const controller = profile.actor.kind === 'human' && profile.actor.controller === 'human'
                    ? ''
                    : ` · ${controllerLabel(profile.actor.controller, t)}`;
                body.append(text(doc, 'span', profile.actor.name, 'cb-option__title'), text(doc, 'span', `${actorType}${controller}`, 'cb-badge'));
                if (!profile.retained) body.append(text(doc, 'span', [
                    t(`gameDialogs.log.actors.countActivity.${profile.activityCount === 1 ? 'one' : 'many'}`, profile.activityCount === 1 ? '{{count}} activity' : '{{count}} activities', { count: profile.activityCount }),
                    t(`gameDialogs.log.actors.countAgreement.${profile.agreementCids.length === 1 ? 'one' : 'many'}`, profile.agreementCids.length === 1 ? '{{count}} agreement' : '{{count}} agreements', { count: profile.agreementCids.length }),
                    t(`gameDialogs.log.actors.countTransaction.${profile.transactionCount === 1 ? 'one' : 'many'}`, profile.transactionCount === 1 ? '{{count}} transaction' : '{{count}} transactions', { count: profile.transactionCount })
                ].join(' · '), 'cb-option__desc'));
                if (profile.actor.wallet) body.append(text(doc, 'code', short(profile.actor.wallet), 'ae-wallet'));
                if (profile.modelCostUsd) body.append(text(doc, 'span', t('gameDialogs.log.actors.modelCost', '{{amount}} model cost', { amount: formatUsd(profile.modelCostUsd) }), 'cb-option__desc'));
                card.append(body);
                card.addEventListener('click', () => {
                    selectActor(state.actorKey === profile.key ? null : profile.key, { notify: true, actor: profile.actor });
                });
                cards.append(card);
            });
            if (!cards.childElementCount) cards.append(text(doc, 'p', t('gameDialogs.log.actors.noActors', 'No actors match this filter.'), 'ae-empty'));
            profiles.append(cards);

            activity.replaceChildren(text(doc, 'h2', t('gameDialogs.log.actors.activityCount', 'Activity ({{count}})', { count: visible.length }), 'ae-section-title'));
            if (!state.actorKey && !showActivityWithoutActor && !runDetail) {
                activity.append(text(doc, 'p', t('gameDialogs.log.actors.chooseActor', 'Choose an actor to see its activity.'), 'ae-empty'));
                renderRunDetail();
                return;
            }
            const list = doc.createElement('ol'); list.className = 'ae-list';
            visible.forEach(event => {
                const item = doc.createElement('li'); item.className = event.ok ? 'ae-event' : 'ae-event is-failed';
                const actionLabel = t(`gameDialogs.log.actions.${event.action.type}`, ACTION_LABELS[event.action.type] || event.action.type);
                const heading = t('gameDialogs.log.actors.eventHeading', '{{actor}} · {{action}}', { actor: event.actor.name, action: actionLabel });
                item.append(text(doc, 'strong', heading));
                if (event.source === 'simulation') item.append(text(doc, 'span', t('gameDialogs.log.actors.sourceSimulation', 'Simulation'), 'cb-badge'));
                item.append(text(doc, 'span', event.message || `${event.action.type} ${event.entity?.id || ''}`, 'ae-event-message'));
                item.append(text(doc, 'time', formatWhen(event.recordedAt), 'ae-muted'));
                const meta = doc.createElement('div'); meta.className = 'ae-meta';
                if (ENTITY_LABELS[event.entity?.type] && event.entity.id) {
                    const entity = { type: event.entity.type, id: string(event.entity.id) };
                    const label = t(`gameDialogs.log.actors.entity.${entity.type}`, `${ENTITY_LABELS[entity.type]} {{id}}`, { id: shortCid(entity.id) });
                    if (typeof openEntity === 'function') {
                        const button = text(doc, 'button', label, 'cb-link'); button.type = 'button';
                        button.title = entity.id;
                        button.addEventListener('click', () => openEntity(entity));
                        meta.append(button);
                    } else {
                        meta.append(text(doc, 'span', label));
                    }
                }
                if (event.transaction) {
                    const transaction = text(doc, 'a', t('gameDialogs.log.actors.transaction', 'Transaction {{id}}', { id: short(event.transaction) }), 'cb-link cb-link--external ae-wallet');
                    transaction.href = `https://explorer.solana.com/tx/${encodeURIComponent(event.transaction)}?cluster=devnet`;
                    transaction.target = '_blank'; transaction.rel = 'noopener noreferrer';
                    meta.append(transaction);
                }
                if (event.runId) {
                    const run = text(doc, 'button', t('gameDialogs.log.actors.openRun', 'Run {{id}}', { id: short(event.runId) }), 'cb-link'); run.type = 'button'; run.addEventListener('click', () => openRun(event.runId)); meta.append(run);
                }
                if (event.model) meta.append(text(doc, 'span', t('gameDialogs.log.actors.eventModel', '{{model}}{{cost}}', { model: event.model, cost: event.modelCostUsd !== null ? ` · ${formatUsd(event.modelCostUsd)}` : '' }), 'cb-badge'));
                item.append(meta);
                const evidence = eventDetail(event);
                if (evidence.rationale || evidence.transaction || evidence.provenance) {
                    const more = doc.createElement('details'); more.append(text(doc, 'summary', t('gameDialogs.log.actors.evidence', 'Evidence')));
                    if (evidence.rationale) more.append(text(doc, 'p', evidence.rationale));
                    if (evidence.transaction) more.append(text(doc, 'p', t('gameDialogs.log.actors.transactionFull', 'Transaction: {{id}}', { id: evidence.transaction }), 'ae-provenance'));
                    if (evidence.provenance) more.append(text(doc, 'pre', JSON.stringify(evidence.provenance, null, 2), 'ae-provenance'));
                    item.append(more);
                }
                list.append(item);
            });
            if (!list.childElementCount) list.append(text(doc, 'li', t('gameDialogs.log.actors.noActivity', 'No activity matches this filter.'), 'ae-empty'));
            activity.append(list);
            renderRunDetail();
        }
        search.addEventListener('input', () => { state.query = search.value; render(); });
        controller.addEventListener('change', () => {
            state.controller = controller.value;
            if (state.actorKey) selectActor(null);
            else render();
        });

        function selectActor(value, { notify = false, actor: actorInput = null } = {}) {
            if (value === null || value === undefined || value === '') {
                state.actorKey = null;
                selectedActor = null;
                runDetail = null;
                ++runRequest;
                if (notify && typeof onSelectActor === 'function') onSelectActor(null);
                render();
                return null;
            }
            const id = String(value);
            const profile = buildActorProfiles(allEvents).find(candidate =>
                [candidate.key, candidate.actor.id, candidate.actor.wallet, candidate.actor.name]
                    .some(identity => identity != null && String(identity) === id));
            const actor = actorInput || profile?.actor || { id, name: id, kind: 'unknown', controller: 'unknown', wallet: null };
            state.query = '';
            state.controller = 'all';
            search.value = '';
            controller.value = 'all';
            state.actorKey = profile?.key || actorKey(actor) || id;
            selectedActor = { ...actor };
            if (runDetail) { runDetail = null; ++runRequest; }
            if (notify && typeof onSelectActor === 'function') {
                onSelectActor({ id: actor.id || null, wallet: actor.wallet || null, name: actor.name || null,
                    key: state.actorKey, actorKey: state.actorKey, kind: actor.kind || 'unknown', controller: actor.controller || 'unknown' });
            }
            render();
            return { ...selectedActor };
        }

        function reset() {
            state = { query: '', controller: 'all', actorKey: null };
            selectedActor = null;
            search.value = ''; controller.value = 'all';
            ++runRequest;
            runDetail = null;
            detail.replaceChildren();
            if (typeof onSelectActor === 'function') onSelectActor(null);
            render();
        }
        clear.addEventListener('click', reset);
        function relabel() {
            search.placeholder = t('gameDialogs.log.actors.search', 'Search actor, agreement, run or transaction');
            search.setAttribute('aria-label', search.placeholder);
            controller.setAttribute('aria-label', t('gameDialogs.log.actors.controllerAria', 'Actor controller'));
            clear.textContent = t('gameDialogs.log.actors.clearSelection', 'Clear selection');
            for (const option of controller.children) {
                const key = option.value === 'all' ? 'controllerAll' : `controller${option.value[0].toUpperCase()}${option.value.slice(1)}`;
                const fallback = { all: 'All controllers', human: 'Person', algorithm: 'Algorithm', llm: 'LLM agent' }[option.value];
                option.textContent = t(`gameDialogs.log.actors.${key}`, fallback);
            }
            profiles.setAttribute('aria-label', t('gameDialogs.log.actors.profilesAria', 'Actor profiles'));
            activity.setAttribute('aria-label', t('gameDialogs.log.actors.activityAria', 'Activity'));
            render();
        }
        relabel();
        return {
            reset,
            relabel,
            selectActor,
            openRun,
            onRun: openRun,
            getSelection() { return { actorKey: state.actorKey, actor: selectedActor ? { ...selectedActor } : null, runId: runDetail?.runId || null }; },
            setEvents(next) {
                allEvents = newestFirst(next);
                if (state.actorKey && selectedActor) {
                    const selectedIdentities = [state.actorKey, selectedActor.id, selectedActor.wallet, selectedActor.name]
                        .filter(identity => identity !== null && identity !== undefined).map(String);
                    const profile = buildActorProfiles(allEvents).find(candidate =>
                        [candidate.key, candidate.actor.id, candidate.actor.wallet, candidate.actor.name]
                            .some(identity => identity !== null && identity !== undefined && selectedIdentities.includes(String(identity))));
                    if (profile) {
                        state.actorKey = profile.key;
                        selectedActor = { ...profile.actor };
                    }
                }
                render();
            },
            getEvents() { return [...allEvents]; }
        };
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

    return { ACTION_LABELS, actionOptions, activityRowHtml, actorKey, backendBase, buildActorProfiles, eventDetail, eventsInvolvingActor, filterEvents, mount, newestFirst, normalizeEvent, runCostTotal };
});
