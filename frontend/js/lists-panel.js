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
            // selecting: the tab whose rows show checkboxes; purpose: what they are for ('compare', or
            // 'plan': the designs of a plan, ticked here with all of them shown on the map); planBase:
            // the plan whose revision they make, if any.
            filtersOpen: false, selecting: null, purpose: null, planBase: null, selected: new Map(), active: null, previewing: null, remote: new Map() };
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
        const host = () => doc.getElementById({ designs: 'proposal-list-host', plans: 'plan-list-host', agreements: 'agreement-list-host' }[state.tab]);
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
        // The design a row stands for, fetched when it is only published but never stored.
        async function designRecord(row) {
            return row.local || { ...win.DesignSync.localDesignFromRow(await win.DesignSync.fetchDesign(row.key), { apiBase: win.DesignSync.apiBase() }), proposalId: row.key };
        }
        // A design as Compare designs measures it: its one-member plan, placed at its site.
        function designPlan(record) {
            const site = win.__siteBinding.siteOf(record);
            const [lng, lat] = win.turf.centroid(site.type === 'Feature' ? site : win.turf.feature(site)).geometry.coordinates;
            return win.PlanComposition.ofDesign(record, [lat, lng]);
        }
        async function planOf(row) {
            const plan = row.record.content ? row.record : await win.NamedPlans.fetchPlan(row.key);
            return row.published ? { ...plan, published: true } : plan;
        }
        // An agreement's plan: its stored copy's, or the published one's fetched by CID. Null when a
        // stored agreement has no plan yet.
        async function agreementPlanOf(row) {
            return row.local ? row.local.plan : win.NamedPlans.fetchPlan(row.record.content.planCid);
        }
        // An agreement as Compare agreements reads it: its terms (a published one not held here is
        // fetched, not stored), its plan measured under the agreement's title, and its side on the
        // map's Compare (a stored agreement only).
        async function agreementCompared(row) {
            const agreement = row.local || (await win.AgreementSync.resolveDetails(row.key)).agreement;
            if (!agreement.plan) throw new Error(t('lists.agreementNoPlan', { title: row.title }));
            return { agreement, plan: agreement.plan, title: row.title, side: row.local ? `agreement:${row.local.id}` : null };
        }
        // The designs a row stands for, as records that need not be stored: the design itself, or
        // the members of a plan (an agreement shows its plan's).
        async function designRecords(row, kind) {
            const apiBase = win.DesignSync.apiBase();
            if (kind === 'designs') return [await designRecord(row)];
            const plan = kind === 'plans' ? await planOf(row) : await agreementPlanOf(row);
            if (!plan) return [];
            return win.PlanComposition.localRecords(await win.PlanWorkspace.resolve(plan), { apiBase });
        }
        // A row shows its object on the map and keeps the list open: browsing commits to nothing.
        // Closing the list by hand, like Open, then selects it (previewing).
        async function focus(row, kind) {
            state.active = `${kind}:${row.key}`; state.previewing = { row, kind }; renderRows();
            if (!win.previewRecordsOnMap(await designRecords(row, kind), `list:${state.active}`)) {
                win.showEphemeralMessage(t('lists.noPlace'), 4000, 'info');
            }
        }
        // Open selects the row's object as a click on it would, closing the list.
        async function inspect(row, kind) {
            state.active = `${kind}:${row.key}`; state.previewing = null;
            win.clearProposalPreview();
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
                win.ClickStack?.close(); win.ThreeClickStack?.close(); state.active = null; state.previewing = null;
                win.clearProposalPreview();
            }
            refresh();
        }
        // Ticking a plan's designs (Create plan on the Designs or Plans tab, or Change designs in the
        // plan dialog): `members` start ticked, `base` is the plan being revised.
        async function choosePlanDesigns({ members = [], base = null } = {}) {
            if (!opened()) win.MapShell.openSheet('proposals-sheet');
            await select('designs');
            state.source = 'local'; controls();
            state.selecting = 'designs'; state.purpose = 'plan'; state.planBase = base; state.selected.clear();
            for (const record of members) state.selected.set(String(record.proposalId), record);
            renderActions(); renderRows(); showPlanSelection();
        }
        // All the ticked designs on the map at once, as the plan they will make.
        // A plan's designs stand together: a design ticked for a plan is applied, virtually, with the
        // ones already ticked (PlanWorkspace.trial); one that cannot stand with them is not ticked.
        async function admitsPlanDesign(record) {
            const ticked = [...state.selected.values()];
            const ids = [...ticked, record].map(design => String(design.proposalId));
            const { fallen, failures } = await win.PlanWorkspace.trial(ids);
            if (!fallen.length) return true;
            const titleOf = design => `“${design?.title || t('planDialog.untitledDesign')}”`;
            const others = ticked.filter(design => fallen.includes(String(design.proposalId)));
            const reason = failures.find(failure => String(failure.proposalId) === String(record.proposalId))?.reason;
            win.showEphemeralMessage(others.length
                ? t('lists.takesGround', { title: titleOf(record), others: others.map(titleOf).join(', ') })
                : [t('lists.cannotStand', { title: titleOf(record) }), reason].filter(Boolean).join(' '), 8000, 'warning');
            return false;
        }
        function showPlanSelection() {
            if (state.purpose !== 'plan') return;
            const records = [...state.selected.values()];
            if (records.length) win.previewRecordsOnMap(records, 'list:plan-selection'); else win.clearProposalPreview();
        }
        function stopSelecting() {
            if (state.purpose === 'plan') win.clearProposalPreview();
            state.selecting = null; state.purpose = null; state.planBase = null; state.selected.clear();
        }
        // Each tab offers the same four actions where they apply, two to a row: Create, Compare,
        // Import and Imported, with the file formats below. Create plan, on Designs and Plans alike,
        // ticks the plan's designs here; a design starts from its place on the map.
        function renderActions() {
            const actions = doc.getElementById('lists-actions'); actions.replaceChildren();
            const kind = state.tab;
            const cancel = () => button(t('common.cancel'), () => { stopSelecting(); renderActions(); renderRows(); }, '', 'xmark');
            const selection = (...buttons) => {
                const row = node('div', 'cb-actions lists-actions__selecting');
                row.append(node('span', 'lists-selection-count', t('planDialog.selected', { count: state.selected.size })), ...buttons, cancel());
                actions.append(row);
            };
            if (state.selecting === kind && state.purpose === 'plan') {
                const next = button(t('modal.track.curvature.continue'), async () => {
                    const members = [...state.selected.values()], base = state.planBase;
                    stopSelecting(); win.MapShell.closeSheets();
                    await win.PlanDialog.create({ members, base });
                }, 'btn-primary', 'arrow-right'); next.disabled = !state.selected.size;
                next.dataset.listsContinue = '';
                return selection(next);
            }
            if (state.selecting === kind) {
                // Measured without applying, so items that cannot stand on the map together compare.
                const run = {
                    designs: records => win.comparePlanStats(records.map(designPlan), { subject: 'designs',
                        // A stored design is also a side on the map's Compare; one fetched only for this is not.
                        sides: records.map(record => win.proposalStorage.getProposal(record.proposalId) ? `design:${record.proposalId}` : null) }),
                    plans: plans => win.comparePlanStats(plans),
                    agreements: rows => win.comparePlanStats(rows.map(row => row.plan), { subject: 'agreements',
                        titles: rows.map(row => row.title), sides: rows.map(row => row.side), terms: rows.map(row => row.agreement) })
                }[kind];
                const compare = button(t('planCompare.compare'), async () => {
                    await run([...state.selected.values()]);
                    stopSelecting(); renderActions(); renderRows();
                }, 'btn-primary', 'table-columns'); compare.disabled = state.selected.size < 2;
                compare.dataset.listsCompare = '';
                return selection(compare);
            }
            const grid = node('div', 'lists-actions__grid');
            if (kind !== 'agreements') grid.append(button(t('planDialog.createPlan'), () => choosePlanDesigns(), 'btn-primary', 'cb-icon-plan'));
            if (kind === 'agreements') grid.append(button(t('agreement.list.create'), () => {
                win.MapShell.closeSheets(); return win.AgreementDialog.open();
            }, 'btn-primary', 'cb-icon-agreement'));
            grid.append(button(t({ designs: 'planCompare.titleDesigns', plans: 'planCompare.title', agreements: 'planCompare.titleAgreements' }[kind]), () => {
                state.selecting = kind; state.purpose = 'compare'; state.selected.clear(); renderActions(); renderRows();
            }, '', 'table-columns'));
            // The picker's file is read on its change; a closed picker starts nothing, and clearing the
            // input lets the same file be chosen again.
            // Plans and designs also come as city models: CityJSON or CityGML (plan-file-ui.js importFile).
            const input = node('input'); input.type = 'file'; input.hidden = true;
            input.accept = kind === 'agreements' ? '.json,application/json' : '.json,.gml,.xml,application/json,application/city+json,application/gml+xml';
            input.dataset.listsImportInput = kind;
            const importLabel = t({ designs: 'planFile.importDesign', plans: 'planFile.import', agreements: 'planFile.importAgreement' }[kind]);
            input.setAttribute('aria-label', importLabel);
            const choose = node('button', 'btn btn-sm', importLabel); choose.type = 'button'; choose.prepend(icon('file-import'));
            choose.dataset.listsImport = kind;
            choose.addEventListener('click', () => { if (!win.BusyControl.isBusy(choose)) input.click(); });
            input.addEventListener('change', () => {
                const file = input.files?.[0]; input.value = '';
                if (file) win.BusyControl.track(choose, () => win.PlanFileUI.importFile(kind, file)).then(refresh);
            });
            grid.append(choose, input, button(t({ designs: 'planFile.importedDesigns', plans: 'planFile.importedPlans', agreements: 'planFile.importedAgreements' }[kind]),
                async () => win.PlanFileUI.imported(kind), '', 'folder-open'));
            const help = node('a', 'lists-actions__help', t('planFile.help')); help.href = 'plan-files.html'; help.target = '_blank'; help.rel = 'noopener';
            actions.append(grid, help);
        }
        function renderRows() {
            if (!ready || !opened()) return;
            const kind = state.tab, page = state.remote.get(cacheKey());
            const rows = state.source === 'local' ? localRows(kind) : remoteRows(page?.rows || [], kind);
            const visible = filterRows(rows, state), list = host(); list.replaceChildren();
            const status = doc.getElementById('lists-status');
            status.textContent = page?.loading && state.source === 'published' ? t('lists.loading')
                : page?.error && state.source === 'published' ? page.error
                : visible.length ? t('lists.count', { count: visible.length }) : '';
            status.hidden = !status.textContent;
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
                            if (check.checked && state.purpose === 'plan') {
                                const record = await designOf(row);
                                if (await admitsPlanDesign(record)) state.selected.set(row.key, record);
                                else check.checked = false;
                            } else if (check.checked) state.selected.set(row.key, kind === 'plans' ? await planOf(row)
                                : kind === 'agreements' ? await agreementCompared(row) : await designRecord(row));
                            else state.selected.delete(row.key);
                            showPlanSelection();
                        } catch (error) { check.checked = false; win.showStyledAlert(error.message); }
                        finally { check.disabled = false; item.removeAttribute('aria-busy'); renderActions(); }
                    }); label.append(check); heading.append(label);
                }
                const title = node('h3', 'lists-item__title', row.title);
                // The whole card shows its object on the map (also by keyboard); its controls keep their actions.
                item.tabIndex = 0; item.title = t('modal.roadWidth.polygonError.showOnMap');
                const show = () => focus(row, kind).catch(error => win.showStyledAlert(error.message));
                item.addEventListener('click', event => {
                    if (!event.target.closest('button, a, input, label, select, summary')) show();
                });
                item.addEventListener('keydown', event => {
                    if (event.target === item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); show(); }
                });
                const mark = node('span', 'lists-item__icon'); mark.append(icon(appearance[0]));
                heading.append(mark, title); item.append(heading);
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
                const open = button(t('lists.open'), () => inspect(row, kind), 'btn-primary lists-item__open', 'arrow-pointer');
                open.setAttribute('aria-label', t('lists.openNamed', { title: row.title }));
                actions.append(open);
                const shareButton = button(t('panel.proposal.actions.share'), () => share(row, kind), '', 'share-nodes');
                shareButton.querySelector('i').classList.add('lists-share-icon');
                if (kind === 'agreements' && !row.published) shareButton.title = t('lists.proposeFirst');
                actions.append(shareButton);
                if (kind === 'designs') actions.append(button(t('common.download'), async () => win.PlanFileUI.design(await designRecord(row)), '', 'download'));
                if (kind === 'plans') actions.append(button(t('common.download'), async () => win.PlanFileUI.plan(await planOf(row)), '', 'download'));
                if (kind === 'agreements') actions.append(button(t('common.download'), async () => {
                    const resolved = row.local ? { agreement: row.local, designs: [] } : await win.AgreementSync.resolveDetails(row.key);
                    return win.PlanFileUI.downloadAgreement(resolved.agreement, resolved.designs);
                }, '', 'download'));
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
            if (!visible.length && !page?.loading && !(state.source === 'published' && page?.error)) list.append(node('p', 'sheet-note', t(rows.length ? 'lists.noMatch' : 'lists.empty')));
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
            const searchRow = node('div', 'lists-search-row');
            const search = node('input'); search.type = 'search'; search.value = state.search;
            search.placeholder = t('lists.search'); search.setAttribute('aria-label', t('lists.search'));
            search.addEventListener('input', () => { state.search = search.value; renderRows(); });
            const filters = node('div', 'lists-filter-panel'); filters.id = 'lists-filter-panel'; filters.hidden = !state.filtersOpen;
            const toggle = node('button', 'btn btn-sm lists-filter-toggle', t('modal.roadWidth.proposalList.filters.toggle')); toggle.type = 'button';
            toggle.prepend(icon('sliders')); toggle.setAttribute('aria-controls', filters.id); toggle.setAttribute('aria-expanded', String(state.filtersOpen));
            toggle.addEventListener('click', () => {
                state.filtersOpen = !state.filtersOpen; filters.hidden = !state.filtersOpen; toggle.setAttribute('aria-expanded', String(state.filtersOpen));
            });
            searchRow.append(search, toggle); box.append(searchRow);
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
            // Leaving the list by hand (×, Escape, the Lists button) selects the row being shown,
            // as Open does; a sheet closed for anything else (a dialog, another selection) does not.
            doc.addEventListener('mapshell:sheetclosed', event => {
                if (event.detail?.id !== 'proposals-sheet') return;
                const pending = state.previewing; state.previewing = null;
                if (pending && event.detail.byHand) inspect(pending.row, pending.kind).catch(error => win.showStyledAlert(error.message));
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
            if (state.selecting && state.selecting !== state.tab) stopSelecting();
            for (const el of doc.querySelectorAll('[data-list-tab]')) {
                const active = el.dataset.listTab === state.tab;
                el.setAttribute('aria-selected', String(active)); el.tabIndex = active ? 0 : -1;
                doc.getElementById(el.getAttribute('aria-controls')).hidden = !active;
            }
            renderActions(); renderRows();
            if (state.source === 'published' && !state.remote.has(cacheKey())) await load();
        }
        function refresh() { if (ready && opened()) { renderActions(); renderRows(); } }
        return { open: async () => { await win.i18n.translationsReady; init(); controls(); return select(state.tab); }, select, refresh, choosePlanDesigns };
    }
    return { filterRows, indexQuery, browser };
});
