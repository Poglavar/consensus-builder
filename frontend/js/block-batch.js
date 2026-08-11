// Purpose: find every block on the map that has no building design on it yet, so a batch can put an
// urban rule on each — `planBlockUrbanRules()` reports what it found and creates nothing.
//
// A block is the ground enclosed by roads, decided by proposals/block-enumeration.js from boundary
// lengths rather than from what happens to be on screen. This file is the thin part: it reads the
// loaded parcels off the map, projects them to metres, says which are corridors and which are
// already built on, and prints the result.
(function attachBlockBatch(global) {
    'use strict';

    function metricRingsOf(feature) {
        const project = global.wgs84ToHTRS96;
        if (typeof project !== 'function' || !feature || !feature.geometry) return [];
        const geometry = feature.geometry;
        const polygons = geometry.type === 'Polygon'
            ? [geometry.coordinates]
            : (geometry.type === 'MultiPolygon' ? geometry.coordinates : []);
        const rings = [];
        polygons.forEach(polygon => (Array.isArray(polygon) ? polygon : []).forEach(ring => {
            if (!Array.isArray(ring) || ring.length < 4) return;
            const metric = [];
            for (const point of ring) {
                if (!Array.isArray(point) || point.length < 2) continue;
                const xy = project(point[1], point[0]);
                if (!Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return;
                metric.push([xy[0], xy[1]]);
            }
            if (metric.length >= 4) rings.push(metric);
        }));
        return rings;
    }

    // What already stands on the ground — and why this cannot be answered from parcel ids alone.
    //
    // Applying a building proposal REWRITES its parentParcelIds to the CADASTRAL BASE ids
    // (apply/buildings.js: `flatParentIds = liveParents.cadastreIds`). So a design put on one piece
    // of parcel 101 comes back recorded against "101" whole, and the piece on the far side of the
    // road we cut through 101 then reads as built too. Widening a candidate's id to its parent to
    // compare — `built.has(id.split('#')[0])` — turns that into a refusal: the first block to claim
    // any piece of a parcel silently disqualifies every other block that parcel reaches into. That
    // is the whole of the 26 skips in a run of 41, and the same rule at plan time is why blocks were
    // reported as already built when they are empty.
    //
    // A building is a thing in a place, so ask where it is. One representative point per applied
    // footprint, tested against the parcel that claims to be free. Ids are still consulted, but only
    // on an exact match, which cannot reach across a cut.
    function occupancy() {
        const turf = global.turf;
        const ids = new Set();
        const marks = [];
        const all = global.proposalStorage?.getAllProposals?.() || [];
        all.forEach(proposal => {
            if (!proposal || proposal.applied !== true) return;
            const isBuilding = !!(proposal.buildingProposal || proposal.buildingGeometry
                || (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length));
            if (!isBuilding) return;
            [
                proposal.parentParcelIds,
                proposal.parcelIds,
                proposal.buildingProposal && proposal.buildingProposal.parentParcelIds
            ].forEach(list => (Array.isArray(list) ? list : []).forEach(id => {
                if (id !== null && id !== undefined && String(id)) ids.add(String(id));
            }));

            if (!turf) return;
            const buildings = (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length)
                ? proposal.geometry.buildings
                : ((proposal.buildingProposal && Array.isArray(proposal.buildingProposal.buildings))
                    ? proposal.buildingProposal.buildings : []);
            buildings.forEach(feature => {
                if (!feature || !feature.geometry) return;
                try {
                    // pointOnFeature, not centroid: a courtyard block or an L is a shape whose
                    // centre of gravity is outside it.
                    const coords = turf.pointOnFeature(feature)?.geometry?.coordinates;
                    if (Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
                        marks.push(coords);
                    }
                } catch (_) { /* a footprint we cannot read proves nothing about any parcel */ }
            });
        });
        return { ids, marks };
    }

    function isPopulated(feature, id, occupied) {
        if (occupied.ids.has(String(id))) return true;
        const turf = global.turf;
        if (!turf || !occupied.marks.length || !feature) return false;
        let box = null;
        try { box = turf.bbox(feature); } catch (_) { box = null; }
        for (const coords of occupied.marks) {
            if (box && (coords[0] < box[0] || coords[0] > box[2] || coords[1] < box[1] || coords[1] > box[3])) continue;
            try {
                if (turf.booleanPointInPolygon(coords, feature)) return true;
            } catch (_) { /* ignore */ }
        }
        return false;
    }

    function collectParcels() {
        const layerGroup = global.parcelLayer;
        const turf = global.turf;
        if (!layerGroup || typeof layerGroup.eachLayer !== 'function' || !turf) return [];
        const occupied = occupancy();
        const entries = [];
        layerGroup.eachLayer(layer => {
            const feature = layer && layer.feature;
            if (!feature || !feature.geometry) return;
            const id = (typeof global.getParcelIdFromFeature === 'function')
                ? global.getParcelIdFromFeature(feature)
                : (feature.properties && feature.properties.parcelId);
            if (id === undefined || id === null || !String(id)) return;
            const rings = metricRingsOf(feature);
            if (!rings.length) return;
            let areaM2 = 0;
            try { areaM2 = turf.area(feature); } catch (_) { areaM2 = 0; }
            const isCorridor = (typeof global.isCorridorParcel === 'function')
                ? global.isCorridorParcel(String(id), layer)
                : false;
            entries.push({
                id: String(id),
                rings,
                areaM2,
                isCorridor,
                populated: isPopulated(feature, String(id), occupied),
                // Kept for the diagnostic below, which has to say what a parcel IS when it explains
                // why a block came out wrong. enumerateBlocks reads neither.
                layer,
                properties: feature.properties || {}
            });
        });
        return entries;
    }

    function planBlockUrbanRules(options = {}) {
        const enumeration = global.__blockEnumeration;
        if (!enumeration) {
            console.error('[blockBatch] block enumeration is not loaded');
            return null;
        }
        const parcels = collectParcels();
        if (!parcels.length) {
            console.warn('[blockBatch] no parcels are loaded — pan over the area first');
            return null;
        }
        const limits = { ...enumeration.DEFAULTS, ...(options || {}) };
        const result = enumeration.enumerateBlocks(parcels, options);
        const enclosed = result.blocks.filter(block => block.enclosed);
        const todo = enclosed.filter(block => !block.populated);
        const done = enclosed.filter(block => block.populated);
        const open = result.blocks.filter(block => !block.enclosed);

        // "Not enclosed" is two quite different complaints and they want different answers: a
        // sliver too small to build on is fine and expected, whereas a block whose outline is not
        // accounted for by roads is either genuinely open ground or a sign that something bounding
        // it was not recognised as a road.
        const tooSmall = open.filter(block => block.enclosure >= limits.minEnclosure);
        const notRinged = open.filter(block => block.enclosure < limits.minEnclosure);

        const report = {
            parcelsRead: parcels.length,
            corridorParcels: result.corridorCount,
            blocksEnclosed: enclosed.length,
            blocksAlreadyBuilt: done.length,
            blocksToPopulate: todo.length,
            notEnclosed: open.length,
            notEnclosedTooSmall: tooSmall.length,
            notEnclosedNotRingedByRoads: notRinged.length,
            totalAreaToPopulateM2: todo.reduce((sum, block) => sum + block.areaM2, 0),
            toPopulate: todo,
            alreadyBuilt: done,
            notEnclosedBlocks: open,
            limits
        };

        console.log(
            `[blockBatch] ${parcels.length} parcels (${result.corridorCount} corridor) · `
            + `${enclosed.length} enclosed block(s): ${todo.length} to populate, ${done.length} already built · `
            + `${open.length} not enclosed (${tooSmall.length} below ${limits.minAreaM2} m², `
            + `${notRinged.length} not ringed by roads)`, report
        );
        const asRow = block => ({
            parcels: block.parcelCount,
            areaM2: block.areaM2,
            outlineM: block.outlineM,
            alongRoadM: block.corridorTouchM,
            enclosure: block.enclosure,
            firstParcel: block.parcelIds[0]
        });
        if (todo.length) console.table(todo.map(asRow));
        // Printed, not buried in the object: this is the bucket that answers "why is that one still
        // empty", and an unexpanded console line answers nothing.
        if (notRinged.length) {
            console.log(`[blockBatch] ${notRinged.length} block(s) not ringed by roads — `
                + `whyIsBlockUnfilled('<a parcel id in one>') explains a single case`);
            console.table(notRinged.slice(0, 40).map(asRow));
        }
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`${todo.length} block(s) with no design yet · ${done.length} already built · `
                + `${tooSmall.length} too small · ${notRinged.length} not ringed by roads.`);
        }
        global.BlockBatch.lastPlan = report;
        return report;
    }

    // The urban rule for one block, built the way the modal builds it: the shared outline generator
    // (blockRingOutline), then the shared massing split. Nothing about the design is re-derived
    // here — a batch block and a hand-made one come out of the same two functions.
    function designFor(parcelLayers, params) {
        const turf = global.turf;
        const features = parcelLayers.map(layer => layer.feature).filter(Boolean);
        if (!features.length || !turf) return null;

        let superparcel = global.robustUnion(features);
        if (!superparcel) return null;
        superparcel = global.sanitizePolygonFeature(superparcel) || superparcel;
        superparcel = global.toSingleLargestPolygon(superparcel) || superparcel;
        if (!superparcel || !superparcel.geometry) return null;

        const ring = global.blockRingOutline(superparcel, superparcel, params);
        if (!ring || !ring.outer || !ring.outer.geometry) return null;

        const close = coords => {
            if (!Array.isArray(coords) || !coords.length) return [];
            const first = coords[0];
            const last = coords[coords.length - 1];
            return (!last || first[0] !== last[0] || first[1] !== last[1]) ? coords.concat([first]) : coords.slice();
        };
        const outerRing = close(ring.outer.geometry.coordinates[0]);
        // No courtyard means the inset collapsed: a solid block, exactly as the modal falls back to.
        const rings = ring.inner && ring.inner.geometry
            ? [outerRing, close(ring.inner.geometry.coordinates[0]).reverse()]
            : [outerRing];
        const massing = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } };

        const forSplit = parcelLayers.map((layer, index) => ({
            feature: layer.feature,
            parcelId: (typeof global.ensureParcelId === 'function')
                ? global.ensureParcelId(layer.feature)
                : (layer.feature?.properties?.parcelId ?? `parcel-${index}`)
        })).filter(entry => entry.feature && entry.feature.geometry);

        const rule = global.currentBlockRule();
        const deps = { turf, largestPolygon: global.toSingleLargestPolygon };
        const split = global.UrbanRuleVariation.splitMassingByParcels(
            massing, forSplit, rule, params.seed, deps);
        if (!split || !Array.isArray(split.pieces) || !split.pieces.length) return null;
        return { buildings: split.pieces, excluded: split.excluded || [], rule, massing, ring };
    }

    // Put an urban rule on every enclosed block that has no design yet.
    //
    // Sequential and idempotent by construction: each block is re-checked against the live records
    // immediately before it is created, so a re-run after an interruption skips what already stands
    // rather than doubling it. `limit` exists so the first real run can be two blocks, not forty.
    async function createBlockUrbanRules(options = {}) {
        const plan = planBlockUrbanRules(options);
        if (!plan || !plan.toPopulate.length) return plan;

        const params = {
            // These are `const` at the top of a classic script, so they live in the global lexical
            // scope rather than on window — read by bare name, not off `global`.
            setback: Number(options.setback ?? (typeof DEFAULT_SETBACK === 'number' ? DEFAULT_SETBACK : 2)),
            width: Number(options.width ?? (typeof DEFAULT_BUILDING_WIDTH === 'number' ? DEFAULT_BUILDING_WIDTH : 15)),
            simplifyM: Number(options.simplifyM ?? (typeof DEFAULT_SIMPLIFY_M === 'number' ? DEFAULT_SIMPLIFY_M : 0)),
            seed: Number(options.seed ?? 1)
        };
        const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : plan.toPopulate.length;
        const targets = plan.toPopulate.slice(0, limit);
        const created = [];
        const failed = [];

        for (const block of targets) {
            // multiParcelSelection is a top-level `const` too, so it is reached by bare name.
            const selection = (typeof multiParcelSelection !== 'undefined') ? multiParcelSelection : null;
            const found = block.parcelIds
                .map(id => ({ id, layer: selection && selection.findParcelById ? selection.findParcelById(id) : null }));
            const layers = found.filter(entry => entry.layer).map(entry => entry.layer);
            if (layers.length !== block.parcelIds.length) {
                failed.push({
                    block: block.parcelIds[0],
                    reason: 'some parcels are no longer on the map',
                    detail: found.filter(entry => !entry.layer).map(entry => entry.id).join(', ')
                });
                continue;
            }
            // Re-checked here rather than trusted from the plan: an earlier block in this same run
            // may have claimed ground this one counted on.
            const occupied = occupancy();
            const taken = found
                .filter(entry => isPopulated(entry.layer.feature, entry.id, occupied))
                .map(entry => entry.id);
            if (taken.length) {
                failed.push({
                    block: block.parcelIds[0],
                    reason: 'already built on by the time its turn came',
                    detail: taken.join(', ')
                });
                continue;
            }

            let design = null;
            try { design = designFor(layers, params); }
            catch (error) {
                failed.push({
                    block: block.parcelIds[0],
                    reason: 'generating the design threw',
                    detail: String(error && error.message || error)
                });
                continue;
            }
            if (!design) {
                failed.push({
                    block: block.parcelIds[0],
                    reason: 'no design could be generated for this outline',
                    detail: `${block.parcelCount} parcel(s), ${block.areaM2} m²`
                });
                continue;
            }

            const parentDetails = block.parcelIds.map(id => ({ id, number: id }));
            const proposal = {
                title: `Block ${block.parcelIds[0]}`,
                name: `Block ${block.parcelIds[0]}`,
                description: `Urban rule generated for the block of ${block.parcelCount} parcel(s).`,
                primaryType: 'Urban Rule',
                goal: 'buildings',
                typologyType: 'block',
                parentParcelIds: block.parcelIds.slice(),
                parcelIds: block.parcelIds.slice(),
                tags: ['buildings'],
                applied: false,
                termsConfirmed: true,
                createdAt: new Date().toISOString(),
                geometry: { buildings: design.buildings },
                buildingProperties: { ...(design.buildings[0].properties || {}) },
                properties: { ...(design.buildings[0].properties || {}) },
                buildingProposal: {
                    parentParcelIds: block.parcelIds.slice(),
                    parentParcelNumbers: parentDetails,
                    createdFrom: 'blockify',
                    blockName: `Block ${block.parcelIds[0]}`,
                    parameters: {
                        mode: 'parametric',
                        typology: 'block',
                        setback: params.setback,
                        width: params.width,
                        height: Number(typeof DEFAULT_BUILDING_HEIGHT === 'number' ? DEFAULT_BUILDING_HEIGHT : 17.5),
                        simplify: params.simplifyM,
                        chamfer: 0,
                        gaps: [],
                        wings: [],
                        rule: design.rule,
                        seed: params.seed
                    },
                    buildingFeature: design.buildings[0],
                    buildings: design.buildings
                }
            };

            let proposalId = null;
            try { proposalId = global.proposalStorage.addProposal(proposal); }
            catch (error) {
                failed.push({
                    block: block.parcelIds[0],
                    reason: 'could not store the record',
                    detail: String(error && error.message || error)
                });
                continue;
            }
            if (!proposalId) {
                failed.push({ block: block.parcelIds[0], reason: 'storage refused the record (duplicate?)', detail: '' });
                continue;
            }

            let applied = false;
            try { applied = await global.ProposalManager.applyProposal(proposalId); }
            catch (error) {
                applied = false;
                failed.push({
                    block: block.parcelIds[0],
                    reason: 'apply threw',
                    detail: String(error && error.message || error)
                });
            }
            created.push({ proposalId, parcels: block.parcelCount, areaM2: block.areaM2, applied: !!applied });
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Block urban rules: ${created.length}/${targets.length} created…`);
            }
        }

        // A skip count on its own is not a finding — it is a question. Group by reason and print the
        // counts, so the run says WHY it declined rather than only how often.
        const byReason = new Map();
        failed.forEach(entry => byReason.set(entry.reason, (byReason.get(entry.reason) || 0) + 1));
        const skipReasons = Array.from(byReason.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => ({ reason, count }));

        const summary = { attempted: targets.length, created, failed, skipReasons };
        console.log(
            `[blockBatch] created ${created.length}/${targets.length} block urban rule(s)`
            + (failed.length ? ` · ${failed.length} skipped` : ''), summary);
        if (failed.length) {
            skipReasons.forEach(entry => console.log(`[blockBatch]   ${entry.count}× ${entry.reason}`));
            console.table(failed);
        }
        if (typeof global.showEphemeralMessage === 'function') {
            const worst = skipReasons[0];
            global.showEphemeralMessage(
                `${created.length} block urban rule(s) created`
                + (failed.length ? `, ${failed.length} skipped — mostly: ${worst.reason}.` : '.'), 10000);
        }
        global.BlockBatch.lastRun = summary;
        return summary;
    }

    // Why is the block containing this parcel still empty?
    //
    // The enclosure test is a ratio of two lengths, and a ratio hides which of them went wrong. This
    // spends the block's boundary metre by metre: how much runs along a road, how much is interior
    // between its own parcels, and how much faces nothing at all. The last column is the answer —
    // a block that is short of enclosure is either genuinely open on one side, or it swallowed
    // something that should have bounded it and is now measuring that thing's outer edge.
    function whyIsBlockUnfilled(parcelId) {
        const enumeration = global.__blockEnumeration;
        const adjacencyApi = global.__parcelAdjacency;
        if (!enumeration || !adjacencyApi) {
            console.error('[blockBatch] block enumeration or parcel adjacency is not loaded');
            return null;
        }
        const parcels = collectParcels();
        const wanted = String(parcelId);
        const target = parcels.find(entry => entry.id === wanted)
            || parcels.find(entry => entry.id.split('#')[0] === wanted);
        if (!target) {
            console.warn(`[blockBatch] ${wanted} is not among the ${parcels.length} loaded parcels`);
            return null;
        }
        if (target.isCorridor) {
            console.log(`[blockBatch] ${target.id} is a corridor — it bounds blocks rather than sitting in one`);
            return { parcel: target.id, isCorridor: true };
        }

        const result = enumeration.enumerateBlocks(parcels);
        const block = result.blocks.find(entry => entry.parcelIds.indexOf(target.id) !== -1);
        if (!block) {
            console.warn(`[blockBatch] ${target.id} ended up in no block at all`);
            return null;
        }

        const byId = new Map(parcels.map(entry => [entry.id, entry]));
        const pairs = adjacencyApi.neighborPairs(parcels.map(entry => ({ id: entry.id, rings: entry.rings })));
        const inBlock = new Set(block.parcelIds);
        const roadSet = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel : null;

        const rows = block.parcelIds.map(id => {
            const entry = byId.get(id) || { rings: [], areaM2: 0, properties: {} };
            const perimeterM = enumeration.perimeterOf(entry.rings);
            let alongRoadM = 0;
            let sharedWithBlockM = 0;
            pairs.forEach(pair => {
                if (pair.a !== id && pair.b !== id) return;
                const otherId = pair.a === id ? pair.b : pair.a;
                const other = byId.get(otherId);
                if (other && other.isCorridor) alongRoadM += pair.sharedM;
                else if (inBlock.has(otherId)) sharedWithBlockM += pair.sharedM;
            });
            const props = entry.properties || {};
            return {
                parcel: id,
                areaM2: Math.round(entry.areaM2),
                perimeterM: Math.round(perimeterM),
                alongRoadM: Math.round(alongRoadM),
                sharedWithBlockM: Math.round(sharedWithBlockM),
                facingNothingM: Math.round(Math.max(0, perimeterM - alongRoadM - sharedWithBlockM)),
                // Should always be false: a member the road set knows about means this parcel is
                // road ground the block absorbed, which is the bug that merges blocks across a street.
                roadSetSaysRoad: !!(roadSet && (roadSet(id) || roadSet(id.split('#')[0])))
                    || props.isRoad === true || props.isCorridor === true
            };
        }).sort((a, b) => b.facingNothingM - a.facingNothingM);

        const unaccountedM = Math.max(0, block.outlineM - block.corridorTouchM);
        const absorbedRoads = rows.filter(row => row.roadSetSaysRoad);
        console.log(
            `[blockBatch] ${target.id} is in a block of ${block.parcelCount} parcel(s), ${block.areaM2} m² · `
            + `outline ${block.outlineM} m = ${block.corridorTouchM} m along roads + ${unaccountedM} m facing nothing · `
            + `enclosure ${block.enclosure} → ${block.enclosed ? 'enclosed' : 'NOT enclosed'}`
            + (block.populated ? ' · already built on' : ''),
            block);
        if (absorbedRoads.length) {
            console.warn(`[blockBatch] ${absorbedRoads.length} member(s) are road ground the block absorbed — `
                + 'that is what merges the blocks on both sides of a street', absorbedRoads.map(row => row.parcel));
        }
        console.table(rows);
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`Block of ${block.parcelCount} parcel(s): ${block.corridorTouchM} m of its `
                + `${block.outlineM} m outline runs along a road (${Math.round(block.enclosure * 100)}%), `
                + `${unaccountedM} m faces nothing.`);
        }
        return { block, members: rows, unaccountedM, absorbedRoads };
    }

    global.BlockBatch = { planBlockUrbanRules, createBlockUrbanRules, collectParcels, designFor, whyIsBlockUnfilled };
    global.planBlockUrbanRules = planBlockUrbanRules;
    global.createBlockUrbanRules = createBlockUrbanRules;
    global.whyIsBlockUnfilled = whyIsBlockUnfilled;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            planBlockUrbanRules, createBlockUrbanRules, collectParcels, designFor,
            whyIsBlockUnfilled, occupancy, isPopulated
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
