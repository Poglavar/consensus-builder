// Loads the Permitted items under a design being edited and runs the rule check on them
// (planning/permitted-check.js), whether or not the Permitted layer is shown. Items come from the
// same /planning/representations feed as the layer, by the same cells, kept per source and cell.
// The planning designations of the city's rule sets (planning/restriction-feed.js) are read for
// the design's box, every effect, and act on the items as they do on the layer.
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
    // Items under the box with the restrictions stage applied. Without a base source the city's
    // rule sets still give the designations ("unknown base", restrictions.js unknownBaseItems).
    async function itemsFor(city, bbox) {
        const feed = root.PlanningRestrictionFeed;
        const [base, reads] = await Promise.all([sourceItemsFor(city, bbox), feed ? feed.load(city, bbox) : null]);
        if (!reads) return { ...base, restrictions: [], partial: false, baseRule: null };
        const { restrictions, partial } = feed.resolve(reads, bbox);
        const ruleSets = reads.map(entry => entry.ruleSet);
        if (base.source) return { ...base, items: root.PlanningRestrictions.applyToItems(base.items, restrictions, { geometryOps: root.turf }),
            restrictions, partial, baseRule: null };
        return { source: { id: ruleSets[0].id, label: ruleSets.map(ruleSet => ruleSet.label).join(' · ') },
            items: root.PlanningRestrictions.unknownBaseItems(restrictions, ruleSets), restrictions, partial, baseRule: 'unknown' };
    }
    async function sourceItemsFor(city, bbox) {
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
        const result = root.PermittedCheck.check({ ...design, items: loaded.items, restrictions: loaded.restrictions,
            restrictionsPartial: loaded.partial, baseRule: loaded.baseRule, geometryOps: root.turf });
        return { ...result, source: loaded.source };
    }
    // The person-readable lines, literal keys so the locale coverage test sees each one.
    const LINE_KEYS = {
        height: { fail: 'permittedCheck.heightFail', conditional: 'permittedCheck.heightConditional', pass: 'permittedCheck.heightPass', unknown: 'permittedCheck.heightUnknown' },
        storeys: { fail: 'permittedCheck.storeysFail', pass: 'permittedCheck.storeysPass', unknown: 'permittedCheck.storeysUnknown' },
        coverage: { fail: 'permittedCheck.coverageFail', pass: 'permittedCheck.coveragePass' },
        floorAreaRatio: { fail: 'permittedCheck.floorAreaRatioFail', pass: 'permittedCheck.floorAreaRatioPass' },
        lotArea: { fail: 'permittedCheck.lotAreaFail', pass: 'permittedCheck.lotAreaPass' },
        use: { fail: 'permittedCheck.useFail', unknown: 'permittedCheck.useUnknown' },
        footprintArea: { fail: 'permittedCheck.footprintAreaFail', conditional: 'permittedCheck.footprintAreaConditional', pass: 'permittedCheck.footprintAreaPass', unknown: 'permittedCheck.footprintAreaUnknown' },
        naturalGround: { fail: 'permittedCheck.naturalGroundFail', conditional: 'permittedCheck.naturalGroundConditional', pass: 'permittedCheck.naturalGroundPass', unknown: 'permittedCheck.naturalGroundUnknown' },
        base: { unknown: 'permittedCheck.baseUnknown' },
        restrictionsPartial: { unknown: 'permittedCheck.restrictionsPartial' }
    };
    // A designation line: where (the designation's own name, its kind and who designated it) and
    // what the rule set makes of it. Literal keys so the locale coverage test sees each one.
    const DESIGNATION_KEYS = {
        'scheduled-monument': 'permittedCheck.designation.scheduledMonument', 'listed-building': 'permittedCheck.designation.listedBuilding',
        'article-4-direction': 'permittedCheck.designation.article4Direction', 'conservation-area': 'permittedCheck.designation.conservationArea',
        'green-belt': 'permittedCheck.designation.greenBelt', 'flood-zone-3': 'permittedCheck.designation.floodZone3',
        'world-heritage-site': 'permittedCheck.designation.worldHeritageSite', 'tree-preservation': 'permittedCheck.designation.treePreservation'
    };
    const REQUIREMENT_KEYS = { 'planning-permission': 'permittedCheck.requirement.planningPermission', 'design-scrutiny': 'permittedCheck.requirement.designScrutiny' };
    const NOTE_KEYS = { 'green-belt': 'permittedCheck.note.greenBelt', 'flood-zone-3': 'permittedCheck.note.floodZone3',
        'world-heritage-site': 'permittedCheck.note.worldHeritageSite', 'tree-preservation': 'permittedCheck.note.treePreservation' };
    const CONDITION_KEYS = { 'no-harm-to-character': 'permittedCheck.condition.noHarmToCharacter' };
    const translated = (keys, code) => {
        const key = keys[code];
        const text = key ? root.i18n.t(key) : '';
        return text && text !== key ? text : code || '';
    };
    // `entry`: a check line or an item's restriction reference ({ effect, reasonCode, requirement,
    // subject, name, organisation }). The source's own name is kept as published.
    function restrictionText(entry) {
        const designation = translated(DESIGNATION_KEYS, entry.reasonCode);
        const organisation = typeof entry.organisation === 'string' ? entry.organisation : entry.organisation?.name || null;
        const place = entry.subject === 'existing-building' ? root.i18n.t('permittedCheck.placeBuilding', { designation, name: entry.name || '' })
            : !entry.name ? root.i18n.t('permittedCheck.placeUnnamed', { designation })
                : organisation ? root.i18n.t('permittedCheck.placeOf', { designation, name: entry.name, organisation })
                    : root.i18n.t('permittedCheck.place', { designation, name: entry.name });
        if (entry.effect === 'prohibit') return root.i18n.t(entry.subject === 'existing-building' ? 'permittedCheck.restriction.keep' : 'permittedCheck.restriction.prohibit', { place });
        if (entry.effect === 'restrict') return root.i18n.t('permittedCheck.restriction.restrict', { place, requirement: translated(REQUIREMENT_KEYS, entry.requirement) });
        return root.i18n.t('permittedCheck.restriction.note', { place, note: translated(NOTE_KEYS, entry.reasonCode) });
    }
    // A list item for one designation, its source linked to the publisher's record of it.
    function restrictionItem(entry, className) {
        const node = document.createElement('li');
        node.className = className;
        node.append(restrictionText(entry));
        if (entry.links?.record) {
            const link = document.createElement('a');
            link.href = entry.links.record; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.className = 'permitted-check__source-link';
            link.textContent = root.i18n.t('permittedCheck.sourceLink', { source: entry.sourceLabel || entry.source?.label || '' });
            node.append(' ', link);
        }
        return node;
    }
    const STATUS_KEYS = { fail: 'permittedCheck.status.fail', conditional: 'permittedCheck.status.conditional',
        unknown: 'permittedCheck.status.unknown', note: 'permittedCheck.status.note', pass: 'permittedCheck.status.pass', unavailable: 'permittedCheck.status.unavailable' };
    function valueText(value, unit) {
        const format = root.CbFormat;
        if (typeof value !== 'number' || !Number.isFinite(value)) return '';
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
            conditionalLimit: valueText(entry.conditionalLimit, entry.unit), condition: entry.condition || translated(CONDITION_KEYS, entry.conditionCode),
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
            if (entry.rule === 'restriction') { list.append(restrictionItem(entry, `permitted-check__rule permitted-check__rule--${entry.status}`)); continue; }
            const text = line(entry);
            if (!text) continue;
            const item = element('li', `permitted-check__rule permitted-check__rule--${entry.status}`, text);
            if (entry.rule === 'use' && entry.reason && entry.status !== 'pass') item.append(element('span', 'permitted-check__reason', entry.reason));
            list.append(item);
        }
        if (list.children.length) container.append(list);
        if (result.source?.label) container.append(element('p', 'permitted-check__source', root.i18n.t('permittedCheck.source', { source: result.source.label })));
    }
    root.PermittedAdvisor = { check, render, restrictionText, restrictionItem };
})(window);
