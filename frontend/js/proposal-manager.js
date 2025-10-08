class Proposal {
    constructor({ id, name, type, definition, parentFeatures, author, description, offer, budget }) {
        this.id = id || `proposal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.name = name;
        this.type = type; // 'road', 'building', etc.
        this.status = 'unapplied'; // 'applied' or 'unapplied'

        // Data to recreate the proposal's geometry, e.g., points and width for a road
        this.definition = definition || {};

        // Deep copy of original GeoJSON features (parcels, etc.) before they were changed
        this.parentFeatures = parentFeatures;
        // GeoJSON features of the new/modified objects created by this proposal
        this.childFeatures = [];

        // Dependency tracking
        this.parentProposals = new Set(); // Set of parent proposal IDs
        this.childProposals = new Set();  // Set of child proposal IDs

        const numericOffer = typeof offer === 'number' ? offer : parseFloat(offer);
        const offerValue = Number.isFinite(numericOffer) ? numericOffer : null;
        const numericBudget = typeof budget === 'number' ? budget : parseFloat(budget);
        const budgetValue = Number.isFinite(numericBudget) ? numericBudget : offerValue;

        this.author = (author && String(author).trim()) || 'User';
        this.description = (description && String(description).trim()) || '';
        this.offer = offerValue;
        this.budget = budgetValue;

        this.calculateChildFeatures();
    }

    calculateChildFeatures() {
        if (this.type !== 'road') {
            return;
        }

        const roadPolygon = _calculateRoadPolygon(this.definition.points, this.definition.width);
        if (!roadPolygon || this.parentFeatures.length === 0) {
            console.error('Invalid inputs to calculateChildFeatures');
            return;
        }

        const numberAllocators = {};

        const getRootInfo = (feature) => {
            const props = feature?.properties || {};
            const parcelNumber = props.BROJ_CESTICE ? String(props.BROJ_CESTICE) : '';
            const cesticaId = props.CESTICA_ID ? String(props.CESTICA_ID) : '';
            const rootNumber = props.rootParcelNumber || _extractRootParcelNumber(parcelNumber);
            const rootCesticaId = props.rootParcelId || _extractRootCesticaId(cesticaId);
            return {
                rootNumber,
                rootCesticaId
            };
        };

        const getAllocatorKey = (rootNumber, rootCesticaId) => `${rootNumber}__${rootCesticaId}`;

        const getNextIdentity = (rootNumber, rootCesticaId) => {
            if (!rootNumber || !rootCesticaId) {
                console.warn('Missing root info for parcel identity generation:', { rootNumber, rootCesticaId });
                return null;
            }
            const key = getAllocatorKey(rootNumber, rootCesticaId);
            let state = numberAllocators[key];
            if (!state) {
                const maxExisting = _computeExistingMaxSubnumber(rootNumber);
                state = numberAllocators[key] = {
                    baseId: rootCesticaId,
                    nextIndex: maxExisting + 1
                };
            }
            const sub = state.nextIndex;
            state.nextIndex += 1;
            return {
                parcelNumber: `${rootNumber}/${sub}`,
                cesticaId: `${state.baseId}_${sub}`,
                subNumber: sub
            };
        };

        const affectedParcels = this.parentFeatures.map(f => {
            const layer = L.geoJSON(f);
            const rootInfo = getRootInfo(f);
            return {
                id: f.properties.CESTICA_ID,
                number: f.properties.BROJ_CESTICE,
                rootNumber: rootInfo.rootNumber,
                rootCesticaId: rootInfo.rootCesticaId,
                layer: layer,
                feature: f
            };
        });

        const primaryAffectedParcelNumber = affectedParcels[0]?.number;
        if (!primaryAffectedParcelNumber) {
            console.error("Could not determine primary affected parcel number.");
            return;
        }

        const primaryRootNumber = affectedParcels[0]?.rootNumber;
        const primaryRootCesticaId = affectedParcels[0]?.rootCesticaId;
        const roadIdentity = getNextIdentity(primaryRootNumber, primaryRootCesticaId);

        const roadFeatureProperties = {
            CESTICA_ID: roadIdentity ? roadIdentity.cesticaId : `road_${Date.now()}`,
            BROJ_CESTICE: roadIdentity ? roadIdentity.parcelNumber : `${primaryAffectedParcelNumber}/road`,
            isRoad: true,
            calculatedArea: _calculateAreaFromLatLngPolygon(roadPolygon),
            roadName: this.name,
            isProposed: true,
            proposalId: this.id,
            parentParcelId: affectedParcels[0]?.id || null,
            parentParcelNumber: primaryAffectedParcelNumber,
            parentParcelIds: affectedParcels.map(p => p.id),
            parentParcelNumbers: affectedParcels.map(p => p.number),
            rootParcelNumber: primaryRootNumber,
            rootParcelId: primaryRootCesticaId
        };

        const roadCoordinates = roadPolygon.map(p => [p.lng, p.lat]);
        const roadFeature = {
            type: 'Feature',
            properties: roadFeatureProperties,
            geometry: {
                type: 'Polygon',
                coordinates: [roadCoordinates]
            }
        };
        this.childFeatures.push(roadFeature);

        const createdGeometryHashes = new Set();

        for (const parcel of affectedParcels) {
            const originalFeature = parcel.feature;
            const originalNumber = originalFeature.properties.BROJ_CESTICE;
            const parcelId = originalFeature.properties.CESTICA_ID;
            const rootNumber = parcel.rootNumber;
            const rootCesticaId = parcel.rootCesticaId;

            try {
                const rings = _getParcelOuterRingsLngLat(originalFeature);
                const parcelOuter = (rings && rings.length > 0) ? rings[0] : null;
                if (!parcelOuter || parcelOuter.length < 4) throw new Error('Invalid parcel outer ring');

                const parcelTurf = turf.polygon([_ensurePolygonIsClosed(parcelOuter)]);
                const roadTurf = turf.polygon([_ensurePolygonIsClosed(roadPolygon.map(p => [p.lng, p.lat]))]);
                const difference = turf.difference(parcelTurf, roadTurf);
                const parentIsRoad = originalFeature?.properties?.isRoad === true
                    || originalFeature?.properties?.isRoad === 'true';

                if (!difference) {
                    // Parcel is completely covered, so it produces no child features.
                    console.log(`Parcel ${parcelId} (${originalNumber}) completely covered by road - removed.`);
                    continue;
                }

                if (difference.geometry.type === 'Polygon') {
                    const remainingCoords = _ensurePolygonIsClosed(difference.geometry.coordinates[0]);
                    const newFeature = JSON.parse(JSON.stringify(originalFeature)); // Deep copy
                    newFeature.geometry.type = 'Polygon';
                    newFeature.geometry.coordinates = [remainingCoords];
                    newFeature.properties.calculatedArea = turf.area(turf.polygon([remainingCoords]));
                    const identity = getNextIdentity(rootNumber, rootCesticaId);
                    if (identity) {
                        newFeature.properties.CESTICA_ID = identity.cesticaId;
                        newFeature.properties.BROJ_CESTICE = identity.parcelNumber;
                    } else {
                        newFeature.properties.CESTICA_ID = `${parcelId}_derived_${Date.now()}`;
                        newFeature.properties.BROJ_CESTICE = rootNumber ? `${rootNumber}/${Date.now()}` : `${originalNumber}/${Date.now()}`;
                    }
                    newFeature.properties.parentParcelId = parcelId;
                    newFeature.properties.parentParcelNumber = originalNumber;
                    newFeature.properties.rootParcelNumber = rootNumber;
                    newFeature.properties.rootParcelId = rootCesticaId;
                    newFeature.properties.proposalId = this.id;
                    newFeature.properties.isRoad = parentIsRoad;
                    this.childFeatures.push(newFeature);

                } else if (difference.geometry.type === 'MultiPolygon') {
                    const polygons = difference.geometry.coordinates;
                    const uniquePolygons = new Map();
                    polygons.forEach((polyCoords) => {
                        const outerRing = Array.isArray(polyCoords[0][0]) ? polyCoords[0] : polyCoords;
                        const area = turf.area(turf.polygon([outerRing]));
                        if (area > 0.1) {
                            const hash = _geometryHash([outerRing]);
                            uniquePolygons.set(hash, { polygon: outerRing, area: area });
                        }
                    });
                    const polygonsWithArea = Array.from(uniquePolygons.values()).sort((a, b) => b.area - a.area);

                    // Largest part keeps original ID
                    const largestPartData = polygonsWithArea.shift();
                    if (largestPartData) {
                        const largestPartCoords = _ensurePolygonIsClosed(largestPartData.polygon);
                        const largestFeature = JSON.parse(JSON.stringify(originalFeature));
                        largestFeature.geometry.type = 'Polygon';
                        largestFeature.geometry.coordinates = [largestPartCoords];
                        largestFeature.properties.calculatedArea = largestPartData.area;
                        const identity = getNextIdentity(rootNumber, rootCesticaId);
                        if (identity) {
                            largestFeature.properties.CESTICA_ID = identity.cesticaId;
                            largestFeature.properties.BROJ_CESTICE = identity.parcelNumber;
                        } else {
                            largestFeature.properties.CESTICA_ID = `${parcelId}_derived_${Date.now()}`;
                            largestFeature.properties.BROJ_CESTICE = rootNumber ? `${rootNumber}/${Date.now()}` : `${originalNumber}/${Date.now()}`;
                        }
                        largestFeature.properties.parentParcelId = parcelId;
                        largestFeature.properties.parentParcelNumber = originalNumber;
                        largestFeature.properties.rootParcelNumber = rootNumber;
                        largestFeature.properties.rootParcelId = rootCesticaId;
                        largestFeature.properties.proposalId = this.id;
                        largestFeature.properties.isRoad = parentIsRoad;
                        this.childFeatures.push(largestFeature);
                    }

                    // Create new parcels for the smaller parts
                    for (const partData of polygonsWithArea) {
                        const partCoords = _ensurePolygonIsClosed(partData.polygon);
                        const hash = _geometryHash([partCoords]);
                        if (createdGeometryHashes.has(hash)) continue;
                        createdGeometryHashes.add(hash);

                        const identity = getNextIdentity(rootNumber, rootCesticaId);
                        const newProperties = {
                            ...originalFeature.properties,
                            CESTICA_ID: identity ? identity.cesticaId : `${parcelId}_split_${Date.now()}`,
                            BROJ_CESTICE: identity ? identity.parcelNumber : `${originalNumber}/split`,
                            calculatedArea: partData.area,
                            isRoad: parentIsRoad,
                            proposalId: this.id,
                            parentParcelId: parcelId,
                            parentParcelNumber: originalNumber,
                            rootParcelNumber: rootNumber,
                            rootParcelId: rootCesticaId
                        };
                        delete newProperties.roadName;

                        const newSplitFeature = {
                            type: 'Feature',
                            properties: newProperties,
                            geometry: { type: 'Polygon', coordinates: [partCoords] }
                        };
                        this.childFeatures.push(newSplitFeature);
                    }
                }
            } catch (error) {
                console.error(`Error processing parcel ${parcelId} (Number: ${originalNumber}):`, error);
            }
        }
    }
}

const ProposalManager = {
    createProposal(options) {
        const proposal = new Proposal(options);
        console.log(`Proposal created: ${proposal.id}`, proposal);

        // Store in proposalStorage with the existing proposals system
        const normalizedAuthor = (options.author && String(options.author).trim()) || proposal.author || 'User';
        const normalizedDescription = (options.description && String(options.description).trim())
            || proposal.description
            || `Road: ${proposal.name}`;
        const offerFromOptions = typeof options.offer === 'number' ? options.offer : parseFloat(options.offer);
        const offerValue = Number.isFinite(proposal.offer) ? proposal.offer : (Number.isFinite(offerFromOptions) ? offerFromOptions : null);
        const budgetFromOptions = typeof options.budget === 'number' ? options.budget : parseFloat(options.budget);
        const budgetValue = Number.isFinite(proposal.budget) ? proposal.budget : (Number.isFinite(budgetFromOptions) ? budgetFromOptions : offerValue);

        const proposalData = {
            type: 'road',
            title: proposal.name,
            author: normalizedAuthor,
            description: normalizedDescription,
            parcelIds: proposal.parentFeatures.map(f => f.properties.CESTICA_ID.toString()),
            roadProposal: {
                id: proposal.id,
                definition: proposal.definition,
                parentFeatures: proposal.parentFeatures,
                childFeatures: proposal.childFeatures,
                status: proposal.status
            },
            createdAt: new Date().toISOString()
        };

        if (Number.isFinite(offerValue)) {
            proposalData.offer = offerValue;
            proposalData.budget = Number.isFinite(budgetValue) ? budgetValue : offerValue;
        }

        if (typeof proposalStorage !== 'undefined') {
            const hash = proposalStorage.addProposal(proposalData);
            proposal.proposalHash = hash;

            if (hash) {
                this._linkProposalToAncestors(hash, proposalData.parcelIds);
            }

            // Update show proposals button
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }
        }

        return proposal;
    },

    registerBuildingProposal(proposalHash, parentParcelIds = []) {
        if (!proposalHash || !Array.isArray(parentParcelIds)) return;
        const normalized = parentParcelIds
            .map(id => id && id.toString ? id.toString() : String(id))
            .filter(Boolean);
        if (normalized.length === 0) return;
        this._linkProposalToAncestors(proposalHash, normalized);
    },

    applyProposal(proposalHash) {
        if (typeof proposalStorage === 'undefined') return false;

        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData) return false;

        if (proposalData.roadProposal) {
            return this._applyRoadProposal(proposalHash, proposalData);
        }

        if (this._isBuildingProposal(proposalData)) {
            return this._applyBuildingProposal(proposalHash, proposalData);
        }

        if (proposalData.type === 'structure' && proposalData.structureProposal) {
            return this._applyStructureProposal(proposalHash, proposalData);
        }

        return false;
    },

    _applyStructureProposal(proposalHash, proposalData) {
        try {
            const sp = proposalData.structureProposal || {};
            if (sp.status === 'applied' || proposalData.status === 'Applied') return true;

            const kind = (sp.kind === 'park' || sp.kind === 'square') ? sp.kind : 'square';
            const geometry = sp.geometry;
            const blockName = sp.blockName || null;
            const parentIds = Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0
                ? sp.parentParcelIds.map(x => x && x.toString ? x.toString() : String(x))
                : (proposalData.parcelIds || []).map(x => x && x.toString ? x.toString() : String(x));

            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                if (typeof updateStatus === 'function') updateStatus('Cannot apply structure proposal: missing geometry.');
                return false;
            }

            // Enforce only one structure per block: unapply other applied structure proposals on same block
            if (blockName) {
                try {
                    const all = proposalStorage.getAllProposals();
                    all.filter(p => p.proposalHash !== proposalHash && p.type === 'structure' && p.structureProposal && p.structureProposal.blockName === blockName)
                        .forEach(p => {
                            const st = p.structureProposal.status || (p.status === 'Applied' ? 'applied' : 'unapplied');
                            if (st === 'applied' || p.status === 'Applied') {
                                if (typeof this.unapplyProposal === 'function') this.unapplyProposal(p.proposalHash);
                            }
                        });
                } catch (e) { }
            }

            // Add to appropriate collection and layer
            const feature = { type: 'Feature', properties: { structureType: kind, blockName: blockName, proposalHash }, geometry: JSON.parse(JSON.stringify(geometry)) };
            if (kind === 'park') {
                if (!Array.isArray(window.parks)) window.parks = [];
                // Replace existing park on same block
                window.parks = window.parks.filter(f => f && f.properties && f.properties.blockName !== blockName);
                // Ensure decorations and save
                try { if (typeof ensureParkDecorations === 'function') ensureParkDecorations(feature); } catch (_) { }
                window.parks.push(feature);
                try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
                try { localStorage.setItem('cb_parks', JSON.stringify(window.parks)); } catch (_) { }
            } else {
                if (!Array.isArray(window.squares)) window.squares = [];
                window.squares = window.squares.filter(f => f && f.properties && f.properties.blockName !== blockName);
                try { if (typeof ensureSquareDecorations === 'function') ensureSquareDecorations(feature); } catch (_) { }
                window.squares.push(feature);
                try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
                try { localStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
            }

            // Link to ancestors and mark modified
            const uniqueParentIds = Array.from(new Set((parentIds || []).filter(Boolean)));
            this._linkProposalToAncestors(proposalHash, uniqueParentIds);
            uniqueParentIds.forEach(id => this._markParcelModified(id));

            // Update status
            sp.status = 'applied';
            proposalData.structureProposal = sp;
            if (proposalData.status !== 'Executed') proposalData.status = 'Applied';
            proposalStorage.proposals.set(proposalHash, proposalData);
            if (proposalStorage.save) proposalStorage.save();

            try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
            try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
            try { if (typeof updateStatus === 'function') updateStatus(`Applied ${kind} proposal ${proposalData.title || proposalHash.substring(0, 8)}`); } catch (_) { }
            if (typeof refreshParcelStylesForAppliedProposals === 'function') {
                refreshParcelStylesForAppliedProposals();
            }
            return true;
        } catch (e) {
            console.warn('Failed to apply structure proposal', e);
            return false;
        }
    },

    _applyRoadProposal(proposalHash, proposalData) {
        if (!proposalData || !proposalData.roadProposal) return false;

        const roadProposal = proposalData.roadProposal;
        if (roadProposal.status === 'applied') return true;

        const missingParents = this._getMissingParentParcels(roadProposal.parentFeatures);
        if (missingParents.length > 0) {
            const missingSummary = missingParents.map(info => {
                if (info.number) {
                    return `${info.number} [${info.id}]`;
                }
                return info.id;
            }).join(', ');
            const message = `Can't apply proposal, prerequisite parcels are missing: ${missingSummary}`;
            console.warn(message);
            if (typeof updateStatus === 'function') {
                updateStatus(message);
            }
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(message, 5000, 'error');
            }
            return false;
        }

        console.log(`Applying proposal ${proposalHash}:`, {
            parentFeatures: roadProposal.parentFeatures.length,
            childFeatures: roadProposal.childFeatures.length,
            parentIds: roadProposal.parentFeatures.map(f => f.properties.CESTICA_ID),
            childIds: roadProposal.childFeatures.map(f => f.properties.CESTICA_ID)
        });

        const parentParcelIds = (roadProposal.parentFeatures || [])
            .map(f => f?.properties?.CESTICA_ID)
            .filter(id => id !== undefined && id !== null)
            .map(id => id.toString());
        const uniqueParentParcelIds = Array.from(new Set(parentParcelIds));
        this._linkProposalToAncestors(proposalHash, uniqueParentParcelIds);
        uniqueParentParcelIds.forEach(id => this._markParcelModified(id));

        this._removeFeaturesFromMap(roadProposal.parentFeatures);

        roadProposal.parentFeatures.forEach(feature => {
            const parcelId = feature.properties.CESTICA_ID;
            localStorage.removeItem(`parcel_${parcelId}_geometry`);
            localStorage.removeItem(`parcel_${parcelId}_properties`);
        });

        // Add new features using normal map styling (no special proposal coloring)
        this._addFeaturesToMap(roadProposal.childFeatures, true);

        roadProposal.childFeatures.forEach(feature => {
            const parcelId = feature.properties.CESTICA_ID;
            const coords = feature.geometry.coordinates[0];
            localStorage.setItem(`parcel_${parcelId}_geometry`, JSON.stringify(coords));
            localStorage.setItem(`parcel_${parcelId}_properties`, JSON.stringify(feature.properties));

            if (feature.properties.isRoad) {
                localStorage.setItem(`parcel_${parcelId}_isRoad`, 'true');
                localStorage.setItem(`parcel_${parcelId}_roadName`, feature.properties.roadName || 'Unnamed Road');
                localStorage.setItem(`parcel_${parcelId}_roadId`, feature.properties.roadId || '');
            }

            this._addProposalAsAncestor(parcelId, proposalHash);
        });

        const descendantParcelIds = roadProposal.childFeatures.map(f => f.properties.CESTICA_ID.toString());
        this._addParcelsAsDescendants(proposalHash, descendantParcelIds);

        roadProposal.status = 'applied';
        proposalData.status = 'Applied';
        proposalStorage.save();

        // Keep proposals indicator in sync
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        if (typeof showAllProposalsModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                showAllProposalsModal();
            }
        }

        // Update proposals indicator and list button
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
            const affectedParcelIds = roadProposal.parentFeatures.map(f => f.properties.CESTICA_ID.toString());
            if (affectedParcelIds.includes(window.selectedParcelId.toString())) {
                if (typeof showParcelInfoPanel === 'function') {
                    const parcelLayer = window.parcelLayer.getLayers().find(l =>
                        l.feature.properties.CESTICA_ID.toString() === window.selectedParcelId.toString()
                    );
                    if (parcelLayer) {
                        showParcelInfoPanel(parcelLayer.feature);
                    }
                }
            }
        }

        return true;
    },

    _isBuildingProposal(proposalData) {
        if (!proposalData) return false;
        if (proposalData.type === 'building') return true;
        if (proposalData.buildingProposal) return true;
        if (proposalData.buildingGeometry) return true;
        return false;
    },

    _getBuildingAncestorKey(proposalData) {
        if (!proposalData) return null;
        const buildingProposal = proposalData.buildingProposal || {};
        if (buildingProposal.ancestorKey) return buildingProposal.ancestorKey;
        const ids = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parcelIds;
        if (!Array.isArray(ids) || ids.length === 0) return null;
        return Array.from(new Set(ids.map(id => id.toString()))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');
    },

    _applyBuildingProposal(proposalHash, proposalData) {
        if (!proposalData) return false;

        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};
        const parentIdsSource = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parcelIds;
        const parentParcelIds = Array.isArray(parentIdsSource) ? parentIdsSource.map(id => id && id.toString ? id.toString() : String(id)) : [];
        const uniqueParentIds = Array.from(new Set(parentParcelIds.filter(Boolean)));

        if (uniqueParentIds.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply building proposal: no ancestor parcels found.');
            }
            return false;
        }

        const missing = [];
        uniqueParentIds.forEach(id => {
            let exists = false;
            try {
                if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                    exists = !!multiParcelSelection.findParcelById(id);
                }
            } catch (_) {
                exists = false;
            }
            if (!exists) {
                const label = Array.isArray(buildingProposal.parentParcelNumbers)
                    ? buildingProposal.parentParcelNumbers.find(info => String(info.id) === String(id))
                    : null;
                missing.push(label && label.number ? `${label.number} [${id}]` : id);
            }
        });

        if (missing.length > 0) {
            const message = `Can't apply building proposal, prerequisite parcels are missing: ${missing.join(', ')}`;
            console.warn(message);
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        const ancestorKey = uniqueParentIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');

        try {
            const allProposals = proposalStorage.getAllProposals();
            allProposals
                .filter(p => p.proposalHash !== proposalHash && this._isBuildingProposal(p))
                .forEach(p => {
                    const otherKey = this._getBuildingAncestorKey(p);
                    const otherStatus = (p.buildingProposal && p.buildingProposal.status) || (p.status === 'Applied' ? 'applied' : p.status === 'Executed' ? 'executed' : 'unapplied');
                    if (otherKey === ancestorKey && (otherStatus === 'applied' || otherStatus === 'executed')) {
                        if (typeof this.unapplyProposal === 'function') {
                            this.unapplyProposal(p.proposalHash);
                        }
                    }
                });
        } catch (err) {
            console.warn('Failed to enforce unique building proposal constraint', err);
        }

        let feature = null;
        if (buildingProposal.buildingFeature && buildingProposal.buildingFeature.type === 'Feature') {
            feature = JSON.parse(JSON.stringify(buildingProposal.buildingFeature));
        } else if (proposalData.buildingGeometry) {
            feature = {
                type: 'Feature',
                geometry: proposalData.buildingGeometry,
                properties: {}
            };
        }

        if (!feature || !feature.geometry) {
            const message = 'Building proposal missing geometry; cannot apply.';
            console.warn(message, { proposalHash });
            if (typeof updateStatus === 'function') updateStatus(message);
            return false;
        }

        const baseProperties = {
            ...(proposalData.buildingProperties || {}),
            ...(proposalData.properties || {}),
            ...(feature.properties || {})
        };

        feature.properties = {
            ...baseProperties,
            proposalHash,
            proposalState: buildingProposal.status === 'executed' || proposalData.status === 'Executed' ? 'executed' : 'applied',
            ancestorParcelIds: uniqueParentIds,
            ancestorParcelNumbers: buildingProposal.parentParcelNumbers || null,
            title: proposalData.title || null,
            author: proposalData.author || null
        };

        if (typeof upsertProposedBuildingFeature === 'function') {
            upsertProposedBuildingFeature(feature);
        } else {
            // Fallback
            if (typeof proposedBuildings === 'undefined') {
                if (typeof window !== 'undefined') window.proposedBuildings = [];
            }
            if (typeof proposedBuildings !== 'undefined') {
                if (!Array.isArray(proposedBuildings)) proposedBuildings = [];
                const existingIndex = proposedBuildings.findIndex(b => b && b.properties && b.properties.proposalHash === proposalHash);
                if (existingIndex > -1) {
                    proposedBuildings[existingIndex] = feature;
                } else {
                    proposedBuildings.push(feature);
                }
                if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
                if (typeof saveExecutedBuildingsToStorage === 'function') saveExecutedBuildingsToStorage();
            }
        }

        const showBuildingsCheckbox = document.getElementById('showProposedBuildings');
        if (showBuildingsCheckbox && !showBuildingsCheckbox.checked) {
            showBuildingsCheckbox.checked = true;
        }

        buildingProposal.status = feature.properties.proposalState === 'executed' ? 'executed' : 'applied';
        buildingProposal.appliedAt = new Date().toISOString();
        buildingProposal.parentParcelIds = uniqueParentIds;
        buildingProposal.ancestorKey = ancestorKey;
        buildingProposal.buildingFeature = feature;
        proposalData.buildingProposal = buildingProposal;

        if (proposalData.status !== 'Executed') {
            proposalData.status = 'Applied';
        }
        proposalData.updatedAt = new Date().toISOString();

        proposalStorage.proposals.set(proposalHash, proposalData);
        proposalStorage.save();

        this._linkProposalToAncestors(proposalHash, uniqueParentIds);

        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        if (typeof updateStatus === 'function') {
            updateStatus(`Applied building proposal ${proposalData.title || proposalHash.substring(0, 8)}`);
        }

        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }

        return true;
    },

    unapplyProposal(proposalHash) {
        if (typeof proposalStorage === 'undefined') return false;

        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData) return false;

        const isRoad = !!proposalData.roadProposal;
        const isBuilding = this._isBuildingProposal(proposalData);
        const isStructure = (proposalData.type === 'structure' && proposalData.structureProposal);

        if (!isRoad && !isBuilding && !isStructure) return false;

        const currentStatus = isRoad
            ? proposalData.roadProposal.status
            : isBuilding
                ? ((proposalData.buildingProposal && proposalData.buildingProposal.status)
                    || (proposalData.status === 'Executed' ? 'executed' : proposalData.status === 'Applied' ? 'applied' : 'unapplied'))
                : (proposalData.structureProposal && proposalData.structureProposal.status) || (proposalData.status === 'Applied' ? 'applied' : 'unapplied');

        if (currentStatus === 'unapplied') return true;

        const allDescendants = this._getAllDescendants(proposalHash);
        if (allDescendants.length > 0) {
            this._showDescendantsConfirmModal({
                action: 'un-apply',
                proposalHash,
                descendants: allDescendants,
                onConfirm: () => {
                    if (isRoad) {
                        this._unapplyProposalConfirmed(proposalHash);
                    } else {
                        this._unapplyBuildingProposalConfirmed(proposalHash);
                    }
                }
            });
            return false;
        }

        if (isRoad) {
            this._unapplyProposalConfirmed(proposalHash);
        } else if (isBuilding) {
            this._unapplyBuildingProposalConfirmed(proposalHash);
        } else if (isStructure) {
            this._unapplyStructureProposalConfirmed(proposalHash);
        }
        return true;
    },

    // Internal: perform unapply after confirmation
    _unapplyProposalConfirmed(proposalHash) {
        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData || !proposalData.roadProposal) return;
        const roadProposal = proposalData.roadProposal;

        const descendantProposalHashes = this._getAllDescendantProposals(proposalHash);
        descendantProposalHashes.forEach(childHash => {
            const childProposal = proposalStorage.getProposal(childHash);
            if (!childProposal || !childProposal.roadProposal) return;
            if (childProposal.roadProposal.status === 'applied') {
                this._unapplyProposalConfirmed(childHash);
            }
        });

        // Remove new features from map
        this._removeFeaturesFromMap(roadProposal.childFeatures);

        // Remove new features from localStorage
        roadProposal.childFeatures.forEach(feature => {
            const parcelId = feature.properties.CESTICA_ID;
            localStorage.removeItem(`parcel_${parcelId}_geometry`);
            localStorage.removeItem(`parcel_${parcelId}_properties`);
            localStorage.removeItem(`parcel_${parcelId}_isRoad`);
            localStorage.removeItem(`parcel_${parcelId}_roadName`);
            localStorage.removeItem(`parcel_${parcelId}_roadId`);

            // Remove this proposal as ancestor of the parcel
            this._removeProposalAsAncestor(parcelId, proposalHash);
        });

        // Add back original features to map
        this._addFeaturesToMap(roadProposal.parentFeatures, true); // Pass true to use normal style

        // Restore original features to localStorage
        const parentIdsForUnmark = [];
        roadProposal.parentFeatures.forEach(feature => {
            const parcelId = feature.properties.CESTICA_ID;
            // Save the outer ring coordinates (the localStorage system expects this format)
            const coords = feature.geometry.coordinates[0]; // Get outer ring
            localStorage.setItem(`parcel_${parcelId}_geometry`, JSON.stringify(coords));
            localStorage.setItem(`parcel_${parcelId}_properties`, JSON.stringify(feature.properties));

            // If the original was a road, restore that too
            if (feature.properties.isRoad) {
                localStorage.setItem(`parcel_${parcelId}_isRoad`, 'true');
                localStorage.setItem(`parcel_${parcelId}_roadName`, feature.properties.roadName || 'Unnamed Road');
                localStorage.setItem(`parcel_${parcelId}_roadId`, feature.properties.roadId || '');
            }
            parentIdsForUnmark.push(parcelId);
        });

        Array.from(new Set(parentIdsForUnmark.map(id => id?.toString()))).forEach(id => this._unmarkParcelModified(id));

        // Clean up dependency tracking
        const descendantParcelIds = roadProposal.childFeatures.map(f => f.properties.CESTICA_ID.toString());
        this._removeParcelsAsDescendants(proposalHash, descendantParcelIds);

        roadProposal.status = 'unapplied';
        proposalData.status = 'Active'; // Update overall proposal status
        proposalStorage.save();

        // Refresh the proposals modal if it's open
        if (typeof showAllProposalsModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                showAllProposalsModal();
            }
        }

        // Refresh parcel info panel if it's open and showing an affected parcel
        if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
            const affectedParcelIds = roadProposal.parentFeatures.map(f => f.properties.CESTICA_ID.toString());
            if (affectedParcelIds.includes(window.selectedParcelId.toString())) {
                // Re-show the parcel info panel to refresh the proposals tab
                if (typeof showParcelInfoPanel === 'function') {
                    const parcelLayer = window.parcelLayer.getLayers().find(l =>
                        l.feature.properties.CESTICA_ID.toString() === window.selectedParcelId.toString()
                    );
                    if (parcelLayer) {
                        showParcelInfoPanel(parcelLayer.feature);
                    }
                }
            }
        }
    },

    _unapplyBuildingProposalConfirmed(proposalHash) {
        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData) return false;

        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};

        if (typeof removeProposedBuildingFeature === 'function') {
            removeProposedBuildingFeature(proposalHash, { updateLayer: true, save: true });
        } else if (typeof proposedBuildings !== 'undefined') {
            if (!Array.isArray(proposedBuildings)) proposedBuildings = [];
            const initialLength = proposedBuildings.length;
            for (let i = proposedBuildings.length - 1; i >= 0; i--) {
                const feature = proposedBuildings[i];
                if (feature && feature.properties && feature.properties.proposalHash === proposalHash) {
                    proposedBuildings.splice(i, 1);
                }
            }
            if (proposedBuildings.length !== initialLength) {
                if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
                if (typeof saveExecutedBuildingsToStorage === 'function') saveExecutedBuildingsToStorage();
            }
        }

        if (typeof markProposedBuildingState === 'function') {
            markProposedBuildingState(proposalHash, 'unapplied', { updateLayer: false, save: true });
            if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
        }

        buildingProposal.status = 'unapplied';
        buildingProposal.appliedAt = null;
        proposalData.buildingProposal = buildingProposal;

        if (proposalData.status === 'Executed') {
            proposalData.status = 'Active';
            delete proposalData.executedAt;
        } else {
            proposalData.status = 'Active';
        }
        proposalData.updatedAt = new Date().toISOString();

        proposalStorage.proposals.set(proposalHash, proposalData);
        proposalStorage.save();

        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }

        return true;
    },

    _unapplyStructureProposalConfirmed(proposalHash) {
        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData || !proposalData.structureProposal) return false;
        const sp = proposalData.structureProposal;
        const kind = (sp.kind === 'park' || sp.kind === 'square') ? sp.kind : 'square';
        const blockName = sp.blockName || null;

        try {
            if (kind === 'park') {
                if (Array.isArray(window.parks)) {
                    const before = window.parks.length;
                    window.parks = window.parks.filter(f => !(f && f.properties && f.properties.proposalHash === proposalHash));
                    if (before !== window.parks.length) {
                        try { localStorage.setItem('cb_parks', JSON.stringify(window.parks)); } catch (_) { }
                        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
                    }
                }
            } else {
                if (Array.isArray(window.squares)) {
                    const before = window.squares.length;
                    window.squares = window.squares.filter(f => !(f && f.properties && f.properties.proposalHash === proposalHash));
                    if (before !== window.squares.length) {
                        try { localStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
                        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
                    }
                }
            }

            // Unmark modified
            const parentIds = Array.isArray(sp.parentParcelIds) ? sp.parentParcelIds.map(String) : (proposalData.parcelIds || []).map(String);
            Array.from(new Set(parentIds)).forEach(id => this._unmarkParcelModified(id));

            // Update status
            sp.status = 'unapplied';
            proposalData.structureProposal = sp;
            if (proposalData.status !== 'Executed') proposalData.status = 'Active';
            proposalStorage.proposals.set(proposalHash, proposalData);
            if (proposalStorage.save) proposalStorage.save();

            try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
            try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
            if (typeof refreshParcelStylesForAppliedProposals === 'function') {
                refreshParcelStylesForAppliedProposals();
            }
            return true;
        } catch (e) {
            console.warn('Failed to unapply structure proposal', e);
            return false;
        }
    },

    deleteProposal(proposalHash) {
        if (typeof proposalStorage === 'undefined') return false;

        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData) return false;

        const isRoad = !!proposalData.roadProposal;
        const isBuilding = this._isBuildingProposal(proposalData);
        if (!isRoad && !isBuilding) return false;

        const allDescendants = this._getAllDescendants(proposalHash);
        if (allDescendants.length > 0) {
            this._showDescendantsConfirmModal({
                action: 'delete',
                proposalHash,
                descendants: allDescendants,
                onConfirm: () => this._deleteProposalConfirmed(proposalHash)
            });
            return false;
        }

        this._deleteProposalConfirmed(proposalHash);
        return true;
    },

    // Internal: perform delete after confirmation
    _deleteProposalConfirmed(proposalHash) {
        const proposalData = proposalStorage.getProposal(proposalHash);
        if (!proposalData) return;

        const isRoad = !!proposalData.roadProposal;
        const isBuilding = this._isBuildingProposal(proposalData);
        const isStructure = (proposalData.type === 'structure' && proposalData.structureProposal);

        if (isRoad && proposalData.roadProposal.status === 'applied') {
            this._unapplyProposalConfirmed(proposalHash);
        }

        if (isBuilding && proposalData.buildingProposal && proposalData.buildingProposal.status !== 'unapplied') {
            this._unapplyBuildingProposalConfirmed(proposalHash);
        }

        if (isStructure && proposalData.structureProposal && proposalData.structureProposal.status === 'applied') {
            this._unapplyStructureProposalConfirmed(proposalHash);
        }

        if (isRoad) {
            const roadProposal = proposalData.roadProposal;

            const descendantParcelIds = roadProposal.childFeatures.map(f => f.properties.CESTICA_ID.toString());
            this._removeParcelsAsDescendants(proposalHash, descendantParcelIds);

            roadProposal.childFeatures.forEach(feature => {
                this._removeProposalAsAncestor(feature.properties.CESTICA_ID, proposalHash);
            });

            try {
                const parentParcelIds = (roadProposal.parentFeatures || [])
                    .map(f => f?.properties?.CESTICA_ID)
                    .filter(id => id !== undefined && id !== null)
                    .map(id => id.toString());
                const uniqueParentParcelIds = Array.from(new Set(parentParcelIds));
                uniqueParentParcelIds.forEach(parcelId => {
                    const ancestorHashes = this._getParcelAncestors(parcelId);
                    ancestorHashes.forEach(ancestorHash => {
                        if (String(ancestorHash) !== String(proposalHash)) {
                            this._removeChildProposalLink(ancestorHash, proposalHash);
                        }
                    });
                });
            } catch (_) { }
        }

        if (isBuilding) {
            try {
                const parentParcelIds = proposalData.buildingProposal && Array.isArray(proposalData.buildingProposal.parentParcelIds)
                    ? proposalData.buildingProposal.parentParcelIds
                    : proposalData.parcelIds;
                const uniqueParentParcelIds = Array.from(new Set((parentParcelIds || []).map(id => id && id.toString ? id.toString() : String(id))));
                uniqueParentParcelIds.forEach(parcelId => {
                    const ancestorHashes = this._getParcelAncestors(parcelId);
                    ancestorHashes.forEach(ancestorHash => {
                        if (String(ancestorHash) !== String(proposalHash)) {
                            this._removeChildProposalLink(ancestorHash, proposalHash);
                        }
                    });
                });
            } catch (_) { }
        }

        this._clearChildProposalLinks(proposalHash);

        if (typeof proposalStorage.removeProposal === 'function') {
            proposalStorage.removeProposal(proposalHash);
        } else if (typeof proposalStorage.deleteProposal === 'function') {
            // Fallback if legacy name exists
            proposalStorage.deleteProposal(proposalHash);
        }

        // Update show proposals button
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }

        // Clear any proposal highlights if this was the currently highlighted proposal
        if (window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalHash === proposalHash) {
            if (typeof clearProposalHighlights === 'function') clearProposalHighlights();
        }

        // Update visual layers and lists
        if (typeof updateProposalLayer === 'function') updateProposalLayer();
        if (typeof updateProposalList === 'function') updateProposalList();

        // Hide proposal info panel if it's showing the deleted proposal
        try {
            const parcelInfoPanel = document.getElementById('parcel-info-panel');
            if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
                const panelTitle = document.querySelector('#parcel-info-panel h3');
                if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                    if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel();
                }
            }
        } catch (_) { }

        // Status
        if (typeof updateStatus === 'function') {
            const title = proposalData?.title || 'Proposal';
            updateStatus(`Proposal "${title}" deleted`);
        }
    },

    // UI: Show a modal with the full list of descendants and ask for confirmation
    _showDescendantsConfirmModal({ action, proposalHash, descendants, onConfirm }) {
        try {
            // Remove any existing modal
            const existing = document.querySelector('.descendants-confirm-modal');
            if (existing) existing.remove();

            const proposalData = proposalStorage.getProposal(proposalHash);
            const titleAction = action === 'delete' ? 'Delete Proposal' : 'Un-apply Proposal';
            const verb = action === 'delete' ? 'delete' : 'un-apply';

            // Build rich list entries with best-effort details
            const items = (descendants || []).map(id => {
                const idStr = String(id);
                // If it's a proposal hash
                const maybeProposal = proposalStorage.getProposal(idStr);
                if (maybeProposal) {
                    return {
                        kind: 'proposal',
                        id: idStr,
                        label: maybeProposal.title || idStr,
                        extra: maybeProposal.type ? `(${maybeProposal.type})` : ''
                    };
                }

                // Try to find parcel details from this proposal's child features first
                let broj = null; let isRoad = false; let roadName = null;
                if (proposalData && proposalData.roadProposal && Array.isArray(proposalData.roadProposal.childFeatures)) {
                    const feat = proposalData.roadProposal.childFeatures.find(f => String(f.properties?.CESTICA_ID) === idStr);
                    if (feat) {
                        broj = feat.properties?.BROJ_CESTICE || null;
                        isRoad = !!feat.properties?.isRoad;
                        roadName = feat.properties?.roadName || null;
                    }
                }

                // Fallback to localStorage
                if (!broj) {
                    try {
                        const propsStr = localStorage.getItem(`parcel_${idStr}_properties`);
                        if (propsStr) {
                            const props = JSON.parse(propsStr);
                            broj = props?.BROJ_CESTICE || broj;
                            isRoad = isRoad || !!props?.isRoad;
                            roadName = roadName || props?.roadName || null;
                        }
                    } catch (_) { }
                }

                // Fallback to map layer
                if (!broj && typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                    try {
                        const layer = multiParcelSelection.findParcelById(idStr);
                        if (layer && layer.feature?.properties) {
                            broj = layer.feature.properties.BROJ_CESTICE || broj;
                            isRoad = isRoad || !!layer.feature.properties.isRoad;
                            roadName = roadName || layer.feature.properties.roadName || null;
                        }
                    } catch (_) { }
                }

                const base = broj ? `Parcel ${broj}` : `Parcel ${idStr}`;
                const extra = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
                return { kind: 'parcel', id: idStr, label: base, extra };
            });

            const counts = items.reduce((acc, it) => { acc[it.kind]++; return acc; }, { parcel: 0, proposal: 0 });

            const modal = document.createElement('div');
            modal.className = 'descendants-confirm-modal';
            modal.style.cssText = `
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            `;

            const listHtml = items.map(it => `
                <div class="desc-item" style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;">
                    <span class="badge" style="font-size:11px;padding:2px 6px;border-radius:10px;background:${it.kind === 'proposal' ? '#e3f2fd' : '#f1f8e9'};color:${it.kind === 'proposal' ? '#1565c0' : '#2e7d32'};text-transform:uppercase;">${it.kind}</span>
                    <span style="font-weight:600;color:#333;">${it.label}</span>
                    <span style="color:#666;">${it.extra || ''}</span>
                </div>
            `).join('');

            modal.innerHTML = `
                <div class="descendants-confirm-content" style="background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.25);width:min(680px,90vw);max-height:80vh;display:flex;flex-direction:column;">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eee;">
                        <h3 style="margin:0;font-size:18px;color:#333;">${titleAction}</h3>
                        <button title="Close" style="border:none;background:transparent;font-size:22px;color:#666;cursor:pointer;" class="descendants-close">&times;</button>
                    </div>
                    <div style="padding:16px 20px;">
                        <p style="margin:0 0 10px;color:#444;">This proposal has dependent items. The following will be removed from map and storage if you ${verb} it:</p>
                        <div style="color:#666;font-size:13px;margin-bottom:12px;">${counts.parcel} parcel${counts.parcel === 1 ? '' : 's'}${counts.proposal ? ` • ${counts.proposal} proposal${counts.proposal === 1 ? '' : 's'}` : ''}</div>
                        <div style="max-height:45vh;overflow:auto;padding-right:4px;">${listHtml || '<em style="color:#666;">No items found.</em>'}</div>
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:10px;padding:12px 16px;border-top:1px solid #eee;background:#fafafa;">
                        <button class="btn-cancel" style="padding:8px 14px;border:1px solid #ccc;background:#fff;border-radius:6px;color:#333;cursor:pointer;">Cancel</button>
                        <button class="btn-confirm" style="padding:8px 14px;border:1px solid #c62828;background:#d32f2f;color:#fff;border-radius:6px;cursor:pointer;">${titleAction}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const close = () => { try { modal.remove(); } catch (_) { } };
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
            modal.querySelector('.descendants-close')?.addEventListener('click', close);
            modal.querySelector('.btn-cancel')?.addEventListener('click', close);
            modal.querySelector('.btn-confirm')?.addEventListener('click', () => { close(); if (typeof onConfirm === 'function') onConfirm(); });

            // ESC to close
            const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
            document.addEventListener('keydown', onKey);
        } catch (e) {
            // Fallback to confirm if modal fails for any reason
            const count = Array.isArray(descendants) ? descendants.length : 0;
            if (confirm(`This proposal has ${count} dependent item(s). Continue to ${action}?`)) {
                if (typeof onConfirm === 'function') onConfirm();
            }
        }
    },

    _removeFeaturesFromMap(features) {
        console.log(`_removeFeaturesFromMap called with ${features?.length} features`);
        console.log(`window.parcelLayer:`, !!window.parcelLayer);
        console.log(`window.map:`, !!window.map);

        if (!window.parcelLayer || !window.map) {
            console.error(`Early return from _removeFeaturesFromMap!`);
            return;
        }

        console.log(`=== ATTEMPTING TO REMOVE ${features.length} FEATURES ===`);

        features.forEach(feature => {
            const parcelId = feature.properties.CESTICA_ID;
            console.log(`Looking for parcel ID: ${parcelId} (type: ${typeof parcelId})`);

            // Log all current layers for debugging
            const allLayers = window.parcelLayer.getLayers();
            console.log(`Total layers in parcelLayer: ${allLayers.length}`);

            // Find all layers with matching CESTICA_ID (comparing as strings to handle type differences)
            const layersToRemove = allLayers.filter(layer => {
                if (!layer.feature || !layer.feature.properties) {
                    return false;
                }
                const layerId = layer.feature.properties.CESTICA_ID;
                const match = layerId !== undefined && layerId.toString() === parcelId.toString();
                if (match) {
                    console.log(`  FOUND MATCH: layerId=${layerId}, parcelId=${parcelId}`);
                }
                return match;
            });

            if (layersToRemove.length > 0) {
                console.log(`✓ Removing ${layersToRemove.length} layer(s) for parcel ID: ${parcelId}`);
                layersToRemove.forEach(layer => {
                    const wasInMap = window.map.hasLayer(layer);
                    // Remove from both parcelLayer AND the map itself
                    window.parcelLayer.removeLayer(layer);
                    if (wasInMap) {
                        window.map.removeLayer(layer);
                    }
                    console.log(`  Removed layer (was in map: ${wasInMap})`);
                });
            } else {
                console.error(`✗ Could not find layer to remove for parcel ID: ${parcelId}`);
                // Log first few layer IDs for debugging
                console.log(`  Available layer IDs (first 5):`,
                    allLayers.slice(0, 5).map(l => l.feature?.properties?.CESTICA_ID));
            }
        });

        console.log(`=== REMOVAL COMPLETE ===`);

        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }
    },

    _addFeaturesToMap(features, useNormalStyle = false) {
        if (!window.parcelLayer) {
            window.parcelLayer = L.featureGroup().addTo(map);
        }

        // Create SVG pattern for striped roads (only once)
        if (!document.getElementById('proposal-road-pattern')) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('id', 'proposal-road-pattern-svg');
            svg.style.position = 'absolute';
            svg.style.width = '0';
            svg.style.height = '0';

            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
            pattern.setAttribute('id', 'proposal-road-pattern');
            pattern.setAttribute('patternUnits', 'userSpaceOnUse');
            pattern.setAttribute('width', '10');
            pattern.setAttribute('height', '10');
            pattern.setAttribute('patternTransform', 'rotate(45)');

            const rect1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect1.setAttribute('width', '5');
            rect1.setAttribute('height', '10');
            rect1.setAttribute('fill', '#2d5016'); // Dark green

            const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect2.setAttribute('x', '5');
            rect2.setAttribute('width', '5');
            rect2.setAttribute('height', '10');
            rect2.setAttribute('fill', '#3d6a1f'); // Lighter green

            pattern.appendChild(rect1);
            pattern.appendChild(rect2);
            defs.appendChild(pattern);
            svg.appendChild(defs);
            document.body.appendChild(svg);
        }

        const proposalRoadStyle = {
            fillColor: '#2d5016', // Dark green for proposed roads
            fillOpacity: 0.8,
            color: '#1a3d0a',
            weight: 2,
            dashArray: '5, 5'
        };

        const proposalParcelStyle = {
            fillColor: '#FFD700', // Gold for proposed parcels
            fillOpacity: 0.5,
            color: '#000',
            weight: 2,
            dashArray: '5, 5'
        };

        console.log(`Adding ${features.length} features to map (useNormalStyle: ${useNormalStyle})`);

        features.forEach(feature => {
            let style;
            if (useNormalStyle) {
                style = feature.properties.isRoad ? window.roadStyle : window.normalStyle;
            } else {
                // Use different styles for roads vs parcels in proposals
                style = feature.properties.isRoad ? proposalRoadStyle : proposalParcelStyle;
            }

            console.log(`Adding feature: ${feature.properties.CESTICA_ID}, isRoad: ${feature.properties.isRoad}`);

            const newLayer = L.geoJSON(feature, {
                style: style,
                onEachFeature: window.onEachFeature // from parcels.js
            });

            newLayer.eachLayer(layer => {
                // Add to parcelLayer (which is already on the map)
                window.parcelLayer.addLayer(layer);
                // Also ensure it's on the map directly if parcelLayer might not propagate it
                if (!window.map.hasLayer(layer)) {
                    layer.addTo(window.map);
                }

                // Apply SVG pattern to proposed roads
                if (!useNormalStyle && feature.properties.isRoad && layer._path) {
                    layer._path.style.fill = 'url(#proposal-road-pattern)';
                }
            });
        });

        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }
    },

    // Helper methods for dependency tracking
    // Record only the immediate creator proposal for a parcel.
    // Persisted shape remains an array for backward compatibility but will contain at most one hash.
    _addProposalAsAncestor(parcelId, proposalHash) {
        const ancestorsKey = `parcel_${parcelId}_ancestors`;
        try {
            // Always overwrite to keep only the immediate creator
            localStorage.setItem(ancestorsKey, JSON.stringify([String(proposalHash)]));
        } catch (_) {
            // Fallback: best-effort set
            try { localStorage.setItem(ancestorsKey, JSON.stringify([String(proposalHash)])); } catch (_) { }
        }
    },

    _removeProposalAsAncestor(parcelId, proposalHash) {
        const ancestorsKey = `parcel_${parcelId}_ancestors`;
        const ancestors = JSON.parse(localStorage.getItem(ancestorsKey) || '[]');
        // Since we now store only a single immediate creator, clear when it matches
        if (ancestors.length === 0) return;
        const current = String(ancestors[ancestors.length - 1]);
        if (String(current) === String(proposalHash)) {
            localStorage.setItem(ancestorsKey, JSON.stringify([]));
        }
    },

    _addParcelsAsDescendants(proposalHash, parcelIds) {
        const descendantsKey = `proposal_${proposalHash}_descendants`;
        const descendants = JSON.parse(localStorage.getItem(descendantsKey) || '[]');
        parcelIds.forEach(parcelId => {
            if (!descendants.includes(parcelId)) {
                descendants.push(parcelId);
            }
        });
        localStorage.setItem(descendantsKey, JSON.stringify(descendants));
    },

    _removeParcelsAsDescendants(proposalHash, parcelIds) {
        const descendantsKey = `proposal_${proposalHash}_descendants`;
        const descendants = JSON.parse(localStorage.getItem(descendantsKey) || '[]');
        parcelIds.forEach(parcelId => {
            const index = descendants.indexOf(parcelId);
            if (index > -1) {
                descendants.splice(index, 1);
            }
        });
        localStorage.setItem(descendantsKey, JSON.stringify(descendants));
    },

    _getProposalDescendants(proposalHash) {
        const descendantsKey = `proposal_${proposalHash}_descendants`;
        return JSON.parse(localStorage.getItem(descendantsKey) || '[]');
    },

    // Return the immediate creator(s) only; for compatibility we keep an array but cap it to one.
    _getParcelAncestors(parcelId) {
        const ancestorsKey = `parcel_${parcelId}_ancestors`;
        let arr;
        try {
            arr = JSON.parse(localStorage.getItem(ancestorsKey) || '[]');
            if (!Array.isArray(arr)) arr = [];
        } catch (_) { arr = []; }

        // If multiple were stored historically, trim to the last (most recent) and persist back.
        if (arr.length > 1) {
            const last = String(arr[arr.length - 1]);
            try { localStorage.setItem(ancestorsKey, JSON.stringify([last])); } catch (_) { }
            return [last];
        }
        return arr.map(x => String(x));
    },

    // Return full transitive dependency list (parcels and proposals)
    _getAllDescendants(proposalHash) {
        const rootHash = String(proposalHash);
        const results = [];
        const visitedProposals = new Set([rootHash]);
        const visitedParcels = new Set();
        const queue = [rootHash];

        while (queue.length) {
            const currentHash = queue.shift();
            const childParcels = this._getProposalDescendants(currentHash) || [];
            childParcels.forEach(parcelId => {
                const parcelStr = String(parcelId);
                if (!visitedParcels.has(parcelStr)) {
                    visitedParcels.add(parcelStr);
                    results.push(parcelStr);
                }
            });

            const childProposals = this._getChildProposalsForProposal(currentHash);
            childProposals.forEach(childHash => {
                const childStr = String(childHash);
                if (visitedProposals.has(childStr)) return;
                visitedProposals.add(childStr);
                results.push(childStr);
                queue.push(childStr);
            });
        }

        return results;
    },

    _addChildProposalLink(parentProposalHash, childProposalHash) {
        if (!parentProposalHash || !childProposalHash) return;
        const key = `proposal_${parentProposalHash}_childProposals`;
        const current = JSON.parse(localStorage.getItem(key) || '[]');
        if (!current.includes(childProposalHash)) {
            current.push(childProposalHash);
            localStorage.setItem(key, JSON.stringify(current));
        }
    },

    _removeChildProposalLink(parentProposalHash, childProposalHash) {
        if (!parentProposalHash || !childProposalHash) return;
        const key = `proposal_${parentProposalHash}_childProposals`;
        const current = JSON.parse(localStorage.getItem(key) || '[]');
        const idx = current.indexOf(childProposalHash);
        if (idx > -1) {
            current.splice(idx, 1);
            localStorage.setItem(key, JSON.stringify(current));
        }
    },

    _clearChildProposalLinks(proposalHash) {
        localStorage.removeItem(`proposal_${proposalHash}_childProposals`);
    },

    _getChildProposalsForProposal(proposalHash) {
        const key = `proposal_${proposalHash}_childProposals`;
        return JSON.parse(localStorage.getItem(key) || '[]');
    },

    _getAllDescendantProposals(proposalHash) {
        const rootHash = String(proposalHash);
        const result = [];
        const visited = new Set([rootHash]);
        const stack = [...(this._getChildProposalsForProposal(rootHash) || [])].reverse();

        while (stack.length) {
            const current = stack.pop();
            const currentStr = String(current);
            if (visited.has(currentStr)) continue;
            visited.add(currentStr);
            result.push(currentStr);
            const children = this._getChildProposalsForProposal(currentStr) || [];
            children.forEach(child => {
                const childStr = String(child);
                if (!visited.has(childStr)) {
                    stack.push(childStr);
                }
            });
        }

        return result;
    },

    // Link this proposal as a child only of the immediate creator proposals of the given parent parcels.
    _linkProposalToAncestors(proposalHash, parentParcelIds) {
        if (!proposalHash || !Array.isArray(parentParcelIds)) return;
        const uniqueParcelIds = Array.from(new Set(parentParcelIds.map(id => String(id))));
        uniqueParcelIds.forEach(parcelId => {
            const ancestorHashes = this._getParcelAncestors(parcelId) || [];
            // Only the immediate creator should be present; loop kept for shape consistency
            ancestorHashes.slice(-1).forEach(ancestorHash => {
                if (String(ancestorHash) !== String(proposalHash)) {
                    this._addChildProposalLink(ancestorHash, proposalHash);
                }
            });
        });
    },

    _markParcelModified(parcelId) {
        if (!parcelId) return;
        const key = 'modified_parcels';
        let list;
        try {
            list = JSON.parse(localStorage.getItem(key) || '[]');
            if (!Array.isArray(list)) list = [];
        } catch (_) {
            list = [];
        }
        const strId = String(parcelId);
        if (!list.includes(strId)) {
            list.push(strId);
            localStorage.setItem(key, JSON.stringify(list));
        }
    },

    _unmarkParcelModified(parcelId) {
        if (!parcelId) return;
        const key = 'modified_parcels';
        let list;
        try {
            list = JSON.parse(localStorage.getItem(key) || '[]');
            if (!Array.isArray(list)) list = [];
        } catch (_) {
            list = [];
        }
        const strId = String(parcelId);
        const index = list.indexOf(strId);
        if (index > -1) {
            list.splice(index, 1);
            localStorage.setItem(key, JSON.stringify(list));
        }
    },

    _getModifiedParcelsSet() {
        try {
            const list = JSON.parse(localStorage.getItem('modified_parcels') || '[]');
            if (Array.isArray(list)) {
                return new Set(list.map(String));
            }
        } catch (_) { }
        return new Set();
    },

    _getMissingParentParcels(parentFeatures) {
        if (!Array.isArray(parentFeatures) || parentFeatures.length === 0) {
            return [];
        }

        const existingIds = new Set();
        try {
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                parcelLayer.eachLayer(layer => {
                    const layerId = layer?.feature?.properties?.CESTICA_ID;
                    if (layerId !== undefined && layerId !== null) {
                        existingIds.add(layerId.toString());
                    }
                });
            }
        } catch (_) { }

        return parentFeatures.reduce((missing, feature) => {
            const id = feature?.properties?.CESTICA_ID;
            if (id === undefined || id === null) {
                return missing;
            }
            const idStr = id.toString();
            if (!existingIds.has(idStr)) {
                missing.push({
                    id: idStr,
                    number: feature?.properties?.BROJ_CESTICE ? feature.properties.BROJ_CESTICE.toString() : null
                });
            }
            return missing;
        }, []);
    },
};

// --- HELPER FUNCTIONS (moved from road-drawing.js) ---

function _getParcelOuterRingsLngLat(feature) {
    const rings = [];
    try {
        const geom = feature.geometry;
        if (geom && geom.type) {
            if (geom.type === 'Polygon') {
                if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    const ring = _ensurePolygonIsClosed(geom.coordinates[0]);
                    if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                }
            } else if (geom.type === 'MultiPolygon') {
                if (Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(poly => {
                        if (Array.isArray(poly) && poly.length > 0) {
                            const ring = _ensurePolygonIsClosed(poly[0]);
                            if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                        }
                    });
                }
            }
        }
    } catch (_) { }
    return rings;
}

function _ensurePolygonIsClosed(coords) {
    if (!coords || coords.length < 3) return coords;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        const newCoords = [...coords];
        newCoords.push([...first]);
        return newCoords;
    }
    return coords;
}

function _calculateRoadPolygon(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: points?.length, width });
        return null;
    }

    const smoothed = _buildOffsetRoadPolygon(points, width);
    if (smoothed && smoothed.length >= 4) {
        return smoothed;
    }

    return _calculateRoadPolygonRectangular(points, width);
}

function _calculateRoadPolygonRectangular(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygonRectangular:', { pointsLength: points?.length, width });
        return null;
    }

    if (points.length === 2) {
        return _createRectangularRoadSegment(points[0], points[1], width);
    }

    let combinedPolygon = null;

    for (let i = 0; i < points.length - 1; i++) {
        const segment = _createRectangularRoadSegment(points[i], points[i + 1], width);

        if (!segment) {
            console.warn(`Failed to create segment ${i}`);
            continue;
        }

        if (combinedPolygon === null) {
            combinedPolygon = segment;
        } else {
            combinedPolygon = _combineRoadPolygons(combinedPolygon, segment);
        }

        if (!combinedPolygon) {
            console.error(`Failed to combine segment ${i}, reverting to single segment`);
            combinedPolygon = segment;
        }

        if (i >= 1 && i < points.length - 1) {
            try {
                const wedge = _createJointWedgePolygon(points[i - 1], points[i], points[i + 1], width);
                if (wedge) {
                    const combinedWithWedge = _combineRoadPolygons(combinedPolygon, wedge);
                    if (combinedWithWedge) {
                        combinedPolygon = combinedWithWedge;
                    }
                }
            } catch (e) {
                // Silent failure for wedge calculation to avoid interrupting drawing
            }
        }
    }

    return combinedPolygon;
}

function _buildOffsetRoadPolygon(points, width) {
    try {
        const halfWidth = width / 2;
        if (!isFinite(halfWidth) || halfWidth <= 0) {
            return null;
        }

        const rawHTRS = points
            .map(p => wgs84ToHTRS96(p.lat, p.lng))
            .filter(_isValidPoint);

        if (rawHTRS.length < 2) return null;

        const cleanedHTRS = [];
        const minDistance = 0.05;
        for (const pt of rawHTRS) {
            if (cleanedHTRS.length === 0) {
                cleanedHTRS.push(pt);
                continue;
            }
            const prev = cleanedHTRS[cleanedHTRS.length - 1];
            const dx = pt[0] - prev[0];
            const dy = pt[1] - prev[1];
            if (Math.hypot(dx, dy) >= minDistance) {
                cleanedHTRS.push(pt);
            }
        }

        if (cleanedHTRS.length < 2) return null;

        const directions = [];
        for (let i = 0; i < cleanedHTRS.length - 1; i++) {
            const dx = cleanedHTRS[i + 1][0] - cleanedHTRS[i][0];
            const dy = cleanedHTRS[i + 1][1] - cleanedHTRS[i][1];
            const len = Math.hypot(dx, dy);
            directions.push(len < 1e-6 ? null : [dx / len, dy / len]);
        }

        const resolvePrevDirection = (idx) => {
            for (let i = idx - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            for (let i = 0; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const resolveNextDirection = (idx) => {
            for (let i = idx; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            for (let i = directions.length - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const addVec = (a, b) => [a[0] + b[0], a[1] + b[1]];
        const scaleVec = (v, scalar) => [v[0] * scalar, v[1] * scalar];
        const vecLength = (v) => Math.hypot(v[0], v[1]);
        const leftNormal = (dir) => [-dir[1], dir[0]];
        const rightNormal = (dir) => [dir[1], -dir[0]];

        const computeOffsetPoint = (point, dirPrev, dirNext, side) => {
            const normalFromDir = side === 1 ? leftNormal : rightNormal;

            if (!dirPrev && dirNext) {
                const normal = normalFromDir(dirNext);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (dirPrev && !dirNext) {
                const normal = normalFromDir(dirPrev);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (!dirPrev && !dirNext) {
                return [point[0], point[1]];
            }

            const normalPrev = normalFromDir(dirPrev);
            const normalNext = normalFromDir(dirNext);
            const summed = addVec(normalPrev, normalNext);
            const sumLen = vecLength(summed);

            if (sumLen < 1e-6) {
                return addVec(point, scaleVec(normalNext, halfWidth));
            }

            const miter = [summed[0] / sumLen, summed[1] / sumLen];
            let dot = miter[0] * normalNext[0] + miter[1] * normalNext[1];
            if (Math.abs(dot) < 1e-6) {
                dot = 1e-6 * Math.sign(dot || 1);
            }

            let scaleFactor = halfWidth / dot;
            const miterLimit = 6;
            const maxScale = miterLimit * halfWidth;
            if (Math.abs(scaleFactor) > maxScale) {
                const fallbackNormal = dot > 0 ? normalNext : normalPrev;
                return addVec(point, scaleVec(fallbackNormal, halfWidth));
            }

            return addVec(point, scaleVec(miter, scaleFactor));
        };

        const leftPts = [];
        const rightPts = [];
        for (let i = 0; i < cleanedHTRS.length; i++) {
            const dirPrev = i > 0 ? resolvePrevDirection(i) : null;
            const dirNext = i < cleanedHTRS.length - 1 ? resolveNextDirection(i) : null;

            const leftPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, 1);
            const rightPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, -1);

            leftPts.push(leftPt);
            rightPts.push(rightPt);
        }

        const polygonHTRS = [...leftPts, ...rightPts.reverse()];
        if (polygonHTRS.length < 4) return null;

        const first = polygonHTRS[0];
        const last = polygonHTRS[polygonHTRS.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
            polygonHTRS.push([...first]);
        }

        return polygonHTRS.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return L.latLng(lat, lng);
        });
    } catch (error) {
        console.warn('Failed to build offset road polygon', error);
        return null;
    }
}

function _createRectangularRoadSegment(point1, point2, width) {
    // Validate input
    if (!point1 || !point2 || !isFinite(width) || width <= 0) {
        console.warn('Invalid inputs to createRectangularRoadSegment');
        return null;
    }

    if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
        !isFinite(point2.lat) || !isFinite(point2.lng)) {
        console.warn('Invalid coordinates in createRectangularRoadSegment');
        return null;
    }

    // Convert to HTRS96/TM for accurate distance calculations
    const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
    const htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);

    // Validate converted points
    if (!_isValidPoint(htrsPoint1) || !_isValidPoint(htrsPoint2)) {
        console.warn('Invalid HTRS points in createRectangularRoadSegment');
        return null;
    }

    // Calculate segment direction
    const dx = htrsPoint2[0] - htrsPoint1[0];
    const dy = htrsPoint2[1] - htrsPoint1[1];
    const length = Math.sqrt(dx * dx + dy * dy);

    // Skip if segment has near-zero length
    if (length < 0.001) {
        return null;
    }

    // Calculate perpendicular vector (normalized)
    const perpX = -dy / length;
    const perpY = dx / length;
    const halfWidth = width / 2;

    const corners = [
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth],
        [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth],
        [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth],
        [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth],
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]
    ];

    const wgsCorners = [];
    for (const corner of corners) {
        const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
        if (isFinite(lat) && isFinite(lng)) {
            wgsCorners.push(L.latLng(lat, lng));
        }
    }

    if (wgsCorners.length < 4) {
        console.warn('Not enough valid corners for rectangle');
        return null;
    }

    return wgsCorners;
}

function _createJointWedgePolygon(prevPoint, jointPoint, nextPoint, width) {
    if (!prevPoint || !jointPoint || !nextPoint || !isFinite(width) || width <= 0) {
        return null;
    }

    const p0 = wgs84ToHTRS96(prevPoint.lat, prevPoint.lng);
    const pj = wgs84ToHTRS96(jointPoint.lat, jointPoint.lng);
    const p1 = wgs84ToHTRS96(nextPoint.lat, nextPoint.lng);

    if (!_isValidPoint(p0) || !_isValidPoint(pj) || !_isValidPoint(p1)) {
        return null;
    }

    const v1 = [pj[0] - p0[0], pj[1] - p0[1]];
    const v2 = [p1[0] - pj[0], p1[1] - pj[1]];

    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) {
        return null;
    }

    const u1 = [v1[0] / len1, v1[1] / len1];
    const u2 = [v2[0] / len2, v2[1] / len2];

    const n1L = [-u1[1], u1[0]];
    const n2L = [-u2[1], u2[0]];
    const n1R = [u1[1], -u1[0]];
    const n2R = [u2[1], -u2[0]];

    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const outerIsRight = cross > 0;

    const halfWidth = width / 2;

    const n1 = outerIsRight ? n1R : n1L;
    const n2 = outerIsRight ? n2R : n2L;

    const pA = [pj[0] + n1[0] * halfWidth, pj[1] + n1[1] * halfWidth];
    const pB = [pj[0] + n2[0] * halfWidth, pj[1] + n2[1] * halfWidth];

    const r = [pB[0] - pA[0], pB[1] - pA[1]];
    const denom = u1[0] * u2[1] - u1[1] * u2[0];

    let miterPoint = null;
    if (Math.abs(denom) > 1e-8) {
        const t = (r[0] * u2[1] - r[1] * u2[0]) / denom;
        miterPoint = [pA[0] + t * u1[0], pA[1] + t * u1[1]];
    }

    const miterLimit = 4;
    let wedgeHTRS;
    if (miterPoint) {
        const miterLen = Math.hypot(miterPoint[0] - pj[0], miterPoint[1] - pj[1]);
        if (miterLen > miterLimit * halfWidth) {
            const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
            const bisLen = Math.hypot(bisector[0], bisector[1]) || 1;
            const cap = [pj[0] + (bisector[0] / bisLen) * halfWidth, pj[1] + (bisector[1] / bisLen) * halfWidth];
            wedgeHTRS = [pA, cap, pB, pA];
        } else {
            wedgeHTRS = [pA, miterPoint, pB, pA];
        }
    } else {
        const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
        const bisLen = Math.hypot(bisector[0], bisector[1]) || 1;
        const cap = [pj[0] + (bisector[0] / bisLen) * halfWidth, pj[1] + (bisector[1] / bisLen) * halfWidth];
        wedgeHTRS = [pA, cap, pB, pA];
    }

    const result = [];
    for (const pt of wedgeHTRS) {
        const [lat, lng] = htrs96ToWGS84(pt[0], pt[1]);
        if (isFinite(lat) && isFinite(lng)) {
            result.push(L.latLng(lat, lng));
        }
    }

    return result.length >= 3 ? result : null;
}

function _combineRoadPolygons(polygon1, polygon2) {
    if (!polygon1 && polygon2) return polygon2;
    if (polygon1 && !polygon2) return polygon1;
    if (!polygon1 && !polygon2) return null;

    try {
        const formatForTurf = (poly) => poly.map(p => [p.lng, p.lat]);

        const turfFormat1 = _ensurePolygonIsClosed(formatForTurf(polygon1));
        const turfFormat2 = _ensurePolygonIsClosed(formatForTurf(polygon2));

        const turfPoly1 = turf.polygon([turfFormat1]);
        const turfPoly2 = turf.polygon([turfFormat2]);

        const combined = turf.union(turfPoly1, turfPoly2);

        let resultCoords;
        if (combined.geometry.type === 'Polygon') {
            resultCoords = combined.geometry.coordinates[0];
        } else if (combined.geometry.type === 'MultiPolygon') {
            let maxArea = 0;
            let largestPolygon = null;
            for (const polygon of combined.geometry.coordinates) {
                const poly = turf.polygon([polygon[0]]);
                const area = turf.area(poly);
                if (area > maxArea) {
                    maxArea = area;
                    largestPolygon = polygon[0];
                }
            }
            resultCoords = largestPolygon;
        } else {
            return null;
        }

        return resultCoords.map(coord => L.latLng(coord[1], coord[0]));
    } catch (error) {
        console.error('Error combining road polygons:', error);
        return polygon2 || polygon1;
    }
}

function _isValidPoint(point) {
    return point &&
        Array.isArray(point) &&
        point.length === 2 &&
        isFinite(point[0]) &&
        isFinite(point[1]);
}

function _calculateAreaFromLatLngPolygon(latLngPolygon) {
    try {
        const turfFormat = latLngPolygon.map(p => [p.lng, p.lat]);
        const closedTurfFormat = _ensurePolygonIsClosed(turfFormat);
        const turfPolygon = turf.polygon([closedTurfFormat]);
        return turf.area(turfPolygon);
    } catch (e) {
        return 0;
    }
}

function _geometryHash(coords) {
    return JSON.stringify(coords.map(ring => ring.map(
        pt => [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]
    )));
}

function _extractRootParcelNumber(parcelNumber) {
    if (!parcelNumber && parcelNumber !== 0) return '';
    const str = String(parcelNumber).trim();
    if (str.length === 0) return '';
    return str.split('/')[0];
}

function _extractRootCesticaId(cesticaId) {
    if (!cesticaId && cesticaId !== 0) return '';
    const str = String(cesticaId).trim();
    if (str.length === 0) return '';
    const idx = str.indexOf('_');
    return idx === -1 ? str : str.substring(0, idx);
}

function _computeExistingMaxSubnumber(rootNumber) {
    if (!rootNumber && rootNumber !== 0) return 0;
    const targetRoot = String(rootNumber);
    let maxSub = 0;

    const considerParcelNumber = (parcelNumber) => {
        if (!parcelNumber && parcelNumber !== 0) return;
        const str = String(parcelNumber);
        if (!str.startsWith(targetRoot)) return;
        const parts = str.split('/');
        if (parts.length < 2) {
            maxSub = Math.max(maxSub, 0);
            return;
        }
        const subValue = parseInt(parts[1], 10);
        if (Number.isFinite(subValue)) {
            maxSub = Math.max(maxSub, subValue);
        }
    };

    try {
        if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') {
            parcelLayer.eachLayer(layer => {
                considerParcelNumber(layer?.feature?.properties?.BROJ_CESTICE);
            });
        }
    } catch (_) { }

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('parcel_') || !key.endsWith('_properties')) continue;
            const propsStr = localStorage.getItem(key);
            if (!propsStr) continue;
            try {
                const props = JSON.parse(propsStr);
                considerParcelNumber(props?.BROJ_CESTICE);
            } catch (_) { }
        }
    } catch (_) { }

    return maxSub;
}


// Make it accessible globally
window.ProposalManager = ProposalManager;
