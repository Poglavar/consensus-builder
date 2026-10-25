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
        en: { title: 'Included in', plans: 'Plans', agreements: 'Agreements', empty: 'None', loading: 'Loading…', failed: 'Could not load this list.', retry: 'Retry', more: 'Show more', draft: 'Draft', unpublished: 'Publish this revision to find shared plans and agreements.' },
        hr: { title: 'Dio je', plans: 'Planovi', agreements: 'Sporazumi', empty: 'Nema', loading: 'Učitavanje…', failed: 'Popis nije moguće učitati.', retry: 'Pokušaj ponovno', more: 'Prikaži više', draft: 'Nacrt', unpublished: 'Objavite ovu verziju da biste pronašli povezane planove i sporazume.' },
        sr: { title: 'Deo je', plans: 'Planovi', agreements: 'Sporazumi', empty: 'Nema', loading: 'Učitavanje…', failed: 'Lista ne može da se učita.', retry: 'Pokušaj ponovo', more: 'Prikaži više', draft: 'Nacrt', unpublished: 'Objavite ovu verziju da biste pronašli povezane planove i sporazume.' },
        es: { title: 'Incluido en', plans: 'Planes', agreements: 'Acuerdos', empty: 'Ninguno', loading: 'Cargando…', failed: 'No se pudo cargar la lista.', retry: 'Reintentar', more: 'Mostrar más', draft: 'Borrador', unpublished: 'Publica esta versión para encontrar planes y acuerdos compartidos.' }
    };
    const explanations = {
        en: { plan: 'Plan', agreement: 'Agreement', planMeaning: 'The spatial proposal: a named set of designs and a saved map view.', agreementMeaning: 'Who decides and on what terms: decision rules and any land or payment terms for its included designs.', openPlan: 'Open plan', openAgreement: 'Agreement details', geometryUnavailable: 'Could not load all included designs. Their full extent cannot be highlighted.' },
        hr: { plan: 'Plan', agreement: 'Sporazum', planMeaning: 'Prostorni prijedlog: imenovani skup dizajna i spremljeni pogled na kartu.', agreementMeaning: 'Tko odlučuje i pod kojim uvjetima: pravila odlučivanja i eventualni uvjeti za zemljište ili plaćanja za uključene dizajne.', openPlan: 'Otvori plan', openAgreement: 'Detalji sporazuma', geometryUnavailable: 'Nije moguće učitati sve uključene dizajne. Njihov puni obuhvat nije moguće istaknuti.' },
        sr: { plan: 'Plan', agreement: 'Sporazum', planMeaning: 'Prostorni predlog: imenovani skup dizajna i sačuvani pogled na kartu.', agreementMeaning: 'Ko odlučuje i pod kojim uslovima: pravila odlučivanja i eventualni uslovi za zemljište ili plaćanja za uključene dizajne.', openPlan: 'Otvori plan', openAgreement: 'Detalji sporazuma', geometryUnavailable: 'Nije moguće učitati sve uključene dizajne. Njihov pun obuhvat nije moguće istaći.' },
        es: { plan: 'Plan', agreement: 'Acuerdo', planMeaning: 'La propuesta espacial: un conjunto de diseños con nombre y una vista guardada del mapa.', agreementMeaning: 'Quién decide y bajo qué condiciones: reglas de decisión y, cuando corresponda, condiciones sobre terrenos o pagos para los diseños incluidos.', openPlan: 'Abrir plan', openAgreement: 'Detalles del acuerdo', geometryUnavailable: 'No se pudieron cargar todos los diseños incluidos. No se puede resaltar su extensión completa.' }
    };
    for (const language of Object.keys(strings)) Object.assign(strings[language], explanations[language]);

    function localAgreements(proposalId, designCid, agreements, publishedCidOf) {
        return agreements.flatMap(agreement => {
            const cid = publishedCidOf(agreement);
            const member = (agreement.designs || []).some(design => cid
                ? designCid && design.cid === designCid
                : String(design.proposalId) === String(proposalId));
            return member ? [{ cid, localId: agreement.id, title: agreement.title, draft: !cid, agreement,
                designIds: cid ? [] : agreement.designs.map(design => String(design.proposalId)),
                designCids: cid ? agreement.designs.map(design => design.cid).filter(Boolean) : [] }] : [];
        });
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

    async function fetchPage({ fetch, backend, kind, designCid, offset = 0, signal }) {
        const query = new URLSearchParams({ design: designCid, limit: String(PAGE_SIZE), offset: String(offset) });
        const response = await fetch(`${backend}/${kind}?${query}`, { signal });
        if (!response.ok) throw new Error(`Membership lookup returned HTTP ${response.status}`);
        const page = await response.json();
        if (!Array.isArray(page[kind]) || typeof page.hasMore !== 'boolean'
            || page[kind].some(row => !row || typeof row.cid !== 'string'))
            throw new Error('Invalid membership list');
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
        // A different index cannot turn a published agreement into a draft or loosen its exact
        // revision match. Imported records retain publication identity while land is reconstructed.
        const local = localAgreements(proposal.proposalId, cid, win.AgreementStore.list(), agreement => agreement.published?.cid || null);
        const knownPlan = win.NamedPlans.current;
        const groups = {
            plans: { items: cid && knownPlan?.content.designCids.includes(cid)
                ? [{ cid: knownPlan.cid, title: knownPlan.content.title, content: knownPlan.content, designCids: knownPlan.content.designCids }] : [] },
            agreements: { items: local }
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
                state.items = mergeRows(state.items, page.items);
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
        const content = instance.cid
            ? (kind === 'plans' ? (instance.content || (await win.NamedPlans.fetchPlan(instance.cid)).content)
                : (await win.AgreementSync.fetchAgreement(instance.cid)).content)
            : instance.agreement;
        const refs = kind === 'plans' ? content.designCids.map(cid => ({ cid })) : content.designs;
        const missing = refs.filter(ref => ref.cid && !win.DesignSync.localCopyOf(ref.cid)).map(ref => ref.cid);
        const downloaded = missing.length ? await win.DesignSync.fetchDesigns(missing) : { rows: new Map(), missing: [] };
        if (downloaded.missing.length) throw new Error(translator(win)('geometryUnavailable'));
        const members = refs.map(ref => {
            const local = ref.cid ? win.DesignSync.localCopyOf(ref.cid) : win.proposalStorage.getProposal(ref.proposalId);
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
            if (instance.cid) {
                const link = node('a', 'btn btn-sm', t(kind === 'plans' ? 'openPlan' : 'openAgreement'));
                link.href = membershipLink(kind, instance.cid, win);
                actions.appendChild(link);
            } else actions.appendChild(action(t('openAgreement'), async () => {
                try {
                    if (win.isThreeModeActive?.()) await win.requestMapMode('2d');
                    await win.AgreementPanel.open(instance.localId || instance.id);
                } catch (error) { win.showStyledAlert(error.message); }
            }));
            host.appendChild(actions);
            const details = node('div', 'click-stack__membership-details');
            host.appendChild(details);
            const load = async () => {
                details.replaceChildren(node('p', 'click-stack__facts', t('loading')));
                try {
                    const data = session ? await session.details(kind, instance) : await inspect(kind, instance, win);
                    Object.assign(instance, data);
                    onFocus(instance);
                    if (!host.isConnected) return;
                    details.replaceChildren();
                    const visibleDesignIds = new Set((hits.designs || []).map(design => String(design.id)));
                    const onlyVisible = data.members.length === 1 && visibleDesignIds.size === 1 && visibleDesignIds.has(String(data.members[0].id));
                    if (!onlyVisible) details.appendChild(win.ClickStackRelations.renderGroup({ kind: 'designs', relation: 'includedDesigns', instances: data.members, count: data.members.length }, doc, win));
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

    return { localAgreements, mergeRows, membershipLink, fetchPage, createSession, inspect, mountSection, strings };
});
