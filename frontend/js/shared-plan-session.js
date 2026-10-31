// A private, turn-taking connection around immutable plan revisions.  The server is the
// authority for the current revision; this browser retains only its owner capability.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.location) root.SharedPlanSession = api.browser(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PREFIX = 'ugt.shared-plan-session/v1:';
    const cleanBase = value => String(value || '').replace(/\/+$/, '');
    const fail = (message, code = 'shared-plan-session') => Object.assign(new Error(message), { code });
    const copy = value => structuredClone(value);

    function artifactOf(row) {
        if (!row || !row.content || !Array.isArray(row.designs)) throw fail('Choose a complete plan revision first.', 'invalid-plan');
        return {
            plan: copy(row.content),
            designs: row.designs.map(member => {
                const source = row.designSources?.[member.cid];
                const parcelSourceId = typeof source === 'string' ? source : source?.sourceId;
                return { cid: member.cid, content: copy(member.content),
                    ...(typeof parcelSourceId === 'string' && parcelSourceId ? { parcelSourceId: parcelSourceId === 'hr-cadastre' ? 'oss-wfs' : parcelSourceId } : {}) };
            })
        };
    }
    function rowOf(artifact, memberIds = {}, runtime = root) {
        if (!artifact?.plan || !Array.isArray(artifact.designs)) throw fail('The shared plan response is incomplete.', 'invalid-plan');
        const byCid = new Map(artifact.designs.map(member => [member.cid, member]));
        const designs = (artifact.plan.designCids || []).map(cid => {
            const member = byCid.get(cid);
            if (!member?.content) throw fail('The shared plan is missing a design member.', 'invalid-plan');
            return { cid, content: copy(member.content) };
        });
        const sources = Object.fromEntries(artifact.designs.filter(member => member.parcelSourceId)
            .map(member => {
                const sourceId = typeof member.parcelSourceId === 'string' ? member.parcelSourceId : member.parcelSourceId.sourceId;
                return [member.cid, { sourceId: sourceId === 'oss-wfs' ? 'hr-cadastre' : sourceId, snapshotId: null }];
            }));
        const row = { cid: runtime.Cid.cidOfObject(artifact.plan), content: copy(artifact.plan), designs,
            memberIds: designs.map(member => memberIds[member.cid] || `shared-plan-${member.cid}`), designSources: sources };
        runtime.PlanComposition.validate(row);
        return row;
    }
    // Follow the ordinary editor's applied revision chain. Copies are separate work, and two
    // applied forks need an explicit choice rather than an arbitrary latest-timestamp winner.
    function currentMembers(row, records, runtime = root) {
        return row.memberIds.map((id, index) => {
            let current = records.find(record => String(record.proposalId) === String(id));
            let cid = row.designs[index].cid;
            // The ordinary plan composer carries immutable members with temporary IDs.
            // Recover their applied identity by exact content before following later forks.
            if (!current) {
                const matches = records.filter(record => record.applied === true && runtime.DesignRecord.cidOf(record) === cid);
                if (matches.length > 1) throw fail('More than one local instance is applied. Choose the intended design before saving the shared plan.', 'shared-plan-revision-ambiguous');
                current = matches[0];
            }
            const seen = new Set();
            while (true) {
                const localId = String(current?.proposalId || id);
                if (seen.has(localId)) throw fail('The local revision chain contains a cycle.', 'shared-plan-revision-cycle');
                seen.add(localId);
                const forks = records.filter(record => {
                    if (record.applied !== true || String(record.proposalId) === localId) return false;
                    const origin = record.proposalOrigin;
                    return ['revision', 'rebind'].includes(origin?.relation) &&
                        ((origin.source?.kind === 'local' && origin.source.localProposalId === localId)
                        || (origin.source?.kind === 'design' && origin.source.cid === (current?.published?.cid || cid)));
                });
                if (forks.length > 1) throw fail('More than one local revision is applied. Choose the intended design before saving the shared plan.', 'shared-plan-revision-ambiguous');
                if (!forks.length) {
                    if (!current) throw fail('A shared-plan member is missing locally.', 'shared-plan-member-missing');
                    return current;
                }
                current = forks[0]; cid = runtime.DesignRecord.cidOf(current);
            }
        });
    }
    function composeCurrentPlan(row, members, runtime) {
        // Construction windows follow the corresponding design when its content CID changes.
        const schedule = {};
        row.designs.forEach((member, index) => {
            const cid = runtime.DesignRecord.cidOf(members[index]);
            const window = row.content.schedule?.[member.cid];
            if (cid && window) schedule[cid] = copy(window);
        });
        return runtime.PlanComposition.create(row.content.title, members, row.content.view,
            Object.keys(schedule).length ? schedule : null);
    }
    function endpoint(win) {
        // URL parameters cannot choose a recipient for private content on a hosted page.
        // Development overrides are restricted to loopback pages and loopback services.
        const page = new URL(win.location.origin);
        const loopback = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        const explicit = new URLSearchParams(win.location.search).get('mcp');
        if (explicit && loopback(page)) {
            const target = new URL(explicit);
            if (!loopback(target) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
                throw fail('The local MCP override must be a loopback HTTP origin.', 'shared-plan-endpoint-invalid');
            }
            return target.origin + '/mcp/plan-sessions';
        }
        return cleanBase(win.resolveFrontendBaseUrl?.() || page.origin) + '/mcp/plan-sessions';
    }
    function browser(win) {
        let active = null;
        let connection = null, connectionId = null, refreshQueued = false, draining = false;
        let connectionStatus = '', applying = false, agentEditing = false, announcement = '';
        let live = null;
        const t = (key, fallback) => win.i18n?.t?.(`sharedPlan.${key}`) || fallback;
        const announce = text => {
            announcement = text;
            if (win.document?.body) {
                if (!live) {
                    live = win.document.createElement('div'); live.className = 'shared-plan-live';
                    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
                    live.setAttribute('aria-atomic', 'true'); win.document.body.append(live);
                }
                live.textContent = text; live.hidden = !text;
            }
            notifyPanels({ statusChanged: true });
        };
        const closeConnection = () => { connection?.close(); connection = null; connectionId = null; refreshQueued = false; };

        let resumeInFlight = null;
        let operationTail = Promise.resolve();
        const exclusive = task => {
            const operation = operationTail.then(task, task);
            operationTail = operation.catch(() => {});
            return operation;
        };
        const panelSubscribers = new Set();
        const notifyPanels = detail => panelSubscribers.forEach(listener => {
            try { listener(detail); } catch (_) { /* a closed panel cannot stop the shared session */ }
        });
        const namespace = base => `${PREFIX}${new URL(base).origin}:${win.BrowserWorkspace?.id || 'browser'}:`;
        const key = (base, id) => namespace(base) + id;
        const planKey = (base, cid) => namespace(base) + 'plan:' + cid;
        const activeKey = base => namespace(base) + 'active';
        const storageReady = async () => {
            if (typeof win.PersistentStorage?.ensureReady === 'function') {
                await new Promise(resolve => win.PersistentStorage.ensureReady(resolve));
            }
        };
        const stored = (base, id) => {
            try { return JSON.parse(win.PersistentStorage.getItem(key(base, id)) || 'null'); } catch (_) { return null; }
        };
        const remember = (base, session, cid = null, memberIds = null) => {
            if (!session?.id) return;
            const old = stored(base, session.id) || {};
            const ownerToken = session.ownerToken || old.ownerToken;
            if (!ownerToken) return;
            win.PersistentStorage.setItem(key(base, session.id), JSON.stringify({ ...old, ownerToken,
                ...(session.inviteToken ? { inviteToken: session.inviteToken } : {}),
                ...(typeof session.controller === 'string' ? { controller: session.controller } : {}),
                ...(Number.isInteger(session.version) ? { version: session.version } : {}),
                ...(Array.isArray(session.artifact?.plan?.designCids) ? { designCids: session.artifact.plan.designCids } : {}),
                ...(Array.isArray(memberIds) ? { memberIds: memberIds.map(String) } : {}) }));
            if (cid) win.PersistentStorage.setItem(planKey(base, cid), session.id);
        };
        const forget = (base, id, cid = null) => { win.PersistentStorage.removeItem(key(base, id)); if (cid) win.PersistentStorage.removeItem(planKey(base, cid)); };
        const request = async (base, path, { method = 'GET', token = null, body = null } = {}) => {
            const segments = Array.isArray(path) ? path : (path ? [path] : []);
            const suffix = segments.map(segment => encodeURIComponent(segment)).join('/');
            const response = await win.fetch(suffix ? `${base}/${suffix}` : base, {
                method, cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(method === 'GET' ? 30_000 : 120_000)
            });
            let data = null; try { data = await response.json(); } catch (_) { /* normalized below */ }
            if (!response.ok) {
                const error = Object.assign(new Error(data?.message || data?.error || `Shared plan request failed (${response.status}).`),
                    { code: data?.code || `http-${response.status}`, status: response.status, current: data?.current || null });
                if (segments[0] && ['shared-plan-expired', 'shared-plan-not-found'].includes(error.code)) {
                    // Keep every local revision, but release the expired server's editing lock.
                    forget(base, segments[0]);
                    let pointer; try { pointer = JSON.parse(win.PersistentStorage.getItem(activeKey(base)) || 'null'); } catch (_) { }
                    if (pointer?.id === segments[0]) {
                        win.PersistentStorage.removeItem(activeKey(base)); active = null; closeConnection();
                    }
                    notifyPanels({ id: segments[0], ended: true, error });
                }
                throw error;
            }
            return data;
        };
        function client(base = endpoint(win)) {
            const origin = cleanBase(base);
            return Object.freeze({
                base: origin,
                create: async row => {
                    const result = await request(origin, '', { method: 'POST', body: { plan: artifactOf(row) } });
                    remember(origin, result, row.cid); return result;
                },
                read: async id => {
                    const capability = stored(origin, id); if (!capability?.ownerToken) throw fail('This browser no longer has control of that shared plan.', 'owner-capability-missing');
                    return request(origin, id, { token: capability.ownerToken });
                },
                control: async (id, expectedVersion, controller, revoke = false) => {
                    const capability = stored(origin, id); if (!capability?.ownerToken) throw fail('This browser no longer has control of that shared plan.', 'owner-capability-missing');
                    return request(origin, [id, 'control'], { method: 'POST', token: capability.ownerToken,
                        body: { expectedVersion, controller, ...(revoke ? { revoke: true } : {}) } });
                },
                save: async (id, expectedVersion, row) => {
                    const capability = stored(origin, id); if (!capability?.ownerToken) throw fail('This browser no longer has control of that shared plan.', 'owner-capability-missing');
                    return request(origin, id, { method: 'PUT', token: capability.ownerToken,
                        body: { expectedVersion, plan: artifactOf(row) } });
                },
                undo: async (id, expectedVersion) => {
                    const capability = stored(origin, id); if (!capability?.ownerToken) throw fail('This browser no longer has control of that shared plan.', 'owner-capability-missing');
                    return request(origin, [id, 'undo'], { method: 'POST', token: capability.ownerToken, body: { expectedVersion } });
                },
                forget: (id, cid) => forget(origin, id, cid)
            });
        }
        function invitation(session, base) {
            // The capability belongs in a copied invitation, not a browser address, history or plan.
            const saved = stored(base, session.id);
            return JSON.stringify({ endpoint: cleanBase(base), sessionId: session.id, inviteToken: session.inviteToken || saved?.inviteToken }, null, 2);
        }
        function mount({ row, host, onChange = () => {} }) {
            const doc = host.ownerDocument, t = (key, fallback) => win.i18n?.t?.(`sharedPlan.${key}`) || fallback;
            let session = null, stopped = false, conflict = false, busy = false, resuming = true, sessionError = null, notice = '';
            const state = doc.createElement('p'); state.className = 'shared-plan-session__status'; state.setAttribute('role', 'status');
            state.setAttribute('aria-live', 'polite');
            const feedback = doc.createElement('p'); feedback.className = 'shared-plan-session__feedback'; feedback.setAttribute('role', 'alert');
            const actions = doc.createElement('div'); actions.className = 'shared-plan-session__sections';
            const panel = doc.createElement('section'); panel.className = 'shared-plan-session';
            panel.append(state, feedback, actions); host.append(panel);
            const group = (title, description, name) => {
                const section = doc.createElement('section'); section.className = `shared-plan-session__group shared-plan-session__group--${name}`;
                const heading = doc.createElement('h3'); heading.textContent = title;
                const hint = doc.createElement('p'); hint.textContent = description;
                const controls = doc.createElement('div'); controls.className = 'shared-plan-session__actions';
                section.append(heading, hint, controls); actions.append(section); return controls;
            };
            const action = (label, task, primary = false, serialize = false, target = actions) => {
                const el = doc.createElement('button'); el.type = 'button'; el.className = `btn${primary ? ' btn-primary' : ''}`; el.textContent = label;
                el.addEventListener('click', async () => {
                    if (busy) return;
                    busy = true; sessionError = null; notice = ''; feedback.textContent = '';
                    panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
                    try {
                        await win.BusyControl.track(el, () => serialize ? exclusive(task) : task());
                    } catch (error) { sessionError = error; }
                    finally { busy = false; if (!stopped) render(); }
                }); target.append(el); return el;
            };
            const currentRow = () => {
                // A normal editor may have forked a connected member. Recompose the exact current
                // local members at Save time instead of sending the revision that opened this card.
                const members = currentMembers(row, win.proposalStorage?.getAllProposals?.() || [], win);
                const editing = win.getActiveProposalDesignDraft?.();
                const ids = new Set([...row.memberIds, ...members.map(member => String(member.proposalId))]);
                if ((editing?.sourceLocalProposalId && ids.has(String(editing.sourceLocalProposalId)))
                    || [...ids].some(id => win.isProposalEditSaving?.(id))) {
                    throw fail('Finish or cancel the local edit before saving or changing turns.', 'shared-plan-editor-active');
                }
                return composeCurrentPlan(row, members, win);
            };
            const publishActive = () => {
                active = session ? { controller: session.controller || 'pending', designCids: new Set(row.content.designCids),
                    memberIds: new Set((row.memberIds || []).map(String)) } : null;
                if (session?.base) remember(session.base, session, row.cid, row.memberIds);
                win.dispatchEvent(new win.CustomEvent('sharedplansessionchange'));
                notifyPanels({ id: session?.id || null, session, row });
            };
            const replace = async (next, localRow = null) => {
                const source = localRow || row;
                const ids = Object.fromEntries((source?.designs || []).map((member, index) => [member.cid, source.memberIds?.[index]]));
                const nextRow = rowOf(next.artifact, ids, win);
                row = nextRow;
                onChange(row);
                win.PlanWorkspace.save(nextRow);
                remember(session.base, session, nextRow.cid, nextRow.memberIds);
                win.PersistentStorage.setItem(activeKey(session.base), JSON.stringify({ id: session.id, cid: nextRow.cid, memberIds: nextRow.memberIds || [] }));
            };
            const render = () => {
                if (busy || stopped || resuming) return;
                const focusedLabel = panel.contains(doc.activeElement) ? doc.activeElement.textContent : null;
                actions.replaceChildren();
                feedback.textContent = sessionError?.message || notice;
                feedback.setAttribute('role', sessionError ? 'alert' : 'status');
                feedback.classList.toggle('shared-plan-session__feedback--error', !!sessionError);
                if (!session) {
                    action(t('collaborate', 'Collaborate'), async () => {
                        const source = client();
                        const existing = pendingSession();
                        if (existing && ![existing.pointer.cid, existing.pointer.localCid].includes(row.cid)) {
                            throw fail('Disconnect the active shared plan before collaborating on another plan.', 'shared-plan-session-already-active');
                        }
                        if (existing) {
                            session = { id: existing.pointer.id, base: source.base, controller: existing.capability.controller,
                                version: existing.capability.version || null };
                            return;
                        }
                        const current = currentRow(); const created = await source.create(current); session = { ...created, base: source.base }; remember(source.base, session, row.cid, current.memberIds);
                        row = current;
                        win.PersistentStorage.setItem(activeKey(source.base), JSON.stringify({ id: session.id, cid: row.cid, memberIds: row.memberIds || [] })); publishActive(); ensureConnection();
                    }, true, true);
                    state.textContent = t('notConnected', 'Create a private shared session for this exact plan revision.'); return;
                }
                const agent = session.controller === 'agent';
                state.textContent = applying ? t('applying', 'Applying the accepted changes…')
                    : agent && agentEditing ? t('working', 'The agent is working on a change…')
                    : agent ? t('agentControl', 'The agent has editing control. Waiting for its next change.')
                    : t('youEditing', 'You have editing control.');
                if (connectionStatus === 'reconnecting') state.textContent += ' ' + t('reconnecting', 'Reconnecting to the shared plan…');
                const pending = row.cid !== pendingSession()?.pointer.cid;
                const changes = group(t('changes', 'Plan changes'), conflict
                    ? t('localConflict', 'A local revision differs from the shared plan. Save it to keep your version, or reload the shared revision.')
                    : pending ? t('unsaved', 'Your local changes have not been saved to the shared plan.')
                    : t('saved', 'All changes are saved to the shared plan.'), 'changes');
                if (!agent) {
                    const save = action(t('save', 'Save to shared plan'), async () => {
                        const current = currentRow(); const saved = await client(session.base).save(session.id, session.version, current);
                        session = { ...session, ...saved }; await replace(session, current); conflict = false; sessionError = null; publishActive(); ensureConnection();
                    }, true, true, changes);
                    save.disabled = !pending && !conflict && !sessionError;
                    if (session.canUndo) {
                        const undo = action(t('undo', 'Undo last agent change'), async () => {
                            await exclusive(async () => {
                                if (currentRow().cid !== pendingSession()?.pointer.cid) throw fail(t('undoPending', 'Save or reload your local changes before undoing the agent change.'));
                                const accepted = await client(session.base).undo(session.id, session.version);
                                session = { ...session, ...accepted };
                            });
                            await resumeActive({ acceptOwnerConflict: true });
                            if (!active?.paused) ensureConnection();
                        }, false, false, changes);
                        undo.disabled = pending || conflict;
                    }
                }
                if (conflict || sessionError) action(t('reload', 'Reload shared revision'), async () => {
                    await resumeActive({ acceptOwnerConflict: true });
                    conflict = false;
                    if (!active?.paused) ensureConnection();
                }, false, false, changes);
                const control = group(t('control', 'Editing control'), agent
                    ? t('takeHint', 'Take control to stop agent edits and make your own changes.')
                    : t('handoverHint', 'Hand over when you are ready. Your current changes are saved first.'), 'control');
                if (!agent) {
                    action(t('letAgentEdit', 'Let agent edit'), async () => {
                        if (win.OnMapEditor?.isActive?.()) throw fail('Finish or cancel the open design editor before giving the agent control.', 'shared-plan-editor-active');
                        // Publish the exact local fork before changing turns; the agent must never
                        // receive an older plan while this browser keeps an unpublished revision.
                        const current = currentRow();
                        if (current.cid !== pendingSession()?.pointer.cid) {
                            const saved = await client(session.base).save(session.id, session.version, current);
                            session = { ...session, ...saved }; await replace(session, current);
                        }
                        const previousController = session.controller;
                        session = { ...session, controller: 'pending' }; publishActive();
                        try {
                            const changed = await client(session.base).control(session.id, session.version, 'agent');
                            session = { ...session, ...changed }; publishActive();
                        } catch (error) { session = { ...session, controller: previousController }; publishActive(); throw error; }
                    }, false, true, control);
                } else action(t('takeControl', 'Take control'), async () => {
                    const previousController = session.controller;
                    session = { ...session, controller: 'pending' }; publishActive();
                    try {
                        const changed = await client(session.base).control(session.id, session.version, 'owner');
                        session = { ...session, ...changed }; publishActive();
                    } catch (error) { session = { ...session, controller: previousController }; publishActive(); throw error; }
                }, true, true, control);
                const access = group(t('access', 'Agent access'), t('inviteHint', 'Copy the invitation into your agent conversation. You choose when it can edit.'), 'access');
                action(t('copyInvite', 'Copy invitation'), async () => {
                    const text = invitation(session, session.base); const copied = await win.DesignSync.copyLink(text);
                    notice = copied ? t('inviteCopied', 'Invitation copied. Give it to the agent you choose.') : text;
                }, false, false, access);
                const end = group(t('connection', 'Connection'), t('disconnectHint', 'Disconnect to revoke agent access. Your local plan is kept.'), 'connection');
                action(t('disconnect', 'Disconnect'), async () => {
                    // Revocation is an owner action even when the agent holds the edit turn.
                    await client(session.base).control(session.id, session.version, 'owner', true);
                    client(session.base).forget(session.id, row.cid); win.PersistentStorage.removeItem(activeKey(session.base)); session = null; sessionError = null;
                    closeConnection(); announce('');
                    publishActive();
                }, false, true, end);
                if (focusedLabel) [...panel.querySelectorAll('button')].find(button => button.textContent === focusedLabel)?.focus();
            };
            const resume = async () => {
                await storageReady();
                const base = endpoint(win), id = win.PersistentStorage.getItem(planKey(base, row.cid));
                if (!id) return;
                const capability = stored(base, id); if (!capability?.ownerToken) return;
                session = { id, base };
                try {
                    const latest = await resumeActive();
                    if (latest?.id === id) {
                        session = { ...session, ...latest, base };
                        if (!active?.paused) ensureConnection();
                    }
                } catch (error) { sessionError = error; }
                render();
            };
            const subscriber = detail => {
                if (stopped || !session) return;
                if (detail?.statusChanged) { render(); return; }
                if (detail?.id !== session.id) return;
                if (detail.ended) { session = null; sessionError = detail.error; conflict = false; render(); return; }
                const changed = (detail.session && session.version !== detail.session.version)
                    || (detail.row && row.cid !== detail.row.cid)
                    || conflict !== (detail.conflict === true) || (detail.error && sessionError !== detail.error);
                if (detail.session) session = { ...session, ...detail.session, base: session.base };
                if (detail.row) { row = detail.row; onChange(row); }
                conflict = detail.conflict === true;
                if (detail.error) sessionError = detail.error;
                if (detail.row && detail.row.cid !== pendingSession()?.pointer.cid) notice = '';
                if (changed) render();
            };
            panelSubscribers.add(subscriber);
            const ready = resume().finally(() => { resuming = false; render(); });
            return { ready, get session() { return session; }, get row() { return row; }, dispose() { stopped = true; panelSubscribers.delete(subscriber); panel.remove(); } };
        }
        const pendingSession = () => {
            const base = endpoint(win);
            let pointer; try { pointer = JSON.parse(win.PersistentStorage.getItem(activeKey(base)) || 'null'); } catch (_) { return null; }
            const capability = pointer?.id ? stored(base, pointer.id) : null;
            if (!pointer?.id || !capability?.ownerToken) return null;
            const plans = win.NamedPlans?.list?.({ storedOnly: true }) || [];
            const old = plans.find(plan => plan.cid === pointer.cid) || null;
            const local = plans.find(plan => plan.cid === pointer.localCid) || null;
            active = { controller: capability.controller || 'pending',
                designCids: new Set(capability.designCids || old?.content?.designCids || []),
                memberIds: new Set((capability.memberIds || pointer.memberIds || old?.memberIds || []).map(String)) };
            return { base, pointer, capability, old, local };
        };
        function saveLocalRevision(previous, next) {
            const connected = pendingSession();
            if (!previous || !connected || ![connected.pointer.cid, connected.pointer.localCid].includes(previous.cid)) return false;
            if (connected.capability.controller !== 'owner') throw fail('Take control before editing this shared plan.', 'shared-plan-control-required');
            win.PlanWorkspace.save(next);
            win.PersistentStorage.setItem(activeKey(connected.base), JSON.stringify({ ...connected.pointer, localCid: next.cid }));
            win.PersistentStorage.setItem(planKey(connected.base, next.cid), connected.pointer.id);
            notifyPanels({ id: connected.pointer.id, row: next });
            return true;
        }
        function captureLocalRevision() {
            const connected = pendingSession();
            const row = connected?.local || connected?.old;
            if (!row || connected.capability.controller !== 'owner' || !win.proposalStorage?.getAllProposals) return row || null;
            const members = currentMembers(row, win.proposalStorage.getAllProposals(), win);
            const next = composeCurrentPlan(row, members, win);
            // Only the browser's pending plan advances. The accepted server pointer and every
            // previous immutable plan stay intact until the owner explicitly saves or hands over.
            if (next.cid !== row.cid) saveLocalRevision(row, next);
            return next;
        }
        const pause = (error, detail = {}) => {
            closeConnection(); announce(error.message);
            active = active ? { ...active, paused: true } : active;
            const pointer = JSON.parse(win.PersistentStorage.getItem(activeKey(endpoint(win))) || 'null');
            notifyPanels({ id: pointer?.id, ...detail, error });
            try { win.showStyledAlert?.(error.message); } catch (_) { }
        };
        const resumeActive = async ({ acceptOwnerConflict = false } = {}) => {
            if (resumeInFlight) return resumeInFlight;
            pendingSession();
            resumeInFlight = exclusive(async () => {
            await storageReady();
            const currentPending = pendingSession();
            if (!currentPending) return;
            active = { ...active, paused: false };
            let { base, pointer, capability, old, local } = currentPending;
            const latest = await client(base).read(pointer.id);
            const nextCid = win.Cid.cidOfObject(latest.artifact?.plan);
            if (latest.controller === 'owner' && nextCid === pointer.cid) captureLocalRevision();
            local = pendingSession()?.local || local;
            let current = local || old;
            if (old && local && local.cid !== old.cid && nextCid && old.cid !== nextCid && latest.controller === 'owner' && !acceptOwnerConflict) {
                // A local owner fork may have been edited while this tab was offline. Never
                // overwrite it from a resume; the panel presents the ordinary Save action once
                // the owner chooses which revision should become current.
                active = { controller: 'owner', designCids: new Set(old.content.designCids || []),
                    memberIds: new Set((old.memberIds || []).map(String)), conflict: true };
                win.dispatchEvent(new win.CustomEvent('sharedplansessionconflict', { detail: { previous: old, current: latest } }));
                notifyPanels({ id: pointer.id, session: { ...latest, base }, row: current, conflict: true });
                return latest;
            }
            if (old && nextCid && (old.cid !== nextCid || (local && acceptOwnerConflict))) {
                const ids = Object.fromEntries(old.designs.map((member, index) => [member.cid, old.memberIds[index]]));
                const replacement = rowOf(latest.artifact, ids, win);
                try {
                    if (typeof win.PlanDialog?.syncSharedPlanOnMap !== 'function') throw fail('The shared-plan map is not ready. Open the plan and retry.', 'shared-plan-map-unavailable');
                    applying = true; announce(t('applying', 'Applying the accepted changes…'));
                    await win.PlanDialog.syncSharedPlanOnMap(replacement, local || old, { lastChange: latest.lastChange });
                } catch (error) {
                    pause(error, { id: pointer.id, session: { ...latest, base }, row: old });
                    return latest;
                } finally { applying = false; }
                const descriptions = win.SharedPlanMotion?.describe?.({ previous: local || old, next: replacement, change: latest.lastChange }) || [];
                const messages = descriptions.map(item => {
                    const label = item.label || t(item.type === 'bench' ? 'bench' : 'building', item.type === 'bench' ? 'Bench' : 'Building');
                    if (item.kind === 'move') {
                        const direction = Math.abs(item.eastM) >= Math.abs(item.northM)
                            ? t(item.eastM >= 0 ? 'east' : 'west', item.eastM >= 0 ? 'east' : 'west')
                            : t(item.northM >= 0 ? 'north' : 'south', item.northM >= 0 ? 'north' : 'south');
                        return `${t('moved', 'Moved')} ${label} ${Math.round(item.distanceM * 10) / 10} m ${direction}`;
                    }
                    if (item.kind === 'rotate') return `${t('rotated', 'Rotated')} ${label} ${Math.round(item.degrees)}°`;
                    return `${t(item.kind === 'add' ? 'added' : item.kind === 'remove' ? 'removed' : 'updated', item.kind === 'add' ? 'Added' : item.kind === 'remove' ? 'Removed' : 'Updated')} ${label}`;
                });
                announce(latest.lastChange?.kind === 'undo' ? t('undone', 'Undid the last agent change.')
                    : messages.length ? messages.slice(0, 3).join('. ') + (messages.length > 3 ? ` (+${messages.length - 3})` : '')
                    : t('updatedPlan', 'Shared plan updated.'));
                win.PersistentStorage.setItem(activeKey(base), JSON.stringify({ id: pointer.id, cid: replacement.cid, memberIds: replacement.memberIds || [] }));
                current = replacement;
            }
            remember(base, latest, current?.cid || pointer.cid, current?.memberIds || capability?.memberIds || []);
            active = { controller: latest.controller || 'pending', designCids: new Set(latest.artifact?.plan?.designCids || []),
                memberIds: new Set((current?.memberIds || capability?.memberIds || []).map(String)) };
            win.dispatchEvent(new win.CustomEvent('sharedplansessionchange'));
            notifyPanels({ id: pointer.id, session: { ...latest, base }, row: current });
            return latest;
            }).finally(() => { resumeInFlight = null; });
            return resumeInFlight;
        };
        const queueRefresh = () => {
            refreshQueued = true;
            if (draining) return;
            draining = true;
            (async () => {
                while (refreshQueued) {
                    refreshQueued = false;
                    await resumeActive();
                    if (active?.paused) break;
                }
            })().catch(error => pause(error)).finally(() => { draining = false; });
        };
        const ensureConnection = () => {
            const pending = pendingSession();
            if (!pending || !win.SharedPlanEvents) return;
            const id = `${pending.base}/${pending.pointer.id}`;
            if (connection && connectionId === id) return;
            closeConnection(); connectionId = id;
            connection = win.SharedPlanEvents.connect({ base: pending.base, sessionId: pending.pointer.id,
                token: pending.capability.ownerToken, fetch: win.fetch.bind(win),
                onState(state) {
                    if (connectionId !== id) return;
                    const current = pendingSession();
                    if (!current || current.pointer.id !== state.id) return;
                    const wasEditing = agentEditing;
                    agentEditing = state.activity.agentEditing;
                    if (wasEditing && !agentEditing && !applying && state.cid === current.pointer.cid) announce(state.controller === 'owner' ? t('youEditing', 'You have editing control.') : t('agentControl', 'The agent has editing control. Waiting for its next change.'));
                    notifyPanels({ statusChanged: true });
                    if (agentEditing && !applying) announce(t('working', 'The agent is working on a change…'));
                    if (state.version > (current.capability.version || 0) || state.cid !== current.pointer.cid) queueRefresh();
                },
                onStatus(status, error) {
                    if (connectionId !== id) return;
                    connectionStatus = status;
                    if (status === 'connected' && announcement === t('reconnecting', 'Reconnecting to the shared plan…')) announce('');
                    notifyPanels({ statusChanged: true });
                    if (status === 'reconnecting') announce(t('reconnecting', 'Reconnecting to the shared plan…'));
                    if (status === 'unavailable') {
                        if ([404, 410].includes(error?.status)) queueRefresh();
                        else pause(error);
                    }
                }
            });
        };
        win.addEventListener?.('pagehide', closeConnection);
        win.addEventListener?.('pageshow', () => { if (!active?.paused) ensureConnection(); });
        const start = async () => {
            try {
                await storageReady();
                const base = endpoint(win);
                let pointer; try { pointer = JSON.parse(win.PersistentStorage.getItem(activeKey(base)) || 'null'); } catch (_) { return; }
                if (!pointer?.id || !stored(base, pointer.id)?.ownerToken) return;
                await resumeActive();
                if (!active?.paused) ensureConnection();
            } catch (error) { pause(error); }
        };
        return Object.freeze({ start, saveLocalRevision, captureLocalRevision, endpoint: () => endpoint(win), client, artifactOf, rowOf: (artifact, memberIds) => rowOf(artifact, memberIds, win), invitation, mount, resumeActive,
            assertMutationAllowed(proposalStore, proposalDraft, options = {}) {
                if (options.sharedPlanSessionRemote === true || !active || active.controller === 'owner') return;
                const record = (store, id) => store?.getProposal?.(id) || null;
                const fingerprint = value => {
                    if (!value) return 'deleted';
                    return `${win.DesignRecord.cidOf(value)}:${value.applied === true ? 'applied' : 'unapplied'}`;
                };
                for (const id of active.memberIds || []) {
                    if (fingerprint(record(proposalStore, id)) !== fingerprint(record(proposalDraft, id))) {
                        throw fail(this.blockedMessage(), 'shared-plan-agent-editing');
                    }
                }
            },
            editBlocked(proposal) {
                if (!active || active.controller === 'owner') return false;
                try { return active.designCids.has(win.DesignRecord.cidOf(proposal)); } catch (_) { return false; }
            },
            blockedMessage: () => t('agentControl', 'The agent has editing control. Take control before editing it here.') });
    }
    return { artifactOf, rowOf, currentMembers, browser };
});
