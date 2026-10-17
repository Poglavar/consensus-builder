// proposals/plan-view.js — a named plan opened on the map (plans.md): its proposals drawn hatched,
// not applied, the map framed on them, and a docked panel with the plan's description, totals and
// proposals, and Apply plan / Share / Bet / Close. Apply plan runs the ordered apply a plan link used
// to run on open (handleSharedPlanRoute in sharing-routes.js). Opened from a plan line on a proposal
// row, a Plans list (proposals/plans.js) and a /proposals/<plan> link. window.PlanView.
(function (win) {
    'use strict';

    const doc = win.document;
    const PANE = 'planPreviewPane';
    const HATCH_ID = 'plan-preview-hatch';

    const state = {
        token: 0,
        slug: null,
        plan: null,
        error: null,
        loading: false,
        records: new Map(),      // member row id -> proposal record (held here, or as published)
        applied: new Set(),      // member row ids standing on this map
        layers: new Map(),       // member row id -> Leaflet layer
        group: null,
        renderer: null,
        panel: null,
        keyWired: false
    };

    function plainT(key, fallback, params = {}) {
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function t(key, fallback, params = {}) {
        const api = win.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t(key, params);
            if (value && value !== key) return value;
        }
        return plainT(key, fallback, params);
    }

    function escapeText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const log = (message, ...rest) => console.log(`[${new Date().toISOString()}] [PlanView] ${message}`, ...rest);
    const isOpen = () => !!(state.panel && state.panel.classList.contains('visible'));
    const planPath = slug => `/proposals/${slug}`;

    // ---- data ----

    async function fetchPlan(slug) {
        const response = await fetch(`${win.resolveBackendBaseUrl()}/plans/${encodeURIComponent(slug)}`);
        if (response.status === 404) throw new Error(t('plans.view.notFound', 'There is no plan named {{name}}.', { name: slug }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    // Each member as a proposal record: the copy this browser holds (it knows whether it stands on
    // the map), else the published record, normalised as an import would but not stored.
    async function loadRecords(ids) {
        const standing = record => typeof win.isProposalCurrentlyApplied === 'function' && win.isProposalCurrentlyApplied(record);
        // Several local records can answer to one published row (a draft and the copy a plan link
        // imported): the one standing on the map is the member's state here.
        const held = new Map();
        (win.proposalStorage.getAllProposals() || []).forEach(record => {
            const id = win.ProposalPlans.serverIdOfRecord(record);
            if (id && (!held.has(id) || (!standing(held.get(id)) && standing(record)))) held.set(id, record);
        });
        const missing = ids.filter(id => !held.has(id));
        const batch = missing.length
            ? await win.fetchSharedProposalBatch(missing, win.resolveBackendBaseUrl())
            : { records: new Map() };
        const records = new Map();
        const applied = new Set();
        ids.forEach(id => {
            const local = held.get(id);
            if (local) {
                records.set(id, local);
                if (standing(local)) applied.add(id);
                return;
            }
            const payload = batch.records.get(id);
            if (payload) records.set(id, win.proposalStorage._normalizeProposal({ ...payload }));
        });
        return { records, applied };
    }

    // What each member draws: its own geometry (road, buildings, structure, plots, site), else the
    // cadastral parcels it declares, fetched when they are not loaded yet.
    async function memberFeatures(records) {
        const features = new Map();
        const parcelOnly = [];
        records.forEach((record, id) => {
            const own = win.collectProposalFeatureSets(record).primaryFeatures;
            if (own.length) features.set(id, own);
            else parcelOnly.push(id);
        });
        const parcelIds = Array.from(new Set(parcelOnly.flatMap(id => (records.get(id).cadastreParcelIds || []).map(String))));
        if (parcelIds.length) {
            const repository = win.CadastralParcelRepository;
            await repository.ensureIds(parcelIds);
            parcelOnly.forEach(id => {
                const list = repository.getMany((records.get(id).cadastreParcelIds || []).map(String));
                if (list.length) features.set(id, list);
            });
        }
        return features;
    }

    // ---- map ----

    function ensureRenderer() {
        const map = win.map;
        if (!map.getPane(PANE)) map.createPane(PANE).classList.add('plan-preview-pane');
        if (!state.renderer) state.renderer = win.L.svg({ pane: PANE });
        return state.renderer;
    }

    function ensureHatch() {
        const svg = state.renderer && state.renderer._container;
        if (!svg || svg.querySelector(`#${HATCH_ID}`)) return;
        const ns = 'http://www.w3.org/2000/svg';
        const defs = doc.createElementNS(ns, 'defs');
        const pattern = doc.createElementNS(ns, 'pattern');
        pattern.setAttribute('id', HATCH_ID);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('width', '8');
        pattern.setAttribute('height', '8');
        pattern.setAttribute('patternTransform', 'rotate(45)');
        const line = doc.createElementNS(ns, 'line');
        line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
        line.setAttribute('x2', '0'); line.setAttribute('y2', '8');
        line.setAttribute('class', 'plan-preview-hatch-line');
        pattern.appendChild(line);
        defs.appendChild(pattern);
        svg.insertBefore(defs, svg.firstChild);
    }

    function clearLayers() {
        if (state.group) win.map.removeLayer(state.group);
        state.group = null;
        state.layers.clear();
    }

    function draw(features) {
        clearLayers();
        const renderer = ensureRenderer();
        state.group = win.L.featureGroup().addTo(win.map);
        features.forEach((list, id) => {
            const layer = win.L.geoJSON({ type: 'FeatureCollection', features: list }, {
                pane: PANE,
                renderer,
                // Passed to each path at creation (setStyle does not change a class): CSS draws the hatch.
                className: `plan-preview-member${state.applied.has(id) ? ' is-applied' : ''}`,
                // Point features (a station marker) draw as small circles rather than default pins.
                pointToLayer: (_feature, latlng) => win.L.circleMarker(latlng, { radius: 6, pane: PANE, renderer })
            });
            layer.on('click', () => focusMemberRow(id));
            layer.on('mouseover', () => setHovered(id, true));
            layer.on('mouseout', () => setHovered(id, false));
            layer.addTo(state.group);
            state.layers.set(id, layer);
        });
        ensureHatch();
    }

    function fitTo(bounds) {
        if (!bounds || !bounds.isValid()) return;
        const padding = typeof win.getProposalPanelFitPadding === 'function'
            ? win.getProposalPanelFitPadding(40)
            : { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] };
        // Frame the plan clear of its own panel: docked on the right on desktop, a bottom sheet on phones.
        const rect = state.panel && isOpen() ? state.panel.getBoundingClientRect() : null;
        if (rect && rect.width && rect.height) {
            const [right, bottom] = padding.paddingBottomRight;
            padding.paddingBottomRight = rect.left > win.innerWidth / 3
                ? [Math.max(right, win.innerWidth - rect.left + 24), bottom]
                : [right, Math.max(bottom, win.innerHeight - rect.top + 16)];
        }
        // animate:false — an animated fit needs frames, which a background tab does not get.
        win.map.fitBounds(bounds, { ...padding, maxZoom: 18, animate: false });
    }

    function setHovered(id, on) {
        const layer = state.layers.get(id);
        if (layer) layer.eachLayer(path => { const el = path.getElement && path.getElement(); if (el) el.classList.toggle('is-hovered', on); });
        const row = state.panel && state.panel.querySelector(`[data-plan-member="${CSS.escape(id)}"]`);
        if (row) row.classList.toggle('is-hovered', on);
    }

    function focusMemberRow(id) {
        const row = state.panel && state.panel.querySelector(`[data-plan-member="${CSS.escape(id)}"]`);
        if (!row) return;
        row.scrollIntoView({ block: 'nearest' });
        row.focus({ preventScroll: true });
    }

    // ---- panel ----

    function ensurePanel() {
        if (state.panel) return state.panel;
        const panel = doc.createElement('section');
        panel.id = 'plan-view-panel';
        panel.className = 'info-panel right-dock-panel plan-view-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'plan-view-title');
        panel.innerHTML = `
            <div class="panel-header">
                <h3 id="plan-view-title"></h3>
                <button type="button" class="close-circle-btn close-circle-btn--lg close-button" data-plan-action="close">×</button>
            </div>
            <div class="panel-body" data-plan-region="body"></div>`;
        panel.addEventListener('click', onPanelClick);
        panel.addEventListener('mouseover', event => {
            const row = event.target.closest('[data-plan-member]');
            if (row) setHovered(row.getAttribute('data-plan-member'), true);
        });
        panel.addEventListener('mouseout', event => {
            const row = event.target.closest('[data-plan-member]');
            if (row && !row.contains(event.relatedTarget)) setHovered(row.getAttribute('data-plan-member'), false);
        });
        (doc.getElementById('map-container') || doc.body).appendChild(panel);
        state.panel = panel;
        return panel;
    }

    function formatDate(value) {
        return value && win.CbFormat && typeof win.CbFormat.formatDate === 'function' ? win.CbFormat.formatDate(value) || '' : '';
    }

    function kindsLine(members) {
        const counts = new Map();
        members.forEach(member => {
            if (member.missing) return;
            const key = member.goal || member.type || 'other';
            counts.set(key, (counts.get(key) || 0) + 1);
        });
        const label = key => (typeof win.formatProposalTypeLabel === 'function' ? win.formatProposalTypeLabel(key) : key);
        return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
            .map(([key, count]) => `${count} × ${label(key)}`).join(' · ');
    }

    function totalsHtml(plan) {
        const members = Array.isArray(plan.members) ? plan.members : [];
        const total = members.length || (plan.proposalIds || []).length;
        const parcels = new Set();
        state.records.forEach(record => (record.cadastreParcelIds || []).forEach(id => parcels.add(String(id))));
        const changed = members.filter(member => member.changed).length;
        const missing = members.filter(member => member.missing).length;
        const rows = [
            [t('panel.parcel.tabProposals', 'Proposals'), state.applied.size
                ? t('plans.view.totals.proposalsApplied', '{{count}}, {{applied}} on this map', { count: total, applied: state.applied.size })
                : String(total)],
            [t('sidebar.parcels.title', 'Parcels'), state.records.size ? String(parcels.size) : '…'],
            [t('plans.view.totals.kinds', 'What it builds'), kindsLine(members)]
        ].filter(([, value]) => value);
        const warnings = [
            changed ? t('plans.view.changed', '{{count}} proposals changed after the plan was named.', { count: changed }) : '',
            missing ? t('plans.view.missing', '{{count}} proposals are no longer on the server.', { count: missing }) : ''
        ].filter(Boolean);
        return `<dl class="plan-view-totals">${rows.map(([label, value]) => `<div><dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd></div>`).join('')}</dl>`
            + warnings.map(text => `<p class="plan-view-note plan-view-note--warning">${escapeText(text)}</p>`).join('');
    }

    function membersHtml(plan) {
        const members = Array.isArray(plan.members) ? plan.members : (plan.proposalIds || []).map(id => ({ id: String(id) }));
        const items = members.map((member, index) => {
            const id = String(member.id);
            const record = state.records.get(id);
            const title = member.title || (record && (record.title || record.name)) || t('modal.roadWidth.proposalList.untitled', 'Untitled proposal');
            const type = member.goal || member.type;
            const typeLabel = type && typeof win.formatProposalTypeLabel === 'function' ? win.formatProposalTypeLabel(type) : '';
            const badges = [
                state.applied.has(id) ? `<span class="cb-badge cb-badge--applied">${escapeText(t('plans.view.onMap', 'On the map'))}</span>` : '',
                member.changed ? `<span class="cb-badge cb-badge--warning">${escapeText(t('proposalDrafts.review.changed', 'Changed'))}</span>` : '',
                member.missing ? `<span class="cb-badge cb-badge--danger">${escapeText(t('plans.view.member.missing', 'Missing'))}</span>` : ''
            ].join('');
            return `<li>
                <button type="button" class="plan-view-member" data-plan-member="${escapeText(id)}"${state.layers.has(id) ? '' : ' disabled'}>
                    <span class="plan-view-member__index">${index + 1}</span>
                    <span class="plan-view-member__text"><span class="plan-view-member__title">${escapeText(title)}</span>${typeLabel ? `<span class="plan-view-member__type">${escapeText(typeLabel)}</span>` : ''}</span>
                    ${badges}
                </button>
            </li>`;
        }).join('');
        return `<h4 class="plan-view-heading">${escapeText(t('plans.view.membersHeading', 'Proposals in this plan'))}</h4><ol class="plan-view-members">${items}</ol>`;
    }

    function actionsHtml(plan) {
        const total = (plan.proposalIds || []).length;
        const allApplied = total > 0 && state.applied.size >= total;
        const applyLabel = allApplied ? t('plans.view.onMap', 'On the map') : t('plans.view.actions.apply', 'Apply plan');
        const ready = !state.loading && state.records.size > 0 && !allApplied;
        const bet = plan.proposalAccount
            ? `<button type="button" class="btn" data-plan-action="bet"><i class="fas fa-coins" aria-hidden="true"></i> ${escapeText(t('panel.proposal.actions.betOutcome', 'Bet on outcome'))}</button>`
            : '';
        return `<div class="plan-view-actions">
            <button type="button" class="btn btn-primary" data-plan-action="apply"${ready ? '' : ' disabled'}><i class="fas fa-check" aria-hidden="true"></i> ${escapeText(applyLabel)}</button>
            <button type="button" class="btn" data-plan-action="share"><i class="fas fa-link" aria-hidden="true"></i> ${escapeText(t('bets.copyLink', 'Copy link'))}</button>
            ${bet}
        </div>`;
    }

    function renderPanel() {
        const panel = ensurePanel();
        const plan = state.plan || { slug: state.slug };
        panel.querySelector('#plan-view-title').textContent = win.ProposalPlans.planLabel(plan) || t('plans.view.title', 'Plan');
        const close = panel.querySelector('[data-plan-action="close"]');
        const closeLabel = t('modal.common.close', 'Close');
        close.setAttribute('aria-label', closeLabel);
        close.title = closeLabel;
        const meta = [plan.author, plan.place, formatDate(plan.createdAt)].filter(Boolean).map(escapeText).join(' · ');
        const status = state.error
            ? `<p class="plan-view-note plan-view-note--danger plan-view-status">${escapeText(t('plans.view.error', 'The plan could not be loaded: {{reason}}', { reason: state.error }))}</p>`
            : (state.loading ? `<p class="plan-view-status">${escapeText(t('plans.view.loading', 'Loading the plan…'))}</p>` : '');
        const newer = Array.isArray(plan.supersededBy) && plan.supersededBy.length
            ? `<p class="plan-view-note plan-view-note--info">${escapeText(t('plans.view.newer', 'A newer version of this plan exists:'))} ${plan.supersededBy.map(slug => `<button type="button" class="cb-link" data-plan-open="${escapeText(slug)}">${escapeText(slug)}</button>`).join(', ')}</p>`
            : '';
        panel.querySelector('[data-plan-region="body"]').innerHTML = `
            <p class="plan-view-hint">${escapeText(t('plans.view.hint', 'Hatched on the map: what this plan would build. Nothing changes until you apply it.'))}</p>
            ${newer}
            ${status}
            ${state.plan ? actionsHtml(plan) : ''}
            ${state.plan ? totalsHtml(plan) : ''}
            ${meta ? `<p class="plan-view-meta">${meta}</p>` : ''}
            ${plan.description ? `<p class="plan-view-description">${escapeText(plan.description)}</p>` : ''}
            ${state.plan ? membersHtml(plan) : ''}`;
        panel.classList.add('visible');
        doc.body.classList.add('plan-view-open');
    }

    // ---- actions ----

    async function applyPlan(button) {
        const ids = (state.plan.proposalIds || []).map(String);
        log(`applying ${state.slug} (${ids.length} proposals)`);
        // The apply frames and opens what it applied; the preview and its panel step aside first.
        await win.BusyControl.track(button, async () => {
            const slug = state.slug;
            hide();
            win.__currentNamedPlan = { ...state.plan, slug };
            await win.handleSharedPlanRoute(ids);
        });
    }

    async function copyLink() {
        const url = `${win.location.origin}${planPath(state.slug)}`;
        try {
            await win.navigator.clipboard.writeText(url);
            win.updateStatus(t('plans.view.linkCopied', 'Plan link copied.'));
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [PlanView] copying the link failed`, error);
            win.updateStatus(t('plans.view.linkInAddressBar', 'Copy the plan link from the address bar.'));
        }
    }

    function zoomToMember(id) {
        const layer = state.layers.get(id);
        if (layer) fitTo(layer.getBounds());
    }

    function onPanelClick(event) {
        const action = event.target.closest('[data-plan-action]');
        const member = event.target.closest('[data-plan-member]');
        const other = event.target.closest('[data-plan-open]');
        if (other) { open(other.getAttribute('data-plan-open')); return; }
        if (member) { zoomToMember(member.getAttribute('data-plan-member')); return; }
        if (!action) return;
        switch (action.getAttribute('data-plan-action')) {
            case 'close': close(); break;
            case 'apply': applyPlan(action); break;
            case 'share': win.BusyControl.track(action, copyLink); break;
            case 'bet': win.openBetDialog({ proposalAccount: state.plan.proposalAccount }); break;
            default: break;
        }
    }

    function onKeyDown(event) {
        if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
        if (typeof win.isEditableTarget === 'function' && win.isEditableTarget(event.target)) return;
        if (typeof win.isAnyModalOpen === 'function' && win.isAnyModalOpen()) return;
        event.preventDefault();
        close();
    }

    // The address bar names the open plan, so it can be copied or reloaded; closing puts it back.
    function setAddress(slug) {
        const url = new URL(win.location.href);
        const target = slug ? planPath(slug) : '/';
        if (url.pathname === target) return;
        if (!slug && !/^\/proposals\/[a-z0-9-]+$/i.test(url.pathname)) return;
        url.pathname = target;
        win.history.replaceState(win.history.state, '', url.toString());
    }

    // ---- public ----

    // Opens the plan named slug. plan: the GET /plans/<slug> answer when the caller already has it.
    async function open(slug, { plan = null } = {}) {
        if (!slug) throw new Error('PlanView.open: a plan name is required');
        if (!state.keyWired) { doc.addEventListener('keydown', onKeyDown); state.keyWired = true; }
        const token = ++state.token;
        state.slug = String(slug);
        state.plan = plan;
        state.error = null;
        state.loading = true;
        state.records = new Map();
        state.applied = new Set();
        clearLayers();
        // The plan takes the right dock: the proposals sheet, a parcel's panel and a proposal's make way.
        if (win.MapShell && typeof win.MapShell.closeSheets === 'function') win.MapShell.closeSheets();
        if (win.ParcelMenu) win.ParcelMenu.close();
        if (doc.getElementById('parcel-info-panel')?.classList.contains('visible')) win.hideParcelInfoPanel();
        if (doc.getElementById('proposal-details-panel')?.classList.contains('visible')) win.hideProposalDetailsPanel(true);
        renderPanel();
        setAddress(state.slug);
        try {
            const resolved = plan && Array.isArray(plan.members) ? plan : await fetchPlan(state.slug);
            if (token !== state.token) return;
            state.plan = resolved;
            renderPanel();
            const ids = (resolved.proposalIds || []).map(String);
            const { records, applied } = await loadRecords(ids);
            if (token !== state.token) return;
            state.records = records;
            state.applied = applied;
            const features = await memberFeatures(records);
            if (token !== state.token) return;
            draw(features);
            state.loading = false;
            renderPanel();
            fitTo(state.group.getBounds());
            log(`opened ${state.slug}: ${ids.length} proposals, ${features.size} drawn, ${applied.size} already on the map`);
        } catch (error) {
            if (token !== state.token) return;
            console.error(`[${new Date().toISOString()}] [PlanView] ${state.slug} could not be opened`, error);
            state.error = error && error.message ? error.message : String(error);
            state.loading = false;
            renderPanel();
        }
    }

    // Removes the preview and the panel without touching the address bar (Apply plan keeps it).
    function hide() {
        state.token += 1;
        clearLayers();
        if (state.panel) state.panel.classList.remove('visible');
        doc.body.classList.remove('plan-view-open');
    }

    function close() {
        hide();
        setAddress(null);
        state.slug = null;
        state.plan = null;
    }

    win.PlanView = { open, close, isOpen, current: () => state.slug };
})(window);
