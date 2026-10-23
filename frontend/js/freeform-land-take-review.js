// Editor-only land review. Reads source stock; never applies demolition or changes agreements.
(function (env) {
    'use strict';
    function mount({ session, getBuildings, initialTake = null, onChange, onHistory, onReview }) {
        const api = env.FreeformLandTake;
        const panel = session.content.querySelector('#single-land-take');
        const rows = panel.querySelector('[data-land-rows]');
        const status = panel.querySelector('[data-land-status]');
        const accept = panel.querySelector('[data-land-accept]');
        const layers = env.L.featureGroup().addTo(session.map);
        let whole = new Set(), parcels = [], current = null, savedTake = initialTake;
        let sequence = 0, timer = null, closed = false, signature = null, reviewed = null;
        let geometryKey = null, stock = [], outcomes = null, pending = false, baseline = null;
        const text = (key, params = {}) => env.i18n.t(`landTake.${key}`, params);
        function style(kind) {
            const css = getComputedStyle(panel);
            const color = css.getPropertyValue(`--land-${kind}`).trim();
            return { color, fillColor: color, weight: 2, fillOpacity: kind === 'take' ? 0.12 : 0.25,
                dashArray: kind === 'remainder' ? '4 4' : null };
        }
        function paint(focus = null) {
            layers.clearLayers();
            if (!current) return;
            const draw = (geometry, kind) => {
                if (geometry) env.L.geoJSON(geometry, { pane: session.pane, interactive: false, style: style(kind) }).addTo(layers);
            };
            draw(current.take, 'take');
            current.rows.forEach(row => draw(row.remainder, 'remainder'));
            outcomes?.parked?.forEach(building => draw(building, 'removed'));
            outcomes?.removed.forEach(building => draw(building, 'removed'));
            outcomes?.partial.forEach(item => { draw(item.demolishedPart, 'removed'); draw(item.remainder, 'retained'); });
            outcomes?.retained.forEach(building => draw(building, 'retained'));
            if (focus) draw(focus, 'focus');
        }
        function invalidate() {
            accept.checked = false;
            reviewed = null;
        }
        function render() {
            rows.replaceChildren();
            if (!current) return;
            const multi = getBuildings().length > 1;
            for (const row of current.rows) {
                const label = document.createElement('label');
                label.className = 'land-take-row';
                const name = document.createElement('span');
                name.textContent = `${row.feature.properties?.BROJ_CESTICE || row.id} · ${Math.round(row.overlapM2 / row.parcelM2 * 100)}%`;
                const select = document.createElement('select');
                select.setAttribute('aria-label', text('parcelChoice', { id: row.id }));
                select.dataset.parcelId = row.id;
                for (const mode of ['footprint', 'whole']) {
                    const option = document.createElement('option');
                    option.value = mode;
                    option.textContent = text(mode);
                    option.disabled = mode === 'whole' && multi;
                    select.append(option);
                }
                select.value = row.mode;
                select.addEventListener('focus', () => paint(row.feature));
                select.addEventListener('blur', () => paint());
                select.addEventListener('change', () => {
                    onHistory();
                    savedTake = null;
                    if (select.value === 'whole') whole.add(row.key); else whole.delete(row.key);
                    invalidate();
                    refresh();
                });
                label.append(name, select);
                rows.append(label);
            }
            panel.querySelector('[data-land-whole]').disabled = multi || pending;
            panel.querySelector('[data-land-multi]').hidden = !multi;
        }
        async function refresh() {
            const ticket = ++sequence;
            pending = true;
            accept.disabled = true;
            status.textContent = text('loading');
            try {
                const buildings = getBuildings();
                const nextKey = JSON.stringify(buildings.map(item => item.geometry));
                if (geometryKey !== null && nextKey !== geometryKey) { savedTake = null; invalidate(); }
                geometryKey = nextKey;
                const footprint = api.union(buildings, env.turf);
                await env.CadastralParcelRepository.ensureFootprint(footprint);
                if (closed || ticket !== sequence) return false;
                parcels = env.LiveParcelFabric.queryBounds(env.turf.bbox(footprint), { includeCorridors: false });
                current = api.plan({ buildings, parcels, whole, savedTake, turf: env.turf });
                savedTake = null;
                whole = new Set(current.rows.filter(row => row.mode === 'whole').map(row => row.key));
                // One building/one parcel: disconnected imported buildings save independently.
                if (buildings.length > 1 && whole.size) {
                    whole.clear();
                    current = api.plan({ buildings, parcels, whole, turf: env.turf });
                }
                if (baseline === null) baseline = JSON.stringify(current.take.geometry);
                onChange(current.take, current.rows.some(row => row.mode === 'whole'));
                const nextSignature = JSON.stringify(current.take.geometry);
                if (signature !== nextSignature) { invalidate(); signature = nextSignature; }
                outcomes = null;
                render();
                paint();
                stock = await env.__demolitionPrefetch.loadBuildingStock(current.take.geometry,
                    (...args) => env.BuildingSourceClient.request(...args));
                if (closed || ticket !== sequence) return false;
                const ownId = env.getActiveProposalDesignDraft?.()?.sourceLocalProposalId;
                const pool = env.collectLoadedCorridorBuildings({ extraPool: stock, includeLoadedSurveyPool: false });
                const hits = env.findBuildingTunnelIntersections(current.take, pool, env.turf)
                    .filter(hit => !ownId || String(env.corridorTunnelHitProposalId(hit)) !== String(ownId));
                const real = hits.filter(hit => !env.corridorTunnelHitProposalId(hit)).map(hit => ({
                    ...hit.feature, geometry: hit.originalGeometry || hit.feature.__corridorOriginalGeometry || hit.feature.geometry
                }));
                outcomes = api.demolitionPreview(current.take, real, env.splitDemolitionFootprint, env.turf);
                const parked = hits.filter(hit => env.corridorTunnelHitProposalId(hit)).map(hit => hit.feature);
                outcomes.parked = parked;
                const review = JSON.stringify([signature,
                    outcomes.removed.map(item => [item.properties?.source, item.properties?.id, item.geometry]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
                    outcomes.partial.map(item => [item.building.properties?.source, item.building.properties?.id, item.demolishedPart, item.remainder]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
                    parked.map(item => item.properties?.proposalId).sort()]);
                if (reviewed !== null && reviewed !== review) invalidate();
                panel.dataset.review = review;
                status.textContent = text('summary', { area: Math.round(current.areaM2), parcels: current.rows.length,
                    removed: outcomes.removed.length, partial: outcomes.partial.length, parked: parked.length });
                pending = false;
                accept.disabled = false;
                render();
                paint();
                onReview?.();
                return true;
            } catch (error) {
                if (closed || ticket !== sequence) return false;
                pending = false;
                invalidate();
                console.warn('[land-take] Review unavailable', error);
                status.textContent = text('unavailable');
                panel.dataset.review = '';
                paint();
                return false;
            }
        }
        panel.querySelector('[data-land-retry]').addEventListener('click', refresh);
        accept.addEventListener('change', () => { reviewed = accept.checked ? panel.dataset.review : null; });
        for (const mode of ['footprint', 'whole']) panel.querySelector(`[data-land-${mode}]`).addEventListener('click', () => {
            onHistory();
            savedTake = null;
            whole = mode === 'whole' ? new Set(current?.rows.map(row => row.key)) : new Set();
            invalidate();
            refresh();
        });
        function schedule() {
            if (closed) return;
            accept.disabled = true;
            clearTimeout(timer);
            timer = setTimeout(refresh, 300);
        }
        return {
            schedule,
            get take() { return current?.take || null; },
            get changeSignature() {
                const value = current ? JSON.stringify(current.take.geometry) : null;
                return value && baseline && value !== baseline ? value : '';
            },
            get preview() {
                if (!current) return {};
                return { boundary: current.take, excluded: outcomes ? [
                    ...outcomes.removed, ...(outcomes.parked || []),
                    ...outcomes.partial.map(item => ({ type: 'Feature', properties: item.building.properties, geometry: item.demolishedPart }))
                ] : [] };
            },
            snapshot() { return current?.take || null; },
            restore(take) { savedTake = take; whole.clear(); geometryKey = null; invalidate(); schedule(); },
            async prepare() {
                clearTimeout(timer);
                const ready = await refresh();
                if (!ready || !accept.checked || !reviewed) {
                    accept.closest('label').scrollIntoView({ block: 'nearest' });
                    accept.focus({ preventScroll: true });
                    return false;
                }
                return true;
            },
            destroy() { closed = true; sequence++; clearTimeout(timer); layers.remove(); }
        };
    }
    env.FreeformLandTakeReview = { mount };
})(window);
