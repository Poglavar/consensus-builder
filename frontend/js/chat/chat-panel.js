(function (win, doc) {
    'use strict';
    // Loaded on the chat sheet's first open; the transcript outlives other sheets closing it.
    const transcript = win.__chatTranscript, context = win.__chatContext;
    const t = (key, values) => win.i18n?.t?.(key, values) || key;
    let host, introNode, messages, status, total, input, sendButton, undoButton, newButton, conversationCopyButton, state = transcript.initial(), lastSynced = null, turnBaseRow = null, turnBaseCaptured = false, resetAfterTurn = false, operation = false;
    const records = () => win.proposalStorage?.getAllProposals?.() || win.proposals || win.currentProposals || [];
    function dispatch(action) { state = transcript.reduce(state, action); render(); }
    function formatCost(value) { return win.CbFormat?.formatMoney?.(+value || 0, 'USD', { minFractionDigits: 4, maxFractionDigits: 4 }) || `$${(+value || 0).toFixed(4)}`; }
    function node(tag, cls, text) { const el = doc.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
    function currentAppliedRow(view) {
        const all = records();
        const row = context.currentPlanRow({ records: all, lastSynced, view, title: t('chat.planTitle'),
            cidOf: record => win.DesignRecord.cidOf(record), isApplied: record => win.isApplied?.(record) ?? record.applied === true,
            compose: (...args) => win.PlanComposition.create(...args) });
        if (!row) return null;
        const applied = new Map();
        all.forEach(record => { try { if (win.isApplied?.(record) ?? record.applied === true) applied.set(win.DesignRecord.cidOf(record), record); } catch (_) { /* ignore incomplete local records */ } });
        return { ...row, memberIds: row.designs.map((member, index) => {
            const record = applied.get(member.cid);
            if (record?.proposalId != null) return String(record.proposalId);
            const oldIndex = lastSynced?.designs?.findIndex(item => item.cid === member.cid) ?? -1;
            return oldIndex >= 0 ? lastSynced.memberIds?.[oldIndex] || `shared-plan-${member.cid}` : row.memberIds?.[index] || `shared-plan-${member.cid}`;
        }) };
    }
    function appliedMembersMatch(row) {
        const current = currentAppliedRow(win.MapShare?.capture?.(win));
        const wanted = (row?.content?.designCids || []).map(String).sort();
        const actual = (current?.content?.designCids || []).map(String).sort();
        return wanted.length === actual.length && wanted.every((cid, index) => cid === actual[index]);
    }
    function actionButton(key, cls, action) {
        const button = node('button', cls, t(key)); button.type = 'button';
        button.addEventListener('click', () => win.BusyControl.track(button, action).catch(showError)); return button;
    }
    function copyButton(key, readText) {
        const button = node('button', 'btn btn-quiet btn-sm chat-copy-button'); button.type = 'button';
        button.setAttribute('aria-label', t(key)); button.title = t(key);
        const icon = node('i', 'fas fa-copy'); icon.setAttribute('aria-hidden', 'true'); button.append(icon);
        button.addEventListener('click', () => win.BusyControl.track(button, async () => {
            const copied = await win.copyTextWithFeedback?.(readText());
            status.textContent = copied ? '' : t('chat.copyFailed');
        }).catch(() => { status.textContent = t('chat.copyFailed'); }));
        return button;
    }
    function serializeConversation() {
        return transcript.serializeConversation(state, { you: t('chat.roles.you'), agent: t('chat.roles.agent'), options: t('chat.optionsLabel') });
    }
    function buildContext(forceArtifact = false) {
        const city = win.CityConfigManager?.getCurrentCityId?.() || win.currentCityId || win.currentCity;
        const stack = win.ClickStack?.current?.();
        const instance = stack && win.__clickStackModel?.selectedInstance?.(stack, stack.selectedKind);
        const selected = win.selectedProposal || instance?.proposal || instance?.record || instance?.localRecord
            || (instance?.id ? win.proposalStorage?.getProposal?.(instance.id) : null);
        const parcelSourceId = win.DesignSync?.parcelSourceIdOf?.(city);
        const view = win.MapShare?.capture?.(win);
        const row = currentAppliedRow(view);
        if (state.pending) { turnBaseRow = row; turnBaseCaptured = true; }
        const applied = records().filter(record => { try { return win.isApplied(record); } catch (_) { return false; } });
        const build = context.buildContext({ city, parcelSourceId, title: t('chat.planTitle'),
            view, records: records(), lastSynced, selected,
            selectedBuildingIndex: selected?.selectedBuildingIndex ?? selected?.buildingIndex ?? selected?.properties?.buildingIndex,
            cidOf: record => win.DesignRecord.cidOf(record), isApplied: record => win.isApplied?.(record) ?? record.applied === true,
            compose: (...args) => win.PlanComposition.create(...args), artifactOf: row => win.SharedPlanSession.artifactOf(row),
            stack, stackModel: win.__clickStackModel, selectedParcels: win.multiParcelSelection?.selectedParcels || win.selectedParcelIds });
        if (forceArtifact) {
            const row = context.currentPlanRow({ records: applied, lastSynced, view, title: t('chat.planTitle'),
                cidOf: record => win.DesignRecord.cidOf(record), isApplied: record => win.isApplied?.(record) ?? record.applied === true,
                compose: (...args) => win.PlanComposition.create(...args) });
            if (row) { build.planCid = row.cid; build.planArtifact = { ...win.SharedPlanSession.artifactOf(row), cid: row.cid }; }
        }
        build.selection = { ...build.selection, ...win.ChatNavigation?.capture?.() };
        return build;
    }
    function mount(root) {
        if (!root) return;
        if (host === root) { render(); return; }
        host = root; root.replaceChildren();
        introNode = node('p', 'chat-intro', t('chat.intro')); root.append(introNode);
        messages = node('div', 'chat-transcript'); messages.setAttribute('role', 'log'); messages.setAttribute('aria-live', 'polite'); messages.setAttribute('aria-label', t('chat.title'));
        status = node('div', 'chat-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        total = node('p', 'chat-cost');
        const controls = node('div', 'chat-controls');
        undoButton = actionButton('chat.undo', 'btn btn-quiet btn-sm', undo);
        conversationCopyButton = copyButton('chat.copyConversation', serializeConversation);
        newButton = actionButton('chat.newConversation', 'btn btn-quiet btn-sm', reset); controls.append(undoButton, conversationCopyButton, newButton);
        const composer = node('div', 'chat-composer'); input = node('textarea', 'chat-input'); input.rows = 2; input.enterKeyHint = 'send'; input.placeholder = t('chat.placeholder'); input.setAttribute('aria-label', t('chat.placeholder'));
        sendButton = actionButton('chat.send', 'btn btn-primary btn-sm', () => send(input.value));
        input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); win.BusyControl.track(sendButton, () => send(input.value)).catch(showError); } });
        composer.append(input, sendButton); root.append(messages, status, total, controls, composer);
        const saved = win.ChatClient.conversation(); if (saved) dispatch({ type: 'conversation', conversation: saved }); else render();
    }
    function showError(error) { dispatch({ type: 'turn:failed', code: error?.code || 'stream_error', status: error?.status }); }
    async function send(text) {
        const value = String(text || '').trim(); if (!value || operation) return;
        operation = true; render();
        input.value = ''; input.disabled = true;
        try {
            let conv = state.conversation || win.ChatClient.conversation();
            if (!conv) { conv = await win.ChatClient.start(win.i18n?.getLanguage?.() || win.i18n?.language || 'en', win.CityConfigManager?.getCurrentCityId?.() || win.currentCityId || win.currentCity); dispatch({ type: 'conversation', conversation: conv }); }
            dispatch({ type: 'turn:start', text: value }); status.textContent = t('chat.working'); let planEvent = null, navigation = Promise.resolve(), navigationError = null;
            const turnKey = win.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const sendTurn = includeArtifact => win.ChatClient.turn(conv.id, { text: value,
                language: win.i18n?.getLanguage?.() || 'en', turnKey, context: buildContext(includeArtifact) },
                { onEvent(event) {
                    if (event.name === 'plan') planEvent = event;
                    if (['view', 'selection'].includes(event.name)) navigation = navigation.then(async () => {
                        if (!navigationError) await win.ChatNavigation.apply(event);
                    }).catch(error => { navigationError = error; });
                    dispatch({ type: 'event', event });
                } });
            try { await sendTurn(false); }
            catch (error) {
                if (error.status !== 409 || !['plan_artifact_required', 'plan_reference_expired'].includes(error.code)) throw error;
                await sendTurn(true);
            }
            await navigation;
            if (navigationError) throw navigationError;
            if (planEvent) await applyPlan(planEvent);
        } catch (error) {
            if (state.conversation && win.ChatClient.sync) {
                try {
                    const synced = await win.ChatClient.sync(state.conversation.id);
                    dispatch({ type: 'conversation:sync', conversation: synced });
                    if (turnBaseCaptured && appliedMembersMatch(turnBaseRow) && synced.plan?.cid !== lastSynced?.cid) {
                        await applyPlan(synced.plan ? { draftRef: synced.plan.draftRef, cid: synced.plan.cid } : { draftRef: null, cid: null });
                    }
                } catch (_) { /* retain the stream error */ }
            }
            showError(error);
        }
        finally {
            operation = false; dispatch({ type: 'turn:end' });
            turnBaseRow = null; turnBaseCaptured = false;
            if (resetAfterTurn) { resetAfterTurn = false; await reset({ locked: true }); }
            else if (host?.closest('.map-sheet') && !host.closest('.map-sheet').hidden) input.focus({ preventScroll: true });
        }
    }
    async function applyPlan(event, kind = 'edit') {
        try {
            const previous = turnBaseRow || lastSynced;
            if (!event.draftRef) {
                if (event.cid) throw Object.assign(new Error('A plan revision is missing its private reference.'), { code: 'invalid-plan-reference' });
                await clearAppliedPlan(previous);
                dispatch({ type: kind === 'undo' ? 'undo:done' : 'plan:applied', kind, plan: { ...event, cid: null } });
                win.showEphemeralMessage?.(t('chat.planApplied'), 5000, 'success');
                return;
            }
            const draftPage = new URL('/designs', win.location.origin); draftPage.searchParams.set('draft', event.draftRef);
            const loaded = await win.DraftLink.load(draftPage.href);
            const artifact = context.artifactFromDraft(loaded, { cidOf: content => win.Cid.cidOfObject(content), cid: event.cid });
            const next = context.nextRowFromDraft(artifact, previous, { rowOf: (value, ids) => win.SharedPlanSession.rowOf(value, ids) });
            if (event.cid && next.cid !== event.cid) throw Object.assign(new Error('The private plan revision does not match its identifier.'), { code: 'plan-cid-mismatch' });
            const lastChange = context.lastChangeOf(previous, next, event.changes, kind);
            await win.PlanDialog.syncSharedPlanOnMap(next, previous || { designs: [], memberIds: [] }, { lastChange, present: false, notice: null });
            lastSynced = next;
            dispatch({ type: kind === 'undo' ? 'undo:done' : 'plan:applied', kind, plan: { ...event, cid: next.cid } });
            win.showEphemeralMessage?.(t('chat.planApplied'), 5000, 'success');
        } catch (error) { dispatch({ type: 'plan:failed', kind, plan: event, error: error?.code || 'plan_failed' }); throw error; }
    }
    async function clearAppliedPlan(previous) {
        if (previous) {
            const opened = await win.handleSharedDesignRoute([], { draftRows: new Map(), enter3D: false, openDetails: false,
                summary: false, frame: false, replaceAppliedIds: (previous.memberIds || []).map(String), retainedProposalIds: [], sharedPlanSessionRemote: true });
            if (opened.failed.length || opened.blocked) throw new Error('The initial plan change could not be removed from this map.');
        }
        lastSynced = null;
    }
    async function undo() {
        if (!state.lastPlan?.applied || !state.conversation || operation) return;
        operation = true; render();
        try {
            const result = await win.ChatClient.undo(state.conversation.id);
            await applyPlan({ draftRef: result.draftRef, cid: result.cid, changes: result.changes || [] }, 'undo');
        } finally {
            operation = false;
            if (resetAfterTurn) { resetAfterTurn = false; await reset(); }
            else render();
        }
    }
    async function reset({ locked = false } = {}) {
        if (operation && !locked) return;
        const ownLock = !operation; if (ownLock) { operation = true; render(); }
        try {
            if (state.conversation) await win.ChatClient.end(state.conversation.id);
            lastSynced = null; turnBaseRow = null; turnBaseCaptured = false;
            dispatch({ type: 'reset' }); if (input) input.value = '';
        } finally { if (ownLock) { operation = false; render(); } }
    }
    function highlight(ref) {
        const parsed = context.parseRef(ref); if (!parsed) return;
        const record = win.DesignSync.localCopyOf(parsed.designCid);
        if (!record) return;
        const buildings = record.content?.geometry?.buildings || record.geometry?.buildings || [];
        const features = parsed.buildingIndex == null
            ? win.ClickStackHits?.featuresFor?.('designs', { id: record.proposalId }) || []
            : [buildings[parsed.buildingIndex]].filter(Boolean).map(building => building.type === 'Feature' ? building : ({ type: 'Feature', geometry: building.geometry, properties: building.properties || {} }));
        win.highlightFeaturesForInspection?.(features, { className: 'chat-ref-highlight' });
        win.focusThreeModeOnProposals?.([record.proposalId]);
    }
    const expandedSteps = new Set();
    function render() {
        if (!messages) return;
        const focused = messages.contains(doc.activeElement) ? doc.activeElement?.dataset?.chatOptionKey : null;
        messages.querySelectorAll('details.chat-steps[open]').forEach(details => expandedSteps.add(details.dataset.chatMessageId));
        messages.replaceChildren();
        state.messages.forEach(message => {
            const article = node('article', `chat-message chat-message--${message.role}`);
            article.append(node('strong', '', t(message.role === 'user' ? 'chat.roles.you' : 'chat.roles.agent')));
            if (message.text) article.append(node('p', '', message.text));
            if (message.pending) article.append(node('p', '', t('chat.working')));
            if (message.steps?.length) {
                const details = node('details', 'chat-steps'), key = String(message.id), summary = node('summary', '', t('chat.steps.other', { count: message.steps.length })), list = node('ol');
                details.dataset.chatMessageId = key; details.open = expandedSteps.has(key);
                details.addEventListener('toggle', () => { if (details.open) expandedSteps.add(key); else expandedSteps.delete(key); });
                message.steps.forEach(step => list.append(node('li', '', step.tool || step.name || t('chat.stepFailed')))); details.append(summary, list); article.append(details);
            }
            if (message.options?.length) { const options = node('div', 'chat-options'); message.options.forEach((option, index) => { const chip = node('button', 'btn btn-sm chat-option', option.label); chip.type = 'button'; chip.dataset.chatOptionKey = `${message.id}:${index}`; chip.addEventListener('focus', () => highlight(option.ref)); chip.addEventListener('mouseenter', () => highlight(option.ref)); chip.addEventListener('blur', () => win.highlightFeaturesForInspection?.([])); chip.addEventListener('mouseleave', () => win.highlightFeaturesForInspection?.([])); chip.addEventListener('click', () => win.BusyControl.track(sendButton, () => send(option.label)).catch(showError)); options.append(chip); }); article.append(options); }
            if (message.role === 'agent' && message.text?.trim()) article.append(copyButton('chat.copyReply', () => message.text));
            messages.append(article);
        });
        messages.scrollTop = messages.scrollHeight;
        if (focused) [...messages.querySelectorAll('.chat-option')].find(button => button.dataset.chatOptionKey === focused)?.focus({ preventScroll: true });
        status.textContent = state.pending ? t('chat.working') : state.error ? t(state.error.key || transcript.errorKey(state.error.code, state.error.status)) : '';
        total.hidden = state.conversation?.debugCosts !== true || !state.totals.turns;
        total.textContent = !total.hidden ? t('chat.sessionTotal.other', { cost: formatCost(state.totals.spentUsd), count: state.totals.turns }) : '';
        conversationCopyButton.disabled = !serializeConversation();
        input.disabled = !!state.pending || operation; sendButton.disabled = !!state.pending || operation;
        undoButton.disabled = !state.lastPlan?.applied || !!state.pending || operation; newButton.disabled = !!state.pending || operation;
    }
    win.addEventListener('cityChanged', () => { if (operation) resetAfterTurn = true; else reset().catch(showError); });
    win.addEventListener('i18n:translationsLoaded', () => {
        if (!host) return;
        introNode.textContent = t('chat.intro');
        input.placeholder = t('chat.placeholder'); input.setAttribute('aria-label', t('chat.placeholder'));
        sendButton.textContent = t('chat.send'); undoButton.textContent = t('chat.undo'); newButton.textContent = t('chat.newConversation');
        conversationCopyButton.setAttribute('aria-label', t('chat.copyConversation')); conversationCopyButton.title = t('chat.copyConversation');
        messages.setAttribute('aria-label', t('chat.title')); render();
    });
    win.ChatPanel = Object.freeze({ mount, open: mount, send, undo, reset, state: () => state });
})(window, document);
