// Editor-only land review. Reads source stock; never applies demolition or changes agreements.
(function (env) {
    'use strict';
    function mount({ session, getBuildings, initialTake = null, onChange, onHistory, onReview }) {
        const api = env.FreeformLandTake;
        const panel = session.content.querySelector('#single-land-take');
        const rows = panel.querySelector('[data-land-rows]');
        const status = panel.querySelector('[data-land-status]');
        const error = document.createElement('p');
        error.id = 'single-land-take-error';
        error.className = 'land-take-error';
        error.setAttribute('role', 'alert');
        error.hidden = true;
        status.after(error);
        const layers = env.L.featureGroup().addTo(session.map);
        let whole = new Set(), parcels = [], current = null, savedTake = initialTake;
        let sequence = 0, timer = null, closed = false;
        let geometryKey = null, stock = [], outcomes = null, pending = false, baseline = null;
        const text = (key, params = {}) => env.i18n.t(`landTake.${key}`, params);
        function style(kind) {
            const css = getComputedStyle(panel);
            const color = css.getPropertyValue(`--land-${kind}`).trim();
            return { color, fillColor: color, weight: 2, fillOpacity: kind === 'take' ? 0.12 : 0.25,
                dashArray: kind === 'remainder' ? '4 4' : null };
        }
        let hoveredKey = null, focusedKey = null, selectedKey = null;
        function paint() {
            const key = hoveredKey || focusedKey || selectedKey;
            const focus = current?.rows.find(row => row.key === key)?.feature;
            rows.querySelectorAll('.land-take-row').forEach(row => {
                row.classList.toggle('is-highlighted', row.dataset.landKey === key);
            });
            layers.clearLayers();
            if (!current) return;
            const draw = (geometry, kind) => {
                if (geometry) env.L.geoJSON(geometry, { pane: session.pane, interactive: false, style: { ...style(kind), ...(kind === 'focus' ? { className: 'land-take-focus', weight: 4 } : {}) } }).addTo(layers);
            };
            draw(current.take, 'take');
            current.rows.forEach(row => draw(row.remainder, 'remainder'));
            outcomes?.parked?.forEach(building => draw(building, 'removed'));
            outcomes?.removed.forEach(building => draw(building, 'removed'));
            outcomes?.partial.forEach(item => { draw(item.demolishedPart, 'removed'); draw(item.remainder, 'retained'); });
            outcomes?.retained.forEach(building => draw(building, 'retained'));
            if (focus) draw(focus, 'focus');
        }
        function render() {
            rows.replaceChildren();
            panel.querySelector('[data-land-intro]').textContent = text('intro', { count: current?.rows.length || 0 });
            const multi = getBuildings().length > 1;
            panel.querySelector('[data-land-whole]').disabled = multi || pending || !current;
            panel.querySelector('[data-land-footprint]').disabled = pending;
            if (!current) return;
            for (const row of current.rows) {
                const label = document.createElement('label');
                label.className = 'land-take-row';
                label.dataset.landKey = row.key;
                const name = document.createElement('span');
                name.className = 'land-take-parcel';
                const id = String(row.feature.properties?.BROJ_CESTICE || row.id);
                const number = document.createElement('span');
                number.className = 'land-take-parcel-id';
                number.textContent = id.length > 13 ? `${id.slice(0, 5)}…${id.slice(-5)}` : id;
                number.title = id;
                number.setAttribute('aria-label', id);
                const percent = document.createElement('span');
                percent.className = 'land-take-percent';
                percent.textContent = `${Math.round(row.overlapM2 / row.parcelM2 * 100)}%`;
                name.append(number, percent);
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
                label.addEventListener('mouseenter', () => { hoveredKey = row.key; paint(); });
                label.addEventListener('mouseleave', () => { hoveredKey = null; paint(); });
                label.addEventListener('click', () => { selectedKey = row.key; paint(); });
                select.addEventListener('focus', () => { focusedKey = row.key; paint(); });
                select.addEventListener('blur', () => { focusedKey = null; paint(); });
                select.addEventListener('change', () => {
                    onHistory();
                    savedTake = null;
                    if (select.value === 'whole') whole.add(row.key); else whole.delete(row.key);
                    refresh({ choiceChanged: true });
                });
                label.append(name, select);
                rows.append(label);
            }
        }
        async function refresh({ choiceChanged = false } = {}) {
            const ticket = ++sequence;
            pending = true;
            status.textContent = text('loading');
            panel.querySelector('[data-land-whole]').disabled = true;
            panel.querySelector('[data-land-footprint]').disabled = true;
            try {
                const buildings = getBuildings();
                const nextKey = JSON.stringify(buildings.map(item => item.geometry));
                if (geometryKey !== null && nextKey !== geometryKey) savedTake = null;
                geometryKey = nextKey;
                const footprint = api.union(buildings, env.turf);
                const region = footprint;
                await env.CadastralParcelRepository.ensureFootprint(region);
                if (closed || ticket !== sequence) return false;
                // Review source parcels, not the fragments this applied design itself produced.
                parcels = env.__cadastreAncestry.loadedCadastreParcels(env.turf.bbox(region)).map(item => item.feature);
                current = api.plan({ buildings, parcels, whole, savedTake, turf: env.turf });
                savedTake = null;
                whole = new Set(current.rows.filter(row => row.mode === 'whole').map(row => row.key));
                // One building/one parcel: disconnected imported buildings save independently.
                if (buildings.length > 1 && whole.size) {
                    whole.clear();
                    current = api.plan({ buildings, parcels, whole, turf: env.turf });
                }
                if (baseline === null) baseline = JSON.stringify(current.take.geometry);
                onChange(current.take, current.rows.some(row => row.mode === 'whole'), choiceChanged);
                outcomes = null;
                render();
                paint();
                stock = await env.__demolitionPrefetch.loadBuildingStock(current.take.geometry,
                    (...args) => env.BuildingSourceClient.request(...args));
                if (closed || ticket !== sequence) return false;
                const ownId = env.getActiveProposalDesignDraft?.()?.sourceLocalProposalId;
                // Replacing this source must review its original stock, before its own removals.
                const pool = env.collectLoadedCorridorBuildings({ extraPool: stock, includeLoadedSurveyPool: false,
                    excludeProposalId: ownId });
                const hits = env.findBuildingTunnelIntersections(current.take, pool, env.turf)
                    .filter(hit => !ownId || String(env.corridorTunnelHitProposalId(hit)) !== String(ownId));
                const real = hits.filter(hit => !env.corridorTunnelHitProposalId(hit)).map(hit => ({
                    ...hit.feature, geometry: hit.originalGeometry || hit.feature.__corridorOriginalGeometry || hit.feature.geometry
                }));
                outcomes = api.demolitionPreview(current.take, real, env.splitDemolitionFootprint, env.turf);
                const parked = hits.filter(hit => env.corridorTunnelHitProposalId(hit)).map(hit => hit.feature);
                outcomes.parked = parked;
                status.textContent = text('summary', { area: Math.round(current.areaM2), parcels: current.rows.length,
                    removed: outcomes.removed.length, partial: outcomes.partial.length, parked: parked.length });
                pending = false;
                error.hidden = true;
                render();
                paint();
                onReview?.();
                return true;
            } catch (error) {
                if (closed || ticket !== sequence) return false;
                pending = false;
                render();
                console.warn('[land-take] Review unavailable', error);
                status.textContent = text('unavailable');
                paint();
                return false;
            }
        }
        for (const mode of ['footprint', 'whole']) panel.querySelector(`[data-land-${mode}]`).addEventListener('click', event => {
            if (env.BusyControl.isBusy(event.currentTarget)) return;
            onHistory();
            savedTake = null;
            whole = mode === 'whole' ? new Set(current?.rows.map(row => row.key)) : new Set();
            env.BusyControl.track(event.currentTarget, () => refresh({ choiceChanged: true }));
        });
        function schedule() {
            if (closed) return;
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
            restore(take) { savedTake = take; whole.clear(); geometryKey = null; schedule(); },
            async prepare() {
                clearTimeout(timer);
                const ready = await refresh();
                if (!ready) {
                    error.textContent = text('unavailable');
                    error.hidden = false;
                    error.scrollIntoView({ block: 'nearest' });
                    panel.querySelector('[data-land-footprint]').focus({ preventScroll: true });
                    return false;
                }
                error.hidden = true;
                return true;
            },
            destroy() { closed = true; sequence++; clearTimeout(timer); layers.remove(); }
        };
    }
    env.FreeformLandTakeReview = { mount };
})(window);
