// Reverse navigation for one exact design revision, combining local agreement drafts with public memberships.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.DesignMemberships = api;
        root.mountDesignMemberships = (host, proposal) => api.mount(host, proposal, root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const PAGE_SIZE = 5;
    const mounts = new WeakMap();
    const strings = {
        en: { title: 'Included in', plans: 'Plans', agreements: 'Agreements', empty: 'None', loading: 'Loading…', failed: 'Could not load this list.', retry: 'Retry', more: 'Show more', draft: 'Draft', unpublished: 'Publish this revision to find shared plans and agreements.' },
        hr: { title: 'Dio je', plans: 'Planovi', agreements: 'Sporazumi', empty: 'Nema', loading: 'Učitavanje…', failed: 'Popis nije moguće učitati.', retry: 'Pokušaj ponovno', more: 'Prikaži više', draft: 'Nacrt', unpublished: 'Objavite ovu verziju da biste pronašli povezane planove i sporazume.' },
        sr: { title: 'Deo je', plans: 'Planovi', agreements: 'Sporazumi', empty: 'Nema', loading: 'Učitavanje…', failed: 'Lista ne može da se učita.', retry: 'Pokušaj ponovo', more: 'Prikaži više', draft: 'Nacrt', unpublished: 'Objavite ovu verziju da biste pronašli povezane planove i sporazume.' },
        es: { title: 'Incluido en', plans: 'Planes', agreements: 'Acuerdos', empty: 'Ninguno', loading: 'Cargando…', failed: 'No se pudo cargar la lista.', retry: 'Reintentar', more: 'Mostrar más', draft: 'Borrador', unpublished: 'Publica esta versión para encontrar planes y acuerdos compartidos.' }
    };

    function localAgreements(proposalId, designCid, agreements, publishedCidOf) {
        return agreements.flatMap(agreement => {
            const cid = publishedCidOf(agreement);
            const member = (agreement.designs || []).some(design => cid
                ? designCid && design.cid === designCid
                : String(design.proposalId) === String(proposalId));
            return member ? [{ cid, localId: agreement.id, title: agreement.title, draft: !cid }] : [];
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

    async function mount(host, proposal, win) {
        if (!host?.isConnected) return;
        mounts.get(host)?.abort();
        const controller = new AbortController();
        mounts.set(host, controller);
        const current = () => host.isConnected && mounts.get(host) === controller;
        for (const [language, entries] of Object.entries(strings)) win.i18n?.registerTranslations(language,
            Object.fromEntries(Object.entries(entries).map(([key, value]) => [`designMemberships.${key}`, value])));
        const t = key => {
            const value = win.i18n?.t(`designMemberships.${key}`);
            return value && value !== `designMemberships.${key}` ? value : strings.en[key];
        };
        const doc = host.ownerDocument;
        const node = (tag, className, text) => {
            const element = doc.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        };
        const backend = win.resolveBackendBaseUrl().replace(/\/$/, '');
        const cid = win.DesignSync.publishedCid(proposal);
        const local = localAgreements(proposal.proposalId, cid, win.AgreementStore.list(), agreement => {
            if (agreement.published?.apiBase?.replace(/\/$/, '') !== backend) return null;
            // Imported agreements retain their verified publication reference while local land is reconstructed.
            return agreement.published.cid;
        });
        const knownPlan = win.NamedPlans.current;
        const groups = {
            plans: { items: cid && knownPlan?.content.designCids.includes(cid)
                ? [{ cid: knownPlan.cid, title: knownPlan.content.title }] : [] },
            agreements: { items: local }
        };
        host.replaceChildren();
        host.classList.add('design-memberships');
        host.setAttribute('aria-label', t('title'));
        host.appendChild(node('h4', 'design-memberships__title', t('title')));
        for (const [kind, state] of Object.entries(groups)) {
            state.shown = PAGE_SIZE;
            state.nextOffset = cid ? 0 : null;
            state.loading = !!cid;
            state.host = node('div', 'design-memberships__group');
            state.host.dataset.membershipKind = kind;
            host.appendChild(state.host);
        }
        if (!cid) host.appendChild(node('p', 'design-memberships__note', t('unpublished')));

        function render(kind) {
            if (!current()) return;
            const state = groups[kind], group = state.host;
            group.replaceChildren(node('h5', 'design-memberships__label', t(kind)));
            const list = node('ul', 'design-memberships__list');
            for (const row of state.items.slice(0, state.shown)) {
                const item = node('li', 'design-memberships__item');
                const link = node(row.cid ? 'a' : 'button', 'design-memberships__link', row.title || `${t(kind)} · ${String(row.cid || row.localId).slice(-8)}`);
                if (row.cid) link.href = membershipLink(kind, row.cid, win);
                else {
                    link.type = 'button';
                    link.addEventListener('click', async () => {
                        try {
                            if (win.isThreeModeActive?.()) await win.requestMapMode('2d');
                            await win.AgreementPanel.open(row.localId);
                        } catch (error) { win.showStyledAlert(error.message); }
                    });
                }
                item.appendChild(link);
                if (row.draft) item.appendChild(node('span', 'design-memberships__draft', t('draft')));
                list.appendChild(item);
            }
            if (list.childNodes.length) group.appendChild(list);
            if (!state.items.length && !state.loading && !state.error) group.appendChild(node('span', 'design-memberships__note', t('empty')));
            if (state.loading) {
                const status = node('span', 'design-memberships__note', t('loading'));
                status.setAttribute('role', 'status');
                group.appendChild(status);
            }
            if (state.error) {
                const status = node('span', 'design-memberships__note', t('failed'));
                status.setAttribute('role', 'status');
                group.appendChild(status);
                const retry = node('button', 'btn btn-sm', t('retry'));
                retry.type = 'button';
                retry.addEventListener('click', () => load(kind));
                group.appendChild(retry);
            } else if (!state.loading && (state.items.length > state.shown || state.nextOffset !== null)) {
                const more = node('button', 'btn btn-sm', t('more'));
                more.type = 'button';
                more.addEventListener('click', () => {
                    state.shown += PAGE_SIZE;
                    if (state.shown > state.items.length && state.nextOffset !== null) load(kind);
                    else render(kind);
                });
                group.appendChild(more);
            }
        }

        async function load(kind) {
            const state = groups[kind];
            state.loading = true; state.error = false; render(kind);
            try {
                const page = await fetchPage({ fetch: win.fetch.bind(win), backend, kind, designCid: cid,
                    offset: state.nextOffset || 0, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
                if (!current()) return;
                state.items = mergeRows(state.items, page.items);
                state.nextOffset = page.nextOffset;
            } catch (error) {
                if (!current() || controller.signal.aborted) return;
                state.error = true;
                win.console.warn(`[${new Date().toISOString()}] [DesignMemberships] ${kind} lookup failed`, error);
            } finally { state.loading = false; render(kind); }
        }
        for (const kind of Object.keys(groups)) render(kind);
        if (cid) await Promise.all(Object.keys(groups).map(load));
    }

    return { localAgreements, mergeRows, membershipLink, fetchPage, mount, strings };
});
