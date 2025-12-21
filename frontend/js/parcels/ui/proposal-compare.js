(function (global) {
    'use strict';

    function showProposalCompareModal(proposalId, parcelId) {
        try {
            const storage = (typeof global.Proposals !== 'undefined' && global.Proposals.storage) ? global.Proposals.storage : global.proposalStorage;
            const proposal = storage && typeof storage.get === 'function'
                ? storage.get(proposalId)
                : (storage && typeof storage.getProposal === 'function' ? storage.getProposal(proposalId) : null);
            if (!proposal) {
                if (typeof global.showParcelAlert === 'function') {
                    global.showParcelAlert('proposal_not_found', 'Proposal not found.');
                }
                return;
            }

            const compareTitle = global.translateParcelText('modal.compare.title', 'Compare: Current vs Proposed');
            const closeLabel = global.translateParcelText('modal.version.closeLabel', 'Close');
            const loadingText = global.translateParcelText('modal.compare.loading', 'Loading comparison…');
            const failedToBuildText = global.translateParcelText('modal.compare.failed_to_build', 'Failed to build comparison.');

            const canCompare = typeof global.isProposalApplied === 'function'
                ? global.isProposalApplied(proposal)
                : ((proposal.status || '').toLowerCase() === 'applied' || (proposal.status || '').toLowerCase() === 'executed');
            if (!canCompare) {
                const compareMessage = global.translateParcelText('status.messages.only_the_currently_applied_proposal_can_be_compared', 'Only the currently applied proposal can be compared.');
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus(compareMessage);
                } else if (typeof global.showParcelAlert === 'function') {
                    global.showParcelAlert('only_the_currently_applied_proposal_can_be_compared', 'Only the currently applied proposal can be compared.');
                }
                return;
            }

            let modal = global.document ? global.document.querySelector('.proposal-info-modal.compare-modal') : null;
            if (!modal && global.document) {
                modal = global.document.createElement('div');
                modal.className = 'proposal-info-modal compare-modal';
                global.document.body.appendChild(modal);
            }
            if (!modal) return;

            const content = global.document.createElement('div');
            content.className = 'proposal-info-modal-content';
            content.innerHTML = `
            <div class="proposal-info-modal-header">
                <h2>${compareTitle}</h2>
                <button type="button" class="proposal-info-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeLabel}">×</button>
            </div>
            <div class="proposal-info-modal-body" id="compare-modal-body"></div>
            <div class="proposal-info-modal-footer">
                <button class="btn btn-secondary" id="compare-close-btn">${closeLabel}</button>
            </div>
        `;

            modal.innerHTML = '';
            modal.appendChild(content);

            const close = () => hideProposalCompareModal();
            content.querySelector('.proposal-info-modal-close').addEventListener('click', close);
            content.querySelector('#compare-close-btn').addEventListener('click', close);
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

            const body = content.querySelector('#compare-modal-body');
            body.innerHTML = `<div>${loadingText}</div>`;

            ensureExistingBuildingsLoaded()
                .then(() => {
                    try {
                        const tableHtml = buildProposalComparisonTable(proposal, parcelId);
                        body.innerHTML = tableHtml;
                    } catch (err) {
                        console.error('Error building comparison table:', err);
                        body.innerHTML = `<div style="color:#dc3545">${failedToBuildText}</div>`;
                    }
                })
                .catch((err) => {
                    console.error('Error ensuring buildings loaded:', err);
                    try {
                        const tableHtml = buildProposalComparisonTable(proposal, parcelId);
                        body.innerHTML = tableHtml;
                    } catch (e2) {
                        console.error('Error building comparison table (fallback):', e2);
                        body.innerHTML = `<div style="color:#dc3545">${failedToBuildText}</div>`;
                    }
                });

            modal.style.display = 'flex';
        } catch (e) {
            console.error('showProposalCompareModal error:', e);
            if (typeof global.showParcelAlert === 'function') {
                global.showParcelAlert('could_not_open_comparison_modal', 'Could not open comparison modal.');
            }
        }
    }

    function hideProposalCompareModal() {
        const modal = global.document ? global.document.querySelector('.proposal-info-modal.compare-modal') : null;
        if (modal) modal.style.display = 'none';
    }

    function ensureExistingBuildingsLoaded() {
        return new Promise((resolve, reject) => {
            try {
                const ready = () => {
                    const bl = global.buildingLayer;
                    if (bl && typeof bl.getLayers === 'function' && bl.getLayers().length > 0) {
                        resolve();
                        return true;
                    }
                    return false;
                };

                if (ready()) return;

                const onUpdated = () => {
                    if (ready()) {
                        try { global.removeEventListener('buildingsLayerUpdated', onUpdated); } catch (_) { }
                        resolve();
                    }
                };
                try { global.addEventListener('buildingsLayerUpdated', onUpdated, { once: true }); } catch (_) { }

                if (typeof global.fetchBuildings === 'function') {
                    global.fetchBuildings();
                } else {
                    resolve();
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    function buildProposalComparisonTable(proposal, parcelId) {
        const metrics = computeComparisonMetrics(proposal, parcelId);

        const fmt = (v) => {
            if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
            if (typeof v === 'number') return Math.round(Number(v)).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            return String(v);
        };

        const PARKING_SPOT_COST = 10000;
        const adjustedProposedMarket = metrics.marketValue.proposed - (metrics.parking.proposed * PARKING_SPOT_COST);

        const rows = [
            { label: 'Parcel area (m²)', current: metrics.parcelArea.current, proposed: metrics.parcelArea.proposed },
            { label: 'Building footprint (m²)', current: metrics.footprint.current, proposed: metrics.footprint.proposed },
            { label: 'Building height (m)', current: metrics.height.current, proposed: metrics.height.proposed },
            { label: 'Building floors', current: metrics.floors.current, proposed: metrics.floors.proposed },
            { label: 'Square meters (m²)', current: metrics.squareMeters.current, proposed: metrics.squareMeters.proposed },
            { label: 'Parking spots', current: metrics.parking.current, proposed: metrics.parking.proposed },
            { label: 'Estimated market value (€)', current: metrics.marketValue.current, proposed: adjustedProposedMarket },
        ];

        const adjustedDiff = adjustedProposedMarket - metrics.marketValue.current;
        const summaryHtml = adjustedDiff > 0
            ? `
            <div class="metric-group">
                <div class="metric-label"><span class="result-tag result-tag-profit">Profit!</span></div>
                <div class="metric-value">You can profit by accepting this proposal.</div>
            </div>
        `
            : (adjustedDiff < 0
                ? `
            <div class="metric-group">
                <div class="metric-label"><span class="result-tag result-tag-loss">Loss!</span></div>
                <div class="metric-value">If you accept this proposal your property will be worth less than today.</div>
            </div>
        ` : '');

        const table = `
        <div class="proposal-details">
            ${summaryHtml}
            <div class="metric-group">
                <div class="metric-label">Difference in market value (profit)</div>
                <div class="metric-value ${adjustedDiff >= 0 ? 'profit-positive' : 'profit-negative'}"><span class="animated-amount">${fmt(adjustedDiff)} €</span></div>
            </div>
            <table class="comparison-table">
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Currently</th>
                        <th>Proposed</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `
                        <tr>
                            <td class="label">${r.label}</td>
                            <td class="value">${fmt(r.current)}</td>
                            <td class="value">${fmt(r.proposed)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
        return table;
    }

    function computeComparisonMetrics(proposal, parcelId) {
        const parcelLayerRef = typeof global.parcelLayer !== 'undefined' ? global.parcelLayer : null;
        const parcelLayerObj = parcelLayerRef ? parcelLayerRef.getLayers().find(l => String(l?.feature?.properties?.parcelId) === String(parcelId)) : null;
        const parcelFeature = parcelLayerObj ? parcelLayerObj.feature : null;
        const parcelArea = parcelFeature ? (parcelFeature.properties?.calculatedArea || safeArea(parcelFeature)) : 0;

        let proposedParcelArea = parcelArea;
        try {
            if (((typeof global.normalizeProposalGoalKey === 'function' ? global.normalizeProposalGoalKey(proposal.goal) : (proposal.goal || '').toLowerCase()) === 'road-track') && proposal.roadGeometry && proposal.roadGeometry.polygon && parcelFeature) {
                const remaining = global.turf ? global.turf.difference(parcelFeature, proposal.roadGeometry.polygon) : null;
                proposedParcelArea = remaining && global.turf ? global.turf.area(remaining) : parcelArea;
            }
        } catch (_) { proposedParcelArea = parcelArea; }

        let currentFootprint = 0;
        let currentHeightFromBuildings = null;
        try {
            const parcelPoly = parcelFeature;
            const bLayer = global.buildingLayer;
            if (parcelPoly && bLayer && typeof bLayer.getLayers === 'function') {
                const layers = bLayer.getLayers();
                let totalIntersectArea = 0;
                let heightAreaProduct = 0;

                for (let i = 0; i < layers.length; i++) {
                    const l = layers[i];
                    const feat = l && l.feature ? l.feature : null;
                    if (!feat || !feat.geometry) continue;
                    try {
                        if (typeof l.getBounds === 'function' && l.getBounds && parcelLayerObj && parcelLayerObj.getBounds) {
                            const parcelBounds = parcelLayerObj.getBounds();
                            try { if (!parcelBounds.intersects(l.getBounds())) continue; } catch (_) { }
                        }

                        const inter = global.turf ? global.turf.intersect(parcelPoly, feat) : null;
                        if (inter) {
                            const a = global.turf.area(inter);
                            if (isFinite(a) && a > 0) {
                                currentFootprint += a;
                                totalIntersectArea += a;
                                const h = extractBuildingHeightMeters(feat.properties);
                                if (isFinite(h) && h > 0) {
                                    heightAreaProduct += h * a;
                                }
                            }
                        }
                    } catch (_) { }
                }

                if (totalIntersectArea > 0 && heightAreaProduct > 0) {
                    currentHeightFromBuildings = heightAreaProduct / totalIntersectArea;
                }
            }
        } catch (_) { }

        let proposedFootprint = 0;
        const proposedBuildingFeature = (() => {
            if (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length) {
                return proposal.geometry.buildings[0];
            }
            return null;
        })();
        try {
            if (proposedBuildingFeature && proposedBuildingFeature.geometry && parcelFeature) {
                const inter = global.turf ? global.turf.intersect(parcelFeature, proposedBuildingFeature) : null;
                proposedFootprint = inter && global.turf ? global.turf.area(inter) : 0;
            }
        } catch (_) { proposedFootprint = 0; }

        const currentHeight = isFinite(currentHeightFromBuildings) && currentHeightFromBuildings > 0
            ? Math.round(currentHeightFromBuildings)
            : 10;
        let proposedHeight = 10;
        try {
            if (proposedBuildingFeature && proposedBuildingFeature.properties && isFinite(Number(proposedBuildingFeature.properties.height))) {
                proposedHeight = Math.round(Number(proposedBuildingFeature.properties.height));
            } else if (proposal.properties && isFinite(Number(proposal.properties.height))) {
                proposedHeight = Math.round(Number(proposal.properties.height));
            } else if (proposal.title && /\b(\d{1,3})m\b/i.test(proposal.title)) {
                const m = proposal.title.match(/\b(\d{1,3})m\b/i);
                if (m) proposedHeight = Number(m[1]);
            }
        } catch (_) { }

        const currentFloors = Math.floor(currentHeight / 3);
        const proposedFloors = Math.floor(proposedHeight / 3);

        const currentSqm = currentFootprint * currentFloors;
        const proposedSqm = proposedFootprint * proposedFloors;

        const currentParking = 4;
        const proposedParking = 0;

        const sqmPrice = 3500;
        const currentMarket = currentSqm * sqmPrice;
        const proposedMarket = proposedSqm * sqmPrice;

        return {
            parcelArea: { current: parcelArea, proposed: proposedParcelArea },
            footprint: { current: currentFootprint, proposed: proposedFootprint },
            height: { current: currentHeight, proposed: proposedHeight },
            floors: { current: currentFloors, proposed: proposedFloors },
            squareMeters: { current: currentSqm, proposed: proposedSqm },
            parking: { current: currentParking, proposed: proposedParking },
            marketValue: { current: currentMarket, proposed: proposedMarket }
        };
    }

    function safeArea(feature) {
        try { return global.turf ? global.turf.area(feature) : 0; } catch (_) { return 0; }
    }

    function extractBuildingHeightMeters(props) {
        if (!props) return null;
        try {
            if (isFinite(Number(props.height))) return Number(props.height);
            if (isFinite(Number(props.HEIGHT))) return Number(props.HEIGHT);
            if (isFinite(Number(props.visina))) return Number(props.visina);
            if (isFinite(Number(props.Visina))) return Number(props.Visina);

            const floorsCandidates = [props.floors, props.FLOORS, props.kat, props.KAT, props.katova, props.KATOVA, props.storeys, props.STOREYS];
            for (let i = 0; i < floorsCandidates.length; i++) {
                const f = Number(floorsCandidates[i]);
                if (isFinite(f) && f > 0) return f * 3;
            }
        } catch (_) { }
        return null;
    }

    global.ParcelsUIProposalCompare = {
        showProposalCompareModal,
        hideProposalCompareModal,
        ensureExistingBuildingsLoaded,
        buildProposalComparisonTable,
        computeComparisonMetrics,
        safeArea,
        extractBuildingHeightMeters
    };

    global.showProposalCompareModal = showProposalCompareModal;
    global.hideProposalCompareModal = hideProposalCompareModal;
})(typeof window !== 'undefined' ? window : globalThis);

