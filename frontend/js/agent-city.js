// agent-city.js — the Agent city: the designs agents' agreements executed, drawn on the map as they
// stood at a date, with a time control to move through the executions. Two sources: the published
// agents (the index's executed agreements in this city, each with its design) and this simulation
// (simulation-agreements.js). Display only: design-display.js draws the standing designs; nothing
// is applied or imported. A later execution on a parcel replaces the design standing there.
// The card is #agent-city in index.html (styled as the build-out time control, css/buildout-clock.css).
// The pure timeline is tested in backend/test/frontend-agent-city.test.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentCity = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const SOURCES = Object.freeze(['server', 'simulation']);
    const PLAY_STEP_MS = 1200;
    const PAGE = 200;
    const MAX_PAGES = 10;

    const dayOf = iso => String(iso || '').slice(0, 10);

    // Pure: the executions in date order and the distinct days they fall on (the slider's steps).
    function timeline(items) {
        const sorted = (items || [])
            .filter(item => item && item.key && Number.isFinite(Date.parse(item.executedAt)))
            .sort((a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt) || String(a.key).localeCompare(String(b.key)));
        const days = [...new Set(sorted.map(item => dayOf(item.executedAt)))];
        return { items: sorted, days };
    }

    // Pure: what stands at the end of `day`: every execution up to it, a later one replacing an
    // earlier one that shares a parcel. `fresh` are the keys executed on `day` itself.
    function standingAt(sortedItems, day) {
        const standing = [];
        sortedItems.forEach(item => {
            if (dayOf(item.executedAt) > day) return;
            const parcels = new Set((item.parcelIds || []).map(String));
            for (let index = standing.length - 1; index >= 0; index--) {
                if ((standing[index].parcelIds || []).some(id => parcels.has(String(id)))) standing.splice(index, 1);
            }
            standing.push(item);
        });
        return { standing, fresh: new Set(standing.filter(item => dayOf(item.executedAt) === day).map(item => item.key)) };
    }

    // Pure: an executed agreement row of the index as an item, given its design row (or null).
    function serverItem(agreement, designRow) {
        const executedAt = agreement?.onchain?.executedAt || null;
        if (agreement?.status !== 'executed' || !executedAt || !designRow?.content) return null;
        return {
            key: agreement.cid,
            executedAt,
            parcelIds: agreement.inputParcelIds || [],
            design: designRow.content,
            label: agreement.title || designRow.content.title || '',
            author: agreement.author || designRow.content.author || '',
            open: { type: 'agreement', id: agreement.cid }
        };
    }

    // Pure: a simulation agreement executed on a design of this browser as an item.
    function simulationItem(agreement, design) {
        if (agreement?.status !== 'executed' || !agreement.closedAt || !design) return null;
        return {
            key: agreement.proposalId,
            executedAt: agreement.closedAt,
            parcelIds: agreement.parcelIds || [],
            design,
            label: design.title || '',
            author: design.author || '',
            open: { type: 'design', id: agreement.proposalId }
        };
    }

    // ---- The card ----
    const state = { open: false, source: 'server', items: [], days: [], step: 0, playing: null, loading: false, error: null, request: 0 };

    const t = (key, fallback, params) => {
        const value = root?.i18n?.t?.(key, params);
        if (value && value !== key) return value;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (params && name in params ? params[name] : match));
    };
    const el = id => root?.document?.getElementById(id);
    const log = (...args) => console.log(`[${new Date().toISOString()}] [agent-city]`, ...args);

    async function fetchJson(url) {
        const response = await root.fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return response.json();
    }

    async function serverItems() {
        const base = root.getBackendBase();
        const city = root.CityConfigManager?.getCurrentCityId?.() || '';
        const agreements = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const body = await fetchJson(`${base}/agreements?city=${encodeURIComponent(city)}&limit=${PAGE}&offset=${page * PAGE}`);
            const rows = Array.isArray(body) ? body : (body.agreements || body.items || []);
            agreements.push(...rows);
            if (rows.length < PAGE) break;
        }
        const executed = agreements.filter(row => row?.status === 'executed' && row.designCids?.length);
        const { rows } = executed.length
            ? await root.DesignSync.fetchDesigns(executed.map(row => row.designCids[0]))
            : { rows: new Map() };
        const items = executed.map(row => serverItem(row, rows.get(row.designCids[0]) || null)).filter(Boolean);
        log(`${city}: ${agreements.length} agreements, ${executed.length} executed, ${items.length} with their design`);
        return items;
    }

    function simulationItems() {
        const storage = root.proposalStorage;
        return (root.SimulationAgreements?.executed() || [])
            .map(agreement => simulationItem(agreement, storage?.getProposal?.(agreement.proposalId) || null))
            .filter(Boolean);
    }

    function currentDay() {
        return state.days[state.step] || null;
    }

    function publish() {
        const day = currentDay();
        if (!state.open) { root.DesignDisplay?.setLayer('agentCity', null); return; }
        if (!day) { root.DesignDisplay?.setLayer('agentCity', []); return; }
        const { standing, fresh } = standingAt(state.items, day);
        root.DesignDisplay?.setLayer('agentCity', standing.map(item => ({
            key: item.key, design: item.design, opacity: 1, fresh: fresh.has(item.key), open: item.open
        })));
    }

    function formatDay(day) {
        if (!day) return '';
        try { return root.CbFormat.formatDate(new Date(`${day}T00:00:00Z`), { timeZone: 'UTC' }); } catch (_) { return day; }
    }

    function render() {
        const card = el('agent-city');
        if (!card) return;
        card.hidden = !state.open;
        root.document.body.classList.toggle('agent-city-open', state.open);
        if (!state.open) return;
        root.document.querySelectorAll('[data-agent-city-source]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.agentCitySource === state.source));
        });
        const slider = el('agent-city-slider');
        const last = Math.max(0, state.days.length - 1);
        slider.max = String(last);
        slider.value = String(state.step);
        slider.disabled = state.days.length < 2;
        ['agent-city-back', 'agent-city-forward', 'agent-city-play'].forEach(id => { el(id).disabled = state.days.length < 2; });
        el('agent-city-back').disabled ||= state.step <= 0;
        el('agent-city-forward').disabled ||= state.step >= last;
        const play = el('agent-city-play');
        const playing = !!state.playing;
        const playLabel = playing ? t('sidebar.game.pause', 'Pause') : t('sidebar.game.play', 'Play');
        play.setAttribute('aria-pressed', String(playing));
        play.setAttribute('aria-label', playLabel);
        play.setAttribute('title', playLabel);
        play.querySelector('i').className = `fas ${playing ? 'fa-pause' : 'fa-play'}`;
        el('agent-city-date').textContent = formatDay(currentDay());
        let summary;
        if (state.loading) summary = t('agentCity.loading', 'Loading executed agreements…');
        else if (state.error) summary = t('agentCity.error', 'The executed agreements could not be loaded.');
        else if (!state.items.length) {
            summary = state.source === 'simulation'
                ? t('agentCity.emptySimulation', 'No design of this simulation has been executed yet. Owners decide over the turns.')
                : t('agentCity.emptyServer', 'No agent agreement has been executed in this city yet.');
        } else {
            const { standing } = standingAt(state.items, currentDay());
            const executed = state.items.filter(item => dayOf(item.executedAt) <= currentDay()).length;
            summary = t('agentCity.summary', 'Designs standing: {{standing}} · executed {{executed}} of {{total}}', {
                standing: standing.length, executed, total: state.items.length
            });
        }
        el('agent-city-summary').textContent = summary;
    }

    function setStep(step) {
        state.step = Math.max(0, Math.min(Math.max(0, state.days.length - 1), step));
        publish();
        render();
    }

    function stopPlaying() {
        if (state.playing) root.clearInterval(state.playing);
        state.playing = null;
    }

    function togglePlay() {
        if (state.playing) { stopPlaying(); render(); return; }
        if (state.step >= state.days.length - 1) setStep(0);
        state.playing = root.setInterval(() => {
            if (state.step >= state.days.length - 1) { stopPlaying(); render(); return; }
            setStep(state.step + 1);
        }, PLAY_STEP_MS);
        render();
    }

    // Brings the executions into view once, when a source has loaded.
    function frame(items) {
        const L = root.L;
        const points = [];
        items.forEach(item => (root.DesignDisplay?.displayParts(item.design) || []).forEach(part => {
            points.push(...root.turf.coordAll(part.feature));
        }));
        if (!points.length || !L) return;
        const bounds = L.latLngBounds(points.map(([lng, lat]) => [lat, lng]));
        if (root.isThreeModeActive?.() && root.getThree3DGeoView && root.applyThree3DGeoView) {
            const centre = bounds.getCenter();
            root.applyThree3DGeoView({ ...root.getThree3DGeoView(), targetLat: centre.lat, targetLng: centre.lng });
        } else if (root.map && !root.map.getBounds().contains(bounds)) {
            root.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
        }
    }

    function adopt(items, { follow = false, reframe = false } = {}) {
        const wasLast = state.step >= state.days.length - 1;
        const { items: sorted, days } = timeline(items);
        state.items = sorted;
        state.days = days;
        state.step = follow && !wasLast ? Math.min(state.step, days.length - 1) : Math.max(0, days.length - 1);
        publish();
        render();
        if (reframe) frame(sorted);
    }

    async function load() {
        const request = ++state.request;
        stopPlaying();
        state.error = null;
        if (state.source === 'simulation') { adopt(simulationItems(), { reframe: true }); return; }
        state.loading = true;
        adopt([]);
        try {
            const items = await serverItems();
            if (request !== state.request || !state.open) return;
            state.loading = false;
            adopt(items, { reframe: true });
        } catch (error) {
            if (request !== state.request) return;
            console.error(`[${new Date().toISOString()}] [agent-city] the executed agreements could not be loaded`, error);
            state.loading = false;
            state.error = error;
            render();
        }
    }

    function open(source = 'server') {
        state.source = SOURCES.includes(source) ? source : 'server';
        state.open = true;
        root.MapShell?.closeSheets?.();
        render();
        load();
        el('agent-city-close')?.focus?.();
    }

    function close() {
        stopPlaying();
        state.request++;
        state.open = false;
        state.items = [];
        state.days = [];
        publish();
        render();
    }

    function bind() {
        const card = el('agent-city');
        if (!card || card.dataset.bound === 'true') return;
        card.dataset.bound = 'true';
        el('agent-city-close').addEventListener('click', close);
        el('agent-city-back').addEventListener('click', () => { stopPlaying(); setStep(state.step - 1); });
        el('agent-city-forward').addEventListener('click', () => { stopPlaying(); setStep(state.step + 1); });
        el('agent-city-play').addEventListener('click', togglePlay);
        el('agent-city-slider').addEventListener('input', event => { stopPlaying(); setStep(Number(event.target.value)); });
        root.document.querySelectorAll('[data-agent-city-source]').forEach(button => button.addEventListener('click', () => {
            if (button.dataset.agentCitySource === state.source) return;
            state.source = button.dataset.agentCitySource;
            load();
        }));
        root.document.querySelectorAll('[data-agent-city-open]').forEach(button => button.addEventListener('click', () => open(button.dataset.agentCityOpen)));
        // This simulation keeps executing while the card is open: the newest day follows along.
        root.addEventListener('simulationagreementschange', () => {
            if (state.open && state.source === 'simulation') adopt(simulationItems(), { follow: true });
        });
        root.i18n?.onChange?.(() => render());
        card.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        // ?agentcity=server|simulation opens it once the map and city are up (map-core.js appBooted).
        const requested = new URLSearchParams(root.location.search).get('agentcity');
        if (requested !== null) {
            root.addEventListener('appBooted', () => open(requested === 'simulation' ? 'simulation' : 'server'), { once: true });
        }
    }

    if (root?.document) {
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bind);
        else bind();
    }

    return { SOURCES, timeline, standingAt, serverItem, simulationItem, open, close, isOpen: () => state.open };
});
