// A plan as a Compare side without applying it. The members an applied design stands for are already
// in the scene; the rest ("unapplied members") are read the way Plan stats reads a plan (PlanAnalysis:
// exact members, their source parcels, a private fabric) and drawn by the two Compare renderers on
// that plan's side alone, with the standing buildings they clear taken off that side by the demolition
// scan's rule (PresentState.clearance). Nothing is applied, stored or replayed. The pure rules come
// first and are unit tested; the browser part loads each plan once and tells the renderers when it is
// ready (window event `compareunappliedchange`).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CompareUnapplied = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // The ids a plan side shows, in member order: an applied copy by its proposal id, a member without
    // one by its design CID (the plan draws it itself). plan: { content: { designCids }, designs?:
    // [{ cid, proposalId, localId }] } (designs when the plan was resolved on this device);
    // applied: [{ id, cid }] for every applied design, cid null when it has none.
    function membersOf(plan, applied) {
        const members = [], unapplied = [];
        const resolved = new Map((plan?.designs || []).map(member => [String(member.cid), member]));
        for (const cid of (plan?.content?.designCids || []).map(String)) {
            const member = resolved.get(cid);
            const copies = [member?.proposalId, member?.localId].filter(value => value != null).map(String);
            const match = (applied || []).find(design => (design.cid != null && String(design.cid) === cid) || copies.includes(String(design.id)));
            if (match) members.push(String(match.id));
            else { members.push(cid); unapplied.push(cid); }
        }
        return { members, unapplied };
    }

    // The footprints an unapplied member draws on the map, each with what it is: its buildings, its
    // road's corridor, or its park, square, lake or station ground.
    function footprintsOf(record) {
        const out = [];
        const feature = (kind, geometry, properties = {}) => {
            if (!geometry) return;
            if (geometry.type === 'Feature') out.push({ kind, feature: geometry });
            else out.push({ kind, feature: { type: 'Feature', properties, geometry } });
        };
        for (const building of record?.geometry?.buildings || record?.buildingProposal?.buildings || []) feature('building', building);
        feature('road', record?.roadProposal?.definition?.polygon);
        feature('structure', record?.structureProposal?.geometry, { kind: record?.structureProposal?.kind || null });
        return out;
    }

    // The members of a loaded plan that a side draws itself, each with the ground it clears: snapshot
    // is PlanAnalysis.prepare's result, unapplied the member CIDs no applied design stands for,
    // collectRegions(rows, pieces) the demolition scan's regions ([{ key: proposalId, geometry }]) for
    // building and structure members. A road clears its corridor footprint.
    function unappliedPart(snapshot, unapplied, collectRegions) {
        const wanted = new Set((unapplied || []).map(String));
        const rows = (snapshot?.records || []).filter(row => wanted.has(String(row.proposalId)));
        const scanned = new Map();
        for (const region of collectRegions(rows, snapshot?.materializedFeatures || []) || []) {
            const key = String(region.key);
            if (!scanned.has(key)) scanned.set(key, []);
            scanned.get(key).push({ type: 'Feature', properties: {}, geometry: region.geometry });
        }
        const clearing = rows.map(row => {
            const id = String(row.proposalId);
            const polygon = row.roadProposal?.definition?.polygon;
            const regions = [...(scanned.get(id) || []), ...(polygon ? [{ type: 'Feature', properties: {}, geometry: polygon }] : [])];
            return { id, regions };
        }).filter(entry => entry.regions.length);
        return { rows, clearing };
    }

    // What the unapplied members of a part do to one standing building footprint, as cuts
    // [{ by: { id, unapplied: true }, remainder }]: one per member that cuts or clears it, remainder
    // null when the member clears it. clearance(footprint, regions) is PresentState's rule.
    function cutsOf(part, footprint, clearance) {
        const cuts = [];
        for (const member of part?.clearing || []) {
            const { outcome, feature } = clearance(footprint, member.regions);
            if (outcome !== 'kept') cuts.push({ by: { id: member.id, unapplied: true }, remainder: feature?.geometry || null });
        }
        return cuts;
    }

    const pure = { membersOf, footprintsOf, unappliedPart, cutsOf };
    if (!global || !global.document) return Object.freeze(pure);

    // ── the browser: one read per plan, remembered for the page ─────────────────────────────────

    const entries = new Map();
    const log = (...args) => global.console.log(`[${new Date().toISOString()}] [compare-unapplied]`, ...args);

    function announce(cid, status) {
        global.dispatchEvent(new CustomEvent('compareunappliedchange', { detail: { cid, status } }));
    }

    // Starts reading a plan unless it is known already; the renderers learn the outcome by event.
    function load(plan) {
        const cid = String(plan?.cid || '');
        if (!cid || entries.has(cid)) return entries.get(cid) || null;
        const entry = { cid, status: 'loading', error: null, snapshot: null, parts: new Map() };
        entries.set(cid, entry);
        log(`reading ${plan.content?.title || cid}`);
        global.PlanAnalysis.prepare(plan).then(snapshot => {
            Object.assign(entry, { status: 'ready', snapshot });
            log(`${plan.content?.title || cid}: ${snapshot.records.length} members, ${snapshot.materializedFeatures.length} pieces`);
        }).catch(error => {
            Object.assign(entry, { status: 'failed', error: error?.message || String(error) });
            global.console.error(`[${new Date().toISOString()}] [compare-unapplied] ${plan.content?.title || cid} could not be read`, error);
        }).finally(() => announce(cid, entry.status));
        return entry;
    }

    // Reads a plan again after a failed read (the Compare tab's Retry).
    function retry(plan) {
        const cid = String(plan?.cid || '');
        if (entries.get(cid)?.status === 'failed') entries.delete(cid);
        return load(plan);
    }

    function status(cid) {
        const entry = entries.get(String(cid));
        return entry ? { status: entry.status, error: entry.error } : null;
    }

    // The demolition scan's regions for building and structure members, over the plan's own pieces.
    function collectRegions(rows, pieces) {
        return global.__demolitionPrefetch.collectDemolitionRegions(rows, {
            normalizeGoalKey: goal => global.__applyRoute.normalizeGoalKey(goal),
            parcelFeatures: proposal => {
                const ids = new Set((proposal.cadastreParcelIds || []).map(String));
                return pieces.filter(piece => (piece.properties?.cadastreParcelIds || []).some(id => ids.has(String(id))));
            },
            structureGeometry: proposal => proposal.structureProposal?.geometry
        });
    }

    // What a ready side draws itself and clears, for the side's current unapplied members (a plan's, or
    // a design that is not applied, read as a one-member plan): { rows, clearing, cutsOf(id, footprint) }
    // or null while its plan (side.readId) is not ready.
    function partOf(side) {
        const entry = side?.unapplied?.length ? entries.get(String(side.readId)) : null;
        if (!entry || entry.status !== 'ready') return null;
        const key = [...(side.unapplied || [])].map(String).sort().join('|');
        if (!entry.parts.has(key)) {
            const part = unappliedPart(entry.snapshot, side.unapplied, collectRegions);
            const boxes = part.clearing.map(member => ({ ...member, box: bboxOf(member.regions) }));
            const memo = new Map();
            // Memoised per building: the scan clips each footprint against every region of every member.
            part.cutsOf = (id, footprint) => {
                const name = String(id);
                if (!memo.has(name)) {
                    const near = { clearing: boxes.filter(member => !member.box || overlaps(member.box, footprint)) };
                    memo.set(name, near.clearing.length ? cutsOf(near, footprint, global.PresentState.clearanceOf) : []);
                }
                return memo.get(name);
            };
            entry.parts.set(key, part);
        }
        return entry.parts.get(key);
    }

    function bboxOf(features) {
        try { return global.turf.bbox({ type: 'FeatureCollection', features }); } catch (_) { return null; }
    }

    function overlaps([w, s, e, n], footprint) {
        try {
            const [fw, fs, fe, fn] = global.turf.bbox(footprint);
            return !(fe < w || fw > e || fn < s || fs > n);
        } catch (_) { return true; }
    }

    return Object.freeze({ ...pure, load, retry, status, partOf });
});
