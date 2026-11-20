// Layers sheet → Parcels → State land: draws the city's free state plots and land applications on the
// 2D map, each coloured by its procedure stage (granted, refused or cancelled, in procedure). Shown
// only for a city whose configuration has a `stateLand` block. Data, projection and the status
// tables come from js/state-land.js.
(function (global) {
    'use strict';

    const model = global.StateLand;
    const PANE = 'stateLand';
    const ids = { group: 'state-land-layers', free: 'showStateFreePlots', applications: 'showLandApplications', note: 'state-land-status' };
    let cache = new Map(); // city id -> { free: Promise<features>, applications: Promise<features> }
    const layers = { free: null, applications: null };
    let generation = 0;

    const t = (key, params, fallback) => {
        const value = global.i18n?.t?.(key, params || {});
        return typeof value === 'string' && value !== key ? value : fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? ''));
    };
    const cityConfig = () => global.CityConfigManager?.getCurrentCityConfig?.() || null;
    const cityId = () => global.CityConfigManager?.getCurrentCityId?.() || '';
    const config = () => model.normalizeConfig(cityConfig()?.stateLand);
    const element = id => global.document.getElementById(id);

    function announce(text) {
        const note = element(ids.note);
        if (!note) return;
        note.textContent = text;
        note.hidden = !text;
    }

    async function readView(cfg, view, signalBox) {
        const relayBase = global.getBackendBase?.();
        if (!relayBase) throw new Error('No backend is configured for the cadastre relay.');
        const features = [];
        let startIndex = 0;
        for (let page = 0; page < model.MAX_PAGES && startIndex !== null; page += 1) {
            const response = await fetch(model.relayUrl(relayBase, cfg, model.viewUrl(cfg, view, { startIndex })), { credentials: 'omit' });
            if (!response.ok) throw new Error(`The cadastre relay answered HTTP ${response.status}.`);
            if (signalBox.generation !== generation) throw Object.assign(new Error('superseded'), { superseded: true });
            const result = model.readPage(await response.json(), startIndex);
            features.push(...result.features);
            startIndex = result.next;
        }
        if (startIndex !== null) throw new Error('The state land view exceeded its page limit.');
        return features;
    }

    function load(kind) {
        const cfg = config();
        if (!cfg) return Promise.resolve([]);
        const key = cityId();
        const entry = cache.get(key) || {};
        cache.set(key, entry);
        if (entry[kind]) return entry[kind];
        const signalBox = { generation };
        const project = global.proj4(model.projectionDefinition(cfg.zone), 'EPSG:4326').forward;
        entry[kind] = readView(cfg, kind, signalBox)
            .then(rows => rows.map(row => model.toDisplayFeature(row, kind, project)).filter(Boolean));
        entry[kind].catch(() => { if (cache.get(key) === entry) delete entry[kind]; });
        return entry[kind];
    }

    const STAGE_FALLBACK = {
        pending: 'In procedure', granted: 'Granted', registered: 'Registered', stopped: 'Refused or cancelled', unknown: 'Status unknown'
    };

    function tooltipText(properties) {
        const lines = [];
        if (properties.kind === 'application') {
            lines.push(t('sidebar.parcels.stateLand.applicationTitle', { id: properties.id }, 'Land application {{id}}'));
        } else {
            lines.push(t('sidebar.parcels.stateLand.freeTitle', { id: properties.id }, 'Free state plot {{id}}'));
        }
        lines.push(t(`sidebar.parcels.stateLand.stage.${properties.stage}`, {}, STAGE_FALLBACK[properties.stage]));
        // The cadastre's own wording of the status, untranslated: it is source data, not our copy.
        if (properties.statusLabel) {
            lines.push(t('sidebar.parcels.stateLand.cadastreStatus', { label: properties.statusLabel, date: properties.statusOn || '?' },
                'Cadastre status: {{label}} ({{date}})'));
        } else if (properties.statusCode !== null) {
            lines.push(t('sidebar.parcels.stateLand.unknownStatus', { code: properties.statusCode, date: properties.statusOn || '?' },
                'Cadastre status code {{code}}, not in its legend ({{date}})'));
        }
        if (properties.use) lines.push(t('sidebar.parcels.stateLand.use', { use: properties.use }, 'Use: {{use}}'));
        if (properties.listedOn) lines.push(t('sidebar.parcels.stateLand.listedOn', { date: properties.listedOn }, 'Entered on {{date}}'));
        return lines;
    }

    function ensurePane(map) {
        if (map.getPane(PANE)) return;
        // Above the parcel canvas so the shapes answer hover; while a layer is on, a parcel under
        // one of its shapes is selected by switching the layer off.
        map.createPane(PANE).classList.add('state-land-pane');
    }

    function draw(kind, features) {
        const map = global.map;
        if (!map || !global.L) return;
        ensurePane(map);
        remove(kind);
        layers[kind] = global.L.geoJSON({ type: 'FeatureCollection', features }, {
            pane: PANE,
            style: feature => ({ className: `state-land-shape state-land-shape--${feature.properties.kind} state-land-shape--${feature.properties.stage}` }),
            onEachFeature: (feature, layer) => {
                const tooltip = global.document.createElement('div');
                for (const line of tooltipText(feature.properties)) {
                    const row = global.document.createElement('div');
                    row.textContent = line;
                    tooltip.appendChild(row);
                }
                layer.bindTooltip(tooltip, { sticky: true, className: 'state-land-tooltip' });
            }
        }).addTo(map);
    }

    function remove(kind) {
        if (layers[kind]) { layers[kind].remove(); layers[kind] = null; }
    }

    function summaryText() {
        const shown = Object.values(layers).filter(Boolean).flatMap(layer => layer.toGeoJSON().features);
        if (!shown.length && !Object.values(layers).some(Boolean)) return '';
        const counts = model.summarize(shown);
        const parts = [];
        const params = kind => {
            const c = counts[kind] || { total: 0, granted: 0, registered: 0, stopped: 0 };
            return { count: c.total, granted: c.granted + c.registered, stopped: c.stopped };
        };
        if (layers.free) parts.push(t('sidebar.parcels.stateLand.freeCount', params('free'),
            'Free state plots: {{count}} ({{granted}} granted, {{stopped}} refused or cancelled)'));
        if (layers.applications) parts.push(t('sidebar.parcels.stateLand.applicationCount', params('application'),
            'Land applications: {{count}} ({{granted}} granted, {{stopped}} refused or cancelled)'));
        return parts.join(' · ');
    }

    async function toggle(kind, checked) {
        const checkbox = element(kind === 'free' ? ids.free : ids.applications);
        if (!checked) { remove(kind); announce(summaryText()); return; }
        const requested = generation;
        if (checkbox) checkbox.setAttribute('aria-busy', 'true');
        announce(t('sidebar.parcels.stateLand.loading', {}, 'Loading state land from the cadastre…'));
        try {
            const features = await load(kind);
            if (requested !== generation || !checkbox?.checked) return;
            draw(kind, features);
            announce(summaryText());
        } catch (error) {
            if (error?.superseded) return;
            console.error(`[state-land] ${new Date().toISOString()} ${kind} failed`, error);
            if (checkbox) checkbox.checked = false;
            announce(t('sidebar.parcels.stateLand.failed', {}, 'The cadastre did not answer. Try again later.'));
        } finally {
            if (checkbox) checkbox.removeAttribute('aria-busy');
        }
    }

    function syncAvailability() {
        const group = element(ids.group);
        if (group) group.hidden = !config();
    }

    function init() {
        for (const [kind, id] of [['free', ids.free], ['applications', ids.applications]]) {
            element(id)?.addEventListener('change', event => toggle(kind, event.target.checked));
        }
        syncAvailability();
    }

    global.addEventListener('cityChanged', () => {
        generation += 1;
        cache = new Map();
        remove('free'); remove('applications');
        for (const id of [ids.free, ids.applications]) { const box = element(id); if (box) box.checked = false; }
        announce('');
        syncAvailability();
    });
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', init);
    else init();
})(window);
