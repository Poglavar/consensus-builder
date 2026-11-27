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
    // A ring list as WKT, coordinates to 7 decimals (about 1 cm).
    const wktPoint = ([x, y]) => `${Number(x.toFixed(7))} ${Number(y.toFixed(7))}`;
    const wktPolygon = rings => `(${rings.map(ring => `(${ring.map(wktPoint).join(',')})`).join(',')})`;
    function wkt(geometry) {
        if (geometry?.type === 'Polygon') return `POLYGON${wktPolygon(geometry.coordinates)}`;
        if (geometry?.type === 'MultiPolygon') return `MULTIPOLYGON(${geometry.coordinates.map(wktPolygon).join(',')})`;
        throw fail('constraint-source-geometry', 'A constraint read needs a Polygon or MultiPolygon.');
    }
    // Every page of one query, following `links.next` up to the source's page cap.
    async function planningDataPages(source, url, { fetch, signal, rows }) {
        const origin = url.origin, found = [];
        let next = url.toString(), pages = 0, partial = false;
        while (next) {
            if (pages >= source.maxPages) { partial = true; break; }
            signal?.throwIfAborted?.();
            const response = await fetch(next, { signal });
            if (!response.ok) throw fail('constraint-source-http', `Constraint source HTTP ${response.status}`);
            const page = await response.json();
            const list = rows(page);
            if (!Array.isArray(list)) throw fail('constraint-source-invalid', 'Invalid constraint source page');
            pages++;
            found.push(...list);
            const link = page.links?.next || null;
            // Only the publisher's own next page is followed.
            if (link && new URL(link).origin !== origin) throw fail('constraint-source-invalid', 'Constraint source paged elsewhere');
            next = link;
        }
        return { found, partial, pages };
    }
    // Source records as areas; `geometry` is null for a read that asked for no geometry.
    async function planningDataRecords(source, records, { fetch, signal, asOf }) {
        const current = records.filter(entry => entry?.properties && !(entry.properties['end-date'] && entry.properties['end-date'] <= asOf));
        const organisations = await planningDataOrganisations(source,
            [...new Set(current.map(entry => entry.properties['organisation-entity']).filter(value => value !== '' && value != null)
                .map(Number).filter(Number.isFinite))], { fetch, signal });
        return current.map(entry => {
            const p = entry.properties;
            return {
                id: `${source.id}:${p.entity}`, sourceId: source.id, dataset: p.dataset, entity: p.entity,
                reference: p.reference || null, name: p.name || null, geometry: entry.geometry || null,
                organisation: { id: p['organisation-entity'] ?? null, name: organisations.get(Number(p['organisation-entity'])) ?? null },
                // Source fields kept as the publisher states them, for rule-set matching and display.
                fields: Object.fromEntries(Object.entries(p).filter(([, value]) => value !== '' && value !== null)),
                links: { record: new URL(`/entity/${p.entity}`, source.endpoint).toString(), documentation: p['documentation-url'] || null }
            };
        });
    }
    const queryUrl = (source, path, datasets, geometry) => {
        const url = new URL(path, source.endpoint);
        for (const dataset of datasets) url.searchParams.append('dataset', dataset);
        url.searchParams.set('geometry', wkt(geometry));
        url.searchParams.set('geometry_relation', 'intersects');
        url.searchParams.set('limit', String(source.pageSize));
        return url;
    };
    // The designations over a box, with their geometry (the map cuts envelopes with it).
    async function planningDataAreas(source, { bbox, datasets, fetch, signal, asOf = today() }) {
        const [w, s, e, n] = bbox;
        const url = queryUrl(source, '/entity.geojson', datasets, { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
        const { found, partial, pages } = await planningDataPages(source, url, { fetch, signal, rows: page => page?.type === 'FeatureCollection' ? page.features : null });
        const areas = await planningDataRecords(source, found.filter(feature => feature?.geometry), { fetch, signal, asOf });
        return { areas, partial, pages };
    }
    // The designations a geometry (a building footprint, a parcel) lies in, without their
    // geometry: the publisher tests the intersection, so a flood zone of megabytes costs a line.
    // (`field=` lists lose organisation-entity there, so the geometry fields are excluded instead.)
    async function planningDataMembership(source, { geometry, datasets, fetch, signal, asOf = today() }) {
        const url = queryUrl(source, '/entity.json', datasets, geometry);
        for (const field of ['geometry', 'point']) url.searchParams.append('exclude_field', field);
        const { found, partial, pages } = await planningDataPages(source, url, { fetch, signal, rows: page => page?.entities });
        const areas = await planningDataRecords(source, found.map(properties => ({ properties, geometry: null })), { fetch, signal, asOf });
        return { areas, partial, pages };
    }
    // The records an organisation publishes in another dataset (the Article 4 directions an area
    // names), without geometry; one paged query per organisation, kept for the session.
    const linkedRecords = new Map();
    function planningDataLinked(source, { dataset, organisationId, fetch, signal }) {
        const key = `${dataset}:${organisationId}`;
        if (!linkedRecords.has(key)) {
            const url = new URL('/entity.json', source.endpoint);
            url.searchParams.set('dataset', dataset);
            url.searchParams.set('organisation_entity', String(organisationId));
            for (const field of ['geometry', 'point']) url.searchParams.append('exclude_field', field);
            url.searchParams.set('limit', String(source.pageSize));
            const pending = planningDataPages(source, url, { fetch, signal, rows: page => page?.entities }).then(({ found }) => found);
            linkedRecords.set(key, pending);
            pending.catch(() => linkedRecords.delete(key));
        }
        return linkedRecords.get(key);
    }
    const adapters = Object.freeze({ 'planning-data-entity': Object.freeze({ areas: planningDataAreas, membership: planningDataMembership, linked: planningDataLinked }) });

    // One read of a constraint source for a box. Returns { areas, partial, pages }: `partial` means
    // the page cap stopped the read and more areas exist than were read.
    async function readAreas(source, { bbox, datasets, fetch: fetchPage = typeof fetch === 'function' ? fetch : null, signal, asOf } = {}) {
        const adapter = adapters[source?.adapter];
        if (!adapter) throw fail('constraint-source-unknown', `Unknown constraint source adapter: ${source?.adapter}`);
        if (!finiteBox(bbox)) throw fail('constraint-source-bbox', 'A constraint read needs a finite [west, south, east, north] box.');
        if (!Array.isArray(datasets) || !datasets.length) return { areas: [], partial: false, pages: 0 };
        if (typeof fetchPage !== 'function') throw fail('constraint-source-fetch', 'A constraint read needs fetch.');
        if (!(source.pageSize > 0) || !(source.maxPages > 0)) throw fail('constraint-source-config', 'A constraint source needs pageSize and maxPages.');
        return adapter.areas(source, { bbox, datasets, fetch: fetchPage, signal, asOf });
    }
    // Which designations of `datasets` a polygon lies in (no geometry returned).
    // Returns { areas (geometry null), partial, pages }.
    async function readMembership(source, { geometry, datasets, fetch: fetchPage = typeof fetch === 'function' ? fetch : null, signal, asOf } = {}) {
        const adapter = adapters[source?.adapter];
        if (!adapter) throw fail('constraint-source-unknown', `Unknown constraint source adapter: ${source?.adapter}`);
        if (!Array.isArray(datasets) || !datasets.length) return { areas: [], partial: false, pages: 0 };
        if (typeof fetchPage !== 'function') throw fail('constraint-source-fetch', 'A constraint read needs fetch.');
        return adapter.membership(source, { geometry, datasets, fetch: fetchPage, signal, asOf });
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
    // References compared without case or punctuation: a publisher may write one direction
    // "D_43_BEX_ART4_00013" on its area and "D_43_BEX__ART4_00013" on the direction itself.
    const plainReference = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // The areas of a read with the record each links to (a rule-set entry's `removedRights.linked`:
    // the dataset and the area field naming the record's reference, within the area's organisation)
    // as `linked`, null when the organisation publishes none under that reference. A failed lookup
    // is logged and leaves `linked` unset: what the record says stays unread, never "nothing".
    async function withLinked(source, ruleSet, answer, { fetch: fetchPage, signal } = {}) {
        const links = (ruleSet.effects || []).filter(entry => entry.removedRights?.linked)
            .map(entry => ({ areaDataset: entry.dataset, dataset: entry.removedRights.linked.dataset, field: entry.removedRights.linked.field }));
        const adapter = adapters[source?.adapter];
        if (!links.length || !adapter?.linked || !answer?.areas?.length) return answer;
        const found = new Map();
        for (const link of links) {
            const organisations = [...new Set(answer.areas.filter(area => area.dataset === link.areaDataset && area.fields?.[link.field])
                .map(area => Number(area.organisation?.id)).filter(Number.isFinite))];
            await Promise.all(organisations.map(async organisationId => {
                try {
                    const records = await adapter.linked(source, { dataset: link.dataset, organisationId, fetch: fetchPage, signal });
                    found.set(`${link.areaDataset}:${organisationId}`, new Map(records.map(record => [plainReference(record.reference), record])));
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] [constraint-sources] Linked ${link.dataset} records of organisation ${organisationId} could not be read; their rights stay unread`, error);
                }
            }));
        }
        const areas = answer.areas.map(area => {
            const link = links.find(entry => entry.areaDataset === area.dataset);
            const reference = link && area.fields?.[link.field];
            const records = reference ? found.get(`${link.areaDataset}:${Number(area.organisation?.id)}`) : null;
            return records ? { ...area, linked: records.get(plainReference(reference)) || null } : area;
        });
        return { ...answer, areas };
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
                const entry = hit || await cache.load(scope, box, abort => readAreas(source, { bbox: box, datasets, fetch: fetchPage, signal: abort })
                    .then(answer => withLinked(source, ruleSet, answer, { fetch: fetchPage, signal: abort })));
                return { ruleSet, source, ...entry.value, bbox: entry.bbox };
            }));
            return reads;
        }
        // Which designations one polygon lies in, per rule set, without geometry; kept per polygon.
        const memberships = new Map();
        async function membership(ruleSetIds, geometry, { effects = null } = {}) {
            const pairs = ruleSetsFor(config, ruleSetIds);
            if (!pairs.length) return null;
            return Promise.all(pairs.map(async ({ ruleSet, source }) => {
                const datasets = datasetsOf(ruleSet, effects);
                const key = `${ruleSet.id}:${datasets.join(',')}:${JSON.stringify(geometry.coordinates)}`;
                if (!memberships.has(key)) {
                    const pending = readMembership(source, { geometry, datasets, fetch: fetchPage })
                        .then(answer => withLinked(source, ruleSet, answer, { fetch: fetchPage }));
                    memberships.set(key, pending);
                    pending.catch(() => memberships.delete(key));
                    while (memberships.size > 256) memberships.delete(memberships.keys().next().value);
                }
                return { ruleSet, source, ...(await memberships.get(key)) };
            }));
        }
        return { load, membership, clear: () => { cache.clear(); memberships.clear(); } };
    }
    return { adapters, readAreas, readMembership, withLinked, wkt, ruleSetsFor, datasetsOf, effectsOf, createLoader };
});
