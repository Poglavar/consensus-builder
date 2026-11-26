// Loads the Permitted items under a design being edited and runs the rule check on them
// (planning/permitted-check.js), whether or not the Permitted layer is shown. Items come from the
// same /planning/representations feed as the layer, by the same cells, kept per source and cell.
// The planning designations of the city's rule sets (planning/restriction-feed.js) act on the items
// as they do on the layer: those that cut the envelope are read with geometry for the design's box
// (the layer's read), the others per building footprint without geometry, so a design in a flood
// zone of megabytes downloads a line of text.
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
    // Geometry-free reads run one design at a time, newest last: a drag asks again only once the
    // previous answer is in, and a superseded design asks nothing (generation).
    let memberships = Promise.resolve();
    async function membershipsFor(city, buildings, isCurrent) {
        const feed = root.PlanningRestrictionFeed;
        const previous = memberships;
        let release;
        memberships = new Promise(resolve => { release = resolve; });
        try {
            await previous;
            if (!isCurrent()) return null;
            const reads = await Promise.all(buildings.map(async building => ({ buildingId: building.id,
                reads: await feed.membership(city, building.footprint, { effects: ['restrict', 'note'] }) || [] })));
            return root.PlanningRestrictions.membershipRestrictions(reads, { geometryOps: root.turf });
        } finally { release(); }
    }
    async function itemsFor(city, bbox, buildings, isCurrent) {
        const feed = root.PlanningRestrictionFeed;
        const ruleSets = feed?.ruleSetIds(city).length ? true : false;
        const [base, reads, named] = await Promise.all([sourceItemsFor(city, bbox), ruleSets ? feed.load(city, bbox, { effects: ['prohibit'] }) : null,
            ruleSets ? membershipsFor(city, buildings, isCurrent) : null]);
        if (ruleSets && !named) return null;
        if (!reads) return { ...base, restrictions: [], partial: false, baseRule: null };
        const located = feed.resolve(reads, bbox);
        const restrictions = [...located.restrictions, ...named.restrictions], partial = located.partial || named.partial;
        const ruleSetList = reads.map(entry => entry.ruleSet);
        if (base.source) return { ...base, items: root.PlanningRestrictions.applyToItems(base.items, restrictions, { geometryOps: root.turf }),
            restrictions, partial, baseRule: null };
        return { source: { id: ruleSetList[0].id, label: ruleSetList.map(ruleSet => ruleSet.label).join(' · ') },
            items: root.PlanningRestrictions.unknownBaseItems(located.restrictions, ruleSetList), restrictions, partial, baseRule: 'unknown' };
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
    // The existing context relative rule terms read (planning/rule-terms.js), for the parcel the
    // design's first building stands on: its existing buildings, the street it faces and the
    // buildings of the lots along that street (planning/street-width.js streetSetting), from the
    // map's parcels and buildings and the street centrelines the Detached editor reads. Built only
    // when an item under the design states a relative term. Heights a source estimates stay unknown.
    const streetsByParcel = new Map();
    async function existingContextFor(design) {
        const turf = root.turf, fabric = root.LiveParcelFabric, footprint = design.buildings?.find(building => building.footprint)?.footprint;
        if (!footprint || !fabric?.peekBounds) return null;
        const [w, s, e, n] = turf.bbox(footprint), dLat = 80 / 110540, dLng = 80 / (111320 * Math.cos((s + n) / 2 * Math.PI / 180));
        const reach = [w - dLng, s - dLat, e + dLng, n + dLat];
        const lots = fabric.peekBounds(reach, { includeCorridors: false }).filter(piece => ['Polygon', 'MultiPolygon'].includes(piece?.geometry?.type))
            .map(piece => ({ type: 'Feature', id: piece.properties.parcelId, properties: {}, geometry: piece.geometry }));
        const overlap = lot => { try { const part = turf.intersect(lot, footprint); return part ? turf.area(part) : 0; } catch (_) { return 0; } };
        const parcel = lots.map(lot => ({ lot, m2: overlap(lot) })).filter(entry => entry.m2 > 0).sort((a, b) => b.m2 - a.m2)[0]?.lot;
        if (!parcel) return null;
        const pool = (root.buildingFeaturePool || []).filter(feature => {
            if (!feature?.geometry) return false;
            const box = turf.bbox(feature);
            return box[0] <= reach[2] && box[2] >= reach[0] && box[1] <= reach[3] && box[3] >= reach[1];
        });
        const inside = record => { try { return turf.booleanPointInPolygon(turf.pointOnFeature(record), parcel); } catch (_) { return false; } };
        if (!streetsByParcel.has(parcel.id)) streetsByParcel.set(parcel.id, root.StreetFrontage.streetsNear(parcel).then(answer => answer.streets)
            .catch(error => { streetsByParcel.delete(parcel.id); throw error; }));
        let streets = [];
        try { streets = await streetsByParcel.get(parcel.id); }
        catch (error) { console.error(`[${new Date().toISOString()}] [permitted-check] Streets could not be read; street terms stay unknown`, error); }
        const setting = root.PlanningStreetWidth.streetSetting({ parcel, streets, parcels: lots, buildings: pool, turf });
        const [buildings, neighbours] = await measuredHeights(pool.filter(inside), setting.neighbours);
        return root.PlanningRuleTerms.existingContext({ parcel, buildings, street: setting.street, neighbours, geometryOps: turf });
    }
    // The parcel's buildings and its neighbours with the heights a height survey measures in place of
    // their source's (buildings/height-survey-client.js), in one request window. Where a survey gives
    // none, each keeps its source's height.
    async function measuredHeights(buildings, neighbours) {
        const client = root.HeightSurveyClient, idOf = record => root.buildingPoolFeatureKey?.(record) || record.id;
        if (!client) return [buildings, neighbours];
        const own = buildings.length, all = [...buildings, ...(neighbours || [])];
        try {
            const filled = await client.fillHeights(all, { idOf });
            return [filled.slice(0, own), neighbours ? filled.slice(own) : neighbours];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [permitted-check] Building heights could not be measured; they stay unknown`, error);
            return [buildings, neighbours];
        }
    }
    const statesTerms = items => items.some(item => (item.constraints || []).some(constraint => constraint.term || constraint.when));
    let generation = 0;
    // `design` as PermittedCheck.check takes it, without items. Resolves to the result, or null when
    // a later call superseded this one. A source that cannot be read gives status 'unavailable'.
    async function check(design) {
        const id = ++generation;
        return run(design, { isCurrent: () => id === generation });
    }
    // A whole plan's buildings checked once, as Compare plans asks for each column: never superseded
    // by another check. `city` defaults to the map's.
    function checkPlan(design, { city = null } = {}) {
        return run(design, { isCurrent: () => true, city });
    }
    async function run(design, { isCurrent, city = null }) {
        const footprints = (design.buildings || []).map(building => building.footprint).filter(Boolean);
        if (!footprints.length) return { status: 'none', checks: [], buildings: {} };
        const bbox = root.turf.bbox(root.turf.featureCollection(footprints));
        city ||= root.CityConfigManager.getCurrentCityId();
        let loaded;
        let context = null;
        try {
            loaded = await itemsFor(city, bbox, design.buildings.filter(building => building.footprint), isCurrent);
            if (loaded && statesTerms(loaded.items)) context = await existingContextFor(design);
        }
        catch (error) {
            if (!isCurrent()) return null;
            console.error(`[${new Date().toISOString()}] [permitted-check] Permitted items could not be read`, error);
            return { status: 'unavailable', checks: [], buildings: {}, reason: error && error.message ? error.message : String(error) };
        }
        if (!loaded || !isCurrent()) return null;
        const result = root.PermittedCheck.check({ ...design, items: loaded.items, restrictions: loaded.restrictions,
            restrictionsPartial: loaded.partial, baseRule: loaded.baseRule, context, geometryOps: root.turf });
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
    root.PermittedAdvisor = { check, checkPlan, render, restrictionText, restrictionItem, existingContextFor };
})(window);
