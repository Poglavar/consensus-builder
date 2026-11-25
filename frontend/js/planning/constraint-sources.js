// Constraint sources: datasets of areas where planning designations apply (conservation areas,
// listed buildings, flood zones…), read for a bounding box through one adapter per publisher. The
// rule set of a place (planning-sources.json `ruleSets`) says which datasets to read and what each
// one does to Permitted (planning/restrictions.js). The same code runs in the browser, which asks
// the publisher directly, and in node (MCP), with `fetch` passed in. No persistent cache: callers
// keep answers per view (createLoader).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningConstraintSources = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const finiteBox = bbox => Array.isArray(bbox) && bbox.length === 4 && bbox.every(value => typeof value === 'number' && Number.isFinite(value))
        && bbox[0] < bbox[2] && bbox[1] < bbox[3];
    const today = () => new Date().toISOString().slice(0, 10);

    // planning.data.gov.uk entity API (England): one paged GeoJSON query for every dataset at once,
    // following `links.next` up to the source's page cap; then one lookup naming the organisations.
    // An entity whose `end-date` has passed no longer applies and is left out.
    const organisationNames = new Map();
    async function planningDataOrganisations(source, ids, { fetch, signal }) {
        const missing = ids.filter(id => !organisationNames.has(id));
        if (missing.length) {
            const url = new URL('/entity.json', source.endpoint);
            for (const id of missing) url.searchParams.append('entity', String(id));
            for (const field of ['entity', 'name']) url.searchParams.append('field', field);
            url.searchParams.set('limit', String(missing.length));
            const response = await fetch(url.toString(), { signal });
            if (!response.ok) throw fail('constraint-source-http', `Constraint source organisations HTTP ${response.status}`);
            for (const row of (await response.json()).entities || []) organisationNames.set(Number(row.entity), row.name || null);
        }
        return new Map(ids.map(id => [id, organisationNames.get(id) ?? null]));
    }
    async function planningDataAreas(source, { bbox, datasets, fetch, signal, asOf = today() }) {
        const [w, s, e, n] = bbox;
        const url = new URL('/entity.geojson', source.endpoint);
        for (const dataset of datasets) url.searchParams.append('dataset', dataset);
        url.searchParams.set('geometry', `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`);
        url.searchParams.set('geometry_relation', 'intersects');
        url.searchParams.set('limit', String(source.pageSize));
        const origin = url.origin, features = [];
        let next = url.toString(), pages = 0, partial = false;
        while (next) {
            if (pages >= source.maxPages) { partial = true; break; }
            signal?.throwIfAborted?.();
            const response = await fetch(next, { signal });
            if (!response.ok) throw fail('constraint-source-http', `Constraint source HTTP ${response.status}`);
            const page = await response.json();
            if (page?.type !== 'FeatureCollection' || !Array.isArray(page.features)) throw fail('constraint-source-invalid', 'Invalid constraint source page');
            pages++;
            features.push(...page.features);
            const link = page.links?.next || null;
            // Only the publisher's own next page is followed.
            if (link && new URL(link).origin !== origin) throw fail('constraint-source-invalid', 'Constraint source paged elsewhere');
            next = link;
        }
        const current = features.filter(feature => feature?.geometry && feature.properties
            && !(feature.properties['end-date'] && feature.properties['end-date'] <= asOf));
        const organisations = await planningDataOrganisations(source,
            [...new Set(current.map(feature => Number(feature.properties['organisation-entity'])).filter(Number.isFinite))], { fetch, signal });
        const areas = current.map(feature => {
            const p = feature.properties;
            return {
                id: `${source.id}:${p.entity}`, sourceId: source.id, dataset: p.dataset, entity: p.entity,
                reference: p.reference || null, name: p.name || null, geometry: feature.geometry,
                organisation: { id: p['organisation-entity'] ?? null, name: organisations.get(Number(p['organisation-entity'])) ?? null },
                // Source fields kept as the publisher states them, for rule-set matching and display.
                fields: Object.fromEntries(Object.entries(p).filter(([, value]) => value !== '' && value !== null)),
                links: { record: new URL(`/entity/${p.entity}`, source.endpoint).toString(), documentation: p['documentation-url'] || null }
            };
        });
        return { areas, partial, pages };
    }
    const adapters = Object.freeze({ 'planning-data-entity': planningDataAreas });

    // One read of a constraint source for a box. Returns { areas, partial, pages }: `partial` means
    // the page cap stopped the read and more areas exist than were read.
    async function readAreas(source, { bbox, datasets, fetch: fetchPage = typeof fetch === 'function' ? fetch : null, signal, asOf } = {}) {
        const adapter = adapters[source?.adapter];
        if (!adapter) throw fail('constraint-source-unknown', `Unknown constraint source adapter: ${source?.adapter}`);
        if (!finiteBox(bbox)) throw fail('constraint-source-bbox', 'A constraint read needs a finite [west, south, east, north] box.');
        if (!Array.isArray(datasets) || !datasets.length) return { areas: [], partial: false, pages: 0 };
        if (typeof fetchPage !== 'function') throw fail('constraint-source-fetch', 'A constraint read needs fetch.');
        if (!(source.pageSize > 0) || !(source.maxPages > 0)) throw fail('constraint-source-config', 'A constraint source needs pageSize and maxPages.');
        return adapter(source, { bbox, datasets, fetch: fetchPage, signal, asOf });
    }

    // The rule sets and constraint sources a place uses, from planning-sources.json and the city's
    // `planning.ruleSetIds`. A rule set naming a missing constraint source is a configuration error.
    function ruleSetsFor(config, ruleSetIds = []) {
        return ruleSetIds.map(id => {
            const ruleSet = (config?.ruleSets || []).find(entry => entry.id === id);
            if (!ruleSet) throw fail('rule-set-unknown', `Unknown rule set: ${id}`);
            const source = (config.constraintSources || []).find(entry => entry.id === ruleSet.constraintSourceId);
            if (!source) throw fail('constraint-source-unknown', `Rule set ${id} names an unknown constraint source.`);
            return { ruleSet, source };
        });
    }
    const effectsOf = (ruleSet, effects) => (ruleSet.effects || []).filter(entry => !effects || effects.includes(entry.effect));
    const datasetsOf = (ruleSet, effects) => [...new Set(effectsOf(ruleSet, effects).map(entry => entry.dataset))];

    // Reads per view, kept by containment in a viewport cache (planning/scene.js createViewportCache):
    // a pan inside an answered box asks for nothing. Boxes are snapped outward to the viewport grid so
    // nearby views share answers. `effects` limits the datasets read to those a rule set gives those
    // effects (the map needs only what cuts the envelope; the check needs every reason).
    function createLoader({ config, scene, fetch: fetchPage, limit = 32, maxAgeMs = 10 * 60 * 1000 } = {}) {
        if (!scene?.createViewportCache) throw new TypeError('A constraint loader needs the planning scene helpers.');
        const cache = scene.createViewportCache({ limit, maxAgeMs });
        async function load(ruleSetIds, bbox, { effects = null } = {}) {
            const pairs = ruleSetsFor(config, ruleSetIds);
            if (!pairs.length) return null;
            const box = scene.snapBbox(bbox, scene.viewportCellSize(bbox));
            const reads = await Promise.all(pairs.map(async ({ ruleSet, source }) => {
                const datasets = datasetsOf(ruleSet, effects);
                const scope = `${ruleSet.id}:${source.id}:${datasets.join(',')}`;
                const hit = cache.find(scope, box);
                const entry = hit || await cache.load(scope, box, abort => readAreas(source, { bbox: box, datasets, fetch: fetchPage, signal: abort }));
                return { ruleSet, source, ...entry.value, bbox: entry.bbox };
            }));
            return reads;
        }
        return { load, clear: () => cache.clear() };
    }
    return { adapters, readAreas, ruleSetsFor, datasetsOf, effectsOf, createLoader };
});
