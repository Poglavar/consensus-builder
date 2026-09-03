// Purpose: find every block on the map that has no building design on it yet, so a batch can put an
// urban rule on each — `planBlockUrbanRules()` reports what it found and creates nothing.
//
// A block is the ground enclosed by roads, decided by proposals/block-enumeration.js from boundary
// lengths rather than from what happens to be on screen. This file is the thin part: it reads the
// committed live fabric, projects it to metres, says which pieces are corridors and which are
// already built on, and prints the result. Leaflet is presentation, never input.
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

    function blockBatchI18n(key, fallback) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, {});
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        return fallback;
    }

    // A block's NAME comes from the BLOCK — its size and its shape — and from nothing else.
    //
    // Naming it after a parcel was wrong twice over: a block is usually several parcels, so picking
    // the first is arbitrary; and the id of a parcel our own road has cut carries a piece hash,
    // which is what put `#p1gynggs` on the end of a name. A block already has an identity of its
    // own — the ground it encloses — so the name is read off that:
    //
    //     Block 4237-K7QM        4237 m², and a code standing for this outline and no other.
    //
    // Derived, not random or stamped: re-deriving the same block gives the same name, so a re-run
    // cannot quietly mint a second name for ground that already has one. Change the block — move a
    // road, take a parcel out — and it is a different block with a different name, which is right.

    // No 0/O/1/I/L: a name gets read aloud and typed back.
    const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

    // Every vertex of every member, in centimetres, sorted. Centimetres because below that is float
    // drift and a name must not move because a ring was re-emitted; sorted because the flood fill's
    // walk order, a ring's rotation and its winding are all accidents of how the block was found,
    // and none of them changes which ground it is.
    function blockFingerprint(block, byId) {
        const points = [];
        block.parcelIds.forEach(id => {
            const entry = byId.get(id);
            (entry && Array.isArray(entry.rings) ? entry.rings : []).forEach(ring => {
                if (!Array.isArray(ring) || !ring.length) return;
                // Drop the repeated closing vertex: WHICH vertex a closed ring repeats is decided by
                // where it starts, so counting it would make the fingerprint depend on that after
                // all — the exact accident this is supposed to be blind to.
                const first = ring[0];
                const last = ring[ring.length - 1];
                const closed = Array.isArray(first) && Array.isArray(last)
                    && first[0] === last[0] && first[1] === last[1];
                (closed ? ring.slice(0, -1) : ring).forEach(point => {
                    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
                    // Two decimals of a METRE — these rings came through metricRingsOf, which
                    // projects. A centimetre, which is below survey precision and above the noise a
                    // re-derivation introduces. (Do not copy this figure to anything holding
                    // lat/lng: two decimals of a DEGREE is 1.1 km. maintenance.js made exactly that
                    // mistake and named three unrelated blocks …-FAXU.)
                    points.push(`${point[0].toFixed(2)},${point[1].toFixed(2)}`);
                });
            });
        });
        return points.sort().join(' ');
    }

    function blockCode(text) {
        const arrangement = global.__parcelArrangement;
        const hash = (arrangement && typeof arrangement.hash32 === 'function')
            ? arrangement.hash32(text)
            : 0;
        let value = hash >>> 0;
        let code = '';
        for (let i = 0; i < 4; i += 1) {
            code = CODE_ALPHABET[value % CODE_ALPHABET.length] + code;
            value = Math.floor(value / CODE_ALPHABET.length);
        }
        return code;
    }

    function blockBaseName(block, byId) {
        const word = blockBatchI18n('panel.parcel.build.block', 'Block');
        const area = Math.max(0, Math.round(Number(block.areaM2) || 0));
        return `${word} ${area}-${blockCode(blockFingerprint(block, byId || new Map()))}`;
    }

    // Two blocks cannot want the same name: the code stands for an outline, and two blocks with the
    // same outline are one block. The suffix is a backstop for the one case left — a name an earlier
    // run already put on a record — and it should stay unused.
    function nameBlocks(blocks, byId, taken) {
        blocks.forEach(block => {
            const base = blockBaseName(block, byId);
            let name = base;
            for (let n = 2; taken.has(name); n += 1) name = `${base} (${n})`;
            block.name = name;
            taken.add(name);
        });
        return blocks;
    }

    function existingProposalNames() {
        const names = new Set();
        const all = global.proposalStorage?.getAllProposals?.() || [];
        all.forEach(proposal => {
            [proposal && proposal.title, proposal && proposal.name].forEach(value => {
                if (value !== undefined && value !== null && String(value).trim()) names.add(String(value).trim());
            });
        });
        return names;
    }

    // ── Renaming what the previous naming left behind ───────────────────────────────────────────
    //
    // Before the name was read off the block, a batch named each one after the FIRST parcel it
    // happened to contain — and a parcel our own road has cut carries a piece token, so the name
    // came out as `Block HR-330264-628#prqroga`. Those records still exist and still show that name
    // in the plan list. Renaming them is the same derivation the batch now does, applied late.
    //
    // A name is the only thing that moves. The rename refuses rather than guesses: a block whose
    // parcels are not all on the map would fingerprint a SUBSET of its own outline, which is a
    // different block and therefore the wrong name.

    // No derived or default name contains '#'; a parcel id is the only thing that puts one there.
    const LEGACY_NAME_RE = /(^|\s)[A-Za-z0-9][A-Za-z0-9/._-]*#[A-Za-z0-9-]+(\s|$)/;

    function isLegacyBlockName(name) {
        if (name === undefined || name === null) return false;
        return LEGACY_NAME_RE.test(String(name));
    }

    /** The immutable cadastral scope declared by a block proposal. */
    function blockParcelIdsOf(proposal) {
        const ids = new Set();
        (Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds : []).forEach(id => {
            if (id !== null && id !== undefined && String(id)) ids.add(String(id));
        });
        return [...ids];
    }

    /**
     * What a rename run WOULD do. Creates nothing and changes nothing.
     * @returns {{targets: Array, renamable: number, blocked: Array}}
     */
    function planBlockRenames() {
        const byId = new Map(collectParcels().map(entry => [entry.id, entry]));
        const all = global.proposalStorage?.getAllProposals?.() || [];
        const taken = existingProposalNames();

        const targets = all
            .filter(proposal => isLegacyBlockName(proposal && (proposal.title || proposal.name)))
            .map(proposal => {
                const from = String(proposal.title || proposal.name || '');
                const parcelIds = blockParcelIdsOf(proposal);
                const missing = parcelIds.filter(id => !byId.has(id));
                let to = null;
                let reason = null;
                if (!parcelIds.length) {
                    reason = 'the record names no parcels';
                } else if (missing.length) {
                    reason = `${missing.length} of ${parcelIds.length} parcels are not loaded on the map`;
                } else {
                    const areaM2 = parcelIds.reduce((sum, id) => sum + (Number(byId.get(id).areaM2) || 0), 0);
                    const base = blockBaseName({ parcelIds, areaM2 }, byId);
                    to = base;
                    // The proposal's own name is not a collision with itself.
                    for (let n = 2; taken.has(to) && to !== from; n += 1) to = `${base} (${n})`;
                }
                return {
                    proposalId: proposal.proposalId || proposal.id,
                    serverId: proposal.serverProposalId ?? null,
                    from,
                    to,
                    reason,
                    parcelIds,
                    missing
                };
            });

        const blocked = targets.filter(entry => !entry.to);
        const summary = {
            targets,
            renamable: targets.length - blocked.length,
            blocked
        };
        console.log(`[rename] ${targets.length} proposals still carry a parcel-id name; ${summary.renamable} can be renamed now.`);
        targets.forEach(entry => console.log(
            entry.to ? `  ${entry.from}  →  ${entry.to}` : `  ${entry.from}  —  SKIP: ${entry.reason}`
        ));
        return summary;
    }

    // A name is a label, so it is PATCHed on its own. Re-uploading the proposal would rewrite
    // geometry and stamps that have already been consented to, to change a string.
    async function renameProposalRecord(entry) {
        const serverId = entry.serverId ?? (/^\d+$/.test(String(entry.proposalId || '')) ? entry.proposalId : null);
        if (serverId !== null && serverId !== undefined && typeof global.resolveBackendBaseUrl === 'function') {
            const response = await fetch(
                `${global.resolveBackendBaseUrl()}/proposals/${encodeURIComponent(serverId)}/name`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: entry.to })
                }
            );
            if (!response.ok) throw new Error(`PATCH name: HTTP ${response.status}`);
        }
        const stored = global.proposalStorage?.setProposalName?.(entry.proposalId, entry.to);
        if (!stored) throw new Error('local storage refused the rename');
    }

    /**
     * Rename every leftover it can, and say what it left alone. Run planBlockRenames() first.
     * @returns {Promise<{renamed: Array, failed: Array, skipped: Array}>}
     */
    async function renameLegacyBlockNames() {
        const plan = planBlockRenames();
        const renamed = [];
        const failed = [];

        for (const entry of plan.targets) {
            if (!entry.to) continue;
            try {
                await renameProposalRecord(entry);
                renamed.push(entry);
            } catch (error) {
                failed.push({ ...entry, detail: String((error && error.message) || error) });
            }
            if (typeof global.yieldToBrowser === 'function') await global.yieldToBrowser();
        }

        try { if (typeof global.updateProposalList === 'function') global.updateProposalList(); } catch (_) { }

        // A partial run must not read as a clean one: the counts are printed together, and a
        // failure is loud even though the loop kept going.
        console.log(`[rename] renamed ${renamed.length}, failed ${failed.length}, skipped ${plan.blocked.length}`);
        failed.forEach(entry => console.error(`[rename] FAILED ${entry.from}: ${entry.detail}`));
        plan.blocked.forEach(entry => console.warn(`[rename] skipped ${entry.from}: ${entry.reason}`));
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`Renamed ${renamed.length} block(s); ${failed.length} failed, ${plan.blocked.length} skipped.`);
        }
        return { renamed, failed, skipped: plan.blocked };
    }

    // What already stands on the ground. A proposal's cadastral declaration is deliberately broader
    // than a current road-cut piece, so occupancy is a geometry question: test one representative
    // point per applied footprint against the live parcel under consideration.
    function occupancy() {
        const turf = global.turf;
        const marks = [];
        const all = global.proposalStorage?.getAllProposals?.() || [];
        all.forEach(proposal => {
            if (!proposal || proposal.applied !== true) return;
            const isBuilding = !!(proposal.buildingProposal || proposal.buildingGeometry
                || (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length));
            if (!isBuilding) return;
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
                        // The mark carries WHOSE it is: "already built on" is only a useful answer
                        // when it can be checked, and the way it goes wrong is a neighbour's
                        // building landing a metre inside this block.
                        marks.push({ at: coords, by: proposal.title || proposal.name || proposal.proposalId || proposal.id || '?' });
                    }
                } catch (_) { /* a footprint we cannot read proves nothing about any parcel */ }
            });
        });
        return { marks };
    }

    // Who stands on this parcel — the empty list is "nobody", which is what makes it buildable.
    function occupiersOf(feature, id, occupied) {
        const names = [];
        const turf = global.turf;
        if (!turf || !occupied.marks.length || !feature) return names;
        let box = null;
        try { box = turf.bbox(feature); } catch (_) { box = null; }
        occupied.marks.forEach(mark => {
            const at = mark.at;
            if (box && (at[0] < box[0] || at[0] > box[2] || at[1] < box[1] || at[1] > box[3])) return;
            try {
                if (turf.booleanPointInPolygon(at, feature) && names.indexOf(mark.by) === -1) names.push(mark.by);
            } catch (_) { /* ignore */ }
        });
        return names;
    }

    function isPopulated(feature, id, occupied) {
        return occupiersOf(feature, id, occupied).length > 0;
    }

    function collectParcels() {
        const fabric = global.LiveParcelFabric;
        const turf = global.turf;
        if (!fabric || typeof fabric.list !== 'function' || !turf) return [];
        const occupied = occupancy();
        const entries = [];
        fabric.list().forEach(feature => {
            if (!feature || !feature.geometry) return;
            const id = (typeof fabric.featureId === 'function')
                ? fabric.featureId(feature)
                : (feature.properties && feature.properties.parcelId);
            if (id === undefined || id === null || !String(id)) return;
            const rings = metricRingsOf(feature);
            if (!rings.length) return;
            let areaM2 = 0;
            try { areaM2 = turf.area(feature); } catch (_) { areaM2 = 0; }
            const props = feature.properties || {};
            const isCorridor = props.isCorridor === true || props.isRoad === true || props.isTrack === true;
            entries.push({
                id: String(id),
                rings,
                areaM2,
                isCorridor,
                populated: isPopulated(feature, String(id), occupied),
                // Kept for the diagnostic below, which has to say what a parcel IS when it explains
                // why a block came out wrong. enumerateBlocks reads neither.
                feature,
                cadastreParcelIds: typeof fabric.explicitCadastreIds === 'function'
                    ? fabric.explicitCadastreIds(feature)
                    : [],
                properties: props
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
        nameBlocks(result.blocks, new Map(parcels.map(entry => [entry.id, entry])), existingProposalNames());
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
            name: block.name,
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
    function designFor(parcelEntries, params) {
        const turf = global.turf;
        const features = parcelEntries.map(entry => entry && (entry.feature || entry)).filter(Boolean);
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

        const forSplit = parcelEntries.map((entry, index) => ({
            feature: entry && (entry.feature || entry),
            parcelId: (typeof global.ensureParcelId === 'function')
                ? global.ensureParcelId(entry && (entry.feature || entry))
                : (entry?.feature?.properties?.parcelId ?? entry?.properties?.parcelId ?? `parcel-${index}`)
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

        const createEach = async () => {
        for (const block of targets) {
            const fabric = global.LiveParcelFabric;
            const found = block.parcelIds
                .map(id => ({ id, feature: fabric && typeof fabric.get === 'function' ? fabric.get(id) : null }));
            const entries = found.filter(entry => entry.feature);
            if (entries.length !== block.parcelIds.length) {
                failed.push({
                    block: block.name,
                    reason: 'some parcels are no longer in the committed live fabric',
                    detail: found.filter(entry => !entry.feature).map(entry => entry.id).join(', ')
                });
                continue;
            }
            // Re-checked here rather than trusted from the plan: an earlier block in this same run
            // may have claimed ground this one counted on.
            const occupied = occupancy();
            const taken = found
                .map(entry => ({ id: entry.id, by: occupiersOf(entry.feature, entry.id, occupied) }))
                .filter(entry => entry.by.length);
            if (taken.length) {
                failed.push({
                    block: block.name,
                    reason: 'already built on by the time its turn came',
                    detail: taken.map(entry => `${entry.id} ← ${entry.by.join(', ')}`).join(' · ')
                });
                continue;
            }

            let design = null;
            try { design = designFor(entries, params); }
            catch (error) {
                failed.push({
                    block: block.name,
                    reason: 'generating the design threw',
                    detail: String(error && error.message || error)
                });
                continue;
            }
            if (!design) {
                failed.push({
                    block: block.name,
                    reason: 'no design could be generated for this outline',
                    detail: `${block.parcelCount} parcel(s), ${block.areaM2} m²`
                });
                continue;
            }

            const cadastralAnchors = fabric.cadastreIdsForParcelIds(block.parcelIds);
            const proposal = {
                title: block.name,
                name: block.name,
                description: `Urban rule generated for the block of ${block.parcelCount} parcel(s).`,
                primaryType: 'Urban Rule',
                goal: 'buildings',
                typologyType: 'block',
                cadastreParcelIds: cadastralAnchors.slice(),
                tags: ['buildings'],
                applied: false,
                termsConfirmed: true,
                createdAt: new Date().toISOString(),
                geometry: { buildings: design.buildings },
                buildingProposal: {
                    createdFrom: 'blockify',
                    blockName: block.name,
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
                    }
                }
            };

            let proposalId = null;
            try { proposalId = global.proposalStorage.addProposal(proposal); }
            catch (error) {
                failed.push({
                    block: block.name,
                    reason: 'could not store the record',
                    detail: String(error && error.message || error)
                });
                continue;
            }
            if (!proposalId) {
                failed.push({ block: block.name, reason: 'storage refused the record (duplicate?)', detail: '' });
                continue;
            }

            let applied = false;
            try { applied = await global.ProposalManager.applyProposal(proposalId); }
            catch (error) {
                applied = false;
                failed.push({
                    block: block.name,
                    reason: 'apply threw',
                    detail: String(error && error.message || error)
                });
            }
            created.push({ proposalId, parcels: block.parcelCount, areaM2: block.areaM2, applied: !!applied });
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Block urban rules: ${created.length}/${targets.length} created…`);
            }
            // Hand the browser a turn between blocks. Every await in this loop is on data that is
            // usually already there, and an already-settled promise only schedules a microtask —
            // which runs BEFORE the browser paints. Without this the whole run is one frame and the
            // map is frozen from the first block to the last.
            if (typeof global.yieldToBrowser === 'function') await global.yieldToBrowser();
        }
        };
        // One redraw of the proposed buildings at the end, not one per block: rebuilding that layer
        // redraws every building already on it.
        if (typeof global.withProposedBuildingsRefreshHeld === 'function') {
            await global.withProposedBuildingsRefreshHeld(createEach);
        } else {
            await createEach();
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
        const topologyApi = global.__parcelBlockTopology;
        if (!enumeration || !adjacencyApi || !topologyApi) {
            console.error('[blockBatch] block enumeration or parcel topology is not loaded');
            return null;
        }
        const parcels = collectParcels();
        const wanted = String(parcelId);
        const target = parcels.find(entry => entry.id === wanted)
            || parcels.find(entry => entry.cadastreParcelIds.includes(wanted));
        if (!target) {
            console.warn(`[blockBatch] ${wanted} is not among the ${parcels.length} loaded parcels`);
            return null;
        }
        if (target.isCorridor) {
            console.log(`[blockBatch] ${target.id} is a corridor — it bounds blocks rather than sitting in one`);
            return { parcel: target.id, isCorridor: true };
        }

        const result = enumeration.enumerateBlocks(parcels);
        nameBlocks(result.blocks, new Map(parcels.map(entry => [entry.id, entry])), existingProposalNames());
        const block = result.blocks.find(entry => entry.parcelIds.indexOf(target.id) !== -1);
        if (!block) {
            console.warn(`[blockBatch] ${target.id} ended up in no block at all`);
            return null;
        }

        const byId = new Map(parcels.map(entry => [entry.id, entry]));
        const rawPairs = adjacencyApi.neighborPairs(parcels.map(entry => ({ id: entry.id, rings: entry.rings })));
        const memberPairs = topologyApi.neighborPairs(
            parcels.filter(entry => !entry.isCorridor).map(entry => ({ id: entry.id, rings: entry.rings })),
            parcels.filter(entry => entry.isCorridor).map(entry => ({ id: entry.id, rings: entry.rings }))
        );
        // Diagnostics must spend the same graph the actual enumerator walks. Raw adjacency remains
        // useful only for member↔road contact; member↔member links come from block topology so a
        // road-covered cadastral edge is not reported as an escape route after it has been removed.
        const pairs = rawPairs
            .filter(pair => {
                const a = byId.get(pair.a);
                const b = byId.get(pair.b);
                return !!((a && a.isCorridor) || (b && b.isCorridor));
            })
            .concat(memberPairs);
        const inBlock = new Set(block.parcelIds);
        const roadSet = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel : null;
        const occupied = occupancy();

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
                // Blank unless something already stands here. A NEIGHBOUR's name in this column is
                // the block being wrongly counted as built — the batch skips those.
                builtOnBy: occupiersOf(entry.feature, id, occupied).join(', '),
                // Should always be false: a member the road set knows about means this parcel is
                // road ground the block absorbed, which is the bug that merges blocks across a street.
                roadSetSaysRoad: !!entry.isCorridor || !!(roadSet && roadSet(id))
                    || props.isRoad === true || props.isCorridor === true
            };
        }).sort((a, b) => b.facingNothingM - a.facingNothingM);

        // The neighbours of the parcel you ASKED about, which is where an answer this size has to
        // start. A component only escapes through ground that is not a road, and one such neighbour
        // is enough — so these few rows name the gap, where a table of the whole component cannot.
        const neighbours = pairs
            .filter(pair => pair.a === target.id || pair.b === target.id)
            .map(pair => {
                const otherId = pair.a === target.id ? pair.b : pair.a;
                const other = byId.get(otherId) || {};
                return {
                    neighbour: otherId,
                    sharedM: Math.round(pair.sharedM),
                    isRoad: !!other.isCorridor,
                    // Where the fill went. A long boundary with a non-road neighbour is a way out.
                    leadsOutOfTheBlock: !other.isCorridor
                };
            })
            .sort((a, b) => b.sharedM - a.sharedM);

        // How far each member is from the parcel you asked about, counted in parcels crossed.
        //
        // When a component has run away, the question worth answering is not "what is in it" but
        // "where does its ring break, NEAREST to me" — because that is the gap to close, and every
        // parcel beyond it is only in the component by consequence. A member whose boundary is
        // neither road nor shared with a block-mate IS a break in the ring; the nearest such member
        // is the nearest hole.
        const memberLinks = new Map();
        pairs.forEach(pair => {
            if (!inBlock.has(pair.a) || !inBlock.has(pair.b)) return;
            if (!memberLinks.has(pair.a)) memberLinks.set(pair.a, []);
            if (!memberLinks.has(pair.b)) memberLinks.set(pair.b, []);
            memberLinks.get(pair.a).push(pair.b);
            memberLinks.get(pair.b).push(pair.a);
        });
        const hops = new Map([[target.id, 0]]);
        const walk = [target.id];
        while (walk.length) {
            const id = walk.shift();
            const distance = hops.get(id);
            (memberLinks.get(id) || []).forEach(next => {
                if (hops.has(next)) return;
                hops.set(next, distance + 1);
                walk.push(next);
            });
        }
        // Under this a gap is a corner where three roads meet, or the metre a road's own remainder
        // leaves behind — not a way out.
        const OPEN_SIDE_M = 15;
        const nearestHoles = rows
            .filter(row => row.facingNothingM >= OPEN_SIDE_M && hops.has(row.parcel))
            .map(row => ({
                parcelsAway: hops.get(row.parcel),
                parcel: row.parcel,
                openM: row.facingNothingM,
                alongRoadM: row.alongRoadM,
                areaM2: row.areaM2
            }))
            .sort((a, b) => a.parcelsAway - b.parcelsAway || b.openM - a.openM)
            .slice(0, 20);

        const unaccountedM = Math.max(0, block.outlineM - block.corridorTouchM);
        const absorbedRoads = rows.filter(row => row.roadSetSaysRoad);
        // A city block is a handful of parcels. Anything near this is not a block that failed a
        // test — it is the flood fill having walked out of one and kept going, and every number
        // computed from it describes the ground it escaped into rather than the ground you meant.
        const RUNAWAY_MEMBERS = 200;
        const runaway = block.parcelCount >= RUNAWAY_MEMBERS;

        console.log(
            `[blockBatch] ${target.id} is in "${block.name}" — ${block.parcelCount} parcel(s), ${block.areaM2} m² · `
            + `outline ${block.outlineM} m = ${block.corridorTouchM} m along roads + ${unaccountedM} m facing nothing · `
            + `enclosure ${block.enclosure} → ${block.enclosed ? 'enclosed' : 'NOT enclosed'}`
            + (block.populated ? ' · ALREADY BUILT ON, so the batch skips it — see builtOnBy below' : ''),
            block);
        if (runaway) {
            console.warn(
                `[blockBatch] ${block.parcelCount} parcels is not a block — the flood fill escaped and joined `
                + 'everything it could reach. A block is only bounded by ground marked as road, so one unmarked '
                + 'side is enough to let it out. Read the NEAREST HOLES table: the first row is the closest place '
                + `the ring around ${target.id} is not closed, and closing it is what makes this a block again.`);
        }
        if (absorbedRoads.length) {
            console.warn(`[blockBatch] ${absorbedRoads.length} member(s) are road ground the block absorbed — `
                + 'that is what merges the blocks on both sides of a street', absorbedRoads.map(row => row.parcel));
        }
        console.log(`[blockBatch] what ${target.id} touches:`);
        console.table(neighbours);
        if (nearestHoles.length) {
            console.log(`[blockBatch] NEAREST HOLES in the ring around ${target.id} — closest first. `
                + 'parcelsAway is how many parcels you cross to get there; openM is boundary that is '
                + 'neither road nor shared with a block-mate, which is what lets the fill out:');
            console.table(nearestHoles);
        }
        // Bounded: 13,000 rows is not a table anyone reads, and printing it implies it is worth reading.
        if (rows.length > 25) {
            console.log(`[blockBatch] members, worst 25 of ${rows.length} by boundary facing nothing:`);
            console.table(rows.slice(0, 25));
        } else {
            console.table(rows);
        }
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`${block.name}: ${block.corridorTouchM} m of its `
                + `${block.outlineM} m outline runs along a road (${Math.round(block.enclosure * 100)}%), `
                + `${unaccountedM} m faces nothing.`);
        }
        return { block, members: rows, neighbours, nearestHoles, unaccountedM, absorbedRoads, runaway };
    }

    global.BlockBatch = {
        planBlockUrbanRules, createBlockUrbanRules, collectParcels, designFor, whyIsBlockUnfilled,
        planBlockRenames, renameLegacyBlockNames
    };
    global.planBlockUrbanRules = planBlockUrbanRules;
    global.createBlockUrbanRules = createBlockUrbanRules;
    global.whyIsBlockUnfilled = whyIsBlockUnfilled;
    global.planBlockRenames = planBlockRenames;
    global.renameLegacyBlockNames = renameLegacyBlockNames;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            planBlockUrbanRules, createBlockUrbanRules, collectParcels, designFor,
            whyIsBlockUnfilled, occupancy, isPopulated, occupiersOf,
            blockBaseName, blockFingerprint, blockCode, nameBlocks,
            isLegacyBlockName, blockParcelIdsOf, planBlockRenames, renameLegacyBlockNames
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
