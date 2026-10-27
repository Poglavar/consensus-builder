// One browser library for designs, immutable plans, and agreements.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ListsPanel = api.browser(root);
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    function filterRows(rows, { search = '', publication = 'all', sort = 'title' } = {}) {
        const query = search.trim().toLocaleLowerCase();
        return rows.filter(row => (!query || `${row.title} ${row.author || ''}`.toLocaleLowerCase().includes(query))
            && (publication === 'all' || row.published === (publication === 'published')))
            .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title)
                : String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.title.localeCompare(b.title));
    }
    function browser(win) {
        const doc = win.document;
        const state = { tab: 'designs', source: 'local', search: '', publication: 'all', sort: 'title',
            filtersOpen: false, selecting: false, selected: new Map(), active: null, remote: new Map() };
        let ready = false;
        const t = (key, params) => win.i18n.t(key, params || {});
        const node = (tag, cls, text) => {
            const el = doc.createElement(tag); if (cls) el.className = cls;
            if (text !== undefined) el.textContent = text; return el;
        };
        function button(label, action, cls = '') {
            const el = node('button', `btn btn-sm ${cls}`, label); el.type = 'button';
            el.addEventListener('click', () => {
                if (win.BusyControl.isBusy(el)) return;
                win.BusyControl.track(el, action).catch(error => win.showStyledAlert(error.message));
            });
            return el;
        }
        const city = () => win.normalizeCityCodeForApi(win.resolveCurrentCityCode());
        const cacheKey = () => `${win.DesignSync.apiBase()}:${city()}:${state.tab}`;
        const host = () => doc.getElementById({ designs: 'proposal-list-host', plans: 'designs-plans', agreements: 'designs-agreements' }[state.tab]);
        const opened = () => win.MapShell?.isOpen('proposals-sheet');
        function localRows(kind) {
            if (kind === 'designs') return win.proposalStorage.getAllProposals().map(record => ({
                key: record.proposalId, title: record.title || t('planDialog.untitledDesign'), author: record.author,
                createdAt: record.createdAt, published: !!win.DesignSync.publishedCid(record), record, local: record
            }));
            if (kind === 'plans') return win.NamedPlans.list({ storedOnly: true })
                .filter(record => !record.content.view.city || win.normalizeCityCodeForApi(record.content.view.city) === city())
                .map(record => ({ key: record.cid, title: record.content.title, published: record.published === true || !Array.isArray(record.designs), record, local: record }));
            return win.AgreementStore.list().map(record => ({ key: record.id, title: record.title || t('agreement.panel.untitled'),
                author: record.author, createdAt: record.createdAt, published: !!record.published, record, local: record }));
        }
        function remoteRows(rows, kind) {
            const plans = kind === 'plans' ? new Map(localRows('plans').map(row => [row.key, row.local])) : null;
            return rows.map(record => ({ key: record.cid, title: record.title || record.content?.title || t(kind === 'designs' ? 'planDialog.untitledDesign' : 'agreement.panel.untitled'),
                author: record.author, createdAt: record.createdAt, published: true, record,
                local: kind === 'designs' ? win.DesignSync.localCopyOf(record.cid)
                    : kind === 'plans' ? plans.get(record.cid) : win.AgreementSync.localCopyOf(record.cid) }));
        }
        async function load(more = false) {
            const key = cacheKey(), kind = state.tab;
            const previous = state.remote.get(key);
            if (previous?.loading) return;
            const page = { rows: more ? previous.rows : [], next: more ? previous.next : 0, loading: true, error: null };
            state.remote.set(key, page); renderRows();
            try {
                const params = new URLSearchParams({ city: city(), limit: kind === 'designs' ? '1000' : '50' });
                if (kind !== 'designs') params.set('offset', String(page.next));
                const response = await win.fetch(`${win.DesignSync.apiBase()}/${kind}?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
                const result = await response.json();
                if (!response.ok || !Array.isArray(result[kind])) throw new Error(result.error || `HTTP ${response.status}`);
                page.rows.push(...result[kind]);
                page.next = result.hasMore ? result.nextOffset : null;
                page.limited = kind === 'designs' && result[kind].length === 1000;
            } catch (error) { page.error = error.message; }
            finally { page.loading = false; if (opened()) renderRows(); }
        }
        async function designOf(row) {
            return row.local || win.importServerProposal(row.key);
        }
        async function planOf(row) {
            const plan = row.record.content ? row.record : await win.NamedPlans.fetchPlan(row.key);
            return row.published ? { ...plan, published: true } : plan;
        }
        async function inspect(row, kind) {
            state.active = `${kind}:${row.key}`;
            if (kind === 'designs') {
                const record = await designOf(row);
                return win.openListedProposal(record, record.proposalId, 'details');
            }
            if (kind === 'plans') {
                const plan = await win.PlanWorkspace.resolve(await planOf(row));
                win.MapShell.closeSheets();
                return win.ClickStack.showPlan(plan, { designs: win.PlanComposition.localRecords(plan, { apiBase: win.DesignSync.apiBase() }), draft: !row.published });
            }
            win.MapShell.closeSheets();
            return row.local ? win.AgreementPanel.open(row.local.id) : win.AgreementSync.openDetails(row.key);
        }
        async function share(row, kind) {
            if (kind === 'designs') return win.shareSingleProposal(await designOf(row));
            if (kind === 'plans') return win.PlanDialog.share(await planOf(row));
            if (!row.published) {
                // Publication commits agreement terms; inspect/propose in its established editor.
                await inspect(row, kind); return;
            }
            const cid = row.local?.published?.cid || row.record.cid;
            const link = win.AgreementSync.agreementLink(cid, { city: row.record.city });
            const copied = await win.DesignSync.copyLink(link);
            win.showEphemeralMessage(copied ? t('planDialog.copied') : link, 6000, 'info');
        }
        async function remove(row, kind) {
            if (!row.local) return;
            if (!await win.CbDialog.confirm(t('lists.removeConfirm', { title: row.title }), {
                okText: t('lists.remove'), cancelText: t('common.cancel') })) return;
            if (kind === 'designs') await win.deleteProposal(row.local.proposalId);
            else if (kind === 'plans') win.NamedPlans.remove(row.key);
            else win.AgreementStore.remove(row.local.id);
            state.selected.delete(row.key);
            if (state.active === `${kind}:${row.key}`) {
                win.ClickStack?.close(); win.ThreeClickStack?.close(); state.active = null;
            }
            refresh();
        }
        function renderActions() {
            const actions = doc.getElementById('lists-actions'); actions.replaceChildren();
            if (state.tab === 'designs') {
                if (!state.selecting) actions.append(button(t('planDialog.createPlan'), () => {
                    state.selecting = true; state.selected.clear(); renderActions(); renderRows();
                }, 'btn-primary'));
                else {
                    actions.append(node('span', 'lists-selection-count', t('planDialog.selected', { count: state.selected.size })));
                    const next = button(t('lists.continue'), async () => {
                        const members = [...state.selected.values()];
                        win.MapShell.closeSheets(); state.selecting = false; state.selected.clear();
                        await win.PlanDialog.create({ members });
                    }, 'btn-primary'); next.disabled = !state.selected.size;
                    actions.append(next, button(t('common.cancel'), () => { state.selecting = false; state.selected.clear(); renderActions(); renderRows(); }));
                }
            } else if (state.tab === 'plans') actions.append(button(t('planDialog.createPlan'), () => {
                win.MapShell.closeSheets(); return win.PlanDialog.create();
            }, 'btn-primary'));
            else actions.append(node('span', 'sheet-note', t('lists.agreementHint')));
        }
        function renderRows() {
            if (!ready || !opened()) return;
            const kind = state.tab, page = state.remote.get(cacheKey());
            const rows = state.source === 'local' ? localRows(kind) : remoteRows(page?.rows || [], kind);
            const visible = filterRows(rows, state), list = host(); list.replaceChildren();
            const status = doc.getElementById('lists-status');
            status.textContent = page?.loading && state.source === 'published' ? t('lists.loading')
                : page?.error && state.source === 'published' ? page.error
                : t('lists.count', { shown: visible.length, total: rows.length });
            list.setAttribute('aria-busy', String(state.source === 'published' && !!page?.loading));
            for (const row of visible) {
                const item = node('article', `lists-item${state.active === `${kind}:${row.key}` ? ' is-selected' : ''}`);
                item.dataset.listId = row.key;
                const heading = node('div', 'lists-item__heading');
                if (kind === 'designs' && state.selecting) {
                    const label = node('label', 'lists-item__selection');
                    const check = node('input'); check.type = 'checkbox'; check.checked = state.selected.has(row.key);
                    check.setAttribute('aria-label', t('lists.select', { title: row.title }));
                    check.addEventListener('change', async () => {
                        check.disabled = true; item.setAttribute('aria-busy', 'true');
                        try {
                            if (check.checked) state.selected.set(row.key, await designOf(row));
                            else state.selected.delete(row.key);
                        } catch (error) { check.checked = false; win.showStyledAlert(error.message); }
                        finally { check.disabled = false; item.removeAttribute('aria-busy'); renderActions(); }
                    }); label.append(check); heading.append(label);
                }
                const title = button(row.title, () => inspect(row, kind), 'btn-quiet lists-item__title');
                heading.append(title); item.append(heading);
                const badges = node('div', 'lists-item__badges');
                if (kind === 'designs' && row.local) badges.innerHTML = win.proposalLadderBadgesHtml(row.local);
                else badges.append(node('span', `cb-badge cb-badge--${row.published ? 'published' : 'draft'}`, t(row.published ? 'common.lifecycle.published' : 'common.lifecycle.draft')));
                if (row.local) badges.append(node('span', 'cb-badge', t('lists.thisBrowser')));
                if (kind === 'agreements' && (row.record.onchain || row.record.status)) {
                    const status = row.record.onchain?.status || row.record.status;
                    badges.append(node('span', 'cb-badge', win.AgreementPanel.chainStatusText(status)));
                }
                item.append(badges);
                if (kind === 'plans') item.append(node('p', 'sheet-note', t('agreement.list.designs', { count: row.record.content?.designCids.length ?? row.record.designCount })));
                if (kind === 'agreements' && row.local) item.append(node('p', 'sheet-note', win.AgreementPanel.ruleShort(row.local.rule)));
                const actions = node('div', 'cb-actions lists-item__actions');
                const shareButton = button(t('panel.proposal.actions.share'), () => share(row, kind));
                if (kind === 'agreements' && !row.published) shareButton.title = t('lists.proposeFirst');
                actions.append(shareButton);
                if (kind === 'plans') actions.append(button(t('planDialog.createAgreement'), async () => {
                    const plan = await win.PlanWorkspace.resolve(await planOf(row));
                    win.MapShell.closeSheets(); return win.AgreementDialog.open({ plan });
                }));
                if (row.local) actions.append(button(t('lists.remove'), () => remove(row, kind), 'btn-quiet'));
                item.append(actions); list.append(item);
            }
            if (!visible.length && !page?.loading) list.append(node('p', 'sheet-note', t('lists.empty')));
            if (state.source === 'published' && page?.next != null && !page.loading) list.append(button(t('lists.loadMore'), () => load(true)));
            if (state.source === 'published' && page?.limited) list.append(node('p', 'sheet-note', t('lists.limited')));
        }
        function controls() {
            const box = doc.getElementById('lists-controls'); box.replaceChildren();
            const scopes = node('div', 'cb-segmented cb-segmented--fill'); scopes.setAttribute('role', 'group');
            scopes.setAttribute('aria-label', t('lists.source'));
            for (const [value, key] of [['local', 'lists.thisBrowser'], ['published', 'common.lifecycle.published']]) {
                const el = button(t(key), async () => {
                    state.source = value;
                    for (const toggle of box.querySelectorAll('[data-list-source]')) toggle.setAttribute('aria-pressed', String(toggle.dataset.listSource === value));
                    renderActions(); renderRows();
                    if (value === 'published' && !state.remote.has(cacheKey())) await load();
                    controls();
                }, 'cb-segmented__option');
                el.dataset.listSource = value; el.setAttribute('aria-pressed', String(state.source === value)); scopes.append(el);
            }
            box.append(scopes);
            const fields = node('div', 'lists-filters');
            const searchLabel = node('label', '', t('lists.search'));
            const search = node('input'); search.type = 'search'; search.value = state.search;
            search.addEventListener('input', () => { state.search = search.value; renderRows(); }); searchLabel.append(search); box.append(searchLabel);
            const filters = node('details', 'lists-filter-details'); filters.open = state.filtersOpen;
            filters.addEventListener('toggle', () => { state.filtersOpen = filters.open; });
            filters.append(node('summary', '', t('modal.roadWidth.proposalList.filters.toggle')));
            for (const [key, label, options] of [
                ['publication', 'modal.roadWidth.proposalList.filters.publication', [['all', 'modal.roadWidth.proposalList.filters.publicationAll'], ['draft', 'common.lifecycle.draft'], ['published', 'common.lifecycle.published']]],
                ['sort', 'modal.roadWidth.proposalList.filters.sort', [['title', 'lists.byTitle'], ['newest', 'lists.newest']]]
            ]) {
                const wrap = node('label', '', t(label)), select = node('select');
                for (const [value, text] of options) { const option = node('option', '', t(text)); option.value = value; select.append(option); }
                select.dataset.listFilter = key;
                select.value = state[key]; select.addEventListener('change', () => { state[key] = select.value; renderRows(); });
                wrap.append(select); fields.append(wrap);
            }
            filters.append(fields);
            const actions = node('div', 'cb-actions');
            actions.append(button(t('modal.roadWidth.proposalList.filters.reset'), () => {
                state.search = ''; state.publication = 'all'; state.sort = 'title'; controls(); renderRows();
            }, 'btn-quiet'));
            filters.append(actions); box.append(filters);
            if (state.source === 'published') box.append(button(t('agreement.minted.refresh'), () => load(), 'lists-refresh'));
        }
        function init() {
            if (ready) return;
            ready = true;
            const tabs = [...doc.querySelectorAll('[data-list-tab]')];
            tabs.forEach((tab, index) => {
                tab.addEventListener('click', () => win.BusyControl.track(tab, () => select(tab.dataset.listTab)));
                tab.addEventListener('keydown', event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    tabs[next].focus(); tabs[next].click();
                });
            });
            win.AgreementStore.subscribe(refresh);
            win.addEventListener('planschange', refresh);
            win.addEventListener('i18n:translationsLoaded', () => { if (opened()) { controls(); refresh(); } });
            controls();
        }
        async function select(tab) {
            await win.i18n.translationsReady;
            init(); state.tab = tab === 'browse' ? 'designs' : tab;
            if (!['designs', 'plans', 'agreements'].includes(state.tab)) state.tab = 'designs';
            for (const el of doc.querySelectorAll('[data-list-tab]')) {
                const active = el.dataset.listTab === state.tab;
                el.setAttribute('aria-selected', String(active)); el.tabIndex = active ? 0 : -1;
                doc.getElementById(el.getAttribute('aria-controls')).hidden = !active;
            }
            renderActions(); renderRows();
            if (state.source === 'published' && !state.remote.has(cacheKey())) await load();
        }
        function refresh() { if (ready && opened()) { renderActions(); renderRows(); } }
        return { open: async () => { await win.i18n.translationsReady; init(); controls(); return select(state.tab); }, select, refresh };
    }
    return { filterRows, browser };
});
