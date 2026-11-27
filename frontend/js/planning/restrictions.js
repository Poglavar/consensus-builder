// The restrictions stage of Permitted: after a base rule has given each parcel or zone its
// Permitted item, the planning designations over it (planning/constraint-sources.js) act on it with
// one of three effects, which the place's rule set assigns per dataset: `prohibit` removes the
// designated area from the envelope, `restrict` keeps the envelope and attaches a requirement, and
// `note` only gives the Permitted check a reason line. An entry may make its effect depend on the
// permitted development rights a direction removes (`removedRights`): rights no design uses turn it
// into its `otherwise` effect, unknown rights keep it. Where no base rule exists the stage still
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
    // Permitted development rights as codes: a part and a class ("1A", "3L", "20ZA"; England's GPDO
    // Schedule 2), or a whole part ("3"). Read from a list ("1A;1B;2C"), or from "Part 1 Class A,
    // Class B and Part 11 Class C". Null when any of the text is not such a code: unreadable is
    // unknown, never a shorter list.
    const RIGHTS_TOKEN = /\s+|[,;&.()]|AND\b|SCHEDULE\s*2\b|PART\s*(\d{1,2})\b|CLASS(?:ES)?\s+([A-Z]{1,2})\b|(\d{1,2})([A-Z]{1,2})\b/y;
    function rightCodes(text) {
        if (typeof text !== 'string' || !text.trim()) return null;
        const upper = text.toUpperCase(), codes = [];
        let part = null, partClasses = 0;
        const closePart = () => { if (part && !partClasses) codes.push(part); };
        for (let at = 0; at < upper.length;) {
            RIGHTS_TOKEN.lastIndex = at;
            const match = RIGHTS_TOKEN.exec(upper);
            if (!match || !match[0].length) return null;
            at = RIGHTS_TOKEN.lastIndex;
            if (match[1]) { closePart(); part = match[1]; partClasses = 0; }
            else if (match[2]) { if (!part) return null; codes.push(part + match[2]); partClasses++; }
            else if (match[3]) codes.push(match[3] + match[4]);
        }
        closePart();
        return codes.length ? [...new Set(codes)] : null;
    }
    // The rights an area's direction removes, as its rule-set entry's `removedRights` says to read
    // them: the codes in the area's `field`, else in its linked record's (constraint-sources.js
    // withLinked), else the `described` patterns over their texts (`texts`, and the name), unless
    // a text also matches `unless` (it speaks of other works too). Null when unstated or unreadable.
    function removedRightsOf(area, spec) {
        const linked = area.linked || null;
        const codes = rightCodes(area.fields?.[spec.field]) || (linked ? rightCodes(linked[spec.field]) : null);
        if (codes) return codes;
        const texts = [area.fields?.[spec.field], area.name, ...(spec.texts || []).map(name => area.fields?.[name]),
            ...(linked ? [linked[spec.field], linked.name, ...(spec.texts || []).map(name => linked[name])] : [])]
            .filter(text => typeof text === 'string' && text.trim());
        if (!texts.length || (spec.unless && texts.some(text => new RegExp(spec.unless, 'i').test(text)))) return null;
        const described = new Set();
        for (const entry of spec.described || []) {
            if (texts.some(text => new RegExp(entry.pattern, 'i').test(text))) entry.rights.forEach(code => described.add(code));
        }
        return described.size ? [...described] : null;
    }
    // What an area's removed rights do to its effect: the design actions they cover (`actions`, by
    // code, else by its part; an empty list is a right no design here uses). A right the table does
    // not list counts as covering one. When none is covered the effect is `otherwise`; when the
    // rights are unknown it stays the entry's. Returns { effect, removedRights }.
    function rightsEffect(entry, area) {
        const spec = entry.removedRights;
        if (!spec) return { effect: entry.effect, removedRights: undefined };
        if (!EFFECTS.includes(spec.otherwise)) throw new Error(`Rule set entry ${entry.dataset} gives removed rights an unknown effect: ${spec.otherwise}`);
        const codes = removedRightsOf(area, spec);
        if (!codes) return { effect: entry.effect, removedRights: { codes: null, actions: [], unlisted: [] } };
        const actions = new Set(), unlisted = [];
        for (const code of codes) {
            const covered = spec.actions?.[code] ?? spec.actions?.[code.match(/^\d+/)[0]];
            if (!covered) unlisted.push(code); else covered.forEach(action => actions.add(action));
        }
        return { effect: actions.size || unlisted.length ? entry.effect : spec.otherwise, removedRights: { codes, actions: [...actions], unlisted } };
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
                const { effect, removedRights } = rightsEffect(entry, area);
                restrictions.push({
                    id: area.id, ruleSetId: ruleSet.id, sourceId: source.id, dataset: area.dataset, entity: area.entity,
                    reference: area.reference, name: area.name, organisation: area.organisation,
                    effect, reasonCode: entry.reasonCode, requirement: effect === entry.effect ? entry.requirement || null : null,
                    subject: entry.subject || 'land', geometry, footprint, building, fields: area.fields, links: area.links,
                    ...(removedRights ? { removedRights } : {}),
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
        sourceLabel: restriction.source?.label || null, ...(restriction.removedRights ? { removedRights: restriction.removedRights } : {}), ...extra });
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
    // One geometry (an envelope's site a design is built on) without the prohibited areas over it:
    // { geometry (null when nothing is left), cut: [{ id, m2 }] }.
    function cutGeometry(geometry, restrictions, { geometryOps: ops } = {}) {
        if (!ops) throw new TypeError('Restrictions need geometry operations.');
        const prohibits = (restrictions || []).filter(restriction => restriction.effect === 'prohibit' && polygonal(restriction.geometry))
            .map(restriction => ({ ...restriction, box: ops.bbox(restriction.geometry) }));
        if (!polygonal(geometry) || !prohibits.length) return { geometry, cut: [] };
        const result = cut(geometry, prohibits, ops);
        return { geometry: result.geometry, cut: [...result.removed].map(([id, m2]) => ({ id, m2 })) };
    }
    // Restrictions from geometry-free reads (constraint-sources.js membership), one per building
    // footprint: [{ buildingId, reads }] → { restrictions, partial }. Each restriction has no
    // geometry (`footprint: "not-read"`) and lists the buildings the publisher found inside it
    // (`buildingIds`); the Permitted check reads that instead of an overlap.
    function membershipRestrictions(perBuilding, { geometryOps } = {}) {
        const byId = new Map();
        let partial = false;
        for (const { buildingId, reads } of perBuilding || []) {
            const found = restrictionsFor(reads, { geometryOps });
            partial = partial || found.partial;
            for (const restriction of found.restrictions) {
                const known = byId.get(restriction.id);
                if (known) { if (!known.buildingIds.includes(buildingId)) known.buildingIds.push(buildingId); }
                else byId.set(restriction.id, { ...restriction, geometry: null, footprint: 'not-read', buildingIds: [buildingId] });
            }
        }
        return { restrictions: [...byId.values()], partial };
    }
    return { EFFECTS, MIN_M2, classify, rightCodes, rightsEffect, restrictionsFor, applyToItems, unknownBaseItems, restrictionsUnder, cutGeometry, membershipRestrictions };
});
