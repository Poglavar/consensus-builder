// The map's build-out time control: one month moved back and forth over the shown plan's
// construction schedule. It only displays; nothing is applied, unapplied or replayed
// (docs/buildout-timeline.md). The 2D map draws planned designs faded and designs under construction
// hatched with a crane; the model view reads the same states (window 'buildoutchange').
(function (win) {
    'use strict';
    const doc = win.document;
    const S = () => win.BuildoutSchedule;
    const PLAY_STEP_MS = 450;
    // plan: { cid, content } of the plan in view; a simulated build-out adds simulated: true, its seed,
    // the plan it simulates (source; base when that plan has its own dates) and per-building windows of urban rules (buildings[cid][index]).
    const state = { plan: null, month: null, timer: null, cids: new WeakMap(), overlay: null };
    const t = (key, params) => win.i18n?.t?.(`buildout.${key}`, params || {}) ?? key;
    const log = (...args) => win.console.log(`[${new Date().toISOString()}] [buildout]`, ...args);
    const el = id => doc.getElementById(id);

    const scheduled = plan => !!S().range(plan?.content);
    // A named plan comes into view. Without a schedule the time control goes away.
    function show(plan, { month = null } = {}) {
        const next = plan && scheduled(plan) ? { cid: plan.cid, content: plan.content } : null;
        const changed = next?.cid !== state.plan?.cid || !!state.plan?.simulated;
        state.plan = next;
        log(next ? `plan in view: ${next.content.title} (${next.cid})` : 'no scheduled plan in view');
        syncButton();
        if (next && month) open(month);
        else if (changed && state.month) setMonth(clamp(state.month));
    }
    // A plan opened by a link: ?buildout=<seed> simulates it, ?when= opens the time control at a month.
    async function arrive(plan) {
        const params = new URLSearchParams(win.location.search);
        const seed = params.get('buildout');
        // A plan that dates every member has nothing to simulate: its own dates show.
        if (seed && await simulate(plan, { seed, month: requestedMonth() })) return;
        show(plan, { month: requestedMonth() });
    }
    // A seeded build-out of the plan's undated members (js/buildout-simulation.js), shown, never saved.
    async function simulate(plan, { seed = null, month: at = null } = {}) {
        const row = await win.PlanWorkspace.resolve(plan);
        const chosen = seed || Math.random().toString(36).slice(2, 8);
        const area = geometry => win.turf.area(win.turf.feature(geometry));
        // Nothing to simulate when the plan dates every member.
        if (!win.BuildoutSimulation.sitesOf(row.content, row.designs, { area }).length) return false;
        const { schedule, buildings } = win.BuildoutSimulation.scenario(row.content, row.designs, { seed: chosen, start: S().currentMonth(), area });
        pause();
        state.plan = { cid: row.cid, content: { ...row.content, schedule }, simulated: true, seed: chosen, buildings,
            source: { cid: row.cid, content: row.content }, base: row.content.schedule ? { cid: row.cid, content: row.content } : null };
        log(`simulated build-out of ${row.content.title} (${row.cid}), seed ${chosen}`);
        syncButton();
        el('buildout-clock').hidden = false;
        el('buildout-clock-button').setAttribute('aria-expanded', 'true');
        state.month = null;
        setMonth(at || S().range(schedule).start);
        return true;
    }
    function plan() { return state.plan; }
    function month() { return state.month; }
    function isOpen() { return state.month !== null; }

    function clamp(value) {
        const span = S().range(state.plan?.content);
        if (!span) return null;
        const at = S().monthIndex(value);
        if (at === null) return span.start;
        return S().monthOf(Math.min(Math.max(at, S().monthIndex(span.start)), S().monthIndex(span.end)));
    }

    // Members on this browser's map, by design CID. The same design can stand under any local id.
    function cidOf(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;
        if (!state.cids.has(proposal)) {
            let cid = null;
            try { cid = win.DesignRecord.cidOf(proposal); } catch (_) { /* an incomplete draft is no plan member */ }
            state.cids.set(proposal, cid);
        }
        return state.cids.get(proposal);
    }
    function stateOfCid(cid) {
        if (!state.plan || state.month === null) return S().BUILT;
        const window = state.plan.content.schedule?.[cid];
        return window ? S().stateAt(window, state.month) : S().BUILT;
    }
    function stateOf(proposalOrId) {
        const proposal = typeof proposalOrId === 'object' ? proposalOrId : win.proposalStorage?.getProposal(proposalOrId);
        if (!state.plan || state.month === null || !proposal) return S().BUILT;
        return stateOfCid(cidOf(proposal));
    }
    // One building of a design: an urban rule's building in a simulation has its own window; any
    // other building follows its design.
    function stateOfBuilding(proposalOrId, index) {
        const proposal = typeof proposalOrId === 'object' ? proposalOrId : win.proposalStorage?.getProposal(proposalOrId);
        if (!state.plan || state.month === null || !proposal) return S().BUILT;
        const window = state.plan.buildings?.[cidOf(proposal)]?.[index];
        return window ? S().stateAt(window, state.month) : stateOf(proposal);
    }
    // Every scheduled member on the map that is not built at the month in view, by proposal id.
    function unbuilt() {
        const result = new Map();
        if (!state.plan || state.month === null) return result;
        const schedule = state.plan.content.schedule || {};
        for (const proposal of win.proposalStorage?.getAllProposals() || []) {
            const cid = cidOf(proposal);
            if (!cid || !schedule[cid]) continue;
            const at = S().stateAt(schedule[cid], state.month);
            const perBuilding = state.plan.buildings?.[cid];
            const buildings = perBuilding ? (proposal.geometry?.buildings || []).map((_, index) => perBuilding[index] ? S().stateAt(perBuilding[index], state.month) : at) : null;
            if (at.phase !== 'built') result.set(String(proposal.proposalId), { ...at, cid, proposal, buildings });
        }
        return result;
    }

    function setMonth(value) {
        const next = value === null ? null : clamp(value);
        if (next === state.month) return;
        state.month = next;
        writeAddress();
        syncPanel();
        render2d();
        win.dispatchEvent(new win.CustomEvent('buildoutchange', { detail: { month: state.month, planCid: state.plan?.cid || null, simulated: !!state.plan?.simulated } }));
    }
    function open(at = null) {
        if (!state.plan) return false;
        el('buildout-clock').hidden = false;
        el('buildout-clock-button').setAttribute('aria-expanded', 'true');
        setMonth(at || state.month || S().range(state.plan.content).start);
        return true;
    }
    function close() {
        pause();
        el('buildout-clock').hidden = true;
        el('buildout-clock-button')?.setAttribute('aria-expanded', 'false');
        // Back to now also ends a simulation: the plan's own dates, if any, stay in view.
        if (state.plan?.simulated) { state.plan = state.plan.base; syncButton(); }
        setMonth(null);
    }
    function step(count) {
        if (state.month === null) return;
        setMonth(S().addMonths(state.month, count));
    }
    function play() {
        if (!state.plan) return;
        const span = S().range(state.plan.content);
        if (state.month === null || state.month >= span.end) open(span.start);
        pause();
        state.timer = win.setInterval(() => {
            if (state.month >= S().range(state.plan?.content)?.end) return pause();
            step(1);
        }, PLAY_STEP_MS);
        syncPanel();
    }
    function pause() {
        if (state.timer) win.clearInterval(state.timer);
        state.timer = null;
        syncPanel();
    }

    // ?when=YYYY-MM keeps the moment; outside a /plans/<cid> address ?timeline=<cid> names the plan,
    // and ?buildout=<seed> a simulated build-out of it.
    function writeAddress() {
        const url = new URL(win.location.href);
        const planPath = /^\/plans\//.test(url.pathname);
        if (state.month && state.plan) {
            url.searchParams.set('when', state.month);
            if (!planPath) url.searchParams.set('timeline', state.plan.cid);
            if (state.plan.simulated) url.searchParams.set('buildout', state.plan.seed);
            else url.searchParams.delete('buildout');
        } else {
            url.searchParams.delete('when');
            url.searchParams.delete('timeline');
            url.searchParams.delete('buildout');
        }
        if (url.href !== win.location.href) win.history.replaceState(win.history.state, '', url);
    }
    function requestedMonth() {
        const value = new URLSearchParams(win.location.search).get('when');
        return S().monthIndex(value) === null ? null : value;
    }
    // ?timeline=<cid> on an ordinary map address: the named plan from this browser or the server.
    async function arriveFromAddress() {
        const params = new URLSearchParams(win.location.search);
        const cid = params.get('timeline');
        if (!cid || /^\/plans\//.test(win.location.pathname)) return;
        try {
            await win.BrowserWorkspace?.ready;
            const local = win.NamedPlans.list().find(row => row.cid === cid);
            await arrive(local || await win.NamedPlans.fetchPlan(cid));
        } catch (error) {
            win.console.warn(`[${new Date().toISOString()}] [buildout] the plan ${cid} named by the address could not be opened`, error);
        }
    }

    // ---- 2D: planned designs faded, designs under construction hatched with a crane ----
    function overlay() {
        if (state.overlay || !win.map || !win.L) return state.overlay;
        if (!win.map.getPane('buildoutPane')) win.map.createPane('buildoutPane').classList.add('buildout-pane');
        state.overlay = win.L.layerGroup([], { pane: 'buildoutPane' }).addTo(win.map);
        return state.overlay;
    }
    function render2d() {
        const group = overlay();
        if (!group) return;
        group.clearLayers();
        const draw = (shape, at) => {
            if (at.phase === 'built' || !shape?.geometry) return;
            const className = at.phase === 'planned' ? 'buildout-shape buildout-shape--planned' : 'buildout-shape buildout-shape--construction';
            win.L.geoJSON(shape, { pane: 'buildoutPane', interactive: false, style: () => ({ className }) }).addTo(group);
            if (at.phase !== 'construction') return;
            const [lng, lat] = win.turf.pointOnFeature(shape).geometry.coordinates;
            win.L.marker([lat, lng], { pane: 'buildoutPane', interactive: false, keyboard: false,
                icon: win.L.divIcon({ className: 'buildout-crane-marker', html: '<span class="buildout-crane"></span>', iconSize: [26, 26], iconAnchor: [13, 24] }),
                title: t('underConstruction', { percent: Math.round(at.progress * 100) }) }).addTo(group);
        };
        for (const [, item] of unbuilt()) {
            if (typeof win.isApplied === 'function' && !win.isApplied(item.proposal)) continue;
            // An urban rule in a simulation builds parcel by parcel: each building has its own state.
            if (item.buildings) item.proposal.geometry.buildings.forEach((building, index) => draw(win.turf.feature(building.geometry), item.buildings[index]));
            else draw(win.__planOrder?.footprintOf?.(item.proposal), item);
        }
    }

    // ---- controls ----
    const monthLabel = value => {
        const at = S().monthIndex(value);
        if (at === null) return '';
        const date = new Date(Date.UTC(Math.floor(at / 12), at % 12, 1));
        return date.toLocaleDateString(win.i18n?.getLanguage?.() || undefined, { year: 'numeric', month: 'long', timeZone: 'UTC' });
    };
    function syncButton() {
        const button = el('buildout-clock-button');
        if (!button) return;
        button.hidden = !state.plan;
        if (!state.plan && state.month !== null) close();
        syncPanel();
    }
    function syncPanel() {
        const panel = el('buildout-clock');
        if (!panel) return;
        const span = S().range(state.plan?.content);
        const slider = el('buildout-clock-slider');
        if (span) {
            slider.min = '0';
            slider.max = String(S().monthsBetween(span.start, span.end));
            slider.value = String(state.month ? S().monthsBetween(span.start, state.month) : 0);
            slider.setAttribute('aria-valuetext', monthLabel(state.month));
        }
        el('buildout-clock-month').textContent = monthLabel(state.month);
        el('buildout-clock-title').textContent = state.plan ? (state.plan.simulated ? t('simulation') : state.plan.content.title) : '';
        panel.classList.toggle('buildout-clock--simulated', !!state.plan?.simulated);
        const counts = { planned: 0, construction: 0 };
        for (const [, item] of unbuilt()) counts[item.phase] += 1;
        // Members without dates stand as built at every month; the count says so.
        const undated = (state.plan?.content.designCids || []).filter(cid => !state.plan.content.schedule?.[cid]).length;
        el('buildout-clock-summary').textContent = !state.month ? ''
            : undated ? t('summaryUndated', { ...counts, undated }) : t('summary', counts);
        const playing = !!state.timer;
        const playButton = el('buildout-clock-play');
        playButton.setAttribute('aria-pressed', String(playing));
        playButton.title = playButton.ariaLabel = t(playing ? 'pause' : 'play');
        playButton.querySelector('i').className = `fas ${playing ? 'fa-pause' : 'fa-play'}`;
    }
    function bind() {
        const button = el('buildout-clock-button');
        if (!button) return;
        button.addEventListener('click', () => (isOpen() ? close() : open()));
        el('buildout-clock-close').addEventListener('click', close);
        el('buildout-clock-back').addEventListener('click', () => { pause(); step(-1); });
        el('buildout-clock-forward').addEventListener('click', () => { pause(); step(1); });
        el('buildout-clock-play').addEventListener('click', () => (state.timer ? pause() : play()));
        el('buildout-clock-reroll').addEventListener('click', () => {
            if (state.plan?.simulated) simulate(state.plan.source).catch(error => win.showStyledAlert(error.message));
        });
        el('buildout-clock-slider').addEventListener('input', event => {
            // Read the new position first: pausing redraws the panel, slider included.
            const offset = Number(event.target.value), span = S().range(state.plan?.content);
            pause();
            if (span) setMonth(S().addMonths(span.start, offset));
        });
        // Designs placed, removed or edited change what the overlay draws.
        win.addEventListener('proposalStorageChanged', () => { if (isOpen()) { render2d(); syncPanel(); } });
        win.addEventListener('proposedBuildingsUpdated', () => { if (isOpen()) render2d(); });
        syncButton();
        arriveFromAddress();
    }

    win.BuildoutClock = Object.freeze({ show, arrive, simulate, plan, month, isOpen, open, close, setMonth, step, play, pause,
        stateOf, stateOfCid, stateOfBuilding, unbuilt, requestedMonth });
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind, { once: true });
    else bind();
})(window);
