#!/usr/bin/env node
// Evidence behind rethink-proposals.md. Fetches a shared plan from the proposals API and answers
// three questions about it, purely from geometry — no local state, no browser, writes nothing:
//
//   1. base ancestry    — does every proposal anchor to real cadastral parcels on its own?
//   2. pairwise overlap — do proposals actually intersect, or merely share a base parcel?
//   3. commutativity    — does the resulting fabric depend on the order steps are applied in?
//
// Usage:  node scripts/analyze-plan-ancestry.js --ids 97-104 [--api https://api.urbangametheory.xyz]

const turf = require('../backend/node_modules/@turf/turf');

const DEFAULT_API = 'https://api.urbangametheory.xyz';
const MIN_PIECE = 1;      // m² — below this a remainder is a rounding sliver, not a parcel
const MIN_INTERSECT = 2;  // m² — below this an intersection is shared-border noise
const FABRIC_GOALS = new Set(['reparcellization', 'road-track']);

let opErrors = 0;
const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { opErrors++; return fallback; } };

// --- WGS84 -> HTRS96/TM (EPSG:3765), inlined so this script needs no proj4 -------------------
// +proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80
// Verified against proj4 on this plan's bbox corners: agreement < 0.001 m.
function wgs84ToHtrs96(lon, lat) {
    const a = 6378137.0, f = 1 / 298.257222101;           // GRS80
    const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const k0 = 0.9999, lon0 = 16.5 * Math.PI / 180, x0 = 500000;
    const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - lon0;

    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const T = Math.tan(phi) ** 2;
    const C = ep2 * Math.cos(phi) ** 2;
    const A = Math.cos(phi) * lam;

    const e4 = e2 * e2, e6 = e4 * e2;
    const M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
        + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
        - (35 * e6 / 3072) * Math.sin(6 * phi));

    const x = x0 + k0 * N * (A + (1 - T + C) * A ** 3 / 6
        + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
    const y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [x, y];
}

// --- geometry helpers -------------------------------------------------------------------------
function explode(feature) {
    if (!feature || !feature.geometry) return [];
    const g = feature.geometry;
    if (g.type === 'Polygon') return [turf.feature(g)];
    if (g.type === 'MultiPolygon') return g.coordinates.map(c => turf.polygon(c));
    return [];
}

function unionAll(features) {
    if (!features.length) return null;
    let acc = features[0];
    for (let i = 1; i < features.length; i++) acc = safe(() => turf.union(acc, features[i]), acc) || acc;
    return acc;
}

// A proposal's own footprint, independent of any parcel bookkeeping.
function footprintOf(d) {
    const polys = [];
    const push = g => {
        if (!g) return;
        const geom = g.type === 'Feature' ? g.geometry : g;
        if (geom && /Polygon/.test(geom.type || '')) polys.push(turf.feature(geom));
    };
    if (d.reparcellization && Array.isArray(d.reparcellization.polygons)) d.reparcellization.polygons.forEach(p => push(p.geometry));
    if (d.definition && d.definition.polygon) push(d.definition.polygon);
    if (d.geometry && /Polygon/.test(d.geometry.type || '')) push(d.geometry);
    if (d.buildingGeometry) push(d.buildingGeometry);
    if (d.geometry && Array.isArray(d.geometry.buildings)) d.geometry.buildings.forEach(push);
    return unionAll(polys);
}

// --- fabric replay ----------------------------------------------------------------------------
// Each step cuts the CURRENT fabric, which is what apply does.
function applyRoad(fabric, op) {
    const out = [];
    let taken = 0;
    fabric.forEach(p => {
        const hit = safe(() => turf.intersect(p, op.corridor));
        if (!hit) { out.push(p); return; }
        taken += turf.area(hit);
        explode(safe(() => turf.difference(p, op.corridor))).forEach(piece => {
            if (turf.area(piece) >= MIN_PIECE) out.push(piece);
        });
    });
    return { fabric: out, road: taken };
}

function applyReparcel(fabric, op) {
    const area = unionAll(op.pieces);
    const out = [];
    fabric.forEach(p => {
        if (!safe(() => turf.intersect(p, area))) { out.push(p); return; }
        explode(safe(() => turf.difference(p, area))).forEach(piece => {
            if (turf.area(piece) >= MIN_PIECE) out.push(piece);
        });
    });
    op.pieces.forEach(piece => out.push(piece));
    return { fabric: out, road: 0 };
}

function replay(base, order) {
    let fabric = base.slice(), road = 0;
    for (const op of order) {
        const r = op.kind === 'road' ? applyRoad(fabric, op) : applyReparcel(fabric, op);
        fabric = r.fabric; road += r.road;
    }
    const areas = fabric.map(f => Math.round(turf.area(f))).filter(a => a >= MIN_PIECE).sort((a, b) => a - b);
    return { count: areas.length, total: areas.reduce((s, a) => s + a, 0), road: Math.round(road), areas };
}

const permutations = arr => arr.length <= 1 ? [arr]
    : arr.flatMap((v, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [v, ...p]));

// --- cli --------------------------------------------------------------------------------------
function parseArgs(argv) {
    const args = { ids: '97-104', api: DEFAULT_API };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--ids') args.ids = argv[++i];
        else if (argv[i] === '--api') args.api = argv[++i];
        else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    }
    return args;
}

function expandIds(spec) {
    return spec.split(',').flatMap(part => {
        const m = part.trim().match(/^(\d+)-(\d+)$/);
        if (!m) return [Number(part.trim())];
        const out = [];
        for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
        return out;
    }).filter(Number.isFinite);
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(`Analyze a shared plan's parcel ancestry, overlap and order-dependence.

  --ids  <spec>   proposal ids, e.g. "97-104" or "97,98,100" (default: 97-104)
  --api  <url>    proposals API base (default: ${DEFAULT_API})

Read-only. Fetches proposals and cadastral parcels; writes nothing.`);
        return;
    }

    const ids = expandIds(args.ids);
    console.log(`Fetching ${ids.length} proposals from ${args.api} …\n`);
    const raw = await Promise.all(ids.map(async id => {
        const r = await fetch(`${args.api}/proposals/${id}`);
        if (!r.ok) throw new Error(`proposal ${id}: HTTP ${r.status}`);
        return { id, d: await r.json() };
    }));

    const proposals = raw.map(({ id, d }) => {
        const op = {
            id, title: d.title, goal: d.goal, createdAt: d.createdAt,
            declared: d.parentParcelIds || [], children: new Set(d.childParcelIds || []),
            footprint: footprintOf(d), kind: 'overlay'
        };
        if (d.reparcellization && Array.isArray(d.reparcellization.polygons)) {
            op.kind = 'reparcel';
            op.pieces = d.reparcellization.polygons.map(p => turf.feature(p.geometry)).filter(f => f.geometry);
        } else if (d.definition && d.definition.polygon) {
            op.kind = 'road';
            const pg = d.definition.polygon;
            op.corridor = turf.feature(pg.type === 'Feature' ? pg.geometry : pg);
        }
        op.area = op.footprint ? Math.round(turf.area(op.footprint)) : 0;
        return op;
    });

    const withGeom = proposals.filter(p => p.footprint);
    if (withGeom.length !== proposals.length) {
        console.log('!! no footprint for:', proposals.filter(p => !p.footprint).map(p => '#' + p.id).join(', '), '\n');
    }

    // Base cadastre over the plan's extent.
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(turf.featureCollection(withGeom.map(p => p.footprint)));
    const pad = 0.002;
    const sw = wgs84ToHtrs96(minLon - pad, minLat - pad);
    const ne = wgs84ToHtrs96(maxLon + pad, maxLat + pad);
    const bbox = [sw[0], sw[1], ne[0], ne[1]].map(Math.round).join(',');
    const fc = await (await fetch(`${args.api}/parcels?bbox=${encodeURIComponent(bbox)}`)).json();
    const base = (fc.features || [])
        .filter(f => f.geometry && /Polygon/.test(f.geometry.type))
        .map(f => ({ id: f.properties.parcelId, f: turf.feature(f.geometry) }));
    console.log(`Base cadastre in plan extent: ${base.length} parcels`);
    if (!base.length) { console.log('!! empty cadastre fetch — check the bbox/projection'); return; }

    // === 1. base ancestry =====================================================================
    console.log('\n=== 1. declared vs recomputed base ancestry ===');
    const isDerived = id => String(id).includes('#');
    withGeom.forEach(p => {
        p.baseParents = [];
        base.forEach(b => {
            const inter = safe(() => turf.intersect(p.footprint, b.f));
            if (!inter) return;
            const a = turf.area(inter);
            if (a >= MIN_INTERSECT) p.baseParents.push({ id: b.id, area: Math.round(a) });
        });
        p.baseParents.sort((x, y) => y.area - x.area);
        const derived = p.declared.filter(isDerived).length;
        console.log(`#${p.id} ${p.title} [${p.goal}]`);
        console.log(`   declared : ${p.declared.length} (${derived} derived, ${p.declared.length - derived} base)`);
        console.log(`   base only: ${p.baseParents.map(b => `${b.id} (${b.area} m2)`).join(', ') || '(none)'}`);
    });
    const orphans = withGeom.filter(p => !p.baseParents.length);
    console.log(`\n   proposals with no base anchor: ${orphans.length ? orphans.map(p => '#' + p.id).join(', ') : 'none'}`);

    // === 2. ghost references and cycles =======================================================
    console.log('\n=== 2. derived-parent references ===');
    const tokenOf = new Map();
    proposals.forEach(p => p.children.forEach(c => {
        const m = String(c).match(/#(.+)-\d+$/);
        if (m) tokenOf.set(m[1], p.id);
    }));
    const edges = [];
    proposals.forEach(p => p.declared.filter(isDerived).forEach(pid => {
        const m = String(pid).match(/#(.+)-\d+$/);
        const from = m ? tokenOf.get(m[1]) : null;
        if (!from || from === p.id) return;
        edges.push([from, p.id, pid, !proposals.find(x => x.id === from).children.has(pid)]);
    }));
    edges.forEach(([f, t, pid, ghost]) =>
        console.log(`   #${f} -> #${t}   (via ${pid})${ghost ? '   << GHOST: creator no longer mints this id' : ''}`));
    console.log(`   ghost references: ${edges.filter(e => e[3]).length}/${edges.length}`);
    const cyc = new Set();
    edges.forEach(([f, t]) => { if (edges.some(([f2, t2]) => f2 === t && t2 === f)) cyc.add([f, t].sort().join(' <-> #')); });
    console.log(`   cycles: ${[...cyc].map(c => '#' + c).join(', ') || 'none'}`);

    // === 3. pairwise geometric intersection ===================================================
    console.log('\n=== 3. pairwise geometric intersection ===');
    let pairs = 0;
    for (let i = 0; i < withGeom.length; i++) for (let j = i + 1; j < withGeom.length; j++) {
        const a = withGeom[i], b = withGeom[j];
        const inter = safe(() => turf.intersect(a.footprint, b.footprint));
        const area = inter ? Math.round(turf.area(inter)) : 0;
        if (area < MIN_INTERSECT) continue;
        pairs++;
        const bothFabric = FABRIC_GOALS.has(a.goal) && FABRIC_GOALS.has(b.goal);
        console.log(`   #${a.id} x #${b.id}  ${area} m2 (${Math.round(100 * area / Math.min(a.area, b.area))}% of smaller)`
            + `  [${bothFabric ? 'FABRIC vs FABRIC' : 'involves overlay'}]  ${a.title} / ${b.title}`);
    }
    if (!pairs) console.log('   (none)');

    // === 4. commutativity =====================================================================
    console.log('\n=== 4. does apply order change the fabric? ===');
    const fabricOps = proposals.filter(p => p.kind !== 'overlay');
    console.log(`   fabric-changers: ${fabricOps.map(o => '#' + o.id + ' ' + o.kind).join(', ')}`);
    console.log(`   overlays (no fabric effect): ${proposals.filter(p => p.kind === 'overlay').map(o => '#' + o.id).join(', ')}`);
    if (fabricOps.length > 7) { console.log(`   !! ${fabricOps.length}! permutations is too many — skipping`); return; }

    const planArea = unionAll(fabricOps.map(o => o.kind === 'road' ? o.corridor : unionAll(o.pieces)));
    const touched = base.flatMap(b => explode(b.f)).filter(f => safe(() => turf.intersect(f, planArea)));
    console.log(`   base parcels touched: ${touched.length} (${Math.round(touched.reduce((s, f) => s + turf.area(f), 0))} m2)`);

    const orders = permutations(fabricOps);
    const seen = new Map();
    orders.forEach(order => {
        const sig = replay(touched, order);
        const key = `${sig.count}|${sig.total}|${sig.road}|${sig.areas.join(',')}`;
        if (!seen.has(key)) seen.set(key, { sig, orders: [] });
        seen.get(key).orders.push(order.map(o => '#' + o.id).join(' -> '));
    });
    console.log(`   replayed ${orders.length} permutations -> ${seen.size} distinct fabric(s)\n`);
    let n = 0;
    for (const [, v] of seen) {
        console.log(`   result ${++n}: ${v.sig.count} parcels, ${v.sig.total} m2, road ${v.sig.road} m2  (${v.orders.length} order(s), e.g. ${v.orders[0]})`);
    }

    // === 5. A7: what would forming each footprint into its own parcel cost? ===================
    console.log('\n=== 5. parcel formation: merge U cut, and what it leaves behind ===');
    const planOrder = require('../frontend/js/proposals/plan-order.js');
    globalThis.turf = turf;
    const baseEntries = base.map(b => ({ id: b.id, feature: b.f }));
    let totalSlivers = 0, totalShattered = 0, totalUncovered = 0;
    withGeom.forEach(p => {
        const plan = planOrder.formationPlan(p.footprint, baseEntries);
        const merged = plan.merged.length, cut = plan.cut.length;
        console.log(`#${p.id} ${p.title} [${p.goal}] target ${plan.targetM2} m2`);
        console.log(`   merge ${merged} whole parcel(s), cut ${cut}`
            + (plan.uncoveredM2 ? `, UNCOVERED ${plan.uncoveredM2} m2 (no cadastral land)` : ''));
        plan.cut.forEach(c => {
            const shape = c.pieces.map(x => `${x.areaM2} m2 c=${x.compactness}`).join(' + ');
            console.log(`     cut ${c.id} (parent c=${c.parentCompactness}): takes ${c.takenM2}, `
                + `leaves ${c.remainderM2} as ${c.pieces.length} piece(s) -> ${shape}`);
        });
        if (plan.tiny.length) console.log(`     !! ${plan.tiny.length} tiny remainder(s): ` +
            plan.tiny.map(x => `${x.id} ${x.areaM2} m2`).join(', '));
        if (plan.degraded.length) console.log(`     !! ${plan.degraded.length} degraded shape(s): ` +
            plan.degraded.map(x => `${x.id} c=${x.compactness} vs parent ${x.parentCompactness}`).join(', '));
        if (plan.shattered.length) console.log(`     !! ${plan.shattered.length} parcel(s) shattered into multiple pieces`);
        totalSlivers += plan.tiny.length + plan.degraded.length;
        totalShattered += plan.shattered.length;
        totalUncovered += plan.uncoveredM2 ? 1 : 0;
    });
    console.log(`\nFORMATION SUMMARY: ${totalSlivers} problem remainder(s), ${totalShattered} shattered parcel(s), `
        + `${totalUncovered} proposal(s) covering non-cadastral land, across ${withGeom.length} proposals`);

    console.log(`\ngeometry op errors: ${opErrors}`);
    console.log(`VERDICT: ${seen.size === 1
        ? 'fabric is IDENTICAL in every order — these changes commute'
        : `order matters — ${seen.size} distinct fabrics; compare against the pairwise intersections above`}`);
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
