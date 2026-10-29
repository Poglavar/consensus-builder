// _applyParcelLayoutProposal, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyParcels = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    function clipFailureApi() {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('../parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    function openGroundApi() {
        if (typeof window !== 'undefined' && window.__openGround) return window.__openGround;
        return typeof require === 'function' ? require('../open-ground.js') : null;
    }

    // The pure parcel-layout modules: browser globals, CommonJS in node tests.
    function layoutValidationApi() {
        const api = (typeof window !== 'undefined' && window.ParcelLayoutValidation)
            || (typeof require === 'function' ? require('../../parcel-layout-validation.js') : null);
        if (!api || typeof api.validate !== 'function') throw new Error('Parcel-layout validation is unavailable.');
        return api;
    }

    function layoutRecordApi() {
        const api = (typeof window !== 'undefined' && window.ParcelLayoutRecord)
            || (typeof require === 'function' ? require('../../parcel-layout-record.js') : null);
        if (!api || typeof api.plotFingerprint !== 'function') throw new Error('Parcel-layout plot references are unavailable.');
        return api;
    }

    function layoutOwnershipApi() {
        const api = (typeof window !== 'undefined' && window.ParcelLayoutOwnership)
            || (typeof require === 'function' ? require('../../parcel-layout-ownership.js') : null);
        if (!api || typeof api.ownersOf !== 'function') throw new Error('Parcel-layout ownership carry-over is unavailable.');
        return api;
    }

    // What a formed plot shows in the parcel panel: one holder in the shape a single owner always
    // had, several as a joint holding with their shares.
    function holdingOf(owners) {
        return {
            owners: owners.map(owner => {
                const percent = owner.share * 100;
                return {
                    name: owner.displayName,
                    ownerLabel: owner.displayName,
                    ownerKey: owner.ownerKey,
                    percentageShare: percent,
                    actualShareText: `${Math.round(percent * 10) / 10}%`
                };
            }),
            jointPool: owners.length > 1
        };
    }

    const stamp = () => new Date().toISOString();

    return {
    async _applyParcelLayoutProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[${stamp()}] [_applyParcelLayoutProposal] Starting application for ${idLabel}...`);

        if (!proposalData || !proposalData.parcelLayout) {
            console.warn(`[${stamp()}] [_applyParcelLayoutProposal] ${idLabel}: the record carries no parcel layout`);
            try { this._setLastApplyFailure(idLabel, { code: 'invalid-proposal', message: 'The record carries no parcel layout.' }); } catch (_) { }
            return false;
        }
        // Apply works from a private copy. Later roads carve its plots, and nothing derived at
        // apply time is ever written back into the authored layout.
        const layout = JSON.parse(JSON.stringify(proposalData.parcelLayout));

        // Validate the authored layout before later roads carve the private copy. Those roads
        // legitimately leave runtime gaps in the pool; they do not change the design. The geometry
        // rules are the whole check: a layout says nothing about owners, shares or terms.
        const validation = layoutValidationApi().validate(layout, {
            turf: typeof turf !== 'undefined' ? turf : (typeof window !== 'undefined' ? window.turf : null),
            // A site subdivision tiles its record's site.
            site: layout.poolSource === 'site' ? proposalData.site : undefined
        });
        if (!validation.valid) {
            const message = validation.errors.map(item => item.message).join(' ');
            this._setLastApplyFailure?.(idLabel, { code: 'invalid-parcel-layout', message, validation });
            if (typeof updateStatus === 'function') updateStatus(message);
            const error = new Error(message);
            error.code = 'invalid-parcel-layout';
            error.validation = validation;
            throw error;
        }

        // Capture each plot's reference before later corridors alter/filter the private plots.
        const layoutRecord = layoutRecordApi();
        const plotFingerprints = new WeakMap(layout.plots.map(plot => [plot, layoutRecord.plotFingerprint(plot)]));

        // Skip overlay rendering: add child parcels directly with existing parcel styling
        console.debug(`[${stamp()}] [_applyParcelLayoutProposal] ${idLabel}: forming ${layout.plots.length} plot(s) as parcels directly.`);

        // Corridors applied AFTER this layout take their ribbon out of its plots — the same rule that
        // carves a park (apply/road.js _groundAfterLaterCorridors): a plot the road crosses keeps the
        // rest of its ground, split into parts where the road runs through it; a plot the road takes
        // whole is not formed. The authored layout is untouched (this is the private copy), so
        // unapplying the road gives the plots back. The resolver measures the carved layout.
        let groundRecord = proposalData;
        if (typeof this._groundAfterLaterCorridors === 'function') {
            const carved = this._groundAfterLaterCorridors(proposalData, layout.plots.map(plot => plot.geometry), options);
            if (carved.corridorIds.length) {
                layout.plots = layout.plots
                    .map((plot, index) => {
                        const geometry = carved.geometries[index];
                        if (!geometry) return null;
                        const next = { ...plot, geometry };
                        plotFingerprints.set(next, plotFingerprints.get(plot));
                        if (plot.area !== undefined) next.area = _calculateGeoJsonArea(geometry);
                        return next;
                    })
                    .filter(Boolean);
                if (!layout.plots.length) {
                    const message = 'Cannot apply the parcel layout: later roads take all of its plots.';
                    try { this._setLastApplyFailure(idLabel, { code: 'readjustment-taken-by-corridors', message, corridorIds: carved.corridorIds }); } catch (_) { }
                    if (typeof updateStatus === 'function') updateStatus(message);
                    return false;
                }
                groundRecord = {
                    ...proposalData,
                    parcelLayout: { ...proposalData.parcelLayout, plots: layout.plots }
                };
            }
        }

        // An EARLIER road is not carved: nothing is formed over a street. On cadastral ground the
        // arrangement already enforces it (the road's ground is no host piece, so coverage fails);
        // open ground has no arrangement, so the plots are tested against the standing roads here,
        // exactly as a park or square on open ground is.
        const ground = openGroundApi();
        if (ground && ground.hasOpenGround(proposalData) && typeof this._appliedRoadOverlappedByTaking === 'function') {
            for (const plot of layout.plots) {
                const geometry = plot.geometry;
                if (!geometry || !/Polygon/.test(String(geometry.type || ''))) continue;
                const roadHit = this._appliedRoadOverlappedByTaking(geometry, idLabel, options);
                if (!roadHit) continue;
                const road = roadHit.proposal;
                const roadName = road.title || road.name || road.proposalId;
                const message = `Cannot apply the parcel layout: its plots would stand on ${Math.round(roadHit.overlapM2)} m² of the applied road "${roadName}". Nothing is formed over a street — move the outline clear, or unapply that road first.`;
                if (typeof updateStatus === 'function') updateStatus(message);
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'readjustment-over-road',
                        message,
                        roadProposalId: String(road.proposalId || ''),
                        overlapM2: roadHit.overlapM2
                    });
                } catch (_) { }
                return false;
            }
        }

        const liveParents = this._resolveLiveFormationParents(groundRecord, idLabel, 'parcel layout', options);
        if (!liveParents.ok) return false;
        let parentIds = liveParents.ids;
        let parentFeatures = liveParents.features;

        // A layout may stand on any ground NOT already taken — including the remainders a road
        // left behind. That is the whole point of drawing roads to form a block and then
        // redividing it: a block bounded by roads is made of remainders by construction, so
        // requiring whole cadastral parcels meant a layout could never touch anything the roads
        // had created (ruling 2026-08-10, replacing the whole-parcel rule of 2026-08-07).
        //
        // What it may still not do is take ground another formation has already taken — a corridor.
        // That is the same rule roads live under: you may take what is free, never what is spoken
        // for. A record is defined by its cadastral anchors plus the geometry of its take, exactly
        // as a road is; the pieces it stands on are derived and carry no authority of their own.
        //
        // Open ground (PARCEL-OPTIONAL.md phase 4): a subdivision takes the open-ground host, i.e.
        // the part of its site no parcel and no other proposal covers. A piece another proposal
        // FORMED on open ground (a park, a building plot, another subdivision's plot) is that
        // proposal's — open ground has no remainders, so such a piece is always spoken for — and
        // is refused like a corridor piece, never silently re-divided.
        const isHost = feature => !!(ground && ground.isOpenGroundHost(feature));
        {
            const takenParents = parentIds.map(String).filter(id => {
                const layerFeature = parentFeatures.find(f => String(_getParcelIdFromFeature(f)) === id);
                const props = (layerFeature && layerFeature.properties) || {};
                const takers = Array.isArray(props.formedByProposalIds) ? props.formedByProposalIds : [];
                const foreignGroundPiece = !!(ground && layerFeature && !isHost(layerFeature)
                    && ground.groundIdsOf(layerFeature).length
                    && props.producedByProposalId !== undefined && props.producedByProposalId !== null
                    && String(props.producedByProposalId) !== String(proposalId));
                return props.isCorridor === true || props.isTrack === true || takers.length > 0 || foreignGroundPiece;
            });
            if (takenParents.length) {
                const coverers = new Map();
                takenParents.forEach(id => {
                    const layerFeature = parentFeatures.find(f => String(_getParcelIdFromFeature(f)) === id);
                    const props = (layerFeature && layerFeature.properties) || {};
                    const takers = Array.isArray(props.formedByProposalIds) && props.formedByProposalIds.length
                        ? props.formedByProposalIds.map(String)
                        : (props.producedByProposalId ? [String(props.producedByProposalId)] : []);
                    takers.forEach(ownerId => {
                        if (!ownerId) return;
                        const record = options?._parcelMutation?.proposals?.getProposal?.(ownerId) || null;
                        coverers.set(ownerId, (record && (record.title || record.name)) || ownerId);
                    });
                });
                const names = Array.from(coverers.values());
                const message = names.length
                    ? `A parcel layout cannot take ground another design already holds: ${names.map(n => `"${n}"`).join(', ')}. Move the outline off it, or unapply ${names.length === 1 ? 'that design' : 'those designs'} first.`
                    : 'A parcel layout cannot take ground another design already holds. Move the outline off it, or unapply that design first.';
                if (typeof updateStatus === 'function') updateStatus(message);
                console.warn(`[${stamp()}] [_applyParcelLayoutProposal] ${idLabel}: ground already taken —`, takenParents);
                try {
                    this._setLastApplyFailure(idLabel, {
                        code: 'readjustment-taken-ground',
                        message,
                        coveringProposalIds: Array.from(coverers.keys())
                    });
                } catch (_) { }
                return false;
            }
            // The whole-parcel tessellation gate that used to sit here is gone. It required the
            // plan to cover every input parcel to 97%, which made a layout impossible on any
            // ground a road had touched — and forming blocks with roads and then redividing them is
            // the reason to draw roads first. A layout now takes what its outline covers; the
            // part of a parent it does NOT cover stays the owner's as a remainder (§14.2
            // below), exactly as it is for a road.
        }

        // The layout validation above rejects overlapping plots, an uncovered pool and plots
        // outside it even when a shared record bypassed the editor.

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const rootParcelId = liveParents.cadastreIds[0] || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null)
            || primaryNumber || 'parcel';

        // A plot is geometry only. Who holds the parcel it forms is carried over from the ground
        // under it once every piece is final (below), never read from the design.
        const childFeatures = layout.plots.map(plot => ({
            type: 'Feature',
            geometry: plot.geometry,
            properties: {
                producedByProposalId: proposalId,
                readjustmentPiece: { role: 'plot', plotFingerprint: plotFingerprints.get(plot) },
                cadastreParcelIds: liveParents.cadastreIds.slice(),
                rootParcelId,
                rootParcelNumber,
                calculatedArea: Math.round(_calculateGeoJsonArea(plot.geometry)),
                isProposed: true
            }
        }));

        // Flat anchors (formation-edit.js; rethink-proposals.md §15a). Every
        // plot records the base cadastral parcels actually under it — a comasation plot spanning
        // thirty parents is one formation with thirty base anchors, never a chain — and the
        // proposal's flat declaration is written where the cut is computed. Edits are new records;
        // an unchanged record therefore derives the same ids from the same ordered geometry.
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const turfRef = (typeof turf !== 'undefined') ? turf : null;
        if (!formationEdit || !turfRef || typeof turfRef.intersect !== 'function') {
            throw new Error('Parcel-layout formation requires the cadastral provenance geometry service.');
        }
        const anchorCtx = {
            area: f => { try { return turfRef.area(f) || 0; } catch (_) { return 0; } },
            // Zero would drop a parcel from a plot's provenance (whose ground it is).
            intersectionArea: (a, b) => {
                try { const hit = turfRef.intersect(a, b); return hit ? turfRef.area(hit) : 0; } catch (error) {
                    throw clipFailureApi().clipFailure('intersect', error, { site: 'apply-parcels.intersectionArea', proposalId }, [a, b]);
                }
            }
        };
        // Provenance per plot: the cadastral parcels under it and, on open ground, the ground id of
        // the host it stands on. A plot wholly on open ground carries only `groundIds` (rootless id);
        // one spanning both carries both; one on neither is ground from nowhere and refuses.
        const parentEntries = parentFeatures.flatMap(feature => formationEdit.cadastreIdsOfFeature(feature)
            .map(baseId => ({ baseId, feature })));
        const groundEntries = ground
            ? parentFeatures.flatMap(feature => ground.groundIdsOf(feature).map(baseId => ({ baseId, feature })))
            : [];
        if (!parentEntries.length && !groundEntries.length) {
            throw new Error('Parcel-layout parents carry no explicit cadastral or open-ground provenance.');
        }
        // The fabric accepts a plot only when every vertex lies in one of its own cadastral
        // parcels (live-fabric.js vertexInsideFact). A plot can reach into a parcel of the layout
        // by less than the area floor above and still put a vertex well inside it (a 0.13 m² sliver
        // 0.37 m deep, on ground a street already carved from that parcel's pieces): that parcel
        // holds its ground too, so it joins the plot's provenance.
        const fabricDraft = options?._parcelMutation?.fabric;
        const layoutIds = [...new Set(parentEntries.map(entry => String(entry.baseId)))];
        const anchorVertices = (feature, ids) => {
            if (typeof fabricDraft?.cadastreIdsHolding !== 'function') return ids;
            turfRef.coordAll(feature).forEach(vertex => {
                if (fabricDraft.cadastreIdsHolding(vertex, ids).length) return;
                const host = fabricDraft.cadastreIdsHolding(vertex, layoutIds.filter(id => !ids.includes(id)))[0];
                if (host) ids.push(host);
            });
            return ids;
        };
        childFeatures.forEach(feature => {
            const ids = parentEntries.length ? anchorVertices(feature, formationEdit.overlappingBaseIds(feature, parentEntries, anchorCtx)) : [];
            const groundIds = groundEntries.length ? formationEdit.overlappingBaseIds(feature, groundEntries, anchorCtx) : [];
            if (!ids.length && !groundIds.length) {
                throw new Error('A layout plot lies on no declared cadastral parcel and no open ground of its site.');
            }
            feature.properties.cadastreParcelIds = ids;
            if (groundIds.length) feature.properties.groundIds = groundIds;
            else delete feature.properties.groundIds;
            if (!ids.length) {
                feature.properties.rootParcelId = null;
                feature.properties.rootParcelNumber = null;
            }
        });

        let allocForeignIndex = null;
        // §14.2: a formation owes the owner their remainders. The pool consumed above is the
        // LIVE ground under the layout's footprint, and the authored plots may tile less than that
        // (plots drawn against another generation's fabric) — every scrap of pool the plots do
        // not cover is minted back as a remainder parcel, cloned from its parent so the owner
        // keeps it. Without this the leftover strip is ORPHANED: consumed, unminted, a hole in
        // the fabric that hover can only resolve to the hidden ancestor (the Cibona sliver).
        try {
            const turfRemainder = (typeof turf !== 'undefined') ? turf : null;
            // Every part of a formed parcel that is not covered by its authored plots is returned
            // to its owner. Subsequent corridor takes divide that ordinary remainder as needed.
            if (turfRemainder && typeof turfRemainder.difference === 'function' && parentFeatures.length) {
                let plotsUnion = null;
                // The shared clip's grid: a raw union of a block's plots with a carved courtyard left
                // a three-point sliver ring and refused the layout. A failure there still throws, as a
                // plot missing from the union would be minted back as the owner's remainder.
                childFeatures.forEach(feature => {
                    const f = { type: 'Feature', properties: {}, geometry: feature.geometry };
                    plotsUnion = plotsUnion
                        ? clipFailureApi().clipWith(turfRemainder, 'union', plotsUnion, f, { site: 'apply-parcels.plotsUnion', proposalId })
                        : f;
                });
                if (plotsUnion) {
                    parentFeatures.forEach(parentFeature => {
                        if (!parentFeature || !parentFeature.geometry) return;
                        // Open ground has no owner to return a remainder to: the host's leftover
                        // stays open ground, nothing is minted for it.
                        if (isHost(parentFeature)) return;
                        // A failed difference throws: null would mean "no remainder", and the owner's
                        // leftover strip would be consumed and never minted, a hole in the fabric.
                        const leftover = clipFailureApi().clipWith(turfRemainder, 'difference',
                            { type: 'Feature', properties: {}, geometry: parentFeature.geometry }, plotsUnion, {
                                site: 'apply-parcels.remainder',
                                proposalId,
                                parcelId: _getParcelIdFromFeature(parentFeature)
                            });
                        if (!leftover || !leftover.geometry) return;
                        let leftoverArea = 0;
                        try { leftoverArea = turfRemainder.area(leftover) || 0; } catch (_) { leftoverArea = 0; }
                        if (leftoverArea < 0.5) return; // rounding, not land
                        const parentId = _getParcelIdFromFeature(parentFeature);
                        // §15b identity flows with the ground: the leftover of ANOTHER
                        // proposal's formed plot stays the VICTIM's child — the largest part
                        // keeps the plot's id (same parcel, smaller), splits continue the
                        // victim's numbering, and the clone keeps the victim's proposalId and
                        // ownership untouched. Only ground under this layout's plots is re-formed.
                        const carryIdentity = formationEdit.formationIdentityOf(parentFeature);
                        const parentProducer = parentFeature.properties
                            && parentFeature.properties.producedByProposalId;
                        if (carryIdentity && parentProducer && String(parentProducer) !== String(proposalId)
                            && typeof _extractPolygonsWithHolesFromGeometry === 'function'
                            && typeof _ensurePolygonIsClosed === 'function') {
                            if (!allocForeignIndex) allocForeignIndex = this._createForeignIndexAllocator(options);
                            allocForeignIndex.reserve(carryIdentity.anchor, carryIdentity.token, carryIdentity.index);
                            const parts = _extractPolygonsWithHolesFromGeometry(leftover.geometry)
                                .map(({ outer, holes }) => {
                                    const coords = [_ensurePolygonIsClosed(outer || []), ...(Array.isArray(holes) ? holes.map(ring => _ensurePolygonIsClosed(ring || [])) : [])];
                                    let area = 0;
                                    try { area = turfRemainder.area(turfRemainder.polygon(coords)) || 0; } catch (_) { area = 0; }
                                    return { coords, area };
                                })
                                .filter(part => part.area >= 0.5)
                                .sort((x, y) => y.area - x.area);
                            parts.forEach((part, partIndex) => {
                                const carried = JSON.parse(JSON.stringify(parentFeature));
                                carried.geometry = { type: 'Polygon', coordinates: part.coords };
                                carried.properties = carried.properties || {};
                                carried.properties.calculatedArea = Math.round(part.area);
                                const syntheticIndex = partIndex === 0
                                    ? carryIdentity.index
                                    : allocForeignIndex(carryIdentity.anchor, carryIdentity.token);
                                const carriedId = partIndex === 0
                                    ? String(parentId)
                                    : _composeSyntheticParcelId(
                                        carryIdentity.root,
                                        carryIdentity.token,
                                        syntheticIndex);
                                const carriedNumber = partIndex === 0
                                    ? ((parentFeature.properties && parentFeature.properties.BROJ_CESTICE) || null)
                                    : _composeSyntheticParcelNumber(
                                        carried.properties.rootParcelNumber || null,
                                        carryIdentity.token,
                                        syntheticIndex);
                                carried.properties.__carryIdentity = {
                                    parcelId: carriedId,
                                    parcelNumber: carriedNumber,
                                    syntheticToken: carryIdentity.token,
                                    syntheticIndex
                                };
                                _ensureParcelIdOnProperties(carried.properties, carriedId);
                                childFeatures.push(carried);
                            });
                            return;
                        }
                        const remainder = JSON.parse(JSON.stringify(parentFeature));
                        remainder.geometry = leftover.geometry;
                        remainder.properties = remainder.properties || {};
                        remainder.properties.producedByProposalId = proposalId;
                        remainder.properties.readjustmentPiece = { role: 'remainder' };
                        remainder.properties.calculatedArea = Math.round(leftoverArea);
                        remainder.properties.isProposed = true;
                        childFeatures.push(remainder);
                    });
                }
            }
        } catch (remainderError) {
            // A clip failure keeps its type, site and parcel.
            if (remainderError && remainderError.name === 'ClipFailure') throw remainderError;
            throw new Error(`Parcel-layout remainder formation failed: ${remainderError.message || remainderError}`);
        }

        this._assignSyntheticChildIdentities(proposalId, childFeatures);

        // Ownership is carried over, never transferred (plan-design-agreement.md, M1 (a)): every
        // piece this layout forms — plot or remainder, after any split into connected parts — is
        // held by the recorded owners of the ground under it, pro rata by area; open ground stays
        // unowned. Only an executed agreement moves land between owners. A carried piece of
        // ANOTHER proposal's plot (§15b above) keeps whatever it had.
        const mutation = options && options._parcelMutation;
        const ownershipContext = { storage: mutation && mutation.storage, agentStore: mutation && mutation.agents };
        const ownerOf = source => {
            const storage = ownershipContext.storage;
            const id = _getParcelIdFromFeature(source);
            const agentId = storage && typeof storage.getItem === 'function' && id ? storage.getItem(`parcel_${id}_owner`) : null;
            if (!agentId) return null;
            const agent = ownershipContext.agentStore?.getAgent?.(String(agentId)) || null;
            return { ownerKey: String(agentId), displayName: (agent && agent.name) || String(agentId) };
        };
        const ownership = layoutOwnershipApi();
        const ownedSources = parentFeatures.filter(feature => !isHost(feature));
        const holdersOf = new Map();
        childFeatures.forEach(feature => {
            if (String(feature.properties.producedByProposalId) !== String(proposalId)) return;
            const { owners } = ownership.ownersOf(feature, ownedSources, ownerOf, { ...anchorCtx, turf: turfRef });
            holdersOf.set(feature, owners);
            // A remainder is a clone of its parent and keeps what the parcel panel showed for it.
            if (feature.properties.readjustmentPiece.role !== 'plot' || !owners.length) return;
            feature.properties.ownershipDetails = holdingOf(owners);
            feature.properties.jointPool = owners.length > 1;
        });

        await this._addFeaturesToMap(childFeatures, true, proposalData, options);

        const touchedAgentIds = new Set();
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            // §15b: a carried piece of a FOREIGN plot is the victim's child, not this
            // layout's — see the road apply's twin branch.
            const pieceProposalId = feature.properties && feature.properties.producedByProposalId
                ? String(feature.properties.producedByProposalId) : String(proposalId);
            if (pieceProposalId !== String(proposalId)) {
                this._markParcelProducedByProposal(parcelId, pieceProposalId, options);
                return;
            }
            feature.properties.producedByProposalId = proposalId;
            this._markParcelProducedByProposal(parcelId, proposalId, options);
            const owners = holdersOf.get(feature) || [];
            if (parcelId === undefined || parcelId === null || !owners.length) return;
            // The owner record is kept per piece, so carrying a holding over is written as a record
            // for the new piece. One holder keeps their own agent; several hold it jointly.
            // skipAgentSync defers the per-agent owned-parcels rebuild to one pass after the loop —
            // per piece it re-scanned the whole keyspace (O(pieces²), the ~1s-per-parcel freeze).
            if (typeof transferParcelOwnership !== 'function'
                || (owners.length > 1 && typeof getOrCreateJointPoolAgent !== 'function')) {
                throw new Error('Parcel owner records are unavailable, so the holders of a layout plot cannot be carried over.');
            }
            const agentId = owners.length === 1
                ? owners[0].ownerKey
                : getOrCreateJointPoolAgent(
                    owners.map(owner => owner.displayName).join(' / '),
                    owners.map(owner => ({ agentId: owner.ownerKey, name: owner.displayName, share: owner.share })),
                    ownershipContext);
            transferParcelOwnership(String(parcelId), null, agentId, { ...ownershipContext, skipAgentSync: true });
            touchedAgentIds.add(agentId);
        });

        // Rebuild the touched agents' owned-parcel lists in ONE keyspace pass (buildAgentOwnedParcelIndex),
        // batching the agent save to once — instead of a full scan + full re-serialize per piece above.
        if (touchedAgentIds.size && typeof buildAgentOwnedParcelIndex === 'function' && ownershipContext.agentStore) {
            const ownerIndex = buildAgentOwnedParcelIndex({ storage: ownershipContext.storage });
            touchedAgentIds.forEach(id => ownershipContext.agentStore.updateAgent(id, {
                ownedParcels: ownerIndex.get(id) || []
            }));
        }

        // The record keeps only flat cadastral ground actually consumed. Live generated ids are
        // local cut inputs; after replacement they are deleted rather than retained as lineage.
        // §15b: an id carried onto a minted piece is the LIVE piece now — hiding it or
        // recording it as a consumed parent would consume the victim's surviving plot. The
        // ground it lost is anchored to the BASE parcel instead, so this layout's unapply
        // frees it as a BASE remainder (latest wins — never the plot at stale geometry).
        const mintedIdSet = new Set(childFeatures
            .map(f => { try { return String(_getParcelIdFromFeature(f)); } catch (_) { return null; } })
            .filter(Boolean));
        const carriedBaseAnchors = new Set();
        const consumedParentIds = Array.from(new Set(parentFeatures
            .filter(f => !isHost(f))
            .map(f => { const id = _getParcelIdFromFeature(f); return id ? String(id) : null; })
            .filter(Boolean)))
            .filter(id => {
                if (mintedIdSet.has(String(id))) {
                    const retained = parentFeatures.find(feature => (
                        String(_getParcelIdFromFeature(feature) || '') === String(id)
                    ));
                    const cadastreIds = Array.isArray(retained?.properties?.cadastreParcelIds)
                        ? retained.properties.cadastreParcelIds.map(String)
                        : [];
                    cadastreIds.forEach(baseId => carriedBaseAnchors.add(String(baseId)));
                    return false;
                }
                // parentFeatures were resolved from the transaction's live-fabric draft. Their
                // presence there is the domain proof that they are consumable; a Leaflet layer is
                // only a projection and can never veto or resurrect a parcel mutation.
                return true;
            });
        carriedBaseAnchors.forEach(baseId => {
            if (!consumedParentIds.includes(baseId)) consumedParentIds.push(baseId);
        });
        // The open-ground host is transient (never in the fabric): nothing to consume.
        this._consumeFeaturesFromLiveFabric(parentFeatures.filter(f => {
            if (isHost(f)) return false;
            try { return !mintedIdSet.has(String(_getParcelIdFromFeature(f))); } catch (_) { return true; }
        }), options);
        const flatParentIds = Array.from(new Set(
            Array.isArray(proposalData.cadastreParcelIds)
                ? proposalData.cadastreParcelIds.map(String).filter(Boolean)
                : []
        ));
        if (!flatParentIds.length && !liveParents.groundHost) {
            const error = new Error('Cannot apply the parcel layout without explicit cadastral provenance.');
            error.code = 'parcel-layout-cadastre-provenance-missing';
            throw error;
        }
        persistAppliedProposal(proposalData, proposalId, options);
        // The status line is written once, for every type, by _runProposalApplyWithSummary.
        if (options.deferPresentation !== true) refreshProposalUIAfterApply(null, options);

        const totalTime = performance.now() - startTime;
        console.debug(`[${stamp()}] [_applyParcelLayoutProposal] ✓ ${idLabel} formed in ${totalTime.toFixed(2)}ms`);
        return true;
    },
    };
});
