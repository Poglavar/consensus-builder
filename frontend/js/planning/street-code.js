// Street code check: the facts a street code (planning/eligibility.js, `kind: 'street-code'`) is
// judged on, for each building of a plan, and the check itself. A plan names the codes it claims to
// respect (plan-record.js `codes`); this reads what the claim rests on and judges every building with
// the one rule evaluator (BuildingEligibility.evaluate), so the agreement editor and MCP agree.
// Facts come from: the design (storeys, setback storey, storey height), the place (the storey cap from
// the density of the small areas near the street, the buildings built before 1918 near it, the
// designations a building lies in) and the shared API's building facts (listing, date) of a raised
// existing building. Reads are passed in; the rest is pure and works in local metres, without turf.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StreetCode = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const positive = value => (finite(value) && value > 0 ? value : null);
    const eligibilityApi = () => root?.BuildingEligibility || require('./eligibility.js');
    const yieldApi = () => (typeof window !== 'undefined' && window.__planYield) || require('../proposals/plan-yield.js');
    const factsApi = () => root?.BuildingFacts || require('../buildings/building-facts.js');

    // ── local metres ────────────────────────────────────────────────────────────────────────
    function projector(lng0, lat0) {
        const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
        return ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky];
    }
    const ringsOf = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
    function inRing(ring, [x, y]) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    const inPolygon = (polygon, p) => inRing(polygon[0], p) && !polygon.slice(1).some(hole => inRing(hole, p));
    function pointSegment([px, py], [ax, ay], [bx, by]) {
        const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
        return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    }
    function segmentsCross(a, b, c, d) {
        const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
    }
    function segmentsApart(a, b, c, d) {
        if (segmentsCross(a, b, c, d)) return 0;
        return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
    }
    // Distance in metres from an area (polygons) to a set of lines (each a list of points); 0 where
    // a line runs inside it. `within`: the caller only asks whether the distance is at most this; a
    // farther answer is any number above it (a box gap), so boxes skip the far areas and segments
    // instead of measuring every edge pair (a street of houses against district outlines took
    // ~50 ms of main thread in one piece).
    const boxOf = points => points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const boxGap = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
    function areaToLines(polygons, lines, within = Infinity) {
        const areaBox = boxOf(polygons.flatMap(polygon => polygon[0] || []));
        const linesGap = boxGap(areaBox, boxOf(lines.flat()));
        if (linesGap > within) return linesGap;
        let best = Infinity;
        for (const line of lines) {
            if (boxGap(areaBox, boxOf(line)) > Math.min(best, within)) continue;
            if (line.some(point => polygons.some(polygon => inPolygon(polygon, point)))) return 0;
            for (let j = 0; j < line.length - 1 || (line.length === 1 && j === 0); j++) {
                const a = line[j], b = line[Math.min(j + 1, line.length - 1)];
                const segmentBox = boxOf([a, b]);
                if (boxGap(areaBox, segmentBox) > Math.min(best, within)) continue;
                for (const polygon of polygons) for (const ring of polygon) {
                    for (let i = 0; i < ring.length - 1; i++) {
                        const p = ring[i], q = ring[i + 1];
                        // An edge farther than the best so far (or the cutoff) cannot change the answer.
                        // Inline box tests: this loop runs over every edge of a district outline.
                        const limit = Math.min(best, within);
                        if (Math.min(p[0], q[0]) - segmentBox[2] > limit || segmentBox[0] - Math.max(p[0], q[0]) > limit
                            || Math.min(p[1], q[1]) - segmentBox[3] > limit || segmentBox[1] - Math.max(p[1], q[1]) > limit) continue;
                        best = Math.min(best, segmentsApart(p, q, a, b));
                        if (!best) return 0;
                    }
                }
            }
        }
        return Number.isFinite(best) ? best : Math.max(linesGap, within + 1);
    }
    const closed = ring => (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring);
    // A footprint's outline rings as lines (a building counts as near when its outline is).
    const outlineLines = (geometry, project) => ringsOf(geometry).flatMap(polygon => polygon.map(ring => closed(ring).map(project)));
    function centreOf(geometries) {
        const points = geometries.flatMap(geometry => ringsOf(geometry).flatMap(polygon => polygon[0] || []));
        if (!points.length) return null;
        return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
    }

    // ── the design ──────────────────────────────────────────────────────────────────────────
    // Every building of the plan's designs: raised existing ones ('existing', with the building
    // facts id of the building they extend) and new ones. Storeys count only when the design states
    // them or its storey height: a storey height the app would assume is no measurement.
    function planBuildings(designs) {
        const Y = yieldApi();
        const out = [];
        (designs || []).forEach((design, designIndex) => {
            const bp = design?.buildingProposal || design?.building_proposal || null;
            const features = Y.buildingFeaturesOf(design);
            features.forEach((feature, index) => {
                const p = feature.properties || {};
                if (p.type && p.type !== 'proposedBuilding' && p.type !== 'building') return;
                const rule = bp?.parameters?.rule && typeof bp.parameters.rule === 'object' ? bp.parameters.rule : null;
                const measured = Y.measureBuilding(feature, bp, null, features);
                const statedFloors = positive(p.floors) ?? positive(p.storeys);
                const storeyHeightM = positive(p.floorHeightM) ?? positive(rule?.floorHeightM)
                    ?? (statedFloors && positive(measured.heightM) ? measured.heightM / statedFloors : null);
                const mansard = finite(measured.mansardFloorAreaM2);
                const walls = statedFloors ?? (storeyHeightM && positive(measured.heightM) ? Math.max(1, Math.round(measured.heightM / storeyHeightM)) : null);
                const existing = p.basedOnExisting === true;
                out.push({ key: `${designIndex}:${index}`, design: designIndex, index, kind: existing ? 'existing' : 'new',
                    factId: existing ? factsApi().factIdOf({ properties: { id: p.sourceBuildingId } }, p.sourceBuildingId) : null,
                    sourceBuildingId: existing ? p.sourceBuildingId ?? null : null, buildingId: p.buildingId ?? null,
                    geometry: feature.geometry, storeys: walls, setbacks: mansard ? 1 : 0, roof: p.roof || rule?.roof || null,
                    storeyHeightM, setbackRiseM: mansard ? measured.roofRiseM ?? null : null, heightM: positive(measured.heightM) });
            });
        });
        return out;
    }

    // ── the place ───────────────────────────────────────────────────────────────────────────
    // Para 30: the cap of one density by the set's bands.
    function capOf(bands, density) {
        if (!finite(density)) return null;
        for (const band of bands) {
            if (finite(band.below) && density < band.below) return band.storeys;
            if (finite(band.atMost) && density <= band.atMost) return band.storeys;
            if (!finite(band.below) && !finite(band.atMost)) return band.storeys;
        }
        return null;
    }
    /**
     * The storey cap from the small areas read near the street: the lowest cap of every area within
     * `reachM` of the street or under a building of the plan. `street`: lines of [lng, lat] (null when
     * the vote names no street). Without the street the cap is not known, but the areas under the
     * plan's buildings bound it from above (more areas can only lower it): `bound`.
     * Returns { value, bound, areas: [{ code, name, densityPerHa, cap }], lowest, reason }.
     */
    function storeyCap(set, { areas, street, buildings }) {
        if (!Array.isArray(areas)) return { value: null, bound: null, areas: [], lowest: null, reason: 'densityUnread' };
        const geometries = buildings.map(b => b.geometry).filter(Boolean);
        const origin = centreOf(geometries) || (street?.[0]?.[0]) || null;
        if (!origin) return { value: null, bound: null, areas: [], lowest: null, reason: 'noBuildings' };
        const project = projector(origin[0], origin[1]);
        const lines = (street || []).map(line => line.map(project));
        const footprints = geometries.flatMap(geometry => outlineLines(geometry, project));
        const judged = areas.map(area => {
            const polygons = ringsOf(area.geometry).map(polygon => polygon.map(ring => ring.map(project)));
            return { area, under: areaToLines(polygons, footprints, 0) === 0, near: lines.length ? areaToLines(polygons, lines, set.density.reachM) <= set.density.reachM : false };
        });
        const pick = rows => rows.map(({ area }) => ({ code: area.code, name: area.name, scheme: area.scheme, densityPerHa: area.densityPerHa ?? null,
            populationYear: area.populationYear ?? null, cap: capOf(set.density.bands, area.densityPerHa) }));
        const lowestOf = rows => rows.reduce((low, row) => (low === null || (finite(row.cap) && row.cap < low.cap) ? row : low), null);
        const under = pick(judged.filter(row => row.under));
        const bound = under.length && under.every(row => finite(row.cap)) ? Math.min(...under.map(row => row.cap)) : null;
        if (!street) return { value: null, bound, areas: under, lowest: lowestOf(under), reason: 'noStreet' };
        const counted = pick(judged.filter(row => row.under || row.near));
        if (!counted.length) return { value: null, bound, areas: [], lowest: null, reason: 'noArea' };
        if (counted.some(row => !finite(row.cap))) return { value: null, bound, areas: counted, lowest: lowestOf(counted), reason: 'densityUnknown' };
        const lowest = lowestOf(counted);
        return { value: lowest.cap, bound, areas: counted, lowest, reason: null };
    }

    /**
     * Para 37 from the buildings near the street: `near` are [{ id, geometry, built, storeys }] (built
     * a { from, to } span or null, storeys a number or null, as the building facts state them).
     * Ten or more built before 1918 within reach restrict the street to 3+1; when the unknown dates
     * could still decide it either way the restriction is unknown. Where half the buildings along the
     * street (within `streetReachM`) already have more floors, the existing total applies instead,
     * which is not measured here: unknown.
     * Returns { value: storeys | false (no restriction) | null, before1918, unknownDates, reason }.
     */
    function historicLimit(set, { street, near }) {
        const h = set.historic;
        if (!street) return { value: null, before1918: null, unknownDates: null, reason: 'noStreet' };
        if (!Array.isArray(near)) return { value: null, before1918: null, unknownDates: null, reason: 'buildingsUnread' };
        const origin = street[0][0], project = projector(origin[0], origin[1]);
        const lines = street.map(line => line.map(project));
        const apart = building => areaToLines(ringsOf(building.geometry).map(polygon => polygon.map(ring => ring.map(project))), lines, h.reachM);
        let before = 0, unknown = 0;
        const along = [];
        for (const building of near) {
            const distance = apart(building);
            if (distance > h.reachM) continue;
            if (distance <= h.streetReachM) along.push(building);
            const span = building.built;
            if (span && finite(span.to) && span.to < h.builtBefore) before++;
            else if (!(span && finite(span.from) && span.from >= h.builtBefore)) unknown++;
        }
        const counts = { before1918: before, unknownDates: unknown };
        if (before + unknown < h.count) return { value: false, ...counts, reason: null };
        if (before < h.count) return { value: null, ...counts, reason: 'datesUnknown' };
        const taller = along.filter(b => finite(b.storeys) && b.storeys > h.storeys + h.setbacks).length;
        const unsure = along.filter(b => !finite(b.storeys)).length;
        if (along.length && taller * 2 >= along.length) return { value: null, ...counts, reason: 'existingTotal' };
        if (along.length && (taller + unsure) * 2 >= along.length) return { value: null, ...counts, reason: 'storeysUnknown' };
        return { value: h.storeys, ...counts, reason: null };
    }

    // ── facts and the check ─────────────────────────────────────────────────────────────────
    const derived = (name, value, params = {}, extra = {}) => ({ value, derived: true, name, params, source: 'street-code', ...extra });
    /**
     * One building's facts for the set: its kind, its building facts (a raised existing building),
     * the designations it lies in (`designations`: dataset names, or null while unread) and the
     * facts derived from the design and the place.
     */
    function factsFor(set, building, { cap, historic, designations = null, contract = null }) {
        const facts = { kind: { value: building.kind, source: 'design' } };
        if (contract?.found) for (const [name, fact] of Object.entries(contract.facts || {})) if (fact) facts[name] = fact;
        facts.designations = Array.isArray(designations) ? derived('designations', designations, { datasets: designations.join(', ') || '—' }) : derived('designationsUnread', null);
        const lowest = cap.lowest;
        facts.proposed_storeys = derived('proposedStoreys', building.storeys, { storeys: building.storeys ?? '?' });
        facts.storey_cap = derived(cap.value === null ? `storeyCapUnknown.${cap.reason}` : 'storeyCap', cap.value,
            { cap: cap.value ?? cap.bound ?? '?', density: lowest?.densityPerHa != null ? Math.round(lowest.densityPerHa) : '?', area: lowest ? `${lowest.name || lowest.code}` : '?' },
            cap.value === null && finite(cap.bound) ? { bound: cap.bound } : {});
        facts.historic_storeys = derived(historic.value === null ? `historicUnknown.${historic.reason}` : historic.value === false ? 'historicNone' : 'historicCap',
            historic.value, { storeys: set.historic.storeys, setbacks: set.historic.setbacks, count: historic.before1918 ?? '?', unknown: historic.unknownDates ?? '?' });
        facts.proposed_setbacks = derived('proposedSetbacks', building.setbacks, { setbacks: building.setbacks });
        // Para 31 allows one setback storey everywhere, para 32 a second where the cap is 4 or 5.
        const second = finite(cap.value) ? cap.value >= set.setbacks.second.minCap : null;
        facts.setbacks_allowed = derived('setbacksAllowed', second === null ? (building.setbacks <= 1 ? 1 : null) : second ? 2 : 1, { setbacks: second ? 2 : 1 });
        // The app's only setback storey is the mansard (rule-building-details.js): 0.38 m behind the
        // wall top, then 70°, so wholly under a 75° plane from the wall top.
        if (building.setbacks > 0) facts.setback_under_plane = derived('setbackMansard', building.roof === 'mansard' ? true : null, { degrees: set.setbacks.first.degrees });
        facts.storey_height_m = derived('storeyHeight', building.storeyHeightM, { metres: finite(building.storeyHeightM) ? Math.round(building.storeyHeightM * 100) / 100 : '?' });
        if (building.setbacks > 0) facts.setback_rise_m = derived('setbackRise', building.setbackRiseM, { metres: finite(building.setbackRiseM) ? Math.round(building.setbackRiseM * 100) / 100 : '?' });
        return facts;
    }
    // atMostFact against a limit known only as an upper bound (the cap without the street): a value
    // over the bound fails for certain.
    function judge(set, facts) {
        const E = eligibilityApi();
        const result = E.evaluate(set, facts);
        const tests = result.tests.map(test => {
            const definition = set.tests.find(entry => entry.id === test.id);
            const bound = definition?.check === 'atMostFact' ? facts[definition.limit]?.bound : null;
            const value = facts[definition?.fact]?.value;
            return test.status === 'unknown' && finite(bound) && finite(value) && value > bound ? { ...test, status: 'fail', value, limit: bound } : test;
        });
        const has = status => tests.some(test => test.status === status);
        return { ...result, verdict: has('fail') ? 'ineligible' : has('unknown') ? 'unknown' : 'eligible', tests };
    }

    // The datasets a set reads designations from.
    const datasetsOf = set => [...new Set(set.tests.filter(test => test.check === 'notInAreas').flatMap(test => test.datasets))];
    // A box around lines and geometries, grown by metres.
    function boxAround(lines, geometries, metres) {
        const points = [...lines.flat(), ...geometries.flatMap(geometry => ringsOf(geometry).flatMap(polygon => polygon[0] || []))];
        if (!points.length) return null;
        const lat = points[0][1], dy = metres / 110540, dx = metres / (111320 * Math.cos(lat * Math.PI / 180));
        return [Math.min(...points.map(p => p[0])) - dx, Math.min(...points.map(p => p[1])) - dy, Math.max(...points.map(p => p[0])) + dx, Math.max(...points.map(p => p[1])) + dy];
    }

    /**
     * The whole check of a plan against a street code. `designs`: the plan's design contents.
     * `street`: lines of [lng, lat] of the street the vote names, or null. `read`: the place's
     * readers, each optional (an absent or failing one leaves its facts unknown, with the error):
     *   density(bbox) → { areas, sources }   buildingsNear(bbox) → [{ id, geometry }]
     *   facts(ids) → Map id → contract building   designations(geometry, datasets) → [dataset]
     * Returns { set, street, cap, historic, buildings: [{ ...building, facts, result, contract }],
     * errors: [{ read, message }] }; a building's verdict follows the evaluator's.
     */
    async function check(set, { designs, street = null, read = {} }) {
        const errors = [];
        const attempt = async (name, run) => {
            try { return await run(); } catch (error) { errors.push({ read: name, message: error.message }); return null; }
        };
        const buildings = planBuildings(designs);
        const lines = street || [];
        const geometries = buildings.map(b => b.geometry).filter(Boolean);
        const densityBox = boxAround(lines, geometries, set.density.reachM + 50);
        const density = read.density && densityBox ? await attempt('density', () => read.density(densityBox)) : null;
        const cap = storeyCap(set, { areas: density ? density.areas : null, street, buildings });
        // Para 37: the buildings within reach of the street and their dates and storeys.
        let near = null;
        if (street && read.buildingsNear && read.facts) {
            near = await attempt('historic', async () => {
                const found = await read.buildingsNear(boxAround(lines, [], set.historic.reachM + 10));
                const ids = [...new Set(found.map(feature => factsApi().factIdOf(feature, feature.id)).filter(Boolean))];
                const answers = ids.length ? await read.facts(ids) : new Map();
                return found.map(feature => {
                    const answer = answers.get(factsApi().factIdOf(feature, feature.id));
                    return { id: feature.id, geometry: feature.geometry, built: answer?.facts?.built?.value || null, storeys: answer?.facts?.storeys?.value ?? null };
                });
            });
        }
        const historic = historicLimit(set, { street, near });
        const ids = [...new Set(buildings.map(b => b.factId).filter(Boolean))];
        const contracts = ids.length && read.facts ? await attempt('facts', () => read.facts(ids)) : null;
        // Designations: one read over the box around all the plan's buildings, then one per building
        // only where it found any. The box, not the buildings' outlines: a street's worth of outlines
        // is too long for the source's request (HTTP 414), and nothing in the box is nothing under them.
        const datasets = datasetsOf(set);
        let designationsOf = () => null;
        if (read.designations && geometries.length) {
            const points = geometries.flatMap(geometry => ringsOf(geometry).flatMap(polygon => polygon[0] || []));
            const [w, s, e, n] = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
            const all = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
            const found = await attempt('designations', () => read.designations(all, datasets));
            if (Array.isArray(found) && !found.length) designationsOf = () => [];
            else if (Array.isArray(found)) {
                const per = new Map();
                for (const building of buildings) {
                    per.set(building.key, building.geometry ? await attempt('designations', () => read.designations(building.geometry, found)) : null);
                }
                designationsOf = building => per.get(building.key) ?? null;
            }
        }
        const judged = buildings.map(building => {
            const contract = building.factId && contracts ? contracts.get(building.factId) || null : null;
            const facts = factsFor(set, building, { cap, historic, designations: designationsOf(building), contract });
            return { ...building, facts, contract, result: judge(set, facts) };
        });
        return { set: { id: set.id, version: set.version }, street: Boolean(street), cap, historic, buildings: judged,
            sources: density?.sources || [], errors };
    }

    // The tests a set states but the app cannot check, with their reason keys: listed once per plan.
    const unchecked = set => set.tests.filter(test => test.check === 'unchecked').map(test => ({ id: test.id, cite: test.cite, reason: test.reason || null }));

    // A plan's claimed codes this app knows (plan-record.js `codes`), as rule sets.
    function claimedCodes(plan) {
        const E = eligibilityApi();
        return (plan?.codes || []).map(code => E.get(code.id, code.version)).filter(set => set && set.kind === 'street-code');
    }

    // The words of a finished check for an agent or a log: per building, its verdict and each failing
    // or unknown test with the facts it read. `t` translates `planningViews.*`-style keys
    // (`eligibility.*`, `buildingFact.*`).
    function describe(set, outcome, t) {
        const E = eligibilityApi();
        return outcome.buildings.map(building => ({
            building: building.factId || `design ${building.design + 1}, building ${building.index + 1}`, kind: building.kind, verdict: building.result.verdict,
            tests: E.explain(set, building.result, building.contract, t, building.facts).map(test => ({ cite: test.cite, label: test.label, status: test.status, text: test.text,
                ...(test.link ? { link: test.link.url } : {}), ...(test.reason ? { reason: test.reason } : {}) }))
        }));
    }

    // ── the readers, the same in the browser and on the agents' server ──────────────────────
    const constraintsApi = () => root?.PlanningConstraintSources || require('./constraint-sources.js');
    const streetsApi = () => root?.StreetSegments || require('../streets/street-segments.js');
    const json = async (fetchFn, url, what) => {
        const response = await fetchFn(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${what} HTTP ${response.status}`);
        return response.json();
    };
    const bboxParam = bbox => bbox.map(value => value.toFixed(6)).join(',');
    /**
     * The readers a check needs, from planning-sources.json (`config`) and the place's planning rule
     * set ids: the density source the rule set names (`densitySourceId`, `densitySources`), its
     * constraint source for designations, the app's OSM buildings and streets, and building facts.
     * `backendBase`: the app's API; `sharedApi`: the shared API root (…/api); `readFacts(ids)`.
     */
    function readers({ fetch: fetchFn, backendBase, sharedApi, config, ruleSetIds, readFacts }) {
        const pairs = constraintsApi().ruleSetsFor(config, ruleSetIds || []);
        const withDensity = pairs.find(pair => pair.ruleSet.densitySourceId);
        const densitySource = withDensity ? (config.densitySources || []).find(source => source.id === withDensity.ruleSet.densitySourceId) : null;
        if (withDensity && !densitySource) throw new Error(`Rule set ${withDensity.ruleSet.id} names an unknown density source.`);
        const constraint = pairs[0]?.source || null;
        return {
            density: densitySource ? async bbox => {
                if (densitySource.adapter !== 'shared-api-small-areas') throw new Error(`Unknown density adapter: ${densitySource.adapter}`);
                const answer = await json(fetchFn, `${sharedApi}${densitySource.path}?bbox=${bboxParam(bbox)}`, 'Density source');
                if (!Array.isArray(answer.areas)) throw new Error('Invalid density source answer');
                return { areas: answer.areas.filter(area => area.scheme === densitySource.scheme), sources: answer.sources || [], source: densitySource };
            } : undefined,
            // A read the source cut short is no count of the buildings there.
            buildingsNear: async bbox => {
                const answer = await json(fetchFn, `${backendBase}/buildings/osm?bbox=${bboxParam(bbox)}`, 'OSM buildings');
                if (answer.partial || answer.truncated || !Array.isArray(answer.features)) throw new Error('The buildings near the street could not all be read.');
                return answer.features;
            },
            facts: readFacts,
            designations: constraint ? async (geometry, datasets) => {
                const read = await constraintsApi().readMembership(constraint, { geometry, datasets, fetch: fetchFn });
                if (read.partial) throw new Error('The designations could not all be read.');
                return [...new Set(read.areas.map(area => area.dataset))].sort();
            } : undefined,
            // The lines of a recorded street reference; `box` (WGS84) finds a whole street by name.
            street: async (reference, box) => {
                const at = reference.part === 'segment' ? `point=${reference.from.point[0].toFixed(7)},${reference.from.point[1].toFixed(7)}`
                    : `name=${encodeURIComponent(reference.name)}&bbox=${bboxParam(box)}`;
                const answer = await json(fetchFn, `${backendBase}/streets/segments?${at}`, 'Street');
                const found = streetsApi().linesFor(reference, answer);
                if (!found) throw new Error(`The street read there is not ${reference.name}.`);
                return found;
            }
        };
    }
    // A whole street is found by name within its plan's box, at most 0.04° (the street read's limit).
    function streetBox(designs) {
        const box = boxAround([], planBuildings(designs).map(b => b.geometry).filter(Boolean), 300);
        if (!box) return null;
        const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], half = 0.0199;
        return [Math.max(box[0], mid[0] - half), Math.max(box[1], mid[1] - half), Math.min(box[2], mid[0] + half), Math.min(box[3], mid[1] + half)];
    }
    /**
     * Read a vote's street and check a plan against one code: `reference` is the voting record's
     * street (or null), `read` from readers(). Returns check()'s answer with `streetApproximate`.
     */
    async function checkPlan(set, { designs, reference = null, read }) {
        let street = null, approximate = false, streetError = null;
        if (reference && read.street) {
            try { const found = await read.street(reference, streetBox(designs)); street = found.lines; approximate = found.approximate; }
            catch (error) { streetError = { read: 'street', message: error.message }; }
        }
        const outcome = await check(set, { designs, street, read });
        return { ...outcome, streetApproximate: approximate, errors: streetError ? [streetError, ...outcome.errors] : outcome.errors };
    }

    return { planBuildings, capOf, storeyCap, historicLimit, factsFor, judge, check, checkPlan, readers, unchecked, claimedCodes, describe, datasetsOf, areaToLines, projector };
});
