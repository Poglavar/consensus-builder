// The Effects section of the building editor: the neighbouring plots a design takes sunlight, sky or
// distance from (planning/neighbour-effects.js), listed under the Permitted check and coloured on the
// map. Neighbours come from the map's parcels and buildings, their heights from the height survey
// where one covers them (the best measure, as the Permitted check uses), else their source's, else an
// estimate that the section counts. One assessment at a time, the newest design last.
(function (root) {
    'use strict';
    const log = (...args) => console.log(`[${new Date().toISOString()}] [neighbour-effects]`, ...args);
    const SUN_SCRIPT = 'vendor/suncalc-1.9.0/suncalc.js';
    const STATUS_CLASS = { fail: 'neighbour-effect--fail', worse: 'neighbour-effect--worse' };

    // The assessment runs in a worker; answers are matched to requests by id.
    const WORKER_SCRIPT = 'js/planning/neighbour-effects-worker.js';
    let worker = null, nextId = 0;
    const pending = new Map();
    function inWorker(input) {
        if (!worker) {
            worker = new Worker(root.appendBuildToken ? root.appendBuildToken(WORKER_SCRIPT) : WORKER_SCRIPT);
            worker.onmessage = ({ data }) => {
                const request = pending.get(data.id);
                pending.delete(data.id);
                if (data.error) request?.reject(new Error(data.error)); else request?.resolve(data.result);
            };
            worker.onerror = event => {
                const error = new Error(event.message || 'The neighbour effects worker failed');
                for (const request of pending.values()) request.reject(error);
                pending.clear();
                worker = null;
            };
        }
        const id = ++nextId;
        return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, input }); });
    }

    let sunLoading = null;
    function sunCalc() {
        if (root.SunCalc) return Promise.resolve(root.SunCalc);
        sunLoading ??= new Promise((resolve, reject) => {
            const tag = document.createElement('script');
            tag.src = root.appendBuildToken ? root.appendBuildToken(SUN_SCRIPT) : SUN_SCRIPT;
            tag.onload = () => resolve(root.SunCalc);
            tag.onerror = () => { sunLoading = null; tag.remove(); reject(new Error(`Failed to load ${SUN_SCRIPT}`)); };
            document.head.appendChild(tag);
        });
        return sunLoading;
    }

    const metresBox = (bbox, reachM) => {
        const [w, s, e, n] = bbox, dLat = reachM / 110540, dLng = reachM / (111320 * Math.cos((s + n) / 2 * Math.PI / 180));
        return [w - dLng, s - dLat, e + dLng, n + dLat];
    };
    const crosses = (box, reach) => box[0] <= reach[2] && box[2] >= reach[0] && box[1] <= reach[3] && box[3] >= reach[1];
    // A map building with its height: a known one (a survey's or its source's), else the 3D view's
    // estimate, marked as such.
    function standing(record) {
        const props = record.properties || {};
        const known = root.PlanningRuleTerms.buildingHeight(record);
        if (known.known) return { id: record.id, geometry: record.geometry, heightM: known.heightM, survey: known.survey?.name || null };
        const estimate = root.BuildingExtrusion.resolveBuildingHeight({ id: String(record.id ?? props.id ?? ''), heightM: props.height_m,
            levels: props.floors, building: props.building, areaM2: root.BuildingExtrusion.footprintAreaM2(record.geometry) });
        return { id: record.id, geometry: record.geometry, heightM: estimate.heightM, estimated: true };
    }

    // `design`: { buildings: [{ id, footprint: Feature, heightM }] }. Answers the assessment with the
    // lot geometries it names, or { status: 'unavailable', reason }.
    async function assessDesign(design) {
        const turf = root.turf, fabric = root.LiveParcelFabric, effects = root.NeighbourEffects;
        const proposed = (design.buildings || []).filter(building => building.footprint?.geometry && building.heightM > 0)
            .map(building => ({ id: building.id, geometry: building.footprint.geometry, heightM: building.heightM }));
        if (!proposed.length || !fabric?.peekBounds) return { status: 'none', lots: [] };
        const bbox = turf.bbox(turf.featureCollection(proposed.map(record => turf.feature(record.geometry))));
        const tallest = Math.max(...proposed.map(record => record.heightM));
        const reachM = Math.max(effects.GUIDE.minReachM, Math.min(effects.GUIDE.maxReachM, effects.GUIDE.reachFactor * tallest));
        const around = metresBox(bbox, reachM + effects.GUIDE.maxReachM / 2);
        const pieces = fabric.peekBounds(around, { includeCorridors: false }).filter(piece => ['Polygon', 'MultiPolygon'].includes(piece?.geometry?.type));
        const lots = pieces.map(piece => ({ id: String(piece.properties.parcelId), geometry: piece.geometry }));
        const footprints = proposed.map(record => turf.feature(record.geometry));
        const site = lots.filter(lot => footprints.some(footprint => { try { return turf.booleanIntersects(lot.geometry, footprint); } catch (_) { return false; } }))
            .map(lot => lot.geometry);
        // The map's buildings there, loaded whether or not the Built layer is shown.
        await root.ensureBuildingFootprintsForBounds?.([[around[1], around[0]], [around[3], around[2]]]);
        const pool = (root.buildingFeaturePool || []).filter(feature => feature?.geometry && crosses(turf.bbox(feature), around));
        const idOf = record => root.buildingPoolFeatureKey?.(record) || record.id;
        let measured = pool;
        try { measured = await root.HeightSurveyClient.fillHeights(pool, { idOf }); }
        catch (error) { console.error(`[${new Date().toISOString()}] [neighbour-effects] Building heights could not be measured; source heights stand`, error); }
        const existing = measured.map(standing);
        const sun = effects.sunPath(await sunCalc(), `${new Date().getUTCFullYear()}-03-21`, (bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2);
        const started = performance.now();
        const result = await inWorker({ site, lots, existing, proposed, sun });
        log(`${result.lots.length} of ${lots.length} plots affected, ${existing.length} buildings, ${Math.round(performance.now() - started)} ms`);
        const geometries = new Map(lots.map(lot => [lot.id, lot.geometry]));
        return { status: result.lots.length ? 'affected' : 'clear', ...result, geometries,
            surveys: [...new Set(existing.map(record => record.survey).filter(Boolean))] };
    }

    // The newest design waits for the running assessment and replaces any design queued behind it;
    // a design that a newer one replaced is answered null.
    let running = null, queued = null;
    function assess(design, onResult) {
        queued?.onResult(null);
        queued = { design, onResult };
        if (running) return running;
        running = (async () => {
            while (queued) {
                const { design: next, onResult: answer } = queued;
                queued = null;
                let result;
                try { result = await assessDesign(next); }
                catch (error) {
                    console.error(`[${new Date().toISOString()}] [neighbour-effects] Effects could not be measured`, error);
                    result = { status: 'unavailable', lots: [], reason: error?.message || String(error) };
                }
                answer(queued ? null : result);
            }
        })().finally(() => { running = null; });
        return running;
    }

    // ---- Render ----
    const t = (key, params) => root.i18n.t(key, params);
    const format = () => root.CbFormat;
    const share = value => format().formatPercent(value, { maxFractionDigits: 0 });
    // One decimal: 26.6 % is under the 27 % guide, and must not read as 27 %.
    const sky = value => format().formatPercent(value, { ofHundred: true, maxFractionDigits: 1 });
    const metres = value => format().formatLength(value, { maxFractionDigits: 0 });
    // Readings to a tenth: 13.4 m → 12.8 m is a change, and must not read as 13 m → 13 m.
    const reading = value => format().formatLength(value, { maxFractionDigits: 1 });
    // Literal keys so the locale coverage test sees each one.
    const DIRECTION_KEYS = { n: 'neighbourEffects.direction.n', ne: 'neighbourEffects.direction.ne', e: 'neighbourEffects.direction.e', se: 'neighbourEffects.direction.se',
        s: 'neighbourEffects.direction.s', sw: 'neighbourEffects.direction.sw', w: 'neighbourEffects.direction.w', nw: 'neighbourEffects.direction.nw' };
    const STATUS_KEYS = { fail: 'neighbourEffects.status.fail', worse: 'neighbourEffects.status.worse' };
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function readings(lot) {
        const lines = [];
        if (lot.garden && lot.garden.status !== 'same') lines.push([lot.garden.status, t('neighbourEffects.garden', { before: share(lot.garden.before), after: share(lot.garden.after) })]);
        if (lot.sky && lot.sky.status !== 'same') lines.push([lot.sky.status, t('neighbourEffects.sky', { before: sky(lot.sky.before), after: sky(lot.sky.after) })]);
        if (lot.distance && lot.distance.status !== 'same') lines.push([lot.distance.status, lot.distance.before === null
            ? t('neighbourEffects.distanceNew', { after: reading(lot.distance.after) })
            : t('neighbourEffects.distance', { before: reading(lot.distance.before), after: reading(lot.distance.after) })]);
        return lines;
    }
    // Fills `container`: a heading, a line per affected plot (worst first) with its changed readings,
    // and the basis. `result` null while measuring.
    function render(container, result) {
        if (!container) return;
        const status = result?.status || 'measuring';
        container.hidden = false;
        container.dataset.status = status === 'affected' && result.lots.some(lot => lot.status === 'fail') ? 'fail' : status;
        container.replaceChildren(element('h3', 'cb-kicker', t('neighbourEffects.title')));
        if (status === 'none') { container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.noBuildings'))); return; }
        if (status === 'measuring') { container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.measuring'))); return; }
        if (status === 'unavailable') { container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.unavailable', { reason: result.reason || '' }))); return; }
        if (status === 'clear') container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.clear')));
        else {
            const fails = result.lots.filter(lot => lot.status === 'fail').length;
            container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.summary', { count: result.lots.length, fail: fails })));
            const list = element('ul', 'neighbour-effects__plots');
            for (const lot of result.lots) {
                const item = element('li', `neighbour-effects__plot neighbour-effects__plot--${lot.status}`);
                // The plot's name points at it on the map: hover or focus highlights it, a click keeps
                // it highlighted and brings it into view.
                const name = element('button', 'cb-link neighbour-effects__name', t('neighbourEffects.plot', { direction: t(DIRECTION_KEYS[lot.direction]), distance: metres(lot.distanceM) }));
                name.type = 'button';
                name.dataset.plotId = lot.id;
                name.setAttribute('aria-pressed', 'false');
                name.addEventListener('mouseenter', () => highlight(lot.id, true));
                name.addEventListener('focus', () => highlight(lot.id, true));
                name.addEventListener('mouseleave', () => highlight(lot.id, false));
                name.addEventListener('blur', () => highlight(lot.id, false));
                name.addEventListener('click', () => pin(lot.id, container));
                item.append(name, ' ', element('span', 'neighbour-effects__status', t(STATUS_KEYS[lot.status])));
                const lines = element('ul', 'neighbour-effects__readings');
                for (const [lineStatus, text] of readings(lot)) lines.append(element('li', `neighbour-effects__reading neighbour-effects__reading--${lineStatus}`, text));
                item.append(lines);
                list.append(item);
            }
            container.append(list);
        }
        const heights = result.surveys.length ? t('neighbourEffects.heightsSurvey', { source: result.surveys.join(', ') }) : t('neighbourEffects.heightsSource');
        container.append(element('p', 'neighbour-effects__basis', t('neighbourEffects.basis', { heights })));
        if (result.estimated) container.append(element('p', 'neighbour-effects__basis', t('neighbourEffects.estimated', { count: result.estimated })));
    }

    // The affected plots drawn on `map`, coloured by how badly each is affected; replaces the last.
    // Each plot's path is kept by its id, for the list to point at.
    let layer = null, shownOn = null, pinned = null;
    const plotLayers = new Map();
    function show(map, result) {
        clear();
        if (!map || !result?.lots?.length) return;
        shownOn = map;
        layer = root.L.geoJSON({ type: 'FeatureCollection', features: result.lots.map(lot => ({ type: 'Feature',
            properties: { id: lot.id, status: lot.status }, geometry: result.geometries.get(lot.id) })).filter(feature => feature.geometry) }, {
            interactive: false,
            style: feature => ({ className: `neighbour-effect ${STATUS_CLASS[feature.properties.status] || ''}` })
        }).addTo(map);
        layer.eachLayer(path => plotLayers.set(path.feature.properties.id, path));
    }
    function clear() {
        if (layer) { layer.remove(); layer = null; }
        plotLayers.clear();
        shownOn = null;
        pinned = null;
    }
    // A plot stands out on the map while the list points at it; the pinned one stays out.
    function highlight(id, on) {
        const path = plotLayers.get(id);
        if (!path) return;
        const lit = on || pinned === id;
        path.getElement?.()?.classList.toggle('neighbour-effect--focus', lit);
        if (lit) path.bringToFront?.();
    }
    // A click on a plot's name: it stays highlighted (another click lets go) and comes into view.
    function pin(id, container) {
        const previous = pinned;
        pinned = previous === id ? null : id;
        if (previous && previous !== id) highlight(previous, false);
        highlight(id, pinned === id);
        for (const name of container.querySelectorAll?.('.neighbour-effects__name') || []) name.setAttribute('aria-pressed', String(name.dataset.plotId === pinned));
        const path = plotLayers.get(id);
        if (pinned === id && path && shownOn) {
            const bounds = path.getBounds();
            if (!shownOn.getBounds().contains(bounds)) shownOn.panTo(bounds.getCenter());
        }
    }

    root.NeighbourEffectsAdvisor = { assess, assessDesign, render, show, clear, highlight, pin };
})(window);
