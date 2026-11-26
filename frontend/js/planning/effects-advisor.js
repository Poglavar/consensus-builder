// The Effects section of the building editor: the neighbouring plots a design takes sunlight, sky or
// distance from (planning/neighbour-effects.js), listed under the Permitted check and coloured on the
// map. Which readings a place uses and their thresholds are its guides, a rule set's
// `neighbourGuides` (data/planning-sources.json); a place without them gets no section. Neighbours come from the map's parcels and buildings, their heights from the height survey
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

    // The neighbour guides of a city: the first of its rule sets that states them, or null. Known
    // ones are kept, so applies() answers at once after the first read.
    const known = new Map();
    function guidesFor(city = root.CityConfigManager?.getCurrentCityId?.()) {
        if (!known.has(city)) {
            const reading = (root.PlanningRestrictionFeed?.ruleSets?.(city) || Promise.resolve([]))
                .then(ruleSets => ruleSets.find(ruleSet => ruleSet.neighbourGuides)?.neighbourGuides || null)
                .catch(error => { known.delete(city); throw error; });
            known.set(city, reading);
            reading.then(guides => {
                if (known.get(city) !== reading) return;
                known.set(city, { guides });
                // Controls drawn before the guides were known (a design card) show or stay hidden.
                if (city === root.CityConfigManager?.getCurrentCityId?.()) {
                    for (const control of root.document?.querySelectorAll?.('[data-neighbour-effects-control]') || []) control.hidden = !guides;
                }
            }, () => {});
        }
        const entry = known.get(city);
        return entry instanceof Promise ? entry : Promise.resolve(entry.guides);
    }
    // Whether the city has neighbour guides, as far as is known yet (false while they are read).
    function applies(city = root.CityConfigManager?.getCurrentCityId?.()) {
        const entry = known.get(city);
        if (!entry) { guidesFor(city).catch(() => {}); return false; }
        return !(entry instanceof Promise) && !!entry.guides;
    }

    // `design`: { buildings: [{ id, footprint: Feature, heightM }] }. Answers the assessment with the
    // lot geometries it names and the guides it used, { status: 'notApplicable' } where the city has
    // no neighbour guides, or { status: 'unavailable', reason }.
    async function assessDesign(design) {
        const turf = root.turf, fabric = root.LiveParcelFabric, effects = root.NeighbourEffects;
        const guides = await guidesFor();
        if (!guides) return { status: 'notApplicable', lots: [] };
        const proposed = (design.buildings || []).filter(building => building.footprint?.geometry && building.heightM > 0)
            .map(building => ({ id: building.id, geometry: building.footprint.geometry, heightM: building.heightM }));
        if (!proposed.length || !fabric?.peekBounds) return { status: 'none', lots: [] };
        const bbox = turf.bbox(turf.featureCollection(proposed.map(record => turf.feature(record.geometry))));
        const tallest = Math.max(...proposed.map(record => record.heightM));
        const reachM = Math.max(effects.MEASURE.minReachM, Math.min(effects.MEASURE.maxReachM, effects.MEASURE.reachFactor * tallest));
        const around = metresBox(bbox, reachM + effects.MEASURE.maxReachM / 2);
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
        // The garden guide's day this year (MM-DD); the sun's path barely moves from year to year.
        const sun = guides.garden ? effects.sunPath(await sunCalc(), `${new Date().getUTCFullYear()}-${guides.garden.date}`, (bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2) : null;
        const started = performance.now();
        const result = await inWorker({ site, lots, existing, proposed, sun, guides });
        log(`${result.lots.length} of ${lots.length} plots affected, ${existing.length} buildings, ${Math.round(performance.now() - started)} ms`);
        const geometries = new Map(lots.map(lot => [lot.id, lot.geometry]));
        return { status: result.lots.length ? 'affected' : 'clear', ...result, guides, geometries,
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
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    // One icon per kind of reading, so a list can be read at a glance. Literal keys for the locale test.
    const KIND_ICONS = { garden: 'fa-sun', sky: 'fa-cloud', distance: 'fa-left-right' };
    const KIND_KEYS = { garden: 'neighbourEffects.kind.garden', sky: 'neighbourEffects.kind.sky', distance: 'neighbourEffects.kind.distance' };
    function icon(kind, status) {
        const node = element('i', `fas ${KIND_ICONS[kind]} neighbour-effects__icon${status ? ` neighbour-effects__icon--${status}` : ''}`);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }
    // A guide's day (MM-DD) in the reader's language: "21 March".
    const dayOf = monthDay => new Intl.DateTimeFormat(format().currentLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' })
        .format(new Date(`2000-${monthDay}T12:00:00Z`));
    const ratio = value => format().formatNumber(value, { maxFractionDigits: 2 });
    // A reading in words, with the place's guide for it.
    function readingText(lot, kind, guides) {
        const value = lot[kind];
        if (kind === 'garden') return t('neighbourEffects.garden', { hours: format().formatNumber(guides.garden.hours), date: dayOf(guides.garden.date),
            before: share(value.before), after: share(value.after), share: share(guides.garden.share), ratio: ratio(guides.garden.ratio) });
        if (kind === 'sky') return t('neighbourEffects.sky', { before: sky(value.before), after: sky(value.after),
            percent: sky(guides.sky.percent), ratio: ratio(guides.sky.ratio) });
        return value.before === null ? t('neighbourEffects.distanceNew', { after: reading(value.after), metres: metres(guides.distance.metres) })
            : t('neighbourEffects.distance', { before: reading(value.before), after: reading(value.after), metres: metres(guides.distance.metres) });
    }
    function plotItem(lot, container, guides) {
        const effects = root.NeighbourEffects;
        const item = element('li', `neighbour-effects__plot neighbour-effects__plot--${lot.status}`);
        // The plot's name points at it on the map: hover or focus highlights it, a click keeps it
        // highlighted and brings it into view.
        const name = element('button', 'cb-link neighbour-effects__name', t('neighbourEffects.plot', { direction: t(DIRECTION_KEYS[lot.direction]), distance: metres(lot.distanceM) }));
        name.type = 'button';
        name.dataset.plotId = lot.id;
        name.setAttribute('aria-pressed', String(pinned === lot.id));
        name.addEventListener('mouseenter', () => highlight(lot.id, true));
        name.addEventListener('focus', () => highlight(lot.id, true));
        name.addEventListener('mouseleave', () => highlight(lot.id, false));
        name.addEventListener('blur', () => highlight(lot.id, false));
        name.addEventListener('click', () => pin(lot.id, container));
        // What it loses, as icons coloured by status; the readings below say it in words.
        const badges = element('span', 'neighbour-effects__badges');
        for (const { kind, status } of effects.changes(lot)) {
            const badge = icon(kind, status);
            badge.title = t(KIND_KEYS[kind]);
            badges.append(badge);
        }
        const lines = element('ul', 'neighbour-effects__readings');
        for (const { kind, status } of effects.changes(lot)) {
            const line = element('li', `neighbour-effects__reading neighbour-effects__reading--${status}`);
            line.append(icon(kind, status), ' ', readingText(lot, kind, guides));
            lines.append(line);
        }
        item.append(name, ' ', badges, lines);
        return item;
    }
    // Filter buttons: all plots, or only those where one kind of reading changed (sorted by it).
    function filters(container, result, kind) {
        const group = element('div', 'neighbour-effects__filters');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', t('neighbourEffects.filterLabel'));
        const option = (value, label, count) => {
            const control = element('button', 'btn btn-sm neighbour-effects__filter');
            control.type = 'button';
            control.setAttribute('aria-pressed', String(kind === value));
            if (value) control.append(icon(value), ' ');
            control.append(`${label} (${count})`);
            control.disabled = !count;
            control.addEventListener('click', () => render(container, result, { kind: value }));
            return control;
        };
        group.append(option(null, t('neighbourEffects.filterAll'), result.lots.length));
        // Only the readings this place's guides use.
        for (const each of root.NeighbourEffects.KINDS.filter(kind => result.guides[kind])) {
            group.append(option(each, t(KIND_KEYS[each]), result.lots.filter(lot => lot[each] && lot[each].status !== 'same').length));
        }
        return group;
    }
    // What "beyond a guide" means here, a click away: the place's guides, and whether they bind.
    function guidesNote(guides) {
        const details = element('details', 'neighbour-effects__guides');
        details.append(element('summary', '', t('neighbourEffects.guidesTitle')),
            element('p', '', t('neighbourEffects.guidesText', { source: guides.label || '' })),
            element('p', '', t(guides.binding ? 'neighbourEffects.guidesBinding' : 'neighbourEffects.guidesAdvice')));
        return details;
    }
    // The heading's icon turns into a spinner while the section measures (BusyControl's .cb-busy);
    // the last result stays readable meanwhile.
    function busy(container, on) {
        if (!container) return;
        container.querySelector?.('.neighbour-effects__title')?.classList.toggle('cb-busy', on);
        if (on) container.setAttribute('aria-busy', 'true'); else container.removeAttribute('aria-busy');
    }
    // Fills `container`: a heading, the plots beyond a guide and those within the guides (largest
    // loss first, optionally only one kind of reading), what the guides are, and the basis.
    // `result` null while measuring.
    const shownKind = new WeakMap();
    function render(container, result, { kind } = {}) {
        if (!container) return;
        if (kind === undefined) kind = shownKind.get(container) ?? null;
        shownKind.set(container, kind);
        const status = result?.status || 'measuring';
        // A place without neighbour guides has no section.
        container.hidden = status === 'notApplicable';
        if (status === 'notApplicable') { container.replaceChildren(); return; }
        container.dataset.status = status === 'affected' && result.lots.some(lot => lot.status === 'fail') ? 'fail' : status;
        // While measuring, the heading's icon is a spinner (BusyControl's .cb-busy).
        const title = element('h3', `cb-kicker neighbour-effects__title${status === 'measuring' ? ' cb-busy' : ''}`);
        const titleIcon = element('i', 'fas fa-house-circle-exclamation');
        titleIcon.setAttribute('aria-hidden', 'true');
        title.append(titleIcon, ' ', t('neighbourEffects.title'));
        container.replaceChildren(title);
        if (status === 'measuring') container.setAttribute('aria-busy', 'true'); else container.removeAttribute('aria-busy');
        if (status === 'none') { container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.noBuildings'))); return; }
        if (status === 'measuring') { container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.measuring'))); return; }
        if (status === 'unavailable') { container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.unavailable', { reason: result.reason || '' }))); return; }
        if (status === 'clear') container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.clear')));
        else {
            const fails = result.lots.filter(lot => lot.status === 'fail').length;
            container.append(element('p', 'neighbour-effects__headline', t('neighbourEffects.summary', { count: result.lots.length, fail: fails })),
                filters(container, result, kind));
            const [beyond, within] = root.NeighbourEffects.arrange(result.lots, { kind });
            const beyondKey = result.guides.binding ? 'neighbourEffects.groupBeyondBinding' : 'neighbourEffects.groupBeyond';
            for (const [lots, key, group] of [[beyond, beyondKey, 'beyond'], [within, 'neighbourEffects.groupWithin', 'within']]) {
                if (!lots.length) continue;
                container.append(element('h4', `neighbour-effects__group neighbour-effects__group--${group}`, t(key, { count: lots.length })));
                const list = element('ul', 'neighbour-effects__plots');
                for (const lot of lots) list.append(plotItem(lot, container, result.guides));
                container.append(list);
            }
            container.append(guidesNote(result.guides));
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
        changed();
    }
    function clear() {
        if (layer) { layer.remove(); layer = null; }
        plotLayers.clear();
        shownOn = null;
        pinned = null;
        lit = null;
        changed();
    }
    // The 3D model view draws the same plots (three-mode.js syncNeighbourEffects3D): it reads them
    // here and is told when they or the highlighted one change.
    let lit = null;
    function plots() {
        return [...plotLayers.entries()].map(([id, path]) => ({ id, geometry: path.feature.geometry,
            status: path.feature.properties.status, focus: id === lit || id === pinned }));
    }
    const changed = () => root.dispatchEvent?.(new CustomEvent('neighbourEffectsChanged'));
    // A plot stands out on the map while the list points at it; the pinned one stays out.
    function highlight(id, on) {
        const path = plotLayers.get(id);
        if (!path) return;
        const shown = on || pinned === id;
        path.getElement?.()?.classList.toggle('neighbour-effect--focus', shown);
        if (shown) path.bringToFront?.();
        lit = on ? id : lit === id ? null : lit;
        changed();
    }
    // A click on a plot's name: it stays highlighted (another click lets go) and comes into view.
    function pin(id, container) {
        const previous = pinned;
        pinned = previous === id ? null : id;
        if (previous && previous !== id) highlight(previous, false);
        highlight(id, pinned === id);
        for (const name of container.querySelectorAll?.('.neighbour-effects__name') || []) name.setAttribute('aria-pressed', String(name.dataset.plotId === pinned));
        const path = plotLayers.get(id);
        // The 2D map stays still while the 3D view is open (three-mode.js), so only 2D pans.
        if (pinned === id && path && shownOn && !root.document?.body?.classList.contains('three-mode-active')) {
            const bounds = path.getBounds();
            if (!shownOn.getBounds().contains(bounds)) shownOn.panTo(bounds.getCenter());
        }
    }

    root.NeighbourEffectsAdvisor = { assess, assessDesign, guidesFor, applies, render, busy, show, clear, highlight, pin, plots };
})(window);
