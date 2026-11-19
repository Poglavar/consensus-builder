// Loads the Permitted items under a design being edited and runs the rule check on them
// (planning/permitted-check.js), whether or not the Permitted layer is shown. Items come from the
// same /planning/representations feed as the layer, by the same cells, kept per source and cell.
(function (root) {
    'use strict';
    const scene = root.PlanningScene;
    const cache = scene.createViewportCache({ limit: 256, maxAgeMs: 10 * 60 * 1000 });
    const listings = scene.createViewportCache({ limit: 32, maxAgeMs: 10 * 60 * 1000 });
    // The source the Permitted layer shows when it is one of this place's, else the city's first.
    async function sourceFor(city, bbox) {
        const rounded = bbox.map(value => Math.round(value * 100) / 100);
        const sources = (await listings.load(city, rounded, async signal => {
            const url = new URL(`${root.getBackendBase()}/planning/sources`);
            url.searchParams.set('city', city); url.searchParams.set('bbox', bbox.join(','));
            const response = await fetch(url, { signal, cache: 'no-store' });
            if (!response.ok) throw new Error(`Planning sources HTTP ${response.status}`);
            const answer = await response.json();
            const configured = root.CityConfigManager.getCityConfig(city)?.planning?.sourceIds || [];
            return configured.map(id => (answer.sources || []).find(source => source.id === id)).filter(Boolean);
        })).value;
        const shown = root.PlanningViews?.getSource?.();
        return sources.find(source => source.id === shown) || sources[0] || null;
    }
    async function itemsFor(city, bbox) {
        const source = await sourceFor(city, bbox);
        if (!source) return { source: null, items: [] };
        const shownScenario = root.PlanningViews?.getScenario?.();
        const scenario = source.scenarios?.includes(shownScenario) ? shownScenario : source.scenario || '';
        const scope = `check:${city}:${source.id}:${scenario}`;
        const cells = scene.viewCells(bbox, [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2]);
        const answers = await Promise.all(cells.map(cell => cache.load(scope, cell.bbox, signal => {
            const url = new URL(`${root.getBackendBase()}/planning/representations`);
            url.searchParams.set('city', city); url.searchParams.set('source', source.id);
            url.searchParams.set('bbox', cell.bbox.join(','));
            if (scenario) url.searchParams.set('scenario', scenario);
            return root.PlanningFeed.loadViewport(url, { city, signal });
        }).then(entry => entry.value)));
        // A zone over a cell line arrives as each cell's piece; the check sums its overlap over them.
        return { source, items: scene.mergeAnswers(answers)?.items || [] };
    }
    let generation = 0;
    // `design` as PermittedCheck.check takes it, without items. Resolves to the result, or null when
    // a later call superseded this one. A source that cannot be read gives status 'unavailable'.
    async function check(design) {
        const id = ++generation;
        const footprints = (design.buildings || []).map(building => building.footprint).filter(Boolean);
        if (!footprints.length) return { status: 'none', checks: [], buildings: {} };
        const bbox = root.turf.bbox(root.turf.featureCollection(footprints));
        const city = root.CityConfigManager.getCurrentCityId();
        let loaded;
        try { loaded = await itemsFor(city, bbox); }
        catch (error) {
            if (id !== generation) return null;
            console.error(`[${new Date().toISOString()}] [permitted-check] Permitted items could not be read`, error);
            return { status: 'unavailable', checks: [], buildings: {} };
        }
        if (id !== generation) return null;
        const result = root.PermittedCheck.check({ ...design, items: loaded.items, geometryOps: root.turf });
        return { ...result, source: loaded.source };
    }
    // The person-readable lines, literal keys so the locale coverage test sees each one.
    const LINE_KEYS = {
        height: { fail: 'permittedCheck.heightFail', conditional: 'permittedCheck.heightConditional', pass: 'permittedCheck.heightPass' },
        storeys: { fail: 'permittedCheck.storeysFail', pass: 'permittedCheck.storeysPass', unknown: 'permittedCheck.storeysUnknown' },
        coverage: { fail: 'permittedCheck.coverageFail', pass: 'permittedCheck.coveragePass' },
        floorAreaRatio: { fail: 'permittedCheck.floorAreaRatioFail', pass: 'permittedCheck.floorAreaRatioPass' },
        lotArea: { fail: 'permittedCheck.lotAreaFail', pass: 'permittedCheck.lotAreaPass' },
        use: { fail: 'permittedCheck.useFail', unknown: 'permittedCheck.useUnknown' }
    };
    const STATUS_KEYS = { fail: 'permittedCheck.status.fail', conditional: 'permittedCheck.status.conditional',
        unknown: 'permittedCheck.status.unknown', pass: 'permittedCheck.status.pass', unavailable: 'permittedCheck.status.unavailable' };
    function valueText(value, unit) {
        const format = root.CbFormat;
        if (unit === 'm') return format.formatLength(value, { maxFractionDigits: 1 });
        if (unit === 'm2') return format.formatArea(value, { maxFractionDigits: 0 });
        if (unit === 'percent') return format.formatPercent(value, { ofHundred: true, maxFractionDigits: 1 });
        if (unit === 'ratio') return format.formatNumber(value, { maxFractionDigits: 2 });
        return format.formatNumber(value, { maxFractionDigits: 0 });
    }
    function useName(entry) {
        const key = entry.useKey ? `planningViews.use.${entry.useKey}` : '';
        const label = key ? root.i18n.t(key) : key;
        return label && label !== key ? label : entry.use || entry.title || '';
    }
    function line(entry) {
        const key = LINE_KEYS[entry.rule]?.[entry.status];
        if (!key) return null;
        const status = root.i18n.t(`planningViews.resultStatus.${entry.treatment}`);
        // A height limit that stands for a storey class names the class too.
        const limit = entry.rule === 'height' && entry.storeyLimit != null
            ? root.i18n.t('permittedCheck.storeyCount', { limit: valueText(entry.limit, entry.unit), storeys: valueText(entry.storeyLimit, 'count') })
            : valueText(entry.limit, entry.unit);
        return root.i18n.t(key, { measured: valueText(entry.measured, entry.unit), limit,
            conditionalLimit: valueText(entry.conditionalLimit, entry.unit), condition: entry.condition || '',
            storeys: valueText(entry.storeyLimit, 'count'), use: useName(entry),
            status: status.startsWith('planningViews.') ? '' : status });
    }
    // Fills `container` with the result: a headline, a line per rule (failures first) and the source.
    // Hidden when no Permitted rules lie under the design.
    function render(container, result) {
        if (!container) return;
        const status = result?.status || 'none';
        container.hidden = status === 'none';
        container.dataset.status = status;
        container.replaceChildren();
        if (status === 'none') return;
        const element = (tag, className, text) => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        };
        container.append(element('h3', 'cb-kicker', root.i18n.t('permittedCheck.title')),
            element('p', 'permitted-check__headline', root.i18n.t(STATUS_KEYS[status])));
        const entries = root.PermittedCheck.summarize(result);
        const list = element('ul', 'permitted-check__rules');
        for (const entry of entries) {
            const text = line(entry);
            if (!text) continue;
            const item = element('li', `permitted-check__rule permitted-check__rule--${entry.status}`, text);
            if (entry.rule === 'use' && entry.reason && entry.status !== 'pass') item.append(element('span', 'permitted-check__reason', entry.reason));
            list.append(item);
        }
        if (list.children.length) container.append(list);
        if (result.source?.label) container.append(element('p', 'permitted-check__source', root.i18n.t('permittedCheck.source', { source: result.source.label })));
    }
    root.PermittedAdvisor = { check, render };
})(window);
