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
    const planesApi = () => root?.LightPlanes || require('./light-planes.js');
    const roofApi = () => root?.__ruleBuildingDetails || require('../rule-building-details.js');
    const slicerApi = () => root?.__workSlicer || require('../work-slicer.js');

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
    // a line runs inside it.
    function areaToLines(polygons, lines) {
        let best = Infinity;
        for (const line of lines) {
            if (line.some(point => polygons.some(polygon => inPolygon(polygon, point)))) return 0;
            for (const polygon of polygons) for (const ring of polygon) {
                for (let i = 0; i < ring.length - 1; i++) for (let j = 0; j < line.length - 1 || (line.length === 1 && j === 0); j++) {
                    const a = line[j], b = line[Math.min(j + 1, line.length - 1)];
                    best = Math.min(best, segmentsApart(ring[i], ring[i + 1], a, b));
                    if (!best) return 0;
                }
            }
        }
        return best;
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
                    storeyHeightM, setbackRiseM: mansard ? measured.roofRiseM ?? null : null, heightM: positive(measured.heightM),
                    // The height the existing building already has: its volume is kept, never judged.
                    existingHeightM: existing ? positive(p.existingHeight) : null, siblings: features.filter(other => other !== feature) });
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
            return { area, under: areaToLines(polygons, footprints) === 0, near: lines.length ? areaToLines(polygons, lines) <= set.density.reachM : false };
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
        const apart = building => areaToLines(ringsOf(building.geometry).map(polygon => polygon.map(ring => ring.map(project))), lines);
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
    function factsFor(set, building, { cap, historic, designations = null, contract = null, planes = null }) {
        const facts = { kind: { value: building.kind, source: 'design' } };
        if (contract?.found) for (const [name, fact] of Object.entries(contract.facts || {})) if (fact) facts[name] = fact;
        facts.designations = Array.isArray(designations) ? derived('designations', designations, { datasets: designations.join(', ') || '—' }) : derived('designationsUnread', null);
        facts.storey_height_m = derived('storeyHeight', building.storeyHeightM, { metres: finite(building.storeyHeightM) ? Math.round(building.storeyHeightM * 100) / 100 : '?' });
        // The light planes and heights a set's planes and `tallest` derive (planeFacts below).
        if (planes) Object.assign(facts, planes);
        if (!set.density) return facts;
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

    // ── light planes and heights (a set's `planes` and `tallest`) ─────────────────────────────
    // Where a plane rises from (eligibility.js `planes.*.from`): the block's edge and plots need the
    // vote's block; the others read the plots around the plan's buildings.
    const BLOCK_BASES = ['blockEdge', 'blockPlots'];
    const AROUND_M = 60;
    const planeSpecs = set => Object.entries(set.planes || {});
    const polygonsOf = (geometry, project) => ringsOf(geometry).map(polygon => polygon.map(ring => ring.map(project)));
    // A plan building's massing in local metres: its walls, and its roof (pitched or mansard) as the
    // app draws it (rule-building-details.js roofFrame), with the design's other buildings as party
    // walls. A building of unknown height has no top; an existing one keeps the volume it has.
    function massingOf(building, project) {
        const polygons = polygonsOf(building.geometry, project);
        const walls = building.heightM;
        let topAt = () => (finite(walls) ? walls : null);
        const kind = ['pitched', 'mansard'].includes(building.roof) ? building.roof : null;
        if (kind && finite(walls) && polygons.length) {
            const details = roofApi();
            const ring = details.ccw(polygons.slice().sort((a, b) => Math.abs(details.signedArea(b[0])) - Math.abs(details.signedArea(a[0])))[0][0]);
            const neighbours = (building.siblings || []).flatMap(other => ringsOf(other.geometry).map(polygon => polygon[0].map(project)));
            const frame = details.roofFrame(ring, { party: details.partyEdges(ring, neighbours, 1), metresPerUnit: 1, kind });
            if (frame) topAt = p => walls + details.roofHeightAt(frame, p[0], p[1]);
        }
        return { polygons, topAt, exemptBelowM: building.kind === 'existing' ? building.existingHeightM ?? null : 0 };
    }
    // One plane against several protected plots: pierced over any of them names it; unknown when one
    // is unknown and none is pierced.
    function combine(results) {
        const pierced = results.filter(row => row.result.status === 'pierced');
        if (pierced.length) return { status: 'pierced', parcels: pierced.map(row => row.id).filter(Boolean).sort(), clearM: Math.min(...pierced.map(row => row.result.clearM)) };
        if (results.some(row => row.result.status === 'unknown')) return { status: 'unknown', reason: 'topUnknown', parcels: [] };
        return { status: 'clear', parcels: [] };
    }
    /**
     * The plane and height facts of each plan building under a set (`plane_<name>`, `proposed_top_m`,
     * `tallest_existing_m`). Reads, all awaited: the vote's block plots, the plots around the plan and
     * the existing buildings with their building facts. The geometry runs in slices that hand the
     * browser back its thread (work-slicer.js), so a long street never freezes the page.
     * Returns Map building key → facts.
     */
    async function planeFacts(set, { buildings, street = null, block = null, read, attempt, slicer }) {
        const P = planesApi(), S = slicerApi();
        const out = new Map(buildings.map(building => [building.key, {}]));
        const specs = planeSpecs(set);
        if (!specs.length && !set.tallest) return out;
        const geometries = buildings.map(b => b.geometry).filter(Boolean);
        const origin = centreOf(geometries);
        if (!origin) return out;
        const project = projector(origin[0], origin[1]);
        const unknownAll = (name, reason) => { for (const facts of out.values()) facts[`plane_${name}`] = derived(`planeUnknown.${reason}`, { status: 'unknown', reason, parcels: [] }); };
        const plotRows = rows => (rows || []).filter(row => row?.geometry).map(row => ({ id: String(row.id), polygons: polygonsOf(row.geometry, project) }));
        const wantsBlock = specs.some(([, spec]) => BLOCK_BASES.includes(spec.from)) || set.tallest;
        const wantsAround = specs.some(([, spec]) => !BLOCK_BASES.includes(spec.from));
        const blockRows = wantsBlock && block && read.plots ? await attempt('plots', () => read.plots({ parcelSourceId: block.parcelSourceId, parcelIds: block.parcelIds })) : null;
        const blockPlots = blockRows ? plotRows(blockRows) : null;
        const aroundBox = boxAround([], geometries, AROUND_M);
        const aroundRows = wantsAround && read.plots ? await attempt('plots', () => read.plots({ bbox: aroundBox })) : null;
        const aroundPlots = aroundRows ? plotRows(aroundRows) : null;
        // The existing buildings around, with their heights where a source states them (never guessed).
        let existing = null;
        if (read.buildingsNear && read.facts) {
            existing = await attempt('buildings', async () => {
                const blockBox = blockRows?.length ? boxAround([], [...geometries, ...blockRows.map(row => row.geometry)], 5) : null;
                const found = await read.buildingsNear(blockBox || aroundBox);
                const ids = [...new Set(found.map(feature => factsApi().factIdOf(feature, feature.id)).filter(Boolean))];
                const answers = ids.length ? await read.facts(ids) : new Map();
                return found.filter(feature => feature?.geometry).map(feature => {
                    const id = factsApi().factIdOf(feature, feature.id);
                    return { id: id || String(feature.id), polygons: polygonsOf(feature.geometry, project), heightM: positive(answers.get(id)?.facts?.height_m?.value) };
                });
            });
        }
        const massings = new Map(buildings.map(building => {
            const massing = massingOf(building, project);
            // Its footprint points and box, sampled once: which plots it stands on is read from them.
            const points = P.massingPoints(massing.polygons);
            return [building.key, { ...massing, points, box: P.boxOf(points) }];
        }));
        const boxOfPlot = new Map();
        const plotBox = plot => { if (!boxOfPlot.has(plot)) boxOfPlot.set(plot, P.boxOf(plot.polygons.flatMap(polygon => polygon[0]))); return boxOfPlot.get(plot); };
        const near = (a, b, m = 1) => a[0] <= b[2] + m && a[2] >= b[0] - m && a[1] <= b[3] + m && a[3] >= b[1] - m;
        // A building stands on a plot when some of its footprint points lie inside it.
        const standsOn = (plot, massing) => near(plotBox(plot), massing.box) && massing.points.some(p => P.inPolygons(plot.polygons, p) && P.edgeDistance(plot.polygons, p) > P.TOLERANCE_M);
        // Existing buildings the plan raises, or that a new building stands over, are the plan's own.
        const ownSources = new Set(buildings.map(b => b.factId).filter(Boolean));
        const others = building => (existing || []).filter(row => !ownSources.has(row.id)
            && !(building.kind === 'new' && P.standsOn(row.polygons, massings.get(building.key).polygons)));
        const inBlockCache = new Map();
        const inBlock = row => {
            if (!inBlockCache.has(row)) { const pts = P.massingPoints(row.polygons, 2), box = P.boxOf(pts); inBlockCache.set(row, blockPlots.some(plot => standsOn(plot, { points: pts, box }))); }
            return inBlockCache.get(row);
        };
        const sliced = steps => S.runSliced(steps, slicer);
        for (const [name, spec] of specs) {
            const plots = BLOCK_BASES.includes(spec.from) ? blockPlots : aroundPlots;
            if (BLOCK_BASES.includes(spec.from) && !block) { unknownAll(name, 'noBlock'); continue; }
            if (!plots || !plots.length) { unknownAll(name, 'plotsUnread'); continue; }
            if (spec.from === 'otherStreetPlots' && !street) { unknownAll(name, 'noStreet'); continue; }
            const plane = base => ({ base, baseHeightM: 0, angle: spec.angle, raisers: [] });
            const edge = spec.from === 'blockEdge' ? P.outerEdge(plots) : null;
            const along = spec.from === 'otherStreetPlots' ? new Set(street.flatMap(line => line.length > 1 ? streetsApi().plotsAlong({ coordinates: line,
                parcels: aroundRows.map(row => ({ id: String(row.id), geometry: row.geometry })) }).map(row => row.id) : [])) : null;
            for (const building of buildings) {
                const massing = massings.get(building.key);
                const own = plots.filter(plot => standsOn(plot, massing)).map(plot => plot.id);
                const otherBuildings = others(building);
                await slicer.checkpoint();
                let fact;
                if (spec.from === 'blockEdge') {
                    const around = otherBuildings.filter(row => blockPlots.length && inBlock(row));
                    const raisers = spec.raisedBy === 'existing' ? around.filter(row => finite(row.heightM)).map(row => P.raiser(row.polygons, row.heightM)) : [];
                    const result = await sliced(P.checkSteps({ ...plane(edge), raisers }, massing));
                    // Pierced under the raised line we know, but a building of unknown height in between could raise it more.
                    const unsure = result.status === 'pierced' && spec.raisedBy === 'existing' && around.some(row => !finite(row.heightM));
                    fact = unsure ? { status: 'unknown', reason: 'raisersUnknown', parcels: [] } : { ...result, parcels: [] };
                } else {
                    if (!own.length && spec.from === 'neighbourPlots') { fact = { status: 'unknown', reason: 'ownPlotUnknown', parcels: [] }; }
                    else {
                        // Only plots near enough for a plane from them to reach the building.
                        const reach = (Math.max(0, ...massing.points.map(p => massing.topAt(p) ?? 0)) + 1) / Math.tan(Math.min(...[spec.angle].flat().map(a => (typeof a === 'number' ? a : Math.min(a.northOfEastWest, a.fromSouth.base)))) * Math.PI / 180);
                        let protectedPlots = plots.filter(plot => !own.includes(plot.id) && near(plotBox(plot), massing.box, reach));
                        if (spec.from === 'neighbourPlots') {
                            const ownPolygons = plots.filter(plot => own.includes(plot.id)).flatMap(plot => plot.polygons);
                            protectedPlots = protectedPlots.filter(plot => P.apart(ownPolygons, plot.polygons) <= 0.5);
                            // Para 52 protects only a neighbour whose house is not attached to this one.
                            if (spec.unattached) protectedPlots = protectedPlots.filter(plot => !otherBuildings.some(row => P.standsOn(plot.polygons, row.polygons) && P.apart(massing.polygons, row.polygons) <= 0.5));
                        }
                        if (along) protectedPlots = protectedPlots.filter(plot => !along.has(plot.id));
                        const results = [];
                        for (const plot of protectedPlots) { results.push({ id: plot.id, result: await sliced(P.checkSteps(plane(P.boundaryPoints(plot.polygons)), massing)) }); await slicer.checkpoint(); }
                        fact = combine(results);
                    }
                }
                const key = fact.status === 'clear' ? 'planeClear' : fact.status === 'pierced' ? 'planePierced' : `planeUnknown.${fact.reason || 'topUnknown'}`;
                out.get(building.key)[`plane_${name}`] = derived(key, fact, { degrees: finite(spec.angle) ? spec.angle : '35–45', parcels: (fact.parcels || []).join(', ') || '—',
                    metres: finite(fact.clearM) ? Math.abs(Math.round(fact.clearM * 10) / 10) : '?' });
                await slicer.checkpoint();
            }
        }
        if (set.tallest) {
            for (const building of buildings) {
                const massing = massings.get(building.key);
                const tops = massing.points.map(massing.topAt);
                const top = tops.length && tops.every(finite) ? Math.max(...tops) : null;
                out.get(building.key).proposed_top_m = derived('proposedTop', top, { metres: finite(top) ? Math.round(top * 10) / 10 : '?' });
                const onBlock = blockPlots && existing ? existing.filter(row => inBlock(row)) : null;
                // Their own existing heights count too: a raised building was that high.
                const heights = onBlock ? [...onBlock.map(row => row.heightM), ...buildings.filter(b => b.kind === 'existing').map(b => b.existingHeightM)] : [];
                const known = heights.filter(finite);
                const value = onBlock && known.length === heights.length && known.length ? Math.max(...known) : null;
                out.get(building.key).tallest_existing_m = derived(value === null ? (onBlock ? 'tallestPartly' : 'tallestUnread') : 'tallestExisting', value,
                    { metres: known.length ? Math.round(Math.max(...known) * 10) / 10 : '?', over: set.tallest.overM, unknown: heights.length - known.length },
                    value === null && known.length ? { bound: Math.max(...known) } : {});
                await slicer.checkpoint();
            }
        }
        return out;
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
    async function check(set, { designs, street = null, block = null, read = {}, slicer = slicerApi().createSlicer() }) {
        const errors = [];
        const attempt = async (name, run) => {
            try { return await run(); } catch (error) { errors.push({ read: name, message: error.message }); return null; }
        };
        const buildings = planBuildings(designs);
        const lines = street || [];
        const geometries = buildings.map(b => b.geometry).filter(Boolean);
        // A set's density cap and historic limit (Strong Suburbs paras 30 and 37) only where it states them.
        const densityBox = set.density ? boxAround(lines, geometries, set.density.reachM + 50) : null;
        const density = read.density && densityBox ? await attempt('density', () => read.density(densityBox)) : null;
        const cap = set.density ? storeyCap(set, { areas: density ? density.areas : null, street, buildings }) : null;
        // Para 37: the buildings within reach of the street and their dates and storeys.
        let near = null;
        if (set.historic && street && read.buildingsNear && read.facts) {
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
        const historic = set.historic ? historicLimit(set, { street, near }) : null;
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
        const planes = await planeFacts(set, { buildings, street, block, read, attempt, slicer });
        const judged = buildings.map(building => {
            const contract = building.factId && contracts ? contracts.get(building.factId) || null : null;
            const facts = factsFor(set, building, { cap, historic, designations: designationsOf(building), contract, planes: planes.get(building.key) });
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
    function readers({ fetch: fetchFn, backendBase, sharedApi, config, ruleSetIds, readFacts, readPlots = null }) {
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
            // Plots ({ bbox } or { parcelSourceId, parcelIds }) → [{ id, geometry }], from the map's
            // parcels in the browser and the parcel source on the agents' server.
            ...(readPlots ? { plots: readPlots } : {}),
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
    async function checkPlan(set, { designs, reference = null, block = null, read }) {
        let street = null, approximate = false, streetError = null;
        if (reference && read.street) {
            try { const found = await read.street(reference, streetBox(designs)); street = found.lines; approximate = found.approximate; }
            catch (error) { streetError = { read: 'street', message: error.message }; }
        }
        const outcome = await check(set, { designs, street, block, read });
        return { ...outcome, streetApproximate: approximate, errors: streetError ? [streetError, ...outcome.errors] : outcome.errors };
    }

    return { planBuildings, capOf, storeyCap, historicLimit, factsFor, judge, check, checkPlan, readers, unchecked, claimedCodes, describe, datasetsOf, areaToLines, projector };
});
