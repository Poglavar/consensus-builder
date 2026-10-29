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
    // One page of the public index. Explore has no city: its designs are those whose site meets the
    // visible area (area = getProposalCountAreaContext()), as the index matches a bbox.
    function indexQuery(kind, { city, area = null, offset = 0 }) {
        const params = new URLSearchParams({ limit: kind === 'designs' ? '1000' : '50' });
        if (kind === 'designs' && area?.explore && area.bbox) params.set('bbox', area.bbox.join(','));
        else params.set('city', city);
        if (kind !== 'designs') params.set('offset', String(offset));
        return params;
    }
    function browser(win) {
        const doc = win.document;
        const state = { tab: 'designs', source: 'local', search: '', publication: 'all', sort: 'title',
            // selecting: the tab whose rows show checkboxes (designs → Create plan, plans → Compare plans).
            filtersOpen: false, selecting: null, selected: new Map(), active: null, remote: new Map() };
        let ready = false;
        const t = (key, params) => win.i18n.t(key, params || {});
        const node = (tag, cls, text) => {
            const el = doc.createElement(tag); if (cls) el.className = cls;
            if (text !== undefined) el.textContent = text; return el;
        };
        const icon = name => {
            const el = node('i', name.startsWith('cb-icon-') ? `fas ${name}` : `fas fa-${name}`); el.setAttribute('aria-hidden', 'true'); return el;
        };
        function button(label, action, cls = '', iconName = null) {
            const el = node('button', `btn btn-sm ${cls}`, label); el.type = 'button';
            if (iconName) el.prepend(icon(iconName));
            el.addEventListener('click', () => {
                if (win.BusyControl.isBusy(el)) return;
                win.BusyControl.track(el, action).catch(error => win.showStyledAlert(error.message));
            });
            return el;
        }
        const city = () => win.normalizeCityCodeForApi(win.resolveCurrentCityCode());
        const area = () => state.tab === 'designs' ? win.getProposalCountAreaContext() : null;
        const cacheKey = () => { const view = area(); return `${win.DesignSync.apiBase()}:${view?.explore ? view.key : city()}:${state.tab}`; };
        const host = () => doc.getElementById({ designs: 'proposal-list-host', plans: 'plan-list-host', agreements: 'designs-agreements' }[state.tab]);
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
                const params = indexQuery(kind, { city: city(), area: area(), offset: page.next });
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
            const startSelecting = () => { state.selecting = state.tab; state.selected.clear(); renderActions(); renderRows(); };
            const stopSelecting = () => { state.selecting = null; state.selected.clear(); };
            const cancel = () => button(t('common.cancel'), () => { stopSelecting(); renderActions(); renderRows(); }, '', 'xmark');
            if (state.selecting === state.tab) actions.append(node('span', 'lists-selection-count', t('planDialog.selected', { count: state.selected.size })));
            if (state.tab === 'designs') {
                if (state.selecting !== 'designs') actions.append(button(t('planDialog.createPlan'), startSelecting, 'btn-primary', 'cb-icon-plan'));
                else {
                    const next = button(t('modal.track.curvature.continue'), async () => {
                        const members = [...state.selected.values()];
                        win.MapShell.closeSheets(); stopSelecting();
                        await win.PlanDialog.create({ members });
                    }, 'btn-primary', 'arrow-right'); next.disabled = !state.selected.size;
                    actions.append(next, cancel());
                }
            } else if (state.tab === 'plans') {
                if (state.selecting !== 'plans') {
                    actions.append(button(t('planDialog.createPlan'), () => {
                        win.MapShell.closeSheets(); return win.PlanDialog.create();
                    }, 'btn-primary', 'cb-icon-plan'));
                    actions.append(button(t('planCompare.title'), startSelecting, '', 'table-columns'));
                } else {
                    // Measured without applying, so plans that cannot stand on the map together compare.
                    const compare = button(t('planCompare.compare'), async () => {
                        const plans = [...state.selected.values()];
                        await win.comparePlanStats(plans);
                        stopSelecting(); renderActions(); renderRows();
                    }, 'btn-primary', 'table-columns'); compare.disabled = state.selected.size < 2;
                    compare.dataset.listsCompare = '';
                    actions.append(compare, cancel());
                }
            } else actions.append(node('span', 'sheet-note', t('lists.agreementHint')));
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
                const goal = row.local?.goal || row.record.goal || row.record.content?.goal;
                const appearance = kind === 'plans' ? ['cb-icon-plan', 'plan']
                    : kind === 'agreements' ? ['cb-icon-agreement', 'agreement']
                    : ({ park: ['tree', 'nature'], lake: ['water', 'water'], square: ['border-all', 'place'],
                        station: ['train', 'place'], single: ['building', 'building'], buildings: ['building', 'building'],
                        row: ['building', 'building'], parcelBased: ['house', 'building'], 'road-track': ['road', 'place'],
                        'parcel-layout': ['draw-polygon', 'plan'], 'urban-rule': ['ruler-combined', 'plan'],
                        'ownership-transfer': ['people-arrows', 'agreement'], 'as-is': ['location-dot', 'place'] }[goal] || ['cb-icon-design', 'place']);
                item.dataset.listTone = appearance[1];
                const heading = node('div', 'lists-item__heading');
                if (state.selecting === kind) {
                    const label = node('label', 'lists-item__selection');
                    const check = node('input'); check.type = 'checkbox'; check.checked = state.selected.has(row.key);
                    check.setAttribute('aria-label', t('lists.select', { title: row.title }));
                    check.addEventListener('change', async () => {
                        check.disabled = true; item.setAttribute('aria-busy', 'true');
                        try {
                            if (check.checked) state.selected.set(row.key, kind === 'plans' ? await planOf(row) : await designOf(row));
                            else state.selected.delete(row.key);
                        } catch (error) { check.checked = false; win.showStyledAlert(error.message); }
                        finally { check.disabled = false; item.removeAttribute('aria-busy'); renderActions(); }
                    }); label.append(check); heading.append(label);
                }
                const title = button(row.title, () => inspect(row, kind), 'btn-quiet lists-item__title');
                const mark = node('span', 'lists-item__icon'); mark.append(icon(appearance[0]));
                title.prepend(mark); heading.append(title); item.append(heading);
                const badges = node('div', 'lists-item__badges');
                if (kind === 'designs' && row.local) badges.innerHTML = win.proposalLadderBadgesHtml(row.local);
                else badges.append(node('span', `cb-badge cb-badge--${row.published ? 'published' : 'draft'}`, t(row.published ? 'common.lifecycle.published' : 'common.lifecycle.draft')));
                if (row.local) badges.append(node('span', 'cb-badge', t('modal.roadWidth.proposalList.sources.local')));
                if (kind === 'agreements' && (row.record.onchain || row.record.status)) {
                    const status = row.record.onchain?.status || row.record.status;
                    badges.append(node('span', 'cb-badge', win.AgreementPanel.chainStatusText(status)));
                }
                item.append(badges);
                if (kind === 'plans') item.append(node('p', 'sheet-note', t('agreement.list.designs', { count: row.record.content?.designCids.length ?? row.record.designCount })));
                if (kind === 'agreements' && row.local) item.append(node('p', 'sheet-note', win.AgreementPanel.ruleShort(row.local.rule)));
                const actions = node('div', 'cb-actions lists-item__actions');
                const shareButton = button(t('panel.proposal.actions.share'), () => share(row, kind), '', 'share-nodes');
                shareButton.querySelector('i').classList.add('lists-share-icon');
                if (kind === 'agreements' && !row.published) shareButton.title = t('lists.proposeFirst');
                actions.append(shareButton);
                if (kind === 'plans') {
                    actions.append(button(t('sidebar.proposals.planStats.modalTitle'), async () => {
                        await win.showPlanStatsModal(await planOf(row));
                    }, '', 'chart-pie'));
                    const rooster = button(t('sidebar.proposals.grainScore.buttonLabel'), async () => {
                        await win.summonUrbanistRooster(await planOf(row));
                    }, 'lists-rooster');
                    const portrait = node('img', 'lists-rooster__portrait');
                    portrait.src = '/images/grain-rooster-critic.png'; portrait.alt = '';
                    portrait.width = 32; portrait.height = 32;
                    rooster.prepend(portrait); actions.append(rooster);
                    actions.append(button(t('planDialog.createAgreement'), async () => {
                        const plan = await win.PlanWorkspace.resolve(await planOf(row));
                        win.MapShell.closeSheets(); return win.AgreementDialog.open({ plan });
                    }, '', 'cb-icon-agreement'));
                    actions.append(button(t('planDialog.schedule'), async () => {
                        const plan = await planOf(row);
                        win.MapShell.closeSheets(); return win.PlanDialog.schedule(plan);
                    }, '', 'hourglass-half'));
                }
                if (row.local) {
                    const trash = button('', () => remove(row, kind), 'btn-danger btn-icon lists-item__remove', 'trash-can');
                    trash.setAttribute('aria-label', t('lists.remove')); trash.title = t('lists.remove'); actions.append(trash);
                }
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
            for (const [value, key] of [['local', 'modal.roadWidth.proposalList.sources.local'], ['published', 'common.lifecycle.published']]) {
                const el = button(t(key), async () => {
                    state.source = value;
                    for (const toggle of box.querySelectorAll('[data-list-source]')) toggle.setAttribute('aria-pressed', String(toggle.dataset.listSource === value));
                    renderActions(); renderRows();
                    if (value === 'published' && !state.remote.has(cacheKey())) await load();
                    controls();
                }, 'cb-segmented__option', value === 'local' ? 'laptop' : 'globe');
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
            if (state.source === 'published') box.append(button(t('agreement.minted.refresh'), () => load(), 'lists-refresh', 'arrows-rotate'));
        }
        function init() {
            if (ready) return;
            ready = true;
            const tabs = [...doc.querySelectorAll('[data-list-tab]')];
            tabs.forEach((tab, index) => {
                tab.prepend(icon({ designs: 'cb-icon-design', plans: 'cb-icon-plan', agreements: 'cb-icon-agreement' }[tab.dataset.listTab]));
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
            if (state.selecting && state.selecting !== state.tab) { state.selecting = null; state.selected.clear(); }
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
    return { filterRows, indexQuery, browser };
});
