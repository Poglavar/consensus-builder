// Load a complete viewport from bounded source pages. No persistent or cross-viewport cache.
// Also provides lossless wire compaction/hydration so per-source descriptors, decree rules,
// repeated constraint sets and identical volume geometries are sent once per response.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningFeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

    function compactSource(source, base) {
        if (!isPlainObject(source) || !isPlainObject(base)) return source;
        const diff = { id: source.id };
        for (const [key, value] of Object.entries(source)) {
            if (key === 'id') continue;
            if (JSON.stringify(value) !== JSON.stringify(base[key])) diff[key] = value;
        }
        return diff;
    }

    function compactAnswer(answer) {
        if (!isPlainObject(answer) || answer.schemaVersion !== 'planning-representations.v1' || !Array.isArray(answer.items) || !answer.items.length) {
            return answer;
        }
        const bySourceId = new Map((answer.sources || []).filter(s => s?.id).map(s => [s.id, s]));
        const rules = [], rulesIndex = new Map();
        const constraints = [], constraintsIndex = new Map();
        const sourceReferences = [], sourceRefIndex = new Map();
        const intern = (list, index, value) => {
            const key = JSON.stringify(value);
            let id = index.get(key);
            if (id === undefined) { id = list.length; list.push(value); index.set(key, id); }
            return id;
        };
        const items = answer.items.map(item => {
            if (!isPlainObject(item)) return item;
            let next = item;
            if (item.source?.id && bySourceId.has(item.source.id)) {
                next = { ...next, source: compactSource(item.source, bySourceId.get(item.source.id)) };
            }
            if (isPlainObject(item.sourceEvidence) && isPlainObject(item.sourceEvidence.rules)) {
                const { rules: itemRules, ...restEvidence } = item.sourceEvidence;
                next = { ...next, sourceEvidence: { ...restEvidence, rulesRef: intern(rules, rulesIndex, itemRules) } };
            }
            const volGeomIndex = new Map();
            if (Array.isArray(item.volumes)) {
                item.volumes.forEach((volume, idx) => {
                    if (volume?.geometry) volGeomIndex.set(JSON.stringify(volume.geometry), idx);
                });
            }
            if (item.site && volGeomIndex.size) {
                const siteRef = volGeomIndex.get(JSON.stringify(item.site));
                if (siteRef !== undefined) {
                    const { site: _droppedSite, ...restItem } = next;
                    next = { ...restItem, siteRef };
                }
            }
            if (isPlainObject(item.derivation) && item.derivation.parcel && item.derivation.covered
                && JSON.stringify(item.derivation.parcel) === JSON.stringify(item.derivation.covered)) {
                const { covered: _droppedCovered, ...restDerivation } = item.derivation;
                next = { ...next, derivation: { ...restDerivation, coveredSameAsParcel: true } };
            }
            if (Array.isArray(item.configurations) && item.configurations.length) {
                const compactedConfigs = item.configurations.map(cfg => {
                    if (!isPlainObject(cfg)) return cfg;
                    let nextCfg = cfg;
                    if (Array.isArray(cfg.constraints) && cfg.constraints.length) {
                        const { constraints: cfgConstraints, ...restCfg } = nextCfg;
                        nextCfg = { ...restCfg, constraintsRef: intern(constraints, constraintsIndex, cfgConstraints) };
                    }
                    if (isPlainObject(nextCfg.sourceReference)) {
                        const { sourceReference, ...restCfg } = nextCfg;
                        nextCfg = { ...restCfg, sourceReferenceRef: intern(sourceReferences, sourceRefIndex, sourceReference) };
                    }
                    if (Array.isArray(nextCfg.volumes) && nextCfg.volumes.length && volGeomIndex.size) {
                        let changed = false;
                        const vols = nextCfg.volumes.map(vol => {
                            if (!vol?.geometry) return vol;
                            const ref = volGeomIndex.get(JSON.stringify(vol.geometry));
                            if (ref === undefined) return vol;
                            changed = true;
                            const { geometry: _dropped, ...restVol } = vol;
                            return { ...restVol, geometryRef: ref };
                        });
                        if (changed) nextCfg = { ...nextCfg, volumes: vols };
                    }
                    return nextCfg;
                });
                next = { ...next, configurations: compactedConfigs };
            }
            return next;
        });
        const shared = {};
        if (rules.length) shared.rules = rules;
        if (constraints.length) shared.constraints = constraints;
        if (sourceReferences.length) shared.sourceReferences = sourceReferences;
        return Object.keys(shared).length ? { ...answer, shared, items } : { ...answer, items };
    }

    function hydrateAnswer(answer) {
        if (!isPlainObject(answer) || !Array.isArray(answer.items)) return answer;
        const bySourceId = new Map((answer.sources || []).filter(s => s?.id).map(s => [s.id, s]));
        const sharedRules = Array.isArray(answer.shared?.rules) ? answer.shared.rules : null;
        const sharedConstraints = Array.isArray(answer.shared?.constraints) ? answer.shared.constraints : null;
        const sharedSourceRefs = Array.isArray(answer.shared?.sourceReferences) ? answer.shared.sourceReferences : null;
        const items = answer.items.map(item => {
            if (!isPlainObject(item)) return item;
            let next = item;
            if (item.source?.id && bySourceId.has(item.source.id)) {
                next = { ...next, source: { ...bySourceId.get(item.source.id), ...item.source } };
            }
            if (sharedRules && isPlainObject(next.sourceEvidence) && Number.isInteger(next.sourceEvidence.rulesRef)) {
                const { rulesRef, ...restEvidence } = next.sourceEvidence;
                if (sharedRules[rulesRef] !== undefined) next = { ...next, sourceEvidence: { ...restEvidence, rules: sharedRules[rulesRef] } };
            }
            if (Number.isInteger(next.siteRef) && Array.isArray(next.volumes) && next.volumes[next.siteRef]?.geometry) {
                const { siteRef, ...restItem } = next;
                next = { ...restItem, site: next.volumes[siteRef].geometry };
            }
            if (isPlainObject(next.derivation) && next.derivation.coveredSameAsParcel && next.derivation.parcel) {
                const { coveredSameAsParcel: _flag, ...restDerivation } = next.derivation;
                next = { ...next, derivation: { ...restDerivation, covered: next.derivation.parcel } };
            }
            if (Array.isArray(next.configurations) && next.configurations.length) {
                let changedConfig = false;
                const hydratedConfigs = next.configurations.map(cfg => {
                    if (!isPlainObject(cfg)) return cfg;
                    let nextCfg = cfg;
                    if (sharedConstraints && Number.isInteger(nextCfg.constraintsRef)) {
                        const { constraintsRef, ...restCfg } = nextCfg;
                        if (sharedConstraints[constraintsRef] !== undefined) {
                            nextCfg = { ...restCfg, constraints: sharedConstraints[constraintsRef] };
                            changedConfig = true;
                        }
                    }
                    if (sharedSourceRefs && Number.isInteger(nextCfg.sourceReferenceRef)) {
                        const { sourceReferenceRef, ...restCfg } = nextCfg;
                        if (sharedSourceRefs[sourceReferenceRef] !== undefined) {
                            nextCfg = { ...restCfg, sourceReference: sharedSourceRefs[sourceReferenceRef] };
                            changedConfig = true;
                        }
                    }
                    if (Array.isArray(nextCfg.volumes) && Array.isArray(next.volumes)) {
                        let changedVol = false;
                        const vols = nextCfg.volumes.map(vol => {
                            if (!isPlainObject(vol) || !Number.isInteger(vol.geometryRef)) return vol;
                            const refGeom = next.volumes[vol.geometryRef]?.geometry;
                            if (!refGeom) return vol;
                            changedVol = true;
                            const { geometryRef: _ref, ...restVol } = vol;
                            return { ...restVol, geometry: refGeom };
                        });
                        if (changedVol) { nextCfg = { ...nextCfg, volumes: vols }; changedConfig = true; }
                    }
                    return nextCfg;
                });
                if (changedConfig) next = { ...next, configurations: hydratedConfigs };
            }
            return next;
        });
        if (!answer.shared) return { ...answer, items };
        const { shared: _shared, ...rest } = answer;
        return { ...rest, items };
    }

    async function loadViewport(url, { city, signal, fetchPage = fetch, readJson = response => response.json(), onProgress = () => {}, body } = {}) {
        const items = new Map(), summaries = new Map(), cursors = new Set();
        const pageUrl = new URL(url);
        let cursor = null, omitted = 0, answer;
        do {
            signal?.throwIfAborted();
            if (cursor) pageUrl.searchParams.set('cursor', cursor);
            const init = { signal, cache: 'no-store' };
            if (body) { init.method = 'POST'; init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
            const response = await fetchPage(pageUrl.toString(), init);
            if (!response.ok) throw Object.assign(new Error(`Planning source HTTP ${response.status}`), { status: response.status });
            answer = hydrateAnswer(await readJson(response));
            signal?.throwIfAborted();
            if (answer.schemaVersion !== 'planning-representations.v1' || answer.city !== city || !Array.isArray(answer.items)
                || (answer.nextCursor !== null && typeof answer.nextCursor !== 'string')
                || Boolean(answer.truncated) !== Boolean(answer.nextCursor)) throw new Error('Invalid planning representation response');
            for (const item of answer.items) items.set(item.id, item);
            for (const summary of answer.summaries || []) summaries.set(summary.sourceId, summary);
            omitted += answer.omitted || 0;
            cursor = answer.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error('Repeated planning cursor');
            if (cursor) cursors.add(cursor);
            onProgress({ count: items.size + omitted, total: [...summaries.values()].reduce((sum, entry) => sum + entry.withGeometry, 0) });
        } while (cursor);
        return { ...answer, items: [...items.values()], summaries: [...summaries.values()], omitted };
    }
    return { loadViewport, compactAnswer, hydrateAnswer };
});
