// "Road in parcel": a road fitted into ground already left for one (docs/road-in-parcel.md). The
// parcel card's Transport tile opens it on the selected parcels (a layout's street strips too); it reads
// the streets the site holds (proposals/road-in-site.js), lets the author choose the lanes for
// each street width, previews them and places the roads through the corridor import, each bounded
// by its part of the site: its land is that ground and nothing beyond it.
(function (win) {
    'use strict';
    if (!win?.document) return;

    const doc = win.document;
    // `cores`: the lanes chosen per street width (road-in-site.js groupKey), `coreKeys` the preset
    // each came from, for the panel's selects.
    const state = { session: null, site: null, parcelIds: [], cores: {}, coreKeys: {}, turn: false, plan: null, layers: null, placing: false };

    function t(key, fallback, params = {}) {
        const text = win.i18n?.t?.(`roadInParcel.${key}`, params);
        if (text && text !== `roadInParcel.${key}`) return text;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? ''));
    }
    // A string another part of the app already words (a lane's name, the tile's own label).
    function tShared(key, fallback) {
        const text = win.i18n?.t?.(key);
        return text && text !== key ? text : fallback;
    }
    const log = (level, message, detail) => console[level](`[${new Date().toISOString()}] [road-in-parcel] ${message}`, detail ?? '');
    const number = (value, digits = 1) => win.CbFormat?.formatNumber?.(value, { maxFractionDigits: digits })
        ?? new Intl.NumberFormat(doc.documentElement.lang || 'en', { maximumFractionDigits: digits }).format(value);
    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    // ---- the site -------------------------------------------------------------------------------

    function parcelFeature(id) {
        return win.LiveParcelFabric?.get?.(String(id)) || win.CadastralParcelRepository?.get?.(String(id)) || null;
    }

    // Ground a road or track already holds cannot be given to another one (the same test the
    // parcel layout applies, parcel-layout.js).
    function isTaken(feature) {
        const props = feature?.properties || {};
        const takers = Array.isArray(props.formedByProposalIds) ? props.formedByProposalIds : [];
        return props.isCorridor === true || props.isTrack === true || takers.length > 0;
    }

    function unionOf(geometries) {
        const turf = win.turf;
        let merged = turf.feature(geometries[0]);
        geometries.slice(1).forEach(geometry => {
            const next = turf.union(merged, turf.feature(geometry));
            if (next) merged = next;
        });
        return merged.geometry;
    }

    // ---- the plan and its preview ---------------------------------------------------------------

    function replan() {
        state.plan = win.__roadInSite.roadsInSite(state.site, {
            cores: state.cores,
            turn: state.turn,
            skipUnreadable: true,
            drivingSide: win.CityConfigManager?.getDrivingSide?.() === 'left' ? 'left' : 'right'
        });
        log('debug', 'planned', { roads: state.plan.roads.length, groups: state.plan.groups, issues: state.plan.issues });
    }

    function clearPreview() {
        Object.values(state.layers || {}).forEach(layer => layer.remove());
        state.layers = null;
    }

    function drawPreview() {
        clearPreview();
        const map = state.session?.map;
        if (!map || !win.L) return;
        const outline = win.L.geoJSON(state.site, {
            interactive: false,
            // Stroke and dashes come from the stylesheet (road-in-parcel.css).
            style: { className: 'road-in-parcel__site', fill: false }
        }).addTo(map);
        const strips = win.L.layerGroup().addTo(map);
        state.plan.roads.forEach(road => {
            try {
                const definition = win.__roadInSite.boundedDefinition(road);
                const frame = win.__corridorFootprint.frameForDefinition(definition);
                win.corridorSegmentEntries(definition).forEach(entry => {
                    const layer = win.renderCorridorStrips(win.buildCorridorStrips(entry.points, entry.profile, frame), { pane: win.CORRIDOR_STRIPS_PANE });
                    if (layer) strips.addLayer(layer);
                });
            } catch (error) {
                log('warn', 'preview failed', error);
            }
        });
        state.layers = { outline, strips };
    }

    // ---- the panel ------------------------------------------------------------------------------

    function issueText(issue) {
        if (issue.code === 'not-a-grid') return t('issue.notGrid', 'This ground does not read as straight streets. Draw the road by hand with the Road tool.');
        if (issue.code === 'disconnected') return t('issue.disconnected', 'Parts of this ground do not connect as one street network. Select the parts separately.');
        if (issue.code === 'too-narrow') return t('issue.tooNarrow', 'A street here is {{width}} m wide, too narrow for a lane.', { width: number(issue.widthM) });
        if (issue.code === 'core-too-wide') return t('issue.tooWide', 'The lanes chosen for the {{width}} m streets need {{required}} m with their pavements.', { width: number(issue.widthM), required: number(issue.requiredM) });
        return '';
    }

    function presetLabel(core) {
        const lanes = core.filter(strip => strip.type === 'driving' || strip.type === 'bus').length;
        const width = win.__corridorSiteFit.widthOf(core);
        const extras = [];
        if (core.some(strip => strip.type.startsWith('parking'))) extras.push(tShared('modal.corridor.laneTypes.parking', 'Parallel parking'));
        if (core.some(strip => strip.type === 'cycleway')) extras.push(tShared('modal.corridor.laneTypes.cycleway', 'Cycle path'));
        if (core.some(strip => strip.type === 'median')) extras.push(tShared('modal.corridor.laneTypes.median', 'Median'));
        return t('preset.label', 'Lanes: {{lanes}}, {{width}} m', { lanes, width: number(width) }) + (extras.length ? ` · ${extras.join(', ')}` : '');
    }

    function renderGroups() {
        const list = state.session.root.querySelector('.road-in-parcel__groups');
        list.replaceChildren();
        state.plan.groups.forEach(group => {
            const row = el('label', 'road-in-parcel__group');
            row.append(el('span', 'road-in-parcel__group-label', t('group.label', '{{count}} × {{width}} m', { count: group.count, width: number(group.widthM) })));
            const select = el('select', 'cb-input road-in-parcel__lanes');
            select.dataset.group = group.key;
            const auto = el('option', '', t('preset.automatic', 'Automatic'));
            auto.value = '';
            select.append(auto);
            win.__corridorSiteFit.corePresetsFor(group.widthM).forEach(entry => {
                const option = el('option', '', presetLabel(entry.core));
                option.value = entry.key;
                select.append(option);
            });
            select.value = state.coreKeys[group.key] || '';
            select.addEventListener('change', () => {
                const key = select.value;
                if (!key) { delete state.cores[group.key]; delete state.coreKeys[group.key]; }
                else {
                    const entry = win.__corridorSiteFit.corePresetsFor(group.widthM).find(item => item.key === key);
                    state.cores[group.key] = entry ? entry.core : null;
                    state.coreKeys[group.key] = key;
                }
                refresh();
            });
            row.append(select);
            list.append(row);
        });
    }

    function refresh() {
        replan();
        const root = state.session.root;
        renderGroups();
        const blocking = win.__roadInSite.blocking(state.plan.issues);
        const square = state.plan.issues.some(issue => issue.code === 'square');
        root.querySelector('[data-action="turn"]').hidden = !square;
        // Parts that do not read as streets: with nothing else to place that is the refusal; beside
        // readable parts they are named here, before Place, and stay as they are.
        const skipped = state.plan.issues.filter(issue => issue.code === 'skipped');
        const notes = blocking.map(issueText);
        if (skipped.length && !state.plan.roads.length) notes.push(issueText({ code: skipped[0].reason }));
        else if (skipped.length) notes.push(t('issue.skipped', 'Pieces that do not read as straight streets stay as they are: {{count}}.', { count: skipped.length }));
        root.querySelector('.road-in-parcel__status').textContent = notes.filter(Boolean).join(' ');
        const summary = state.plan.roads.length
            ? t('summary', 'Streets: {{streets}} · parcels: {{parcels}}', {
                streets: state.plan.groups.reduce((sum, group) => sum + group.count, 0),
                parcels: state.parcelIds.length || 1
            })
            : '';
        root.querySelector('.road-in-parcel__summary').textContent = summary;
        root.querySelector('[data-action="place"]').disabled = !!blocking.length || !state.plan.roads.length;
        drawPreview();
    }

    function buildPanel() {
        const content = el('div', 'road-in-parcel__content');
        const hint = el('p', 'road-in-parcel__hint', t('hint', 'The lanes run along the middle of each street and fit its narrowest part; pavements and verges fill the rest. Nothing outside this ground is taken.'));
        const summary = el('p', 'road-in-parcel__summary');
        const groups = el('div', 'road-in-parcel__groups');
        const turn = el('button', 'btn', t('turn', 'Turn 90°'));
        turn.type = 'button';
        turn.dataset.action = 'turn';
        turn.hidden = true;
        const status = el('p', 'road-in-parcel__status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        content.append(hint, summary, groups, turn, status);
        const footer = el('div', 'road-in-parcel__footer');
        const place = el('button', 'btn btn-primary', t('place', 'Place road'));
        place.type = 'button';
        place.dataset.action = 'place';
        footer.append(place);
        return { content, footer };
    }

    function close() {
        const session = state.session;
        if (!session) return;
        state.session = null;
        clearPreview();
        session.close();
    }

    function open(site, options = {}) {
        if (state.session || !win.map) return false;
        if (!win.__roadInSite || !win.__corridorImport) {
            log('error', 'the road-in-site modules are not loaded');
            return false;
        }
        const { content, footer } = buildPanel();
        const session = win.OnMapEditor?.open({
            owner: 'road-in-parcel', id: 'road-in-parcel', modes: ['2d'],
            title: tShared('panel.parcel.build.roadInParcel', 'Road in parcel'), content, footer, onCancel: close
        });
        // Another map tool holds the map; it says so itself.
        if (!session) return false;
        session.root.classList.add('road-in-parcel');
        Object.assign(state, { session, site, parcelIds: options.parcelIds || [], cores: {}, coreKeys: {}, turn: false, placing: false });
        session.root.querySelector('[data-action="turn"]').addEventListener('click', () => { state.turn = !state.turn; refresh(); });
        session.root.querySelector('[data-action="place"]').addEventListener('click', event => win.BusyControl.track(event.currentTarget, place));
        refresh();
        session.fitFeature({ type: 'Feature', properties: {}, geometry: site });
        return true;
    }

    // ---- placing --------------------------------------------------------------------------------

    /**
     * Place the roads `site` holds, bounded by it. `options`: `cores` and `turn` (as chosen in the
     * panel), `title`. Resolves to { created, failed, issues }; nothing is placed when the site has
     * a blocking issue.
     */
    async function placeRoadsInSite(site, options = {}) {
        const plan = win.__roadInSite.roadsInSite(site, {
            cores: options.cores || {},
            turn: options.turn === true,
            skipUnreadable: true,
            drivingSide: win.CityConfigManager?.getDrivingSide?.() === 'left' ? 'left' : 'right'
        });
        const blocking = win.__roadInSite.blocking(plan.issues);
        if (blocking.length || !plan.roads.length) return { created: [], failed: [], issues: blocking.length ? blocking : [{ code: 'not-a-grid' }] };
        const title = options.title || t('roadName', 'Streets');
        const elements = [];
        const roads = plan.roads.map((road, index) => {
            elements.push(...road.form.elements);
            return { id: `bounded-${index + 1}`, name: plan.roads.length > 1 ? `${title} (${index + 1})` : title, wayIds: road.wayIds };
        });
        const records = win.__corridorImport.recordsFromImport({ form: { elements }, roads }, {
            author: win.getProposalAuthorValue?.() || 'road-in-parcel',
            source: 'road-in-parcel',
            fallbackTitle: title,
            description: options.description || t('description', 'Streets fitted into the ground left for them.')
        });
        records.forEach((record, index) => {
            const definition = record.roadProposal.definition;
            definition.bound = { site: JSON.parse(JSON.stringify(plan.roads[index].site)) };
            definition.metadata = { ...definition.metadata, mode: 'bounded' };
        });
        const result = await win.__corridorImport.createRoadRecords(records);
        if (result.failed.length) log('warn', `${result.failed.length} of ${records.length} roads failed`, result.failed);
        return { ...result, issues: [] };
    }

    async function place() {
        if (state.placing || !state.session) return;
        state.placing = true;
        try {
            const { created, failed, issues } = await placeRoadsInSite(state.site, { cores: state.cores, turn: state.turn });
            if (!created.length) {
                const reason = issues.length ? issues.map(issueText).join(' ') : failed.filter(Boolean).join(' ');
                if (state.session) state.session.root.querySelector('.road-in-parcel__status').textContent = t('failed', 'Could not place the road: {{reason}}', { reason: reason || '?' });
                return;
            }
            close();
            win.updateStatus?.(t('done', 'Roads placed in the parcel: {{count}}.', { count: created.length }));
        } finally {
            state.placing = false;
        }
    }

    // The Transport tile: the selected parcels are the site, unless one is already a road's.
    function openForParcels(ids) {
        const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
        const features = list.map(parcelFeature).filter(feature => feature?.geometry);
        if (!features.length) {
            win.updateStatus?.(t('noParcel', 'Select the parcel left for the road first.'));
            return false;
        }
        if (features.some(isTaken)) {
            win.updateStatus?.(t('taken', 'A road or track already holds this ground. Unapply it first, or select other parcels.'));
            return false;
        }
        let site;
        try {
            site = unionOf(features.map(feature => feature.geometry));
        } catch (error) {
            log('error', 'the selected parcels could not be joined', error);
            win.updateStatus?.(t('joinFailed', 'The selected parcels could not be joined into one site.'));
            return false;
        }
        return open(site, { parcelIds: list });
    }

    win.RoadInParcel = { open, openForParcels, placeRoadsInSite, close, isTaken };
})(typeof window !== 'undefined' ? window : null);
