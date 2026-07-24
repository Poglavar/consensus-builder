(function (global) {
    'use strict';

    const normalizeFeatureParcelId = global.normalizeFeatureParcelId || function () { return null; };

    async function removeAncestorParcelsFromAppliedProposals() {
        const tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const proposalStorage = global.proposalStorage || (typeof window !== 'undefined' && window.proposalStorage);
        if (!proposalStorage || typeof proposalStorage.getAllProposals !== 'function') {
            return;
        }

        try {
            const allProposals = proposalStorage.getAllProposals();
            const appliedRoadProposals = allProposals.filter(p => {
                const goalKey = (typeof global.normalizeProposalGoalKey === 'function') ? global.normalizeProposalGoalKey(p.goal) : (p.goal || '').toLowerCase();
                return p.roadProposal && goalKey === 'road-track' && isApplied(p, p.roadProposal);
            });

            // Applied structure proposals (parks/squares/lakes) are managed separately; avoid treating them as ancestor removals.
            const appliedStructureProposals = [];

            if (appliedRoadProposals.length === 0 && appliedStructureProposals.length === 0) {
                const duration = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStart;
                if (duration > 1 && typeof console !== 'undefined' && console.log) {
                    console.log(`[removeAncestorParcelsFromAppliedProposals] No applied proposals; skipped in ${duration.toFixed ? duration.toFixed(1) : duration}ms`);
                }
                return;
            }

            const parentParcelIdsSet = new Set();
            const proposalsWithChildren = [];

            for (const proposal of appliedRoadProposals) {
                if (!proposal || !proposal.roadProposal) continue;

                let parentIds = [];
                if (Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    parentIds = proposal.roadProposal.parentParcelIds.map(id => String(id));
                } else if (Array.isArray(proposal.roadProposal.affectedParcelIds)) {
                    parentIds = proposal.roadProposal.affectedParcelIds.map(id => String(id));
                } else if (proposal.proposalId && global.ProposalManager && typeof global.ProposalManager._loadRoadProposalAssets === 'function') {
                    try {
                        const assets = global.ProposalManager._loadRoadProposalAssets(proposal, {
                            includeParents: true,
                            includeChildren: false,
                            includeKeepDetails: false,
                            allowMissing: true
                        });
                        if (Array.isArray(assets.parentFeatures)) {
                            parentIds = assets.parentFeatures
                                .map(f => normalizeFeatureParcelId(f))
                                .filter(Boolean);
                        }
                    } catch (_) { }
                }

                parentIds.forEach(id => parentParcelIdsSet.add(id));

                let childFeatures = [];
                if (Array.isArray(proposal.roadProposal.childFeatures)) {
                    childFeatures = proposal.roadProposal.childFeatures;
                } else if (proposal.proposalId && global.ProposalManager && typeof global.ProposalManager._loadRoadProposalAssets === 'function') {
                    try {
                        const assets = global.ProposalManager._loadRoadProposalAssets(proposal, {
                            includeParents: false,
                            includeChildren: true,
                            includeKeepDetails: false,
                            allowMissing: true
                        });
                        if (Array.isArray(assets.childFeatures)) {
                            childFeatures = assets.childFeatures;
                        }
                    } catch (_) { }
                }

                if (childFeatures.length > 0) {
                    proposalsWithChildren.push({ proposal, childFeatures });
                }
            }

            // Structure proposals no longer contribute parent removals here.

            if (parentParcelIdsSet.size === 0) {
                const duration = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStart;
                if (duration > 1 && typeof console !== 'undefined' && console.log) {
                    console.log(`[removeAncestorParcelsFromAppliedProposals] No parent parcels to remove; skipped in ${duration.toFixed ? duration.toFixed(1) : duration}ms`);
                }
                return;
            }

            let removedCount = 0;
            if (typeof global.removeParcelLayerById === 'function') {
                for (const parcelId of parentParcelIdsSet) {
                    const existing = global.resolveParcelLayerById ? global.resolveParcelLayerById(parcelId) : null;
                    if (existing) {
                        global.removeParcelLayerById(parcelId);
                        removedCount++;
                    }
                }
            }

            let addedCount = 0;
            if (proposalsWithChildren.length > 0 && typeof global.parcelLayer !== 'undefined' && global.parcelLayer) {
                const parcelsOnMap = new Set();
                if (typeof global.parcelLayer.eachLayer === 'function') {
                    global.parcelLayer.eachLayer(layer => {
                        if (layer && layer.feature) {
                            const parcelId = normalizeFeatureParcelId(layer.feature);
                            if (parcelId) {
                                parcelsOnMap.add(String(parcelId));
                            }
                        }
                    });
                }

                for (const { proposal, childFeatures } of proposalsWithChildren) {
                    const missingChildren = childFeatures.filter(feature => {
                        const parcelId = normalizeFeatureParcelId(feature);
                        return parcelId && !parcelsOnMap.has(String(parcelId));
                    });

                    if (missingChildren.length > 0) {
                        if (typeof global.ProposalManager !== 'undefined' &&
                            typeof global.ProposalManager._addFeaturesToMap === 'function') {
                            try {
                                global.ProposalManager._addFeaturesToMap(missingChildren, true, proposal);
                                addedCount += missingChildren.length;
                            } catch (error) {
                                console.warn('[removeAncestorParcelsFromAppliedProposals] Failed to add child features:', error);
                            }
                        } else if (typeof global.ingestParcelFeatures === 'function') {
                            try {
                                await global.ingestParcelFeatures(missingChildren);
                                addedCount += missingChildren.length;
                            } catch (error) {
                                console.warn('[removeAncestorParcelsFromAppliedProposals] Failed to ingest child features:', error);
                            }
                        }
                    }
                }
            }

            // We intentionally avoid removing applied parks/squares/lakes when cleaning ancestor parcels.

            if (addedCount > 0) {
                if (typeof global.applyProposalHighlights === 'function') {
                    try {
                        global.applyProposalHighlights();
                    } catch (error) {
                        console.warn('[removeAncestorParcelsFromAppliedProposals] Failed to refresh proposal highlights:', error);
                    }
                }

                if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
                    try {
                        global.refreshParcelStylesForAppliedProposals();
                    } catch (error) {
                        console.warn('[removeAncestorParcelsFromAppliedProposals] Failed to refresh parcel styles:', error);
                    }
                }
            }

            if (removedCount > 0 || addedCount > 0) {
                const messages = [];
                if (removedCount > 0) {
                    messages.push(`Cleaned up ${removedCount} ancestor parcel${removedCount === 1 ? '' : 's'}`);
                }
                if (addedCount > 0) {
                    messages.push(`Added ${addedCount} descendant parcel${addedCount === 1 ? '' : 's'}`);
                }
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus(messages.join(' and ') + ' from applied proposals.');
                }
            }

            const duration = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStart;
            if (typeof console !== 'undefined' && console.debug) {
                console.debug(`[removeAncestorParcelsFromAppliedProposals] Completed in ${duration.toFixed ? duration.toFixed(1) : duration}ms (removed=${removedCount}, added=${addedCount}, appliedProposals=${appliedRoadProposals.length})`);
            }
        } catch (error) {
            console.warn('[removeAncestorParcelsFromAppliedProposals] Error:', error);
        }
    }

    global.removeAncestorParcelsFromAppliedProposals = removeAncestorParcelsFromAppliedProposals;
})(typeof window !== 'undefined' ? window : globalThis);
