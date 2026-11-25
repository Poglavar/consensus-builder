// The restrictions stage of Permitted: after a base rule has given each parcel or zone its
// Permitted item, the planning designations over it (planning/constraint-sources.js) act on it with
// one of three effects, which the place's rule set assigns per dataset: `prohibit` removes the
// designated area from the envelope, `restrict` keeps the envelope and attaches a requirement, and
// `note` only gives the Permitted check a reason line. Where no base rule exists the stage still
// runs: Permitted is then "unknown base, known designations" (unknownBaseItems). Pure: geometry
// operations (turf 6) are passed in, so the browser and node (MCP) run the same code.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningRestrictions = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const EFFECTS = Object.freeze(['prohibit', 'restrict', 'note']);
    // A cut or overlap smaller than this (m²) is digitising noise along a shared edge.
    const MIN_M2 = 0.5;
    const polygonal = geometry => geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
    const boxesMeet = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

    // The rule-set entry for one area: the first whose dataset matches and whose `where` (a source
    // field and the values it may take) holds. Null when the rule set gives the area no effect.
    function classify(area, ruleSet) {
        for (const entry of ruleSet?.effects || []) {
            if (entry.dataset !== area.dataset) continue;
            if (entry.where && !entry.where.in.includes(String(area.fields?.[entry.where.field] ?? ''))) continue;
            if (!EFFECTS.includes(entry.effect)) throw new Error(`Rule set ${ruleSet.id} gives ${entry.dataset} an unknown effect: ${entry.effect}`);
            return entry;
        }
        return null;
    }
    // The footprint of an existing building containing a point, from the building sources the view
    // or the server holds: `buildings` are GeoJSON features. Null when none contains it.
    const buildingBoxes = new WeakMap();
    function buildingAt(point, buildings, ops) {
        for (const building of buildings || []) {
            if (!polygonal(building?.geometry)) continue;
            let box = buildingBoxes.get(building);
            if (!box) { box = ops.bbox(building); buildingBoxes.set(building, box); }
            if (point[0] < box[0] || point[0] > box[2] || point[1] < box[1] || point[1] > box[3]) continue;
            try { if (ops.booleanPointInPolygon(point, building)) return building; } catch (_) { /* a broken footprint contains nothing */ }
        }
        return null;
    }
    const buildingIdOf = feature => String(feature.id ?? feature.properties?.id ?? feature.properties?.osm_id ?? '');

    // Restrictions from constraint reads ([{ ruleSet, source, areas, partial }], constraint-sources.js
    // createLoader). A designation of an existing building given as a point (`subject:
    // "existing-building"`) takes the footprint of the building containing it; with none, it stays a
    // point and its footprint is unknown. A point the rule set says is also published as an outline
    // (`sameAs`) is dropped where that outline was read.
    function restrictionsFor(reads, { buildings = [], geometryOps } = {}) {
        if (!geometryOps) throw new TypeError('Restrictions need geometry operations.');
        const restrictions = [];
        let partial = false;
        for (const { ruleSet, source, areas = [], partial: readPartial } of reads || []) {
            partial = partial || Boolean(readPartial);
            const outlines = new Map();
            for (const entry of ruleSet.effects || []) if (entry.sameAs) {
                const values = new Set(areas.filter(area => area.dataset === entry.sameAs.dataset)
                    .map(area => String(area.fields?.[entry.sameAs.field] ?? '')).filter(Boolean));
                outlines.set(entry.dataset, values);
            }
            for (const area of areas) {
                const entry = classify(area, ruleSet);
                if (!entry) continue;
                if (entry.sameAs && outlines.get(entry.dataset)?.has(String(area.reference))) continue;
                let geometry = area.geometry, footprint = 'source', building = null;
                if (geometry?.type === 'Point' && entry.subject === 'existing-building') {
                    const found = buildingAt(geometry.coordinates, buildings, geometryOps);
                    if (found) { geometry = found.geometry; footprint = 'building'; building = { id: buildingIdOf(found), source: found.properties?.source ?? null }; }
                    else footprint = 'unknown';
                }
                restrictions.push({
                    id: area.id, ruleSetId: ruleSet.id, sourceId: source.id, dataset: area.dataset, entity: area.entity,
                    reference: area.reference, name: area.name, organisation: area.organisation,
                    effect: entry.effect, reasonCode: entry.reasonCode, requirement: entry.requirement || null,
                    subject: entry.subject || 'land', geometry, footprint, building, fields: area.fields, links: area.links,
                    source: { id: source.id, label: source.label, licence: source.licence || null, attribution: source.attribution || null }
                });
            }
        }
        return { restrictions, partial };
    }

    // A reference to a restriction kept on an item (no geometry: the restriction list has it).
    const refOf = (restriction, extra = {}) => ({ id: restriction.id, effect: restriction.effect, reasonCode: restriction.reasonCode,
        requirement: restriction.requirement, subject: restriction.subject, dataset: restriction.dataset, name: restriction.name,
        organisation: restriction.organisation?.name || null, footprint: restriction.footprint, links: restriction.links,
        sourceLabel: restriction.source?.label || null, ...extra });
    function geometriesOf(item) {
        return [...(item.areas || []).map(area => area.geometry), ...(item.volumes || []).map(volume => volume.geometry),
            ...(item.configurations || []).flatMap(configuration => (configuration.volumes || []).map(volume => volume.geometry))].filter(polygonal);
    }
    function overlapM2(a, b, ops) {
        const part = ops.intersect(ops.feature(a), ops.feature(b));
        return part ? ops.area(part) : 0;
    }
    // `geometry` without every prohibited area: { geometry (null when nothing is left), removed: Map(id → m²) }.
    function cut(geometry, prohibits, ops) {
        let remaining = ops.feature(geometry);
        const removed = new Map(), box = ops.bbox(geometry);
        for (const restriction of prohibits) {
            if (!remaining) break;
            if (!boxesMeet(restriction.box, box)) continue;
            const before = ops.area(remaining);
            remaining = ops.difference(remaining, ops.feature(restriction.geometry));
            const lost = before - (remaining ? ops.area(remaining) : 0);
            if (lost >= MIN_M2) removed.set(restriction.id, (removed.get(restriction.id) || 0) + lost);
        }
        return { geometry: remaining?.geometry || null, removed };
    }
    // Every Permitted item with prohibited areas cut out of its zone areas and volumes, and a
    // reference to each restriction over it (`restrictions`, with `cutM2` where land was removed).
    // A configuration whose volumes are all cut away becomes unavailable for reason `restricted`;
    // a cut configuration's floor area is no longer the source's figure and becomes unknown (null).
    function applyToItems(items, restrictions, { geometryOps: ops } = {}) {
        if (!ops) throw new TypeError('Restrictions need geometry operations.');
        const located = (restrictions || []).filter(restriction => restriction.geometry)
            .map(restriction => ({ ...restriction, box: ops.bbox(restriction.geometry) }));
        if (!located.length) return items;
        return (items || []).map(item => {
            if (item?.role !== 'permitted') return item;
            const geometries = geometriesOf(item);
            if (!geometries.length) return item;
            const box = geometries.map(geometry => ops.bbox(geometry))
                .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
            const near = located.filter(restriction => boxesMeet(restriction.box, box));
            if (!near.length) return item;
            const over = near.filter(restriction => geometries.some(geometry => {
                try {
                    return restriction.geometry.type === 'Point'
                        ? ops.booleanPointInPolygon(restriction.geometry.coordinates, ops.feature(geometry))
                        : overlapM2(geometry, restriction.geometry, ops) >= MIN_M2;
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] [restrictions] Overlap test failed`, item.id, restriction.id, error);
                    return true;
                }
            }));
            if (!over.length) return item;
            const prohibits = over.filter(restriction => restriction.effect === 'prohibit' && polygonal(restriction.geometry));
            const cutM2 = new Map(), failed = new Set();
            const apply = (geometry, count) => {
                try {
                    const result = cut(geometry, prohibits, ops);
                    if (count) for (const [id, m2] of result.removed) cutM2.set(id, Math.max(cutM2.get(id) || 0, m2));
                    return result;
                } catch (error) {
                    // A failed clip is never taken to mean nothing was cut: the restriction says so.
                    console.error(`[${new Date().toISOString()}] [restrictions] Cut failed`, item.id, error);
                    prohibits.forEach(restriction => failed.add(restriction.id));
                    return { geometry, removed: new Map() };
                }
            };
            const next = { ...item };
            if (prohibits.length) {
                if (item.areas?.length) next.areas = item.areas.map(area => ({ ...area, geometry: apply(area.geometry, true).geometry })).filter(area => area.geometry);
                if (item.volumes?.length) next.volumes = item.volumes.map(volume => ({ ...volume, geometry: apply(volume.geometry, !item.areas?.length && volume.baseM === 0).geometry }))
                    .filter(volume => volume.geometry);
                if (item.configurations?.length) next.configurations = item.configurations.map(configuration => {
                    if (!configuration.volumes?.length) return configuration;
                    const volumes = configuration.volumes.map(volume => ({ ...volume, geometry: apply(volume.geometry, false).geometry })).filter(volume => volume.geometry);
                    const changed = volumes.length !== configuration.volumes.length
                        || volumes.some((volume, i) => volume.geometry !== configuration.volumes[i].geometry && ops.area(volume.geometry) + MIN_M2 < ops.area(configuration.volumes[i].geometry));
                    if (!changed) return configuration;
                    if (!volumes.length) return { ...configuration, volumes, unavailableReason: 'restricted' };
                    const ground = volumes.find(volume => volume.baseM === 0) || volumes[0];
                    return { ...configuration, volumes, metrics: { ...configuration.metrics, footprintM2: ops.area(ground.geometry), floorAreaM2: null } };
                });
            }
            next.restrictions = over.map(restriction => refOf(restriction, {
                ...(cutM2.has(restriction.id) ? { cutM2: cutM2.get(restriction.id) } : {}),
                ...(failed.has(restriction.id) ? { cut: 'failed' } : {}) }));
            return next;
        });
    }

    // Permitted where no base rule is recorded ("unknown base, known designations"): nothing is
    // drawn as permitted massing; each prohibited area is an item whose land does not allow
    // building, so the layer shows it and the Permitted check fails a design over it. Restrict and
    // note designations stay in the restriction list the check reads.
    function unknownBaseItems(restrictions, ruleSets = []) {
        const labelOf = id => ruleSets.find(ruleSet => ruleSet.id === id)?.label || id;
        return (restrictions || []).filter(restriction => restriction.effect === 'prohibit' && polygonal(restriction.geometry)).map(restriction => ({
            id: `restriction:${restriction.id}`, role: 'permitted', title: restriction.name || null, baseRule: 'unknown',
            source: { id: restriction.ruleSetId, label: labelOf(restriction.ruleSetId), recordId: String(restriction.entity) },
            areas: [{ geometry: restriction.geometry }], volumes: [], constraints: [], metrics: { footprintM2: null, heightM: null, floorAreaM2: null },
            assessment: { status: 'prohibited', meaning: 'restriction', reasonCode: restriction.reasonCode },
            restrictions: [refOf(restriction)]
        }));
    }
    // The restrictions touching a footprint (Feature), with the share of the footprint inside each
    // (a point designation: the footprint contains it, share null).
    function restrictionsUnder(restrictions, footprint, ops) {
        const footprintM2 = ops.area(footprint), box = ops.bbox(footprint), found = [];
        for (const restriction of restrictions || []) {
            if (!restriction.geometry || !boxesMeet(ops.bbox(restriction.geometry), box)) continue;
            if (restriction.geometry.type === 'Point') {
                if (ops.booleanPointInPolygon(restriction.geometry.coordinates, footprint)) found.push({ restriction, overlapM2: null, share: null });
                continue;
            }
            let m2;
            try { m2 = overlapM2(footprint.geometry, restriction.geometry, ops); }
            catch (error) {
                console.error(`[${new Date().toISOString()}] [restrictions] Overlap test failed`, restriction.id, error);
                found.push({ restriction, overlapM2: null, share: null, failed: true });
                continue;
            }
            if (m2 >= MIN_M2) found.push({ restriction, overlapM2: m2, share: footprintM2 > 0 ? Math.min(1, m2 / footprintM2) : 0 });
        }
        return found;
    }
    return { EFFECTS, MIN_M2, classify, restrictionsFor, applyToItems, unknownBaseItems, restrictionsUnder };
});
