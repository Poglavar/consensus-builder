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

    const strings = {
        en: { title: 'Included in', plans: 'Plans', agreements: 'Agreements', empty: 'None', loading: 'Loading…', failed: 'Could not load this list.', retry: 'Retry', more: 'Show more', draft: 'Draft', unpublished: 'Publish this design revision to find shared plans.' },
        hr: { title: 'Dio je', plans: 'Planovi', agreements: 'Sporazumi', empty: 'Nema', loading: 'Učitavanje…', failed: 'Popis nije moguće učitati.', retry: 'Pokušaj ponovno', more: 'Prikaži više', draft: 'Nacrt', unpublished: 'Objavite ovu verziju da biste pronašli povezane planove i sporazume.' },
        sr: { title: 'Deo je', plans: 'Planovi', agreements: 'Sporazumi', empty: 'Nema', loading: 'Učitavanje…', failed: 'Lista ne može da se učita.', retry: 'Pokušaj ponovo', more: 'Prikaži više', draft: 'Nacrt', unpublished: 'Objavite ovu verziju da biste pronašli povezane planove i sporazume.' },
        es: { title: 'Incluido en', plans: 'Planes', agreements: 'Acuerdos', empty: 'Ninguno', loading: 'Cargando…', failed: 'No se pudo cargar la lista.', retry: 'Reintentar', more: 'Mostrar más', draft: 'Borrador', unpublished: 'Publica esta versión para encontrar planes y acuerdos compartidos.' }
    };
    const explanations = {
        en: { plan: 'Plan', agreement: 'Agreement', planMeaning: 'A collection of designs and a saved map view.', agreementMeaning: 'Who decides and on what terms: decision rules and any land or payment terms for its included designs.', openPlan: 'Open plan', openAgreement: 'Agreement details', geometryUnavailable: 'Could not load all included designs. Their full extent cannot be highlighted.' },
        hr: { plan: 'Plan', agreement: 'Sporazum', planMeaning: 'Prostorni prijedlog: imenovani skup dizajna i spremljeni pogled na kartu.', agreementMeaning: 'Tko odlučuje i pod kojim uvjetima: pravila odlučivanja i eventualni uvjeti za zemljište ili plaćanja za uključene dizajne.', openPlan: 'Otvori plan', openAgreement: 'Detalji sporazuma', geometryUnavailable: 'Nije moguće učitati sve uključene dizajne. Njihov puni obuhvat nije moguće istaknuti.' },
        sr: { plan: 'Plan', agreement: 'Sporazum', planMeaning: 'Prostorni predlog: imenovani skup dizajna i sačuvani pogled na kartu.', agreementMeaning: 'Ko odlučuje i pod kojim uslovima: pravila odlučivanja i eventualni uslovi za zemljište ili plaćanja za uključene dizajne.', openPlan: 'Otvori plan', openAgreement: 'Detalji sporazuma', geometryUnavailable: 'Nije moguće učitati sve uključene dizajne. Njihov pun obuhvat nije moguće istaći.' },
        es: { plan: 'Plan', agreement: 'Acuerdo', planMeaning: 'La propuesta espacial: un conjunto de diseños con nombre y una vista guardada del mapa.', agreementMeaning: 'Quién decide y bajo qué condiciones: reglas de decisión y, cuando corresponda, condiciones sobre terrenos o pagos para los diseños incluidos.', openPlan: 'Abrir plan', openAgreement: 'Detalles del acuerdo', geometryUnavailable: 'No se pudieron cargar todos los diseños incluidos. No se puede resaltar su extensión completa.' }
    };
    const planActions = {"en": {"planAgreements": "Agreements referencing this plan:", "emptyAgreements": "No agreements yet.", "createAgreement": "Create agreement"}, "hr": {"planAgreements": "Sporazumi koji se odnose na ovaj plan:", "emptyAgreements": "Još nema sporazuma.", "createAgreement": "Izradi sporazum"}, "sr": {"planAgreements": "Sporazumi koji se odnose na ovaj plan:", "emptyAgreements": "Još nema sporazuma.", "createAgreement": "Napravi sporazum"}, "es": {"planAgreements": "Acuerdos que hacen referencia a este plan:", "emptyAgreements": "Todavía no hay acuerdos.", "createAgreement": "Crear acuerdo"}};
    for (const language of Object.keys(strings)) Object.assign(strings[language], planActions[language]);
    for (const language of Object.keys(strings)) Object.assign(strings[language], explanations[language]);
    const sharing = {
        en: { sharePlan: 'Share plan', chooseSharePlan: 'Which plan do you want to share?' },
        hr: { sharePlan: 'Podijeli plan', chooseSharePlan: 'Koji plan želite podijeliti?' },
        sr: { sharePlan: 'Podeli plan', chooseSharePlan: 'Koji plan želite da podelite?' },
        es: { sharePlan: 'Compartir plan', chooseSharePlan: '¿Qué plan quieres compartir?' }
    };
    for (const language of Object.keys(strings)) Object.assign(strings[language], sharing[language]);

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
        for (const [language, entries] of Object.entries(strings)) win.i18n?.registerTranslations(language,
            Object.fromEntries(Object.entries(entries).map(([key, value]) => [`designMemberships.${key}`, value])));
        return key => {
            const value = win.i18n?.t(`designMemberships.${key}`);
            return value && value !== `designMemberships.${key}` ? value : strings.en[key];
        };
    }

    // A selection owns one lookup session; folding or changing sections does not restart requests.
    // The stack receives data, not an independent panel nested inside a design's action view.
    function createSession(proposal, win, onChange = () => {}) {
        const t = translator(win);
        const controller = new AbortController();
        const backend = win.resolveBackendBaseUrl().replace(/\/$/, '');
        const cid = win.DesignSync.publishedCid(proposal);
        const local = localPlans(proposal.proposalId, cid, win.AgreementStore.list());
        const knownPlan = win.NamedPlans.current;
        const groups = {
            plans: { items: mergeRows(local, cid && knownPlan?.content.designCids.includes(cid)
                ? [{ cid: knownPlan.cid, title: knownPlan.content.title, content: knownPlan.content,
                    designCids: knownPlan.content.designCids, draft: false }] : []) }
        };
        for (const group of Object.values(groups)) Object.assign(group, { nextOffset: cid ? 0 : null, loading: !!cid, error: false });
        const detailCache = new Map();
        const notify = () => { if (!controller.signal.aborted) onChange(session); };
        const session = { groups, cid, proposalId: String(proposal.proposalId),
            dispose: () => controller.abort(), load,
            instances(kind, keepEmpty = false) {
                const state = groups[kind];
                const items = state.items.map(row => ({ ...row, id: String(row.localId || row.cid), label: row.title || String(row.cid || row.localId),
                    membershipDesignCid: cid, onParcel: true }));
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
        const refs = content.designCids.map(cid => ({ cid }));
        const localOf = cid => {
            const published = win.DesignSync.localCopyOf(cid);
            if (published) return published;
            const ref = instance.localDesigns?.find(ref => ref.cid === cid);
            const draft = ref ? win.proposalStorage.getProposal(ref.proposalId) : null;
            // A saved plan names a revision; an edited record under the same local id is not it.
            return draft && win.DesignRecord.cidOf(draft) === cid ? draft : null;
        };
        const missing = refs.filter(ref => !localOf(ref.cid)).map(ref => ref.cid);
        const downloaded = missing.length ? await win.DesignSync.fetchDesigns(missing) : { rows: new Map(), missing: [] };
        if (downloaded.missing.length) throw new Error(translator(win)('geometryUnavailable'));
        const members = refs.map(ref => {
            const local = localOf(ref.cid);
            const proposal = local || (ref.cid ? win.DesignSync.localDesignFromRow(downloaded.rows.get(ref.cid), { apiBase: win.resolveBackendBaseUrl() }) : null);
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
        return win.shareAppliedProposals({ plan: instance.draft ? null : { cid: instance.cid, content: data.content },
            members: data.members.map(member => member.proposal) });
    }

    async function shareFromDesign(proposal, win) {
        const t = translator(win), session = createSession(proposal, win);
        try {
            await session.ready;
            const group = session.groups.plans;
            for (;;) {
                const plans = session.instances('plans').filter(plan => !plan.membershipPlaceholder);
                if (!plans.length) {
                    if (group.error) throw new Error(t('failed'));
                    win.ClickStack?.close();
                    win.ThreeClickStack?.close();
                    return await win.shareAppliedProposals({ members: [
                        ...win.proposalStorage.getAllProposals().filter(record => win.isApplied(record)), proposal
                    ] });
                }
                if (plans.length === 1 && group.nextOffset === null) return await sharePlan(plans[0], win, session);
                const more = group.nextOffset !== null;
                const choice = await win.CbDialog.choice(t('chooseSharePlan'), [
                    ...plans.map(plan => ({ value: plan.id, label: plan.label })),
                    ...(more ? [{ value: 'more', label: t('more') }] : []),
                    { value: 'cancel', label: win.i18n.t('common.cancel') }
                ], { title: t('sharePlan') });
                if (choice === 'more') { await session.load('plans'); continue; }
                const plan = plans.find(plan => plan.id === choice);
                return plan ? await sharePlan(plan, win, session) : null;
            }
        } finally { session.dispose(); }
    }

    // Agreements refer to this exact plan; they open a dialog, never a spatial stack section.
    function mountAgreements(host, instance, win) {
        const doc = host.ownerDocument, t = translator(win);
        const section = doc.createElement('div');
        section.className = 'click-stack__choices';
        section.dataset.kind = 'agreements';
        const heading = doc.createElement('span');
        heading.className = 'click-stack__relation-label';
        heading.textContent = t('planAgreements');
        const list = doc.createElement('div'); list.className = 'click-stack__strip';
        section.append(heading, list); host.appendChild(section);
        let items = localAgreements(instance.cid, win.AgreementStore.list(), agreement => agreement.published?.cid || null);
        let offset = instance.draft ? null : 0, loading = false, failed = false;
        function render() {
            if (!host.isConnected) return;
            list.replaceChildren();
            for (const row of items) {
                const link = doc.createElement(row.cid ? 'a' : 'button');
                link.className = 'click-stack__chip';
                link.textContent = row.title || t('agreement');
                if (row.cid) link.href = membershipLink('agreements', row.cid, win);
                else link.type = 'button';
                link.addEventListener('click', async event => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault(); event.stopPropagation();
                    try {
                        if (row.localId) await win.AgreementPanel.open(row.localId);
                        else await win.AgreementSync.openDetails(row.cid);
                    } catch (error) { win.showStyledAlert(error.message); }
                });
                list.appendChild(link);
            }
            if (loading || (!items.length && !failed)) {
                const message = doc.createElement('span'); message.className = 'click-stack__facts';
                message.textContent = t(loading ? 'loading' : 'emptyAgreements'); list.appendChild(message);
            }
            if (failed || (!loading && offset !== null)) {
                const more = doc.createElement('button'); more.type = 'button'; more.className = 'btn btn-sm';
                more.textContent = t(failed ? 'retry' : 'more'); more.addEventListener('click', load); list.appendChild(more);
            }
            if (failed) {
                const message = doc.createElement('span'); message.setAttribute('role', 'status');
                message.textContent = t('failed'); list.appendChild(message);
            }
        }
        async function load() {
            if (loading) return;
            loading = true; failed = false; render();
            try {
                const page = await fetchPage({ fetch: win.fetch.bind(win), backend: win.resolveBackendBaseUrl().replace(/\/$/, ''),
                    kind: 'agreements', planCid: instance.cid, offset: offset || 0, signal: AbortSignal.timeout(15000) });
                items = mergeRows(items, page.items); offset = page.nextOffset;
            } catch (error) {
                failed = true;
                win.console.warn(`[${new Date().toISOString()}] [DesignMemberships] plan agreements lookup failed`, error);
            } finally { loading = false; render(); }
        }
        if (offset !== null) load(); else render();
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
            const button = node('button', 'btn btn-sm', text); button.type = 'button';
            button.addEventListener('click', run); return button;
        };
        const intro = node('p', 'click-stack__facts', t(kind === 'plans' ? 'planMeaning' : 'agreementMeaning'));
        host.appendChild(intro);
        if (!instance.membershipPlaceholder) {
            const summary = node('div', 'click-stack__summary');
            summary.appendChild(node('strong', '', instance.label));
            if (instance.draft) summary.appendChild(node('span', 'click-stack__facts', t('draft')));
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
            if (instance.cid && !instance.draft) {
                const link = node('a', 'btn btn-sm', t(kind === 'plans' ? 'openPlan' : 'openAgreement'));
                link.href = membershipLink(kind, instance.cid, win);
                actions.appendChild(link);
            }
            actions.appendChild(action(t('createAgreement'), async () => {
                try {
                    const data = session ? await session.details(kind, instance) : await inspect(kind, instance, win);
                    if (instance.draft) return await win.AgreementDialog.open({ plan: { cid: instance.cid, content: data.content },
                        designIds: data.members.map(member => member.id) });
                    await win.AgreementSync.createForPlan({ cid: instance.cid, content: data.content });
                } catch (error) { win.showStyledAlert(error.message); }
            }));
            host.appendChild(actions);
            mountAgreements(host, instance, win);
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

    return { localAgreements, localPlans, mountAgreements, mergeRows, membershipLink, fetchPage, createSession, inspect,
        sharePlan, shareFromDesign, mountSection, strings };
});
