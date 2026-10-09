// Two authored alternatives measured on one pinned study area. This is deliberately independent of
// map application: mutable live parcels, existing buildings and demolition caches are not inputs.
// A group is a collection of proposals, not a new proposal type. Conflicting designs retain their
// previews but cannot produce plausible-looking combined totals. Units/rounding come from plan-yield.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__proposalComparison = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const ENGINE_VERSION = '1.0.0';
    const MAX_PROPOSALS = 1000;
    const MAX_VERTICES = 100000;
    const MIN_OVERLAP_M2 = 0.25;
    const BUILDING_GOALS = new Set(['single', 'buildings', 'building(s)', 'single-building', 'row', 'parcelbased']);
    const LAND_METRIC = { park: 'parkAreaM2', square: 'squareAreaM2', lake: 'waterAreaM2', road: 'roadAreaM2', track: 'roadAreaM2' };
    const BUILDING_METRICS = ['buildingCount', 'buildingFootprintM2', 'grossFloorAreaM2', 'floorAreaRatio', 'housingUnits', 'people', 'jobs'];
    function dep(name, path) {
        return global[name] || (typeof require === 'function' ? require(path) : null);
    }
    const yieldApi = () => dep('__planYield', './plan-yield.js');
    const partsApi = () => dep('__footprintParts', './footprint-parts.js');
    const ENGINE_DEFAULTS = Object.freeze({ ...yieldApi().DEFAULTS });
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    const idOf = record => String(record.proposalId ?? record.id ?? '');
    const area = geometry => yieldApi().geometryAreaM2(geometry);
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
    const geometryOf = value => value && value.type === 'Feature' ? value.geometry : value;
    const issue = (list, code, message, proposalIds) => {
        if (!list.some(item => item.code === code && item.message === message)) {
            list.push({ code, message, ...(proposalIds ? { proposalIds } : {}) });
        }
    };

    // Pin only measurement inputs. In particular, owner identities, prices, acceptance state,
    // apply-time demolitions and the proposal's mutable applied flag never travel in a snapshot.
    function copy(value, depth = 0) {
        if (depth > 30) throw new Error('Comparison input is nested too deeply.');
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') {
            if (!finite(value)) throw new Error('Comparison input contains a non-finite number.');
            return value;
        }
        if (Array.isArray(value)) return value.map(item => copy(item, depth + 1));
        if (!value || typeof value !== 'object') return null;
        const result = {};
        Object.keys(value).forEach(key => {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe comparison input.');
            if (value[key] !== undefined) result[key] = copy(value[key], depth + 1);
        });
        return result;
    }
    function select(value, keys) {
        const result = {};
        keys.forEach(key => { if (value && value[key] !== undefined) result[key] = copy(value[key]); });
        return result;
    }
    function pinGeometry(value) {
        const geometry = geometryOf(value);
        return geometry ? select(geometry, ['type', 'coordinates']) : null;
    }
    function pinRule(value) {
        return select(value, ['minHeightM', 'maxHeightM', 'floorHeightM']);
    }
    function pinBuilding(value) {
        const source = value && (value.feature || value);
        const properties = select(source && source.properties, ['height', 'heightM', 'HEIGHT', 'floors', 'storeys', 'katova', 'floorHeightM']);
        if (source && source.properties && source.properties.urbanRule) properties.urbanRule = pinRule(source.properties.urbanRule);
        return { type: 'Feature', properties, geometry: pinGeometry(source) };
    }
    function pinRecord(record) {
        if (!record || typeof record !== 'object') throw new Error('Every comparison member must be a proposal.');
        const result = select(record, ['proposalId', 'id', 'serverProposalId', 'serverId', 'title', 'name', 'goal', 'city',
            'createdAt', 'authoredAt', 'epochYear', 'sourceProposalId', 'replacementOfProposalId', 'cadastreParcelIds']);
        if (record.landFork) result.landFork = true;
        if (record.site) result.site = pinGeometry(record.site);
        const bp = record.buildingProposal || record.building_proposal;
        if (bp) {
            result.buildingProposal = {};
            if (bp.parameters && bp.parameters.rule) result.buildingProposal.parameters = { rule: pinRule(bp.parameters.rule) };
            if (Array.isArray(bp.buildings)) result.buildingProposal.buildings = bp.buildings.map(pinBuilding);
        }
        if (record.geometry) {
            result.geometry = record.geometry.type ? pinGeometry(record.geometry) : {};
            if (Array.isArray(record.geometry.buildings)) result.geometry.buildings = record.geometry.buildings.map(pinBuilding);
            if (record.geometry.groundSurface) result.geometry.groundSurface = {
                treatment: String(record.geometry.groundSurface.treatment || ''),
                polygon: pinGeometry(record.geometry.groundSurface.polygon)
            };
        }
        if (record.buildingGeometry) result.buildingGeometry = pinGeometry(record.buildingGeometry);
        const sp = record.structureProposal || record.structure_proposal;
        if (sp) result.structureProposal = { kind: String(sp.kind || ''), geometry: pinGeometry(sp.geometry) };
        const road = record.roadProposal;
        if (road) {
            const definition = road.definition || {};
            result.roadProposal = { definition: select(definition, ['kind', 'type', 'isTrack', 'width', 'points', 'segments']) };
            if (definition.metadata) result.roadProposal.definition.metadata = select(definition.metadata, ['isTrack']);
            if (definition.polygon) result.roadProposal.definition.polygon = pinGeometry(definition.polygon);
        }
        if (record.reparcellization) result.reparcellization = {
            polygons: (record.reparcellization.polygons || []).map(polygon => ({ geometry: pinGeometry(polygon && polygon.geometry) }))
        };
        return result;
    }
    function normalizeAssumptions(input) {
        const result = { ...ENGINE_DEFAULTS };
        Object.keys(result).forEach(key => {
            if (input && input[key] !== undefined) {
                const value = input[key];
                const share = key === 'efficiency' || key === 'housingShare';
                if (!finite(value) || (share ? value < 0 || value > 1 : value <= 0)) {
                    throw new Error(`Invalid shared assumption: ${key}.`);
                }
                result[key] = value;
            }
        });
        return result;
    }
    function captureInput(input) {
        if (!input || !Array.isArray(input.alternatives) || input.alternatives.length !== 2) {
            throw new Error('Choose exactly two alternatives.');
        }
        let count = 0;
        const alternatives = input.alternatives.map((alternative, i) => {
            if (!alternative || !Array.isArray(alternative.proposals)) throw new Error('Each alternative needs a proposal list.');
            count += alternative.proposals.length;
            return { name: String(alternative.name || `Alternative ${i ? 'B' : 'A'}`).slice(0, 200), proposals: alternative.proposals.map(pinRecord) };
        });
        if (count > MAX_PROPOSALS) throw new Error(`A comparison can contain at most ${MAX_PROPOSALS} proposal selections.`);
        const neededIds = new Set(alternatives.flatMap(a => a.proposals.flatMap(p => p.cadastreParcelIds || [])).map(String));
        const parcels = (input.context && Array.isArray(input.context.parcels) ? input.context.parcels : [])
            .filter(parcel => parcel && neededIds.has(String(parcel.id)))
            .map(parcel => ({ id: String(parcel.id), feature: feature(pinGeometry(parcel.feature || parcel.geometry)) }));
        const result = { alternatives, assumptions: normalizeAssumptions(input.assumptions),
            scope: input.scope && input.scope.geometry ? { geometry: pinGeometry(input.scope.geometry), source: String(input.scope.source || 'fixed'), complete: input.scope.complete !== false } : null,
            context: { city: String(input.context && input.context.city || ''), parcels } };
        let vertices = 0;
        function walk(value) {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value) && value.length >= 2 && value.every(finite)) {
                vertices += 1;
                if (vertices > MAX_VERTICES) throw new Error(`Comparison geometry exceeds ${MAX_VERTICES} vertices.`);
            } else Object.values(value).forEach(walk);
        }
        walk(result);
        return result;
    }

    function polygon(value) {
        const g = geometryOf(value);
        if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) throw new Error('Missing polygon geometry.');
        const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        if (!Array.isArray(polygons) || !polygons.length) throw new Error('Empty polygon geometry.');
        for (const rings of polygons) {
            if (!Array.isArray(rings) || !rings.length) throw new Error('Missing polygon rings.');
            for (const ring of rings) {
                if (!Array.isArray(ring) || ring.length < 4 || ring.some(p => !Array.isArray(p)
                    || !finite(p[0]) || !finite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) {
                    throw new Error('Invalid polygon coordinates.');
                }
                if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
                    throw new Error('Polygon ring is not closed.');
                }
            }
        }
        if (!(area(g) > 0)) throw new Error('Polygon has no measurable area.');
        return g;
    }
    // Turf 6 is the project's shared geometry engine. Do not turn a failed union/intersection into
    // zero, or keep only the first successful part: both make incomplete comparisons look complete.
    function union(geometries, turf) {
        if (!geometries.length) return null;
        let result = feature(polygon(geometries[0]));
        geometries.slice(1).forEach(g => {
            result = turf.union(result, feature(polygon(g)));
            if (!result || !result.geometry) throw new Error('Geometry union failed.');
        });
        return result.geometry;
    }
    function intersect(a, b, turf) {
        const result = turf.intersect(feature(a), feature(b));
        return result && result.geometry || null;
    }
    function memberOf(record, context, turf, issues) {
        const id = idOf(record);
        const member = { record, id, site: null, source: null, shapes: [], unknown: new Set(), siteMissing: false };
        const addShape = (kind, value, building) => {
            try { member.shapes.push({ kind, geometry: polygon(value), building, member }); }
            catch (_) {
                member.unknown.add(kind);
                issue(issues, 'missing-design-geometry', `${id}: ${kind} geometry is missing or invalid.`, [id]);
            }
        };
        const buildings = yieldApi().buildingFeaturesOf(record);
        const rawBuildings = [record.geometry && record.geometry.buildings, record.buildingProposal && record.buildingProposal.buildings]
            .find(list => Array.isArray(list) && list.length) || [];
        if (rawBuildings.length > buildings.length) {
            member.unknown.add('building');
            issue(issues, 'missing-buildings', `${id}: some building geometry is unavailable; building totals are unknown.`, [id]);
        }
        buildings.forEach(building => addShape('building', building.geometry, building));
        if (!buildings.length && (record.buildingProposal || record.buildingGeometry || BUILDING_GOALS.has(String(record.goal).toLowerCase()))) {
            member.unknown.add('building');
            issue(issues, 'missing-buildings', `${id}: building geometry is unavailable; building totals are unknown.`, [id]);
        }
        const sp = record.structureProposal;
        const goal = String(record.goal || '').toLowerCase();
        if (!sp && ['park', 'square', 'lake'].includes(goal)) {
            member.unknown.add(goal);
            issue(issues, 'missing-design-geometry', `${id}: ${goal} geometry is unavailable.`, [id]);
        }
        if (!record.roadProposal && ['road', 'road-track', 'track'].includes(goal)) {
            member.unknown.add('road');
            issue(issues, 'missing-design-geometry', `${id}: corridor geometry is unavailable.`, [id]);
        }
        if (sp) {
            const kind = String(sp.kind).toLowerCase();
            if (LAND_METRIC[kind]) addShape(kind, sp.geometry);
            else issue(issues, 'unmeasured-structure', `${id}: ${kind || 'this structure'} has no yield metric in this comparison.`, [id]);
        }
        const ground = record.geometry && record.geometry.groundSurface;
        if (ground && ['green', 'paved'].includes(ground.treatment)) addShape(ground.treatment === 'green' ? 'park' : 'square', ground.polygon);
        let corridor = null;
        if (record.roadProposal) {
            const definition = record.roadProposal.definition || {};
            const kind = definition.isTrack || definition.metadata && definition.metadata.isTrack
                || definition.kind === 'track' || definition.type === 'track' ? 'track' : 'road';
            corridor = definition.polygon;
            if (!corridor) {
                const centerline = partsApi().footprintParts(record).centerline;
                if (centerline) {
                    try {
                        if (centerline.segments.some(segment => segment.some(p => Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90))) throw new Error('Invalid centerline coordinates.');
                        corridor = union(centerline.segments.map(segment => polygon(turf.buffer(
                            turf.lineString(segment), centerline.halfWidthM, { units: 'meters' }))), turf);
                        issue(issues, 'approximate-corridor', `${id}: corridor area is estimated from the centerline and width; junction and grade details are not resolved.`, [id]);
                    } catch (_) { corridor = null; }
                }
            }
            addShape(kind, corridor);
        }
        try {
            if (record.site) {
                member.site = polygon(record.site);
                member.source = 'authored';
            } else {
                const parts = partsApi().footprintParts(record);
                if (parts.invalid) throw new Error(parts.invalid);
                const geometries = [...parts.polygons, ...member.shapes.map(shape => shape.geometry)];
                if (geometries.length) {
                    member.site = union(geometries, turf);
                    member.source = 'design';
                } else {
                    const ids = (record.cadastreParcelIds || []).map(String);
                    const parcels = new Map(context.parcels.map(p => [p.id, p.feature]));
                    if (!ids.length || ids.some(parcelId => !parcels.has(parcelId))) throw new Error('Incomplete cadastral geometry.');
                    member.site = union(ids.map(parcelId => polygon(parcels.get(parcelId))), turf);
                    member.source = 'cadastre';
                }
            }
        } catch (_) {
            member.siteMissing = true;
            issue(issues, 'missing-site', `${id}: the complete study area could not be established from authored or cadastral geometry.`, [id]);
        }
        return member;
    }
    function prepare(alternative, context, turf) {
        const issues = [];
        const ids = new Set();
        const records = [];
        alternative.proposals.forEach(record => {
            const id = idOf(record);
            if (!id) throw new Error('A proposal is missing its identifier.');
            if (ids.has(id)) throw new Error(`Proposal ${id} occurs twice in one alternative.`);
            ids.add(id);
            records.push(record);
        });
        return { name: alternative.name, issues, members: records.map(record => memberOf(record, context, turf, issues)) };
    }
    function replacementConflict(members) {
        // Reuse the same family semantics as applying a proposal, including the land-fork exception.
        const familyOf = global.proposalReplacementFamilyIds
            || (typeof require === 'function' ? require('../proposal-supersession.js').proposalReplacementFamilyIds : null);
        if (!familyOf) throw new Error('Proposal replacement rules are unavailable.');
        const records = members.map(m => m.record);
        return records.some(record => {
            const family = familyOf(record, records);
            return records.some(other => idOf(other) !== idOf(record) && family.has(idOf(other)));
        });
    }
    function measure(alternative, scope, assumptions, scopeComplete, turf) {
        const { members, issues } = alternative;
        const metrics = { proposalCount: members.length, siteAreaM2: 0, buildingCount: 0, buildingFootprintM2: 0,
            grossFloorAreaM2: 0, floorAreaRatio: 0, housingUnits: 0, people: 0, jobs: 0,
            parkAreaM2: 0, squareAreaM2: 0, waterAreaM2: 0, roadAreaM2: 0 };
        const output = { name: alternative.name, proposalIds: members.map(m => m.id), metrics, issues,
            sources: members.map(m => ({ proposalId: m.id, site: m.source })),
            features: { type: 'FeatureCollection', features: [] } };
        const unknown = new Set(members.flatMap(m => [...m.unknown]));
        const shapes = [];
        const sites = [];
        const addPreview = (geometry, kind, id) => output.features.features.push({ type: 'Feature', properties: { kind, proposalId: id }, geometry });
        if (!scope.geometry) {
            Object.keys(metrics).filter(key => key !== 'proposalCount').forEach(key => { metrics[key] = null; });
            return output;
        }
        for (const member of members) {
            if (member.site) {
                try {
                    const clipped = intersect(member.site, scope.geometry, turf);
                    if (clipped) { sites.push(clipped); addPreview(clipped, 'site', member.id); }
                    if (area(member.site) - area(clipped) > MIN_OVERLAP_M2) issue(issues, 'outside-scope', `${member.id}: only the part inside the shared study area is measured.`, [member.id]);
                } catch (_) { member.siteMissing = true; issue(issues, 'site-clip-failed', `${member.id}: the site could not be clipped.`, [member.id]); }
            }
            member.shapes.forEach(shape => {
                try {
                    const clipped = intersect(shape.geometry, scope.geometry, turf);
                    if (!clipped || area(clipped) < MIN_OVERLAP_M2) return;
                    shapes.push({ ...shape, geometry: clipped });
                    addPreview(clipped, shape.kind, member.id);
                    if (area(shape.geometry) - area(clipped) > MIN_OVERLAP_M2) issue(issues, 'design-clipped', `${member.id}: design quantities are clipped to the shared study area.`, [member.id]);
                } catch (_) {
                    unknown.add(shape.kind);
                    issue(issues, 'design-clip-failed', `${member.id}: ${shape.kind} could not be clipped; its totals are unknown.`, [member.id]);
                }
            });
        }
        try { metrics.siteAreaM2 = members.some(m => m.siteMissing) ? null : area(union(sites, turf)); }
        catch (_) { metrics.siteAreaM2 = null; issue(issues, 'site-union-failed', 'Combined site area could not be measured.'); }
        function combinedArea(list, kind) {
            try { return area(union(list.map(shape => shape.geometry), turf)); }
            catch (_) { unknown.add(kind); issue(issues, 'design-union-failed', `${kind}: combined area could not be measured.`); return null; }
        }
        const buildings = shapes.filter(shape => shape.kind === 'building');
        metrics.buildingCount = buildings.length;
        metrics.buildingFootprintM2 = combinedArea(buildings, 'building');
        buildings.forEach(shape => {
            const building = { ...shape.building, geometry: shape.geometry };
            const measured = yieldApi().measureBuilding(building, shape.member.record.buildingProposal, assumptions);
            if (!finite(measured.gfaM2)) {
                metrics.grossFloorAreaM2 = null;
                issue(issues, 'missing-height', `${shape.member.id}: a building has no usable height; floor area and yield are unknown.`, [shape.member.id]);
            } else if (metrics.grossFloorAreaM2 !== null) metrics.grossFloorAreaM2 += measured.gfaM2;
        });
        for (const metric of new Set(Object.values(LAND_METRIC))) {
            const matching = shapes.filter(shape => LAND_METRIC[shape.kind] === metric);
            metrics[metric] = combinedArea(matching, metric === 'roadAreaM2' ? 'road' : Object.keys(LAND_METRIC).find(k => LAND_METRIC[k] === metric));
        }
        // Same-kind land coverage is a union (a road junction is counted once). Buildings or
        // different uses on the same ground need application/order resolution; no double-counting.
        const bounds = shapes.map(shape => turf.bbox(feature(shape.geometry)));
        for (let i = 0; i < shapes.length; i += 1) {
            for (let j = i + 1; j < shapes.length; j += 1) {
                const a = shapes[i], b = shapes[j];
                if (a.kind !== 'building' && a.kind === b.kind) continue;
                if (LAND_METRIC[a.kind] === 'roadAreaM2' && LAND_METRIC[b.kind] === 'roadAreaM2') continue;
                const x = bounds[i], y = bounds[j];
                if (x[0] > y[2] || y[0] > x[2] || x[1] > y[3] || y[1] > x[3]) continue;
                try {
                    if (area(intersect(a.geometry, b.geometry, turf)) <= MIN_OVERLAP_M2) continue;
                    unknown.add(a.kind); unknown.add(b.kind);
                    issue(issues, 'overlapping-designs', `${a.member.id} (${a.kind}) overlaps ${b.member.id} (${b.kind}). Their combined quantities need design resolution.`, [...new Set([a.member.id, b.member.id])]);
                } catch (_) {
                    unknown.add(a.kind); unknown.add(b.kind);
                    issue(issues, 'overlap-check-failed', 'A design overlap could not be checked; affected totals are unknown.');
                }
            }
        }
        if (replacementConflict(members)) {
            issue(issues, 'replacement-conflict', 'This alternative includes multiple versions from one replacement family. Choose one version before combining quantities.');
            BUILDING_METRICS.concat(Object.values(LAND_METRIC)).forEach(key => { metrics[key] = null; });
        }
        unknown.forEach(kind => {
            if (kind === 'building') BUILDING_METRICS.forEach(key => { metrics[key] = null; });
            else if (LAND_METRIC[kind]) metrics[LAND_METRIC[kind]] = null;
        });
        if (metrics.grossFloorAreaM2 === null) {
            ['floorAreaRatio', 'housingUnits', 'people', 'jobs'].forEach(key => { metrics[key] = null; });
        } else {
            const derived = yieldApi().rederive({ total: { grossFloorAreaM2: metrics.grossFloorAreaM2 },
                unassigned: { grossFloorAreaM2: 0 }, byEpoch: [], cumulative: [] }, assumptions).total;
            metrics.housingUnits = derived.apartments;
            metrics.people = derived.people;
            metrics.jobs = derived.jobs;
            metrics.floorAreaRatio = scopeComplete && scope.areaM2 > 0 ? metrics.grossFloorAreaM2 / scope.areaM2 : null;
        }
        Object.keys(metrics).forEach(key => {
            if (metrics[key] !== null && !finite(metrics[key])) {
                metrics[key] = null;
                issue(issues, 'invalid-measurement', 'A quantity is outside the supported numeric range.');
            }
        });
        return output;
    }
    function compare(source, options = {}) {
        const input = captureInput(source);
        const turf = options.turf || global.turf;
        if (!turf || !turf.union || !turf.intersect) throw new Error('Comparison geometry engine is unavailable.');
        const cities = new Set(input.alternatives.flatMap(a => a.proposals.map(p => p.city)).concat(input.context.city).filter(Boolean));
        if (cities.size > 1) throw new Error('Choose proposals from the same city.');
        const prepared = input.alternatives.map(a => prepare(a, input.context, turf));
        const issues = [];
        let scopeComplete = true;
        let geometry = null;
        if (input.scope) {
            geometry = polygon(input.scope.geometry);
            scopeComplete = input.scope.complete;
            if (!scopeComplete) issue(issues, 'incomplete-scope', 'The pinned study area is incomplete; density cannot be compared.');
        }
        else {
            const members = prepared.flatMap(a => a.members);
            scopeComplete = !members.some(m => m.siteMissing);
            try { geometry = union(members.map(m => m.site).filter(Boolean), turf); }
            catch (_) { scopeComplete = false; }
            if (!scopeComplete) issue(issues, 'incomplete-scope', 'Some proposal sites are unavailable. The shared study area is incomplete; density cannot be compared.');
        }
        if (!geometry) issue(issues, 'missing-scope', 'No study area is available. Add proposals with site geometry or provide a fixed study area.');
        const scope = { geometry, areaM2: geometry && scopeComplete ? area(geometry) : null,
            source: input.scope ? input.scope.source : 'union-of-alternatives', complete: scopeComplete && !!geometry };
        const alternatives = prepared.map(a => measure(a, scope, input.assumptions, scopeComplete, turf));
        const deltas = {};
        Object.keys(alternatives[0].metrics).forEach(key => {
            const a = alternatives[0].metrics[key], b = alternatives[1].metrics[key];
            deltas[key] = finite(a) && finite(b) ? b - a : null;
        });
        return { engineVersion: ENGINE_VERSION, scope, assumptions: input.assumptions, alternatives, deltas, issues };
    }
    return { ENGINE_VERSION, ENGINE_DEFAULTS, MAX_PROPOSALS, MAX_VERTICES, captureInput, compare };
});
