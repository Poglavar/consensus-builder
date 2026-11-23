// One browser library for designs, immutable plans, and agreements.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ListsPanel = api.browser(root);
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    // A row's stage of saving one object: a draft is autosaved in this browser only, a published one
    // is saved on the server too, and an agreement put on chain is saved there as well.
    function stageOf(row) {
        return row.onChain ? 'onchain' : row.published ? 'published' : 'draft';
    }
    // One list per kind: the server's published rows and this browser's, one row per object. A
    // browser's copy of a published object (its cache) joins that object's row under the copy's own
    // key; drafts, and published copies the server page did not return, stay as they are.
    function mergeRows(local, remote) {
        const byCid = new Map(local.filter(row => row.cid).map(row => [row.cid, row]));
        const joined = new Set();
        const rows = remote.map(row => {
            const mine = byCid.get(row.key);
            if (!mine) return row;
            joined.add(mine);
            return { ...row, key: mine.key, local: row.local || mine.local, onChain: row.onChain || mine.onChain,
                publishedAt: row.publishedAt ?? mine.publishedAt, createdAt: row.createdAt ?? mine.createdAt };
        });
        return [...rows, ...local.filter(row => !joined.has(row))];
    }
    function timestampOf(row) {
        const published = Date.parse(row.publishedAt);
        return Number.isFinite(published) ? published : Date.parse(row.createdAt);
    }
    // onMap keeps only the rows applied to this browser's map (row.applied, Designs only).
    function filterRows(rows, { search = '', publication = 'all', sort = 'newest', onMap = false } = {}) {
        const query = search.trim().toLocaleLowerCase();
        const newest = row => { const at = timestampOf(row); return Number.isFinite(at) ? at : -Infinity; };
        return rows.filter(row => (!query || `${row.title} ${row.author || ''} ${row.cid || ''} ${row.key || ''}`.toLocaleLowerCase().includes(query))
            && (publication === 'all' || stageOf(row) === publication)
            && (!onMap || row.applied === true))
            .sort((a, b) => (sort === 'newest' ? newest(b) - newest(a) : 0) || a.title.localeCompare(b.title));
    }
    // One page of the public index. Explore has no city: its designs are those whose site meets the
    // visible area (area = getProposalCountAreaContext()), as the index matches a bbox.
    function indexQuery(kind, { city, area = null, offset = 0 }) {
        const params = new URLSearchParams({ limit: '50' });
        if (kind === 'designs' && area?.explore && area.bbox) params.set('bbox', area.bbox.join(','));
        else params.set('city', city);
        if (offset || kind !== 'designs') params.set('offset', String(offset));
        return params;
    }
    // A row's trash: Delete draft for an unpublished object, which lives only in this browser;
    // Remove from this device for this browser's copy of a published one, which stays available
    // through its link. A design on the map comes off it (deleteProposal unapplies it first).
    // → { label, confirm } as i18n keys.
    function removal(row, kind) {
        if (!row.published) return { label: 'lists.remove', confirm: kind === 'designs' ? 'lists.removeDesignConfirm' : 'lists.removeConfirm' };
        return { label: 'lists.removeLocal',
            confirm: { designs: 'lists.removeLocalConfirm', plans: 'lists.removeLocalPlanConfirm', agreements: 'agreement.panel.removeLocalConfirm' }[kind] };
    }
    function browser(win) {
        const doc = win.document;
        const analysis = win.PlanAnalysisControls || require('./ui/plan-analysis-controls.js');
        const state = { tab: 'designs', search: '', publication: 'all', sort: 'newest', onMap: false,
            // selecting: the tab whose rows show checkboxes; purpose: what they are for ('compare', or
            // 'plan': the designs of a plan, ticked here with all of them shown on the map); planBase:
            // the plan whose revision they make, if any.
            filtersOpen: false, selecting: null, purpose: null, planBase: null, selected: new Map(), active: null, previewing: null, remote: new Map(),
            // hovering: the card whose object is outlined under the pointer; records: each clicked card's designs,
            // read once; known: those already read, the only ones a hover shows
            hovering: null, records: new Map(), known: new Map(), openCritics: new Set() };
        let ready = false;
        const pageSize = 50;
        let shownLimit = pageSize, previewSequence = 0, loadingPreview = null, searchTimer;
        const localLists = new Map();
        const cardCaches = new WeakMap();
        const t = (key, params) => win.i18n.t(key, params || {});
        const offerDirection = direction => (direction === 'buy' ? t('propertyOffer.directions.buy') : t('propertyOffer.directions.sell'));
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
        const areaKey = () => { const view = area(); return `${win.DesignSync.apiBase()}:${view?.explore ? view.key : city()}:${state.tab}`; };
        const cacheKey = () => state.tab === 'designs' ? JSON.stringify([areaKey(), state.search.trim(), state.sort]) : areaKey();
        const host = () => doc.getElementById({ designs: 'proposal-list-host', plans: 'plan-list-host', agreements: 'agreement-list-host' }[state.tab]);
        const opened = () => win.MapShell?.isOpen('proposals-sheet');
        // Applied to this browser's map, as its "Applied" badge says (proposals/display-state.js).
        const appliedHere = record => !!record && win.__proposalDisplayState.of(record).applied;
        const labelOnMap = (el, count) => el.replaceChildren(icon('check'), t('lists.onMap', { count }));
        const labelUnapplyAll = (el, count) => { el.replaceChildren(icon('box-archive'), t('lists.unapplyAll', { count })); el.hidden = count === 0; };
        // Every design applied here comes off the map in one change, after one question. They stay
        // in the list, and the notice names what came off and offers Undo
        // (proposals/layer-render.js unapplyDesignsFromMap).
        async function unapplyApplied() {
            const ids = localRows('designs').filter(row => appliedHere(row.local)).map(row => String(row.local.proposalId));
            if (!ids.length) return;
            if (!await win.CbDialog.confirm(t('lists.unapplyAllConfirm', { count: ids.length }), {
                okText: t('panel.proposal.actions.remove'), cancelText: t('common.cancel') })) return;
            const cameOff = await win.unapplyDesignsFromMap(ids);
            // Nothing is left on the map: a pressed "On the map" would only show an empty list.
            if (cameOff && state.onMap) {
                state.onMap = false;
                doc.querySelector('[data-lists-on-map]')?.setAttribute('aria-pressed', 'false');
            }
            renderRows();
        }
        function localRows(kind, index = kind === 'designs' && win.DesignSync.localDesignIndex()) {
            if (kind === 'designs') return index.records.map(record => {
                const cid = index.published.get(record);
                return { key: record.proposalId, title: record.title || t('planDialog.untitledDesign'), author: record.author,
                    createdAt: record.createdAt, publishedAt: cid ? record.published?.publishedAt : null,
                    published: !!cid, cid, record, local: record };
            });
            const key = JSON.stringify([kind, city(), win.i18n.getLocale?.()]);
            if (localLists.has(key)) return localLists.get(key);
            if (kind === 'plans') {
                const plans = win.NamedPlans.list({ storedOnly: true })
                .filter(record => !record.content.view.city || win.normalizeCityCodeForApi(record.content.view.city) === city())
                .map(record => ({ key: record.cid, title: record.content.title, publishedAt: record.publishedAt, createdAt: record.createdAt, published: record.published === true || !Array.isArray(record.designs), cid: record.cid, record, local: record }));
                localLists.set(key, plans);
                return plans;
            }
            const offers = (win.PropertyOfferStore?.list() || []).map(record => ({ key: record.id, propertyOffer: true,
                title: record.content.title || offerDirection(record.content.direction), author: record.content.proposer, createdAt: record.content.createdAt,
                publishedAt: record.published?.publishedAt, published: !!record.published, cid: record.published?.cid || null,
                onChain: !!record.onchain, record, local: record }));
            const agreements = [...offers, ...win.AgreementStore.list().map(record => ({ key: record.id, title: record.title || t('agreement.panel.untitled'),
                author: record.author, createdAt: record.createdAt, publishedAt: record.published?.publishedAt,
                published: !!record.published, cid: record.published?.cid || null,
                onChain: !!record.onchain, record, local: record }))];
            localLists.set(key, agreements);
            return agreements;
        }
        function remoteRows(rows, kind, local, index) {
            const copies = kind === 'designs' ? index.byCid : new Map(local.map(row => [row.cid, row.local]));
            return rows.map(record => ({ key: record.cid, propertyOffer: record.content?.schema === 'property-offer/v1', cid: record.cid || null, title: record.title || record.content?.title || t(kind === 'designs' ? 'planDialog.untitledDesign' : 'agreement.panel.untitled'),
                // The design, agreement and offer indexes call their first publication time createdAt.
                author: record.author, publishedAt: record.publishedAt ?? record.createdAt,
                createdAt: record.content?.createdAt ?? record.content?.authoredAt, published: true, onChain: !!record.onchain, record,
                local: copies.get(record.cid) }));
        }
        function load({ more = false, force = false } = {}) {
            const key = cacheKey(), kind = state.tab, previous = state.remote.get(key);
            if (previous?.pending) return previous.pending;
            if (previous && !more && !force) return Promise.resolve();
            const location = { city: city(), area: area(), search: state.search.trim(), sort: state.sort };
            const base = win.DesignSync.apiBase(), scope = areaKey();
            const feeds = kind === 'agreements' ? [['agreements', 'agreements'], ['property-offers', 'propertyOffers']] : [[kind, kind]];
            const page = more && previous ? previous : { scope, feeds: feeds.map(([path, field]) => ({ path, field, rows: [], next: 0 })) };
            state.remote.set(key, page);
            if (state.remote.size > 48) state.remote.delete(state.remote.keys().next().value);
            const redraw = () => { if (opened() && cacheKey() === key && state.remote.get(key) === page) renderRows(); };
            page.loading = true;
            page.pending = Promise.all(page.feeds.filter(feed => feed.next !== null).map(async feed => {
                feed.error = null;
                try {
                    const offset = feed.next;
                    let result;
                    if (kind === 'designs') result = await win.DesignSync.listPage({ ...location, offset, force });
                    else {
                        const response = await win.fetch(`${base}/${feed.path}?${indexQuery(kind, { ...location, offset })}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
                        result = await response.json();
                        if (!response.ok || !Array.isArray(result[feed.field])) throw new Error(result.error || `HTTP ${response.status}`);
                    }
                    feed.rows.push(...result[feed.field]);
                    feed.next = result.hasMore && Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
                } catch (error) { feed.error = error.message; }
                redraw();
            })).finally(() => { page.loading = false; page.pending = null; redraw(); });
            redraw();
            return page.pending;
        }
        function queryChanged() {
            clearTimeout(searchTimer);
            shownLimit = pageSize;
            renderRows();
            const key = cacheKey();
            searchTimer = setTimeout(async () => {
                if (!opened() || key !== cacheKey()) return;
                await load();
                // These smaller indexes offer paging without a text query. Finish a search or
                // title sort across all their pages, stopping if the reader leaves the query.
                while (opened() && key === cacheKey() && state.tab !== 'designs' && (state.search.trim() || state.sort === 'title')
                    && state.remote.get(key)?.feeds.some(feed => feed.next !== null && !feed.error)) await load({ more: true });
            }, 120);
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
            if (row.propertyOffer) return null;
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
        // A clicked card's designs, read once until the lists change.
        function cachedRecords(row, kind) {
            const key = `${kind}:${row.key}`;
            if (!state.records.has(key)) {
                const pending = designRecords(row, kind).then(records => {
                    if (state.records.get(key) === pending) state.known.set(key, records);
                    return records;
                }).catch(error => { if (state.records.get(key) === pending) state.records.delete(key); throw error; });
                state.records.set(key, pending);
            }
            return state.records.get(key);
        }
        // What a hover may show: a stored design, or a card already clicked. A hover never fetches or
        // stores anything (a published plan's designs are read on a click, or kept with Download).
        function knownRecords(row, kind) {
            return state.known.get(`${kind}:${row.key}`) || (kind === 'designs' && row.local ? [row.local] : null);
        }
        // Hovering a card outlines its object where it is; leaving it puts back the card last clicked.
        function hover(row, kind) {
            const records = knownRecords(row, kind);
            if (!records) return;
            state.hovering = `${kind}:${row.key}`;
            win.previewRecordsOnMap(records, `list:${state.hovering}`, { reveal: false });
        }
        function unhover(row, kind) {
            if (state.hovering !== `${kind}:${row.key}`) return;
            state.hovering = null;
            const shown = state.previewing && knownRecords(state.previewing.row, state.previewing.kind);
            if (shown) win.previewRecordsOnMap(shown, `list:${state.active}`, { reveal: false });
            else win.clearProposalPreview();
        }
        async function focus(row, kind, item) {
            if (row.propertyOffer) return inspect(row, kind);
            const sequence = ++previewSequence, key = `${kind}:${row.key}`, scope = areaKey();
            state.active = key; state.previewing = { row, kind };
            loadingPreview = { sequence, title: row.title };
            const status = doc.getElementById('lists-status');
            status.textContent = [t('lists.loading'), row.title].join(' · ');
            status.hidden = false;
            for (const card of host().querySelectorAll('[data-list-id]')) card.classList.toggle('is-selected', card === item);
            const current = () => sequence === previewSequence && opened() && scope === areaKey();
            try {
                const records = await win.BusyControl.track(item, () => cachedRecords(row, kind));
                if (current() && !win.previewRecordsOnMap(records, `list:${key}`)) win.showEphemeralMessage(t('lists.noPlace'), 4000, 'info');
            } catch (error) { if (current()) { state.previewing = null; throw error; } }
            finally {
                if (loadingPreview?.sequence === sequence) loadingPreview = null;
                if (current()) renderRows();
            }
        }
        // Open selects the row's object as a click on it would, closing the list.
        async function inspect(row, kind) {
            const sequence = ++previewSequence, scope = areaKey();
            const current = () => sequence === previewSequence && scope === areaKey();
            state.active = `${kind}:${row.key}`; state.previewing = null;
            win.clearProposalPreview();
            if (kind === 'designs') {
                const record = await designOf(row);
                if (!current()) return;
                return win.openListedProposal(record, record.proposalId, 'details');
            }
            if (kind === 'plans') {
                const plan = await win.PlanWorkspace.resolve(await planOf(row));
                if (!current()) return;
                win.MapShell.closeSheets();
                return win.ClickStack.showPlan(plan, { designs: win.PlanComposition.localRecords(plan, { apiBase: win.DesignSync.apiBase() }), draft: !row.published });
            }
            win.MapShell.closeSheets();
            if (row.propertyOffer) return row.local ? win.PropertyOfferPanel.open(row.local.id) : win.PropertyOfferSync.openDetails(row.key);
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
            const link = row.propertyOffer ? win.PropertyOfferSync.link(cid, { city: row.local?.content.city || row.record.content?.city })
                : win.AgreementSync.agreementLink(cid, { city: row.record.city });
            return win.ShareDialog.open({ kind: 'agreement', title: row.title, link });
        }
        async function remove(row, kind) {
            if (!row.local) return;
            const keys = removal(row, kind);
            if (!await win.CbDialog.confirm(t(keys.confirm, { title: row.title }), {
                okText: t(keys.label), cancelText: t('common.cancel'), destructive: true })) return;
            if (kind === 'designs') await win.deleteProposal(row.local.proposalId);
            else if (kind === 'plans') win.NamedPlans.remove(row.key);
            else if (row.propertyOffer) win.PropertyOfferStore.remove(row.local.id);
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
            state.selecting = 'designs'; state.purpose = 'plan'; state.planBase = base; state.selected.clear();
            for (const record of members) state.selected.set(String(record.proposalId), record);
            renderActions(); renderRows(); showPlanSelection();
        }
        // All the ticked designs on the map at once, as the plan they will make.
        // A plan's designs stand together. The design just ticked is applied, virtually, after the
        // ones already ticked (PlanWorkspace.trial), as an Apply click on the map would be: it takes
        // its ground, and the ticked designs it stands down are unticked, with a warning naming them.
        // One the apply refuses outright is not ticked, with the reason.
        async function admitsPlanDesign(record, key) {
            const id = String(record.proposalId);
            const ticked = [...state.selected.entries()];
            const { fallen, failures } = await win.PlanWorkspace.trial([...ticked.map(([, design]) => String(design.proposalId)), id], { last: id });
            const titleOf = design => `“${design?.title || t('planDialog.untitledDesign')}”`;
            if (fallen.includes(id)) {
                const reason = failures.find(failure => String(failure.proposalId) === id)?.reason;
                win.showEphemeralMessage([t('lists.cannotStand', { title: titleOf(record) }), reason].filter(Boolean).join(' '), 8000, 'warning');
                return false;
            }
            const displaced = ticked.filter(([, design]) => fallen.includes(String(design.proposalId)));
            state.selected.set(key, record);
            if (displaced.length) {
                displaced.forEach(([other]) => state.selected.delete(other));
                win.showEphemeralMessage(t('lists.takesGround', { title: titleOf(record), others: displaced.map(([, design]) => titleOf(design)).join(', ') }), 8000, 'warning');
                renderRows();
            }
            return true;
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
                if (file) win.BusyControl.track(choose, async () => {
                    if (kind === 'agreements') {
                        const content = JSON.parse(await file.text());
                        if (content.schema === 'property-offer/v1') {
                            const record = win.PropertyOfferSync.create(content);
                            return win.PropertyOfferPanel.open(record.id);
                        }
                    }
                    return win.PlanFileUI.importFile(kind, file);
                }).then(refresh).catch(error => win.showStyledAlert(error.message));
            });
            grid.append(choose, input, button(t({ designs: 'planFile.importedDesigns', plans: 'planFile.importedPlans', agreements: 'planFile.importedAgreements' }[kind]),
                async () => win.PlanFileUI.imported(kind), '', 'folder-open'));
            const help = node('a', 'lists-actions__help', t('planFile.help')); help.href = 'plan-files.html'; help.target = '_blank'; help.rel = 'noopener';
            actions.append(grid, help);
        }
        function renderRows() {
            if (!ready || !opened()) return;
            const kind = state.tab, page = state.remote.get(cacheKey());
            const index = kind === 'designs' && win.DesignSync.localDesignIndex();
            const local = localRows(kind, index);
            // Already-read cards can be filtered immediately while the full search is in flight.
            const fallback = kind === 'designs' && state.remote.get(JSON.stringify([areaKey(), '', 'newest']));
            const displayed = page && (!page.loading || page.feeds.some(feed => feed.rows.length)) ? page : fallback;
            const remote = [...new Map((displayed?.feeds || []).flatMap(feed => feed.rows).map(record => [record.cid, record])).values()];
            const rows = mergeRows(local, remoteRows(remote, kind, local, index))
                .map(row => ({ ...row, applied: kind === 'designs' && appliedHere(row.local) }));
            const visible = filterRows(rows, { ...state, onMap: kind === 'designs' && state.onMap }), list = host();
            let cards = cardCaches.get(list);
            if (!cards) { cards = new Map(); cardCaches.set(list, cards); }
            const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
            const focusedCard = focused?.closest('[data-list-id]');
            const selector = 'button, input, summary, select, a';
            const focusIndex = focusedCard ? Array.from(focusedCard.querySelectorAll(selector)).indexOf(focused) : -1;
            const desired = [];
            const onMap = doc.querySelector('[data-lists-on-map]');
            if (onMap) labelOnMap(onMap, rows.filter(row => row.applied).length);
            const unapplyAll = doc.querySelector('[data-lists-unapply-all]');
            if (unapplyAll) labelUnapplyAll(unapplyAll, rows.filter(row => row.applied).length);
            const status = doc.getElementById('lists-status');
            const errors = (page?.feeds || []).map(feed => feed.error).filter(Boolean).join(' · ');
            const previewTitle = loadingPreview?.sequence === previewSequence ? loadingPreview.title : '';
            status.textContent = [page?.loading || previewTitle ? t('lists.loading') : '', previewTitle, errors,
                visible.length ? t('lists.count', { count: Math.min(visible.length, shownLimit) }) : ''].filter(Boolean).join(' · ');
            status.hidden = !status.textContent;
            list.setAttribute('aria-busy', String(!!page?.loading));
            const recordIds = visible.map(row => String(row.cid || row.key || '')).filter(Boolean);
            for (const row of visible.slice(0, shownLimit)) {
                const recordId = String(row.cid || row.key || '');
                const recordLabel = win.RecordLabel.label(row.title, recordId, recordIds);
                const signature = JSON.stringify([recordLabel, row.title, row.applied, row.published, row.onChain,
                    timestampOf(row), state.selecting, state.purpose, win.i18n.getLocale?.(), row.local && win.proposalStorage.revision]);
                const cached = cards.get(row.key);
                if (cached && cached.signature === signature && cached.record === row.record && cached.local === row.local) {
                    cached.item.classList.toggle('is-selected', state.active === `${kind}:${row.key}`);
                    const check = cached.item.querySelector('input[type="checkbox"]');
                    if (check && !check.disabled) check.checked = state.selected.has(row.key);
                    desired.push(cached.item);
                    continue;
                }
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
                if (state.selecting === kind && !row.propertyOffer) {
                    const label = node('label', 'lists-item__selection');
                    const check = node('input'); check.type = 'checkbox'; check.checked = state.selected.has(row.key);
                    check.setAttribute('aria-label', t('lists.select', { title: recordLabel }));
                    check.addEventListener('change', async () => {
                        check.disabled = true; item.setAttribute('aria-busy', 'true');
                        try {
                            if (check.checked && state.purpose === 'plan') {
                                const record = await designOf(row);
                                if (!(await admitsPlanDesign(record, row.key))) check.checked = false;
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
                const show = () => focus(row, kind, item).catch(error => win.showStyledAlert(error.message));
                item.addEventListener('click', event => {
                    if (!event.target.closest('button, a, input, label, select, summary, .lists-critics')) show();
                });
                item.addEventListener('keydown', event => {
                    if (event.target === item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); show(); }
                });
                item.addEventListener('mouseenter', () => hover(row, kind));
                item.addEventListener('mouseleave', () => unhover(row, kind));
                const mark = node('span', 'lists-item__icon'); mark.append(icon(appearance[0]));
                heading.append(mark, title);
                if (recordId) heading.append(win.RecordLabel.badge(doc, recordId, recordIds));
                item.append(heading);
                const badges = node('div', 'lists-item__badges');
                // No "Status unknown" here: a record without a lifecycle (every design of an imported
                // plan) would carry it on every row while saying nothing about the design.
                if (kind === 'designs' && row.local) badges.innerHTML = win.proposalLadderBadgesHtml(row.local, { unknownStatus: false });
                else badges.append(node('span', `cb-badge cb-badge--${row.published ? 'published' : 'draft'}`, t(row.published ? 'common.lifecycle.published' : 'common.lifecycle.draft')));
                if (kind === 'agreements' && (row.record.onchain || row.record.status)) {
                    const status = row.record.onchain?.status || row.record.status;
                    badges.append(node('span', 'cb-badge', win.AgreementPanel.chainStatusText(status)));
                }
                const timestamp = timestampOf(row);
                if (Number.isFinite(timestamp)) {
                    const date = new Date(timestamp);
                    const locale = win.i18n.getLocale?.();
                    const stamp = node('time', 'lists-item__timestamp', date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' }));
                    stamp.dateTime = date.toISOString();
                    stamp.title = date.toLocaleString(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
                    badges.append(stamp);
                }
                item.append(badges);
                if (kind === 'plans') item.append(node('p', 'sheet-note', t('agreement.list.designs', { count: row.record.content?.designCids.length ?? row.record.designCount })));
                if (row.propertyOffer) item.append(node('p', 'sheet-note', offerDirection((row.local?.content || row.record.content).direction)));
                else if (kind === 'agreements' && row.local) item.append(node('p', 'sheet-note', win.AgreementPanel.ruleShort(row.local.rule)));
                const actions = node('div', 'cb-actions lists-item__actions');
                const open = button(t('lists.open'), () => inspect(row, kind), 'btn-primary lists-item__open', 'arrow-pointer');
                open.setAttribute('aria-label', t('lists.openNamed', { title: recordLabel }));
                actions.append(open);
                const shareButton = button(t('panel.proposal.actions.share'), () => share(row, kind), '', 'share-nodes');
                shareButton.querySelector('i').classList.add('lists-share-icon');
                if (kind === 'agreements' && !row.published) shareButton.title = t('lists.proposeFirst');
                actions.append(shareButton);
                if (kind === 'designs') actions.append(button(t('common.download'), async () => win.PlanFileUI.design(await designRecord(row)), '', 'download'));
                if (kind === 'plans') actions.append(button(t('common.download'), async () => win.PlanFileUI.plan(await planOf(row)), '', 'download'));
                if (kind === 'agreements') actions.append(button(t('common.download'), async () => {
                    if (row.propertyOffer) return win.PropertyOfferSync.download(row.local || await win.PropertyOfferSync.importOffer(row.key));
                    const resolved = row.local ? { agreement: row.local, designs: [] } : await win.AgreementSync.resolveDetails(row.key);
                    return win.PlanFileUI.downloadAgreement(resolved.agreement, resolved.designs);
                }, '', 'download'));
                if (kind === 'plans') {
                    actions.append(analysis.stats(win, doc, () => planOf(row), row.record));
                    actions.append(button(t('planDialog.createAgreement'), async () => {
                        const plan = await win.PlanWorkspace.resolve(await planOf(row));
                        win.MapShell.closeSheets(); return win.AgreementDialog.open({ plan });
                    }, '', 'cb-icon-agreement'));
                    actions.append(button(t('planDialog.schedule'), async () => {
                        const plan = await planOf(row);
                        win.MapShell.closeSheets(); return win.PlanDialog.schedule(plan);
                    }, '', 'hourglass-half'));
                }
                // Only what this browser holds can be removed: a draft is deleted, the copy of a published
                // object is removed from this device (the server keeps it). A row only on the server has none.
                if (row.local) {
                    const label = t(removal(row, kind).label);
                    const trash = button('', () => remove(row, kind), 'btn-danger btn-icon lists-item__remove', 'trash-can');
                    trash.setAttribute('aria-label', label); trash.title = label; actions.append(trash);
                }
                item.append(actions);
                if (kind === 'plans') {
                    // A refresh can replace the card before the native details toggle event runs.
                    const open = cached?.item.querySelector('.lists-critics')?.open ?? state.openCritics.has(row.key);
                    const picker = analysis.critics(win, doc, () => planOf(row), { row: row.key, open });
                    picker.addEventListener('toggle', () => {
                        if (picker.isConnected) { if (picker.open) state.openCritics.add(row.key); else state.openCritics.delete(row.key); }
                    });
                    item.append(picker);
                }
                cards.set(row.key, { item, record: row.record, local: row.local, signature });
                desired.push(item);
            }
            if (!visible.length && !page?.loading && !errors) desired.push(node('p', 'sheet-note', t(rows.length ? 'lists.noMatch' : 'lists.empty')));
            if (visible.length > shownLimit || page?.feeds.some(feed => feed.next !== null) && !page.loading) {
                const more = button(t('lists.loadMore'), async () => {
                    shownLimit += pageSize;
                    if (page?.feeds.some(feed => feed.next !== null)) await load({ more: true });
                    else renderRows();
                });
                more.dataset.listsMore = ''; desired.push(more);
            }
            const keep = new Set(desired);
            for (const child of Array.from(list.children)) if (!keep.has(child)) child.remove();
            desired.forEach((el, position) => { if (list.children[position] !== el) list.insertBefore(el, list.children[position] || null); });
            for (const [key, card] of cards) if (!keep.has(card.item)) cards.delete(key);
            if (focused && doc.activeElement !== focused) {
                const card = cards.get(focusedCard?.dataset.listId)?.item;
                const next = card ? card.querySelectorAll(selector)[focusIndex] || card
                    : focused.dataset.listsMore !== undefined ? list.querySelector('[data-lists-more]') || desired.find(el => el.dataset.listId) : null;
                next?.focus({ preventScroll: true });
            }
        }
        function controls() {
            const box = doc.getElementById('lists-controls'); box.replaceChildren();
            // Stages of saving: Draft, Published and, for agreements, On chain.
            const stages = [['all', 'modal.roadWidth.proposalList.filters.publicationAll'], ['draft', 'common.lifecycle.draft'], ['published', 'common.lifecycle.published'],
                ...(state.tab === 'agreements' ? [['onchain', 'agreement.chain.heading']] : [])];
            if (!stages.some(([value]) => value === state.publication)) state.publication = 'all';
            const fields = node('div', 'lists-filters');
            const searchRow = node('div', 'lists-search-row');
            const search = node('input'); search.type = 'search'; search.value = state.search;
            search.placeholder = t('lists.search'); search.setAttribute('aria-label', t('lists.search'));
            search.addEventListener('input', () => { state.search = search.value; queryChanged(); });
            const filters = node('div', 'lists-filter-panel'); filters.id = 'lists-filter-panel'; filters.hidden = !state.filtersOpen;
            const toggle = node('button', 'btn btn-sm lists-filter-toggle', t('modal.roadWidth.proposalList.filters.toggle')); toggle.type = 'button';
            toggle.prepend(icon('sliders')); toggle.setAttribute('aria-controls', filters.id); toggle.setAttribute('aria-expanded', String(state.filtersOpen));
            toggle.addEventListener('click', () => {
                state.filtersOpen = !state.filtersOpen; filters.hidden = !state.filtersOpen; toggle.setAttribute('aria-expanded', String(state.filtersOpen));
            });
            searchRow.append(search, toggle); box.append(searchRow);
            // Designs: a pressed toggle keeps only the designs applied to this browser's map, with
            // their count; the button beside it takes all of them off the map.
            if (state.tab === 'designs') {
                const applied = localRows('designs').filter(row => appliedHere(row.local)).length;
                const onMap = node('button', 'btn btn-sm lists-on-map'); onMap.type = 'button';
                onMap.dataset.listsOnMap = ''; onMap.setAttribute('aria-pressed', String(state.onMap));
                labelOnMap(onMap, applied);
                onMap.addEventListener('click', () => {
                    state.onMap = !state.onMap; onMap.setAttribute('aria-pressed', String(state.onMap)); renderRows();
                });
                const unapplyAll = button('', unapplyApplied, 'lists-unapply-all');
                unapplyAll.dataset.listsUnapplyAll = '';
                labelUnapplyAll(unapplyAll, applied);
                const mapRow = node('div', 'lists-map-row');
                mapRow.append(onMap, unapplyAll); box.append(mapRow);
            }
            for (const [key, label, options] of [
                ['publication', 'modal.roadWidth.proposalList.filters.publication', stages],
                ['sort', 'modal.roadWidth.proposalList.filters.sort', [['newest', 'lists.newest'], ['title', 'lists.byTitle']]]
            ]) {
                const wrap = node('label', '', t(label)), select = node('select');
                for (const [value, text] of options) { const option = node('option', '', t(text)); option.value = value; select.append(option); }
                select.dataset.listFilter = key;
                select.value = state[key]; select.addEventListener('change', () => { state[key] = select.value; queryChanged(); });
                wrap.append(select); fields.append(wrap);
            }
            filters.append(fields);
            const actions = node('div', 'cb-actions');
            actions.append(button(t('modal.roadWidth.proposalList.filters.reset'), () => {
                state.search = ''; state.publication = 'all'; state.sort = 'newest'; state.onMap = false; controls(); queryChanged();
            }, 'btn-quiet'));
            filters.append(actions); box.append(filters);
            box.append(button(t('agreement.minted.refresh'), () => load({ force: true }), 'lists-refresh', 'arrows-rotate'));
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
                ++previewSequence;
                const pending = state.previewing; state.previewing = null;
                if (state.hovering && !pending) win.clearProposalPreview();
                state.hovering = null;
                if (pending && event.detail.byHand) inspect(pending.row, pending.kind).catch(error => win.showStyledAlert(error.message));
            });
            win.AgreementStore.subscribe(refresh);
            win.PropertyOfferStore?.subscribe(refresh);
            win.addEventListener('planschange', refresh);
            // What is on the map changes outside the sheet too (a notice's Undo, a card's Unapply):
            // the Applied badges, the On the map count and Unapply all follow every map commit.
            win.LiveParcelFabric?.subscribe?.(() => { if (ready && opened()) renderRows(); });
            win.addEventListener('i18n:translationsLoaded', () => { if (opened()) { controls(); refresh(); } });
            controls();
        }
        async function select(tab) {
            await win.i18n.translationsReady;
            init();
            if (tab !== state.tab) {
                localLists.clear();
                ++previewSequence; shownLimit = pageSize;
                if (state.previewing || state.hovering) win.clearProposalPreview();
                state.previewing = null; state.hovering = null;
            }
            state.tab = tab === 'browse' ? 'designs' : tab;
            if (!['designs', 'plans', 'agreements'].includes(state.tab)) state.tab = 'designs';
            if (state.selecting && state.selecting !== state.tab) stopSelecting();
            for (const el of doc.querySelectorAll('[data-list-tab]')) {
                const active = el.dataset.listTab === state.tab;
                el.setAttribute('aria-selected', String(active)); el.tabIndex = active ? 0 : -1;
                doc.getElementById(el.getAttribute('aria-controls')).hidden = !active;
            }
            controls(); renderActions(); renderRows();
            return load();
        }
        function refresh() { localLists.clear(); state.records.clear(); state.known.clear(); if (ready && opened()) { renderActions(); renderRows(); } }
        function drafts() {
            return ['designs', 'plans', 'agreements'].map(kind => ({ kind,
                rows: localRows(kind).filter(row => !row.published).map(row => ({ key: row.key, title: row.title, cid: row.cid })) }));
        }
        async function reviewDrafts(kind) {
            state.search = ''; state.publication = 'draft'; state.onMap = false; state.filtersOpen = true;
            await select(kind);
            if (!win.MapShell.isOpen('proposals-sheet')) win.MapShell.openSheet('proposals-sheet');
            doc.querySelector(`[data-list-tab="${state.tab}"]`)?.focus();
        }
        return { open: async () => { await win.i18n.translationsReady; init(); controls(); return select(state.tab); }, select, refresh, choosePlanDesigns, drafts, reviewDrafts };
    }
    return { stageOf, mergeRows, filterRows, indexQuery, browser };
});
