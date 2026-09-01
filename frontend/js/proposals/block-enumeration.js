// Every block on the map, where a BLOCK is the ground enclosed by roads.
//
// The existing block detection grows one block outwards from a parcel you clicked, and calls it
// complete when every member is fully inside the viewport. That is the right test for a button —
// you are looking at the block — but it makes the answer depend on where the map happens to be
// framed, which is no basis for a batch. Here a block is complete when its OUTLINE is accounted for
// by corridors: walk the boundary and ask how much of it runs along a road.
//
// The arithmetic avoids unioning anything. A block's outline is the total perimeter of its members
// minus twice the boundaries they share with each other (each interior boundary is counted once
// from either side), so:
//
//     outline        = Σ perimeter(member) − 2 · Σ shared(member, member)
//     corridorTouch  = Σ shared(member, corridor)
//     enclosure      = corridorTouch / outline
//
// No polygon clipping, so nothing here can hit the sweep-line failures that unioning real cadastre
// produces — and it stays a pure function of numbers, testable without a map.
//
// Pure: coordinates must be in METRES, because every tolerance and every result is a length.
(function (global) {
    'use strict';

    const adjacency = () => (global.__parcelAdjacency)
        || (typeof require === 'function' ? require('../parcels/parcel-adjacency.js') : null);
    const blockTopology = () => (global.__parcelBlockTopology)
        || (typeof require === 'function' ? require('../parcels/block-topology.js') : null);

    const DEFAULTS = {
        // How much of a block's outline must run along a road before it counts as enclosed. Not 1.0:
        // a corner where three roads meet, a sliver of cadastre poking between two corridors, and
        // the metre or two a road's own remainder leaves behind all cost a little coverage without
        // making the block open.
        minEnclosure: 0.9,
        // A block of one tiny sliver is a cut remainder, not somewhere to put a building.
        minAreaM2: 200
    };

    // THE flood fill. Growing a block outwards from a parcel is one idea, and it was written out
    // three times in parcel-blocks.js — once plain inside countBlocks, once with viewport validity
    // folded in (floodfillBlock), once more as an animated walk. Adjacency already had a single
    // owner (parcels/parcel-adjacency.js); this gives the traversal one too, with whatever extra
    // rule a caller needs passed in as `canEnter` rather than baked into a fourth copy.
    //
    // `neighboursOf(id)` returns ids. Nothing here knows about layers, roads or the viewport.
    function floodComponents(startIds, neighboursOf, canEnter) {
        const seen = new Set();
        const components = [];
        const enter = typeof canEnter === 'function' ? canEnter : () => true;
        (Array.isArray(startIds) ? startIds : []).forEach(startId => {
            const start = String(startId);
            if (seen.has(start) || !enter(start)) return;
            const component = [];
            const queue = [start];
            seen.add(start);
            while (queue.length) {
                const id = queue.shift();
                component.push(id);
                (neighboursOf(id) || []).forEach(rawNext => {
                    const next = String(rawNext);
                    if (seen.has(next) || !enter(next)) return;
                    seen.add(next);
                    queue.push(next);
                });
            }
            components.push(component);
        });
        return components;
    }

    function perimeterOf(rings) {
        let total = 0;
        (Array.isArray(rings) ? rings : []).forEach(ring => {
            if (!Array.isArray(ring)) return;
            for (let i = 0; i + 1 < ring.length; i += 1) {
                const p = ring[i];
                const q = ring[i + 1];
                if (!Array.isArray(p) || !Array.isArray(q)) continue;
                total += Math.hypot(q[0] - p[0], q[1] - p[1]);
            }
        });
        return total;
    }

    /**
     * @param {Array<{id: string, rings: Array, areaM2: number, isCorridor: boolean, populated: boolean}>} parcels
     *        rings in METRES; areaM2 supplied by the caller (turf on the source feature) rather than
     *        derived here, so ring winding conventions cannot silently invert a block's area.
     * @returns {{blocks: Array, corridorCount: number, memberCount: number}}
     */
    function enumerateBlocks(parcels, options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const api = adjacency();
        const list = (Array.isArray(parcels) ? parcels : []).filter(entry => entry && entry.id);
        if (!api || !list.length) return { blocks: [], corridorCount: 0, memberCount: 0 };

        const byId = new Map(list.map(entry => [String(entry.id), entry]));
        const isCorridor = id => !!(byId.get(String(id)) || {}).isCorridor;
        const memberEntries = list.filter(entry => !entry.isCorridor);
        const corridorEntries = list.filter(entry => entry.isCorridor);

        // Keep raw land↔corridor adjacency for the enclosure measurement, but use the shared block
        // topology service for land↔land links. A cadastral land edge that lies under a live road
        // still contributes to neither side's block; raw adjacency alone would merge the blocks.
        const rawPairs = api.neighborPairs(
            list.map(entry => ({ id: String(entry.id), rings: entry.rings })),
            opts
        );
        const topology = blockTopology();
        const memberPairs = topology && typeof topology.neighborPairs === 'function'
            ? topology.neighborPairs(
                memberEntries.map(entry => ({ id: String(entry.id), rings: entry.rings })),
                corridorEntries.map(entry => ({ id: String(entry.id), rings: entry.rings })),
                opts
            )
            : rawPairs.filter(pair => !isCorridor(pair.a) && !isCorridor(pair.b));

        // Adjacency between members only — the flood fill must never cross a road, which is what
        // makes the component a block rather than the whole town.
        const memberLinks = new Map();
        const corridorTouch = new Map();
        const memberShared = new Map();
        const link = (a, b) => {
            if (!memberLinks.has(a)) memberLinks.set(a, new Set());
            memberLinks.get(a).add(b);
        };
        rawPairs.forEach(pair => {
            const a = String(pair.a);
            const b = String(pair.b);
            const aRoad = isCorridor(a);
            const bRoad = isCorridor(b);
            if (aRoad || bRoad) {
                if (aRoad && bRoad) return;
                const member = aRoad ? b : a;
                corridorTouch.set(member, (corridorTouch.get(member) || 0) + pair.sharedM);
            }
        });
        memberPairs.forEach(pair => {
            const a = String(pair.a);
            const b = String(pair.b);
            link(a, b);
            link(b, a);
            memberShared.set(`${a}~${b}`, pair.sharedM);
        });

        const members = memberEntries.map(entry => String(entry.id));
        const blocks = [];

        floodComponents(members, id => memberLinks.get(id) || [], id => !isCorridor(id)).forEach(parcelIds => {
            const inBlock = new Set(parcelIds);
            let perimeterM = 0;
            let areaM2 = 0;
            let touchM = 0;
            let populated = false;
            parcelIds.forEach(id => {
                const entry = byId.get(id) || {};
                perimeterM += perimeterOf(entry.rings);
                areaM2 += Number(entry.areaM2) || 0;
                touchM += corridorTouch.get(id) || 0;
                if (entry.populated) populated = true;
            });
            let interiorM = 0;
            memberShared.forEach((sharedM, key) => {
                const [a, b] = key.split('~');
                if (inBlock.has(a) && inBlock.has(b)) interiorM += sharedM;
            });

            const outlineM = Math.max(0, perimeterM - (2 * interiorM));
            const enclosure = outlineM > 0 ? Math.min(1, touchM / outlineM) : 0;
            blocks.push({
                parcelIds: parcelIds.slice().sort(),
                parcelCount: parcelIds.length,
                areaM2: Math.round(areaM2),
                outlineM: Math.round(outlineM),
                corridorTouchM: Math.round(touchM),
                enclosure: Math.round(enclosure * 1000) / 1000,
                enclosed: enclosure >= opts.minEnclosure && areaM2 >= opts.minAreaM2,
                populated: !!populated
            });
        });

        blocks.sort((a, b) => b.areaM2 - a.areaM2);
        return {
            blocks,
            corridorCount: list.filter(entry => entry.isCorridor).length,
            memberCount: members.length
        };
    }

    const api = { DEFAULTS, enumerateBlocks, floodComponents, perimeterOf };

    // Namespaced only — a bare global here could shadow a top-level function in the classic scripts
    // loaded alongside this file.
    if (typeof window !== 'undefined') window.__blockEnumeration = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
