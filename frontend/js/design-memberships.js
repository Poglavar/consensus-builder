// Reverse navigation for one exact design revision, combining local agreement drafts with public memberships.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.DesignMemberships = api;
        root.loadDesignMemberships = async (proposal, onChange) => api.createSession(proposal, root, onChange);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const PAGE_SIZE = 5;

    function localAgreements(planCid, agreements, publishedCidOf) {
        return agreements.filter(agreement => agreement.plan?.cid === planCid).map(agreement => ({
            cid: publishedCidOf(agreement), localId: agreement.id, title: agreement.title,
            draft: !publishedCidOf(agreement), agreement
        }));
    }

    function localPlans(proposalId, designCid, agreements) {
        return mergeRows(agreements.filter(agreement => agreement.plan && (designCid
            ? agreement.plan.content.designCids.includes(designCid)
            : agreement.designs.some(design => String(design.proposalId) === String(proposalId))))
            .map(agreement => ({ ...agreement.plan, title: agreement.plan.content.title,
                draft: !agreement.published, localDesigns: agreement.designs })));
    }

    function mergeRows(...lists) {
        const rows = new Map();
        for (const row of lists.flat()) {
            const key = row.cid ? `cid:${row.cid}` : `local:${row.localId}`;
            rows.set(key, { ...rows.get(key), ...row });
        }
        return [...rows.values()];
    }

    function membershipLink(kind, cid, win) {
        const link = kind === 'plans' ? win.NamedPlans.link(cid) : win.AgreementSync.agreementLink(cid);
        const url = new URL(link, win.location.href);
        const backend = new URLSearchParams(win.location.search).get('backend');
        if (backend) url.searchParams.set('backend', backend);
        return url.href;
    }

    async function fetchPage({ fetch, backend, kind, designCid, planCid, offset = 0, signal }) {
        const query = new URLSearchParams({ ...(planCid ? { plan: planCid } : { design: designCid }), limit: String(PAGE_SIZE), offset: String(offset) });
        const response = await fetch(`${backend}/${kind}?${query}`, { signal });
        if (!response.ok) throw new Error(`Membership lookup returned HTTP ${response.status}`);
        const page = await response.json();
        if (!Array.isArray(page[kind]) || typeof page.hasMore !== 'boolean'
            || page[kind].some(row => !row || typeof row.cid !== 'string'))
            throw new Error('Invalid membership list');
        if (planCid && page[kind].some(row => row.planCid !== planCid))
            throw new Error('The agreement list contains a different plan revision.');
        if (page.hasMore && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))
            throw new Error('Invalid membership pagination');
        return { items: page[kind], nextOffset: page.hasMore ? page.nextOffset : null };
    }

    function translator(win) {
        return key => win.i18n?.t(`designMemberships.${key}`) || key;
    }

    // A selection owns one lookup session; folding or changing sections does not restart requests.
    // The stack receives data, not an independent panel nested inside a design's action view.
    function createSession(proposal, win, onChange = () => {}) {
        const t = translator(win);
        const controller = new AbortController();
        const backend = win.resolveBackendBaseUrl().replace(/\/$/, '');
        const cid = win.DesignSync.publishedCid(proposal);
        const local = localPlans(proposal.proposalId, cid, win.AgreementStore.list());
        const revision = win.DesignRecord?.cidOf(proposal) || cid;
        const saved = (win.NamedPlans.list?.() || []).filter(plan => plan.content.designCids.includes(revision))
            .map(plan => ({ ...plan, title: plan.content.title, draft: Array.isArray(plan.designs) && !plan.published }));
        const knownPlan = win.NamedPlans.current;
        const groups = {
            plans: { items: mergeRows(local, saved, cid && knownPlan?.content.designCids.includes(cid)
                ? [{ cid: knownPlan.cid, title: knownPlan.content.title, content: knownPlan.content,
                    designCids: knownPlan.content.designCids, draft: false }] : []) }
        };
        for (const group of Object.values(groups)) Object.assign(group, { nextOffset: cid ? 0 : null, loading: !!cid, error: false });
        const detailCache = new Map();
        const notify = () => { if (!controller.signal.aborted) onChange(session); };
        const session = { groups, cid, revision, proposalId: String(proposal.proposalId),
            dispose: () => controller.abort(), load,
            instances(kind, keepEmpty = false) {
                const state = groups[kind];
                const items = state.items.map(row => ({ ...row, id: String(row.localId || row.cid), label: row.title || String(row.cid || row.localId),
                    membershipDesignCid: cid || revision, onParcel: true }));
                if (!items.length && (state.loading || state.error || keepEmpty)) items.push({ id: `membership-${kind}`, membershipPlaceholder: true, onParcel: true,
                    label: t(state.loading ? 'loading' : state.error ? 'failed' : 'empty') });
                return items;
            },
            details(kind, instance) {
                const key = `${kind}:${instance.id}`;
                if (!detailCache.has(key)) detailCache.set(key, inspect(kind, instance, win).catch(error => { detailCache.delete(key); throw error; }));
                return detailCache.get(key);
            }
        };
        async function load(kind) {
            const state = groups[kind];
            const wasLoading = state.loading;
            state.loading = true; state.error = false;
            if (!wasLoading) notify();
            try {
                const page = await fetchPage({ fetch: win.fetch.bind(win), backend, kind, designCid: cid,
                    offset: state.nextOffset || 0, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
                if (controller.signal.aborted) return;
                state.items = mergeRows(state.items, page.items.map(row => ({ ...row, draft: false })));
                state.nextOffset = page.nextOffset;
            } catch (error) {
                if (controller.signal.aborted) return;
                state.error = true;
                win.console.warn(`[${new Date().toISOString()}] [DesignMemberships] ${kind} lookup failed`, error);
            } finally { state.loading = false; notify(); }
        }
        session.ready = Promise.resolve().then(() => {
            notify();
            return cid ? Promise.all(Object.keys(groups).map(load)) : undefined;
        });
        return session;
    }

    // Reading a parent never imports or applies its designs. Published geometry is verified and
    // converted in memory; full-plan loading remains an explicit navigation action.
    async function inspect(kind, instance, win) {
        if (kind !== 'plans') throw new Error('Only plans have spatial stack sections.');
        const content = instance.content || (await win.NamedPlans.fetchPlan(instance.cid)).content;
        const snapshot = win.PlanWorkspace ? await win.PlanWorkspace.resolve({ ...instance, content }) : null;
        const refs = content.designCids.map(cid => ({ cid }));
        const localOf = cid => {
            const published = win.DesignSync.localCopyOf(cid);
            if (published) return published;
            const carriedIndex = snapshot?.content.designCids.indexOf(cid) ?? -1;
            const ref = instance.localDesigns?.find(ref => ref.cid === cid)
                || (carriedIndex >= 0 ? { proposalId: snapshot.memberIds[carriedIndex] } : null);
            const draft = ref ? win.proposalStorage.getProposal(ref.proposalId) : null;
            // A saved plan names a revision; an edited record under the same local id is not it.
            return draft && win.DesignRecord.cidOf(draft) === cid ? draft : null;
        };
        const carried = new Map((snapshot?.designs || []).map(member => [member.cid, member]));
        const missing = refs.filter(ref => !localOf(ref.cid) && !carried.has(ref.cid)).map(ref => ref.cid);
        const downloaded = missing.length ? await win.DesignSync.fetchDesigns(missing) : { rows: new Map(), missing: [] };
        if (downloaded.missing.length) throw new Error(translator(win)('geometryUnavailable'));
        const members = refs.map(ref => {
            const local = localOf(ref.cid);
            const proposal = local || (ref.cid ? win.DesignSync.localDesignFromRow(carried.get(ref.cid) || downloaded.rows.get(ref.cid), { apiBase: win.resolveBackendBaseUrl() }) : null);
            if (!proposal) throw new Error(translator(win)('geometryUnavailable'));
            return { id: String(local?.proposalId || ref.cid), cid: ref.cid, ...(local ? {} : { serverId: ref.cid }), label: proposal.title || proposal.name || ref.cid, proposal };
        });
        const features = members.flatMap(member => {
            if (win.collectProposalFeatureSets) return win.collectProposalFeatureSets(member.proposal, { includeBuildingGeometry: true }).primaryFeatures;
            const footprint = win.__planOrder?.footprintOf(member.proposal);
            return footprint ? [footprint] : [];
        });
        return { content, members, features, designCids: refs.map(ref => ref.cid).filter(Boolean),
            designIds: members.filter(member => !member.serverId).map(member => member.id) };
    }

    // Sharing reads exact member revisions in memory; it never applies or imports a plan just to
    // prepare its checkboxes. The same entry point serves 2D, model 3D and Google 3D sections.
    async function sharePlan(instance, win, session = null) {
        const data = session ? await session.details('plans', instance) : await inspect('plans', instance, win);
        win.ClickStack?.close();
        win.ThreeClickStack?.close();
        return win.shareAppliedProposals({ plan: { cid: instance.cid, content: data.content },
            members: data.members.map(member => member.proposal) });
    }

    // Agreements belong to the selected exact plan, not to independently picked geometry.
    function createAgreementScope(win, { getPlan, getAgreement = () => null, onChange }) {
        let plan = null, generation = 0, items = [], offset = null, loading = false, failed = false, controller = null;
        const locals = () => {
            if (!plan) return [];
            const pinned = getAgreement();
            return mergeRows(localAgreements(plan.cid, win.AgreementStore.list(), row => row.published?.cid || null),
                pinned?.readOnly && pinned.plan?.cid === plan.cid ? [pinned] : []);
        };
        const notify = () => {
            const version = generation;
            queueMicrotask(() => {
                if (version !== generation) return;
                const rows = mergeRows(items, locals()).map(row => ({ ...row, id: String(row.localId || row.cid),
                    label: row.title || translator(win)('agreement'), createdAt: row.createdAt || row.agreement?.createdAt,
                    plan, onParcel: true }));
                if (!rows.length && plan && (loading || failed)) rows.push({ id: `agreements:${plan.cid}`, plan,
                    label: translator(win)(failed ? 'failed' : 'loading'), membershipPlaceholder: true, onParcel: true });
                onChange(rows, { loading, failed, more: offset !== null, load, plan });
            });
        };
        async function load() {
            if (!plan || loading || offset === null) return;
            const version = generation;
            loading = true; failed = false;
            if (!items.length && !locals().length) notify();
            try {
                const page = await fetchPage({ fetch: win.fetch.bind(win), backend: win.resolveBackendBaseUrl().replace(/\/$/, ''),
                    kind: 'agreements', planCid: plan.cid, offset, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
                if (version !== generation) return;
                items = mergeRows(items, page.items); offset = page.nextOffset;
            } catch (error) {
                if (version !== generation || controller.signal.aborted) return;
                failed = true;
                win.console.warn(`[${new Date().toISOString()}] [DesignMemberships] plan agreements lookup failed`, error);
            } finally { if (version === generation) { loading = false; notify(); } }
        }
        const unsubscribe = win.AgreementStore.subscribe?.(notify);
        return {
            sync() {
                const selected = getPlan();
                if ((selected?.cid || null) === (plan?.cid || null)) return;
                controller?.abort(); generation++; plan = selected?.membershipPlaceholder ? null : selected;
                items = []; loading = false; failed = false; offset = plan && !plan.draft ? 0 : null;
                controller = new AbortController(); notify();
                if (offset !== null) return load();
            },
            dispose() { controller?.abort(); generation++; unsubscribe?.(); }
        };
    }

    function mountAgreement(host, instance, win, { onFocus = () => {}, group = {} } = {}) {
        const doc = host.ownerDocument, t = translator(win);
        host.classList.add('click-stack__agreement');
        const slot = doc.createElement('div'); slot.className = 'click-stack__agreement-properties'; host.appendChild(slot);
        if (!instance.localId && !instance.readOnly && !instance.membershipPlaceholder) {
            const loading = doc.createElement('p'); loading.className = 'agreement-hint'; loading.setAttribute('role', 'status'); loading.textContent = t('loading'); slot.appendChild(loading);
        }
        const ready = !instance.membershipPlaceholder ? win.AgreementPanel.mount(slot, instance).catch(error => {
            if (!host.isConnected) return;
            const notice = doc.createElement('p'); notice.className = 'agreement-alert'; notice.textContent = error.message;
            slot.replaceChildren(notice);
        }) : Promise.resolve(null);
        updateAgreementGroup(host, group, win);
        if (instance.membershipPlaceholder) return ready;
        inspect('plans', instance.plan, win).then(data => {
            if (!host.isConnected) return;
            Object.assign(instance, { features: data.features }); onFocus(instance);
        }).catch(error => win.console.warn(`[${new Date().toISOString()}] [DesignMemberships] agreement extent unavailable`, error));
        return ready;
    }

    function updateAgreementGroup(host, group, win) {
        host.querySelector('.click-stack__agreement-more')?.remove();
        if (!group.failed && !group.more) return;
        const more = host.ownerDocument.createElement('button'); more.type = 'button'; more.className = 'btn click-stack__agreement-more';
        more.textContent = translator(win)(group.failed ? 'retry' : 'more'); more.disabled = group.loading;
        more.addEventListener('click', () => win.BusyControl.track(more, group.load)); host.appendChild(more);
    }

    function mountSection(host, kind, instance, session, win, { onFocus = () => {}, hits = {} } = {}) {
        const t = translator(win), doc = host.ownerDocument;
        const node = (tag, className, text) => {
            const element = doc.createElement(tag);
            element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        };
        const action = (text, run) => {
            const button = node('button', 'btn', text); button.type = 'button';
            button.addEventListener('click', run); return button;
        };
        host.classList.add('click-stack__plan');
        if (!instance.membershipPlaceholder) {
            const summary = node('div', 'click-stack__summary');
            summary.appendChild(node('p', 'click-stack__facts', instance.draft ? t('draft') : win.i18n.t('proposals.share.panel.published')));
            const revision = node('p', 'click-stack__facts', `${t('revision')}: `);
            const cid = node('code', 'click-stack__revision', instance.cid);
            cid.title = instance.cid;
            revision.appendChild(cid);
            summary.appendChild(revision);
            host.appendChild(summary);
            const actions = node('div', 'cb-actions click-stack__actions');
            const share = action(t('sharePlan'), async () => {
                try { await win.BusyControl.track(share, () => sharePlan(instance, win, session)); }
                catch (error) { win.showStyledAlert(error.message); }
            });
            share.className = 'btn btn-primary click-stack__share-plan';
            const shareIcon = node('i', 'fas fa-share-alt');
            shareIcon.setAttribute('aria-hidden', 'true');
            share.replaceChildren(shareIcon, node('span', '', t('sharePlan')));
            actions.appendChild(share);
            // A plan opened from a copied address is only previewed; applying it is one click here.
            const planRow = () => win.NamedPlans.list().find(row => row.cid === instance.cid)
                || { cid: instance.cid, content: instance.content, published: !instance.draft };
            if (kind === 'plans' && instance.content && !win.PlanWorkspace.appliedMembers(planRow())) {
                const applyPlan = action(win.i18n.t('panel.proposal.actions.apply'), async () => {
                    try {
                        const result = await win.BusyControl.track(applyPlan, () => win.PlanWorkspace.apply(planRow()));
                        if (!result.blocked) { applyPlan.remove(); onFocus(instance); }
                    } catch (error) { win.showStyledAlert(error.message); }
                });
                applyPlan.className = 'btn click-stack__apply-plan';
                actions.appendChild(applyPlan);
            }
            const createAgreement = action(t('createAgreement'), async () => {
                try {
                    let selectedPlan;
                    await win.BusyControl.track(createAgreement, async () => {
                        const data = session ? await session.details(kind, instance) : await inspect(kind, instance, win);
                        selectedPlan = win.NamedPlans.remember({ cid: instance.cid, content: data.content }, data.members.map(member => member.id));
                    });
                    // Created: the stack moves to its Agreements section with the new agreement; closed
                    // without saving: the plan stays as it was.
                    const saved = await win.AgreementDialog.open({ plan: selectedPlan, preserveContext: true });
                    if (saved?.id) await win.ClickStack.showAgreement(win.AgreementStore.get(saved.id) || saved);
                    else onFocus(instance);
                } catch (error) { win.showStyledAlert(error.message); }
            });
            createAgreement.className = 'btn click-stack__create-agreement';
            actions.appendChild(createAgreement);
            // Construction windows of the members: a new plan revision (docs/buildout-timeline.md).
            const editSchedule = (focus = null) => win.BusyControl.track(scheduleButton,
                () => win.PlanDialog.schedule({ cid: instance.cid, content: instance.content }, { focus, members: instance.localDesigns || [] }))
                .catch(error => win.showStyledAlert(error.message));
            const scheduleButton = action(win.i18n.t('planDialog.schedule'), () => editSchedule());
            scheduleButton.className = 'btn click-stack__schedule-plan';
            const download = action(win.i18n.t('common.download'), () => win.BusyControl.track(download,
                () => win.PlanFileUI.plan({ cid: instance.cid, content: instance.content }, instance.localDesigns || []))
                .catch(error => win.showStyledAlert(error.message)));
            download.className = 'btn click-stack__download-plan';
            actions.appendChild(download);
            host.appendChild(actions);
            const strip = node('div', 'click-stack__schedule');
            strip.appendChild(scheduleButton);
            if (instance.content?.schedule && win.PlanDialog?.scheduleStrip) {
                const titles = new Map((instance.localDesigns || []).flatMap(record => {
                    try { return [[win.DesignRecord.cidOf(record), record.title]]; } catch (_) { return []; }
                }));
                strip.appendChild(win.PlanDialog.scheduleStrip(instance.content, { titles, onPick: editSchedule }));
            }
            host.appendChild(strip);
            const details = node('div', 'click-stack__membership-details');
            host.appendChild(details);
            const load = async () => {
                details.replaceChildren(node('p', 'click-stack__facts', t('loading')));
                try {
                    const data = session ? await session.details(kind, instance) : await inspect(kind, instance, win);
                    if (!host.isConnected) return;
                    Object.assign(instance, data);
                    onFocus(instance);
                    details.replaceChildren();
                    details.appendChild(win.ClickStackRelations.renderGroup({ kind: 'designs', relation: 'includedDesigns', instances: data.members, count: data.members.length }, doc, win));
                } catch (error) {
                    if (!host.isConnected) return;
                    const message = node('p', 'click-stack__facts', t('geometryUnavailable'));
                    message.setAttribute('role', 'status');
                    details.replaceChildren(message, action(t('retry'), load));
                    win.console.warn(`[${new Date().toISOString()}] [DesignMemberships] ${kind} inspection failed`, error);
                }
            };
            load();
        }
        const group = session?.groups[kind];
        if (!group) return;
        if (group.loading) host.appendChild(node('p', 'click-stack__facts', t('loading')));
        if (instance.membershipPlaceholder && !group.loading && !group.error) host.appendChild(node('p', 'click-stack__facts', t('empty')));
        if (group.error) {
            const message = node('p', 'click-stack__facts', t('failed')); message.setAttribute('role', 'status');
            host.append(message, action(t('retry'), () => session.load(kind)));
        } else if (!group.loading && group.nextOffset !== null) host.appendChild(action(t('more'), () => session.load(kind)));
    }

    return { localAgreements, localPlans, createAgreementScope, mountAgreement, updateAgreementGroup, mergeRows, membershipLink, fetchPage, createSession, inspect,
        sharePlan, mountSection };
});
