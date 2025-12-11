(function (global) {
    'use strict';

    const adParcelIdSet = (global.adParcelIdSet instanceof Set) ? global.adParcelIdSet : new Set();
    global.adParcelIdSet = adParcelIdSet;
    if (typeof global.showAdParcels !== 'boolean') {
        global.showAdParcels = false;
    }

    function supportsOssOwnership() {
        return typeof global.getCurrentCityId === 'function' ? global.getCurrentCityId() === 'zagreb' : false;
    }

    function formatParcelText(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function translateParcelText(key, fallback, params = {}) {
        const api = (typeof global !== 'undefined' && global.i18n) ? global.i18n : null;
        if (api && typeof api.t === 'function') {
            return api.t(key, params);
        }
        return formatParcelText(fallback, params);
    }

    function showParcelAlert(key, fallback, params = {}) {
        const message = translateParcelText(`alerts.messages.${key}`, fallback, params);
        const alertFn = (typeof global !== 'undefined' && typeof global.showStyledAlert === 'function')
            ? global.showStyledAlert
            : global.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
        return message;
    }

    const roadStyle = {
        fillColor: '#00ff00',
        fillOpacity: 0.2,
        color: '#00ff00',
        weight: 1
    };
    const adParcelStyle = {
        fillColor: '#b5f7b2',
        fillOpacity: 0.45,
        color: '#2e7d32',
        weight: 2,
        opacity: 1
    };
    const normalStyle = {
        fillColor: 'red',
        fillOpacity: 0.2,
        color: 'red',
        weight: 1
    };
    const selectedParcelStyle = {
        fillColor: '#ff3300',
        fillOpacity: 0.4,
        color: '#ff3300',
        weight: 4,
        opacity: 1,
        dashArray: ''
    };

    const appliedProposalStyleTemplate = {
        color: normalStyle.color,
        weight: normalStyle.weight,
        opacity: normalStyle.opacity !== undefined ? normalStyle.opacity : 1,
        dashArray: normalStyle.dashArray || '',
        fillColor: normalStyle.fillColor,
        fillOpacity: 0
    };

    let parcelsWithAppliedSpatialProposals = new Set();

    function createAppliedProposalStyle() {
        return { ...appliedProposalStyleTemplate };
    }

    function parcelHasAppliedSpatialProposal(parcelId) {
        if (parcelId === undefined || parcelId === null) return false;
        return parcelsWithAppliedSpatialProposals.has(parcelId.toString());
    }

    function getParcelBaseStyle(parcelId, options = {}) {
        const { isRoad: isRoadOverride } = options || {};
        const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        const roadFlag = typeof isRoadOverride === 'boolean'
            ? isRoadOverride
            : (idStr ? (typeof global.isRoad === 'function' ? global.isRoad(idStr) : false) : false);
        if (roadFlag) {
            return { ...roadStyle };
        }
        const isAdParcel = Boolean(global.showAdParcels && idStr && adParcelIdSet.has(idStr));
        if (isAdParcel) {
            return { ...adParcelStyle };
        }
        if (idStr && parcelHasAppliedSpatialProposal(idStr)) {
            return createAppliedProposalStyle();
        }
        return { ...normalStyle };
    }

    function recomputeParcelsWithAppliedSpatialProposals() {
        const result = new Set();
        if (typeof global.proposalStorage !== 'undefined' && global.proposalStorage && typeof global.proposalStorage.getAllProposals === 'function') {
            try {
                const proposals = global.proposalStorage.getAllProposals();
                proposals.forEach(proposal => {
                    if (!proposal) return;
                    const status = (proposal.status || '').toLowerCase();
                    const parcelIds = [];
                    const buildingProposal = proposal.buildingProposal || null;
                    if (buildingProposal) {
                        const buildingStatus = (buildingProposal.status || status).toLowerCase();
                        if (buildingStatus === 'applied' || buildingStatus === 'executed') {
                            const ids = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
                                ? buildingProposal.parentParcelIds
                                : proposal.parcelIds;
                            if (Array.isArray(ids)) parcelIds.push(...ids);
                        }
                    } else if ((proposal.type === 'building' || proposal.buildingGeometry) && (status === 'applied' || status === 'executed')) {
                        if (Array.isArray(proposal.parcelIds)) parcelIds.push(...proposal.parcelIds);
                    }

                    const structureProposal = proposal.structureProposal || null;
                    if (structureProposal) {
                        const kind = (structureProposal.kind || '').toLowerCase();
                        const structureStatus = (structureProposal.status || status).toLowerCase();
                        if ((kind === 'park' || kind === 'square') && (structureStatus === 'applied' || structureStatus === 'executed')) {
                            const ids = Array.isArray(structureProposal.parentParcelIds) && structureProposal.parentParcelIds.length > 0
                                ? structureProposal.parentParcelIds
                                : proposal.parcelIds;
                            if (Array.isArray(ids)) parcelIds.push(...ids);
                        }
                    }

                    parcelIds
                        .filter(id => id !== undefined && id !== null)
                        .forEach(id => result.add(id.toString()));
                });
            } catch (error) {
                console.warn('recomputeParcelsWithAppliedSpatialProposals failed', error);
            }
        }
        parcelsWithAppliedSpatialProposals = result;
        return result;
    }

    function refreshParcelStylesForAppliedProposals() {
        recomputeParcelsWithAppliedSpatialProposals();
        if (!global.parcelLayer) return;

        const selectedId = global.selectedParcelId ? global.selectedParcelId.toString() : null;
        const hasMultiSelection = typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection && global.multiParcelSelection.isActive;

        global.parcelLayer.eachLayer(layer => {
            const parcelId = layer?.feature?.properties?.CESTICA_ID;
            if (parcelId === undefined || parcelId === null) return;
            const idStr = parcelId.toString();

            if (selectedId && idStr === selectedId) {
                layer.setStyle(selectedParcelStyle);
                layer.bringToFront();
                return;
            }

            if (hasMultiSelection && global.multiParcelSelection.selectedParcels && global.multiParcelSelection.selectedParcels.has(idStr)) {
                layer.setStyle({
                    fillColor: '#ff9800',
                    fillOpacity: 0.6,
                    color: '#f57c00',
                    weight: 3
                });
                return;
            }

            const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
            const currentSelectedBlockName = (typeof global.selectedBlockName !== 'undefined' && global.selectedBlockName)
                ? global.selectedBlockName
                : (typeof global !== 'undefined' ? global.selectedBlockName : null);
            const layerBlockName = layer?.feature?.properties?.block;
            if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                return;
            }

            layer.setStyle(getParcelBaseStyle(idStr));
        });

        if (hasMultiSelection && typeof global.multiParcelSelection?.reapplyMultiParcelHighlights === 'function') {
            global.multiParcelSelection.reapplyMultiParcelHighlights();
        }

        if (typeof global.rehighlightSelectedBlockParcels === 'function') {
            global.rehighlightSelectedBlockParcels();
        }

        if (selectedId) {
            const selectedLayer = global.parcelLayer.getLayers().find(layer =>
                layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === selectedId
            );
            if (selectedLayer) {
                selectedLayer.setStyle(selectedParcelStyle);
                selectedLayer.bringToFront();
            }
        }
    }

    global.supportsOssOwnership = supportsOssOwnership;
    global.formatParcelText = formatParcelText;
    global.translateParcelText = translateParcelText;
    global.showParcelAlert = showParcelAlert;
    global.roadStyle = roadStyle;
    global.normalStyle = normalStyle;
    global.adParcelStyle = adParcelStyle;
    global.selectedParcelStyle = selectedParcelStyle;
    global.appliedProposalStyleTemplate = appliedProposalStyleTemplate;
    global.createAppliedProposalStyle = createAppliedProposalStyle;
    global.parcelHasAppliedSpatialProposal = parcelHasAppliedSpatialProposal;
    global.getParcelBaseStyle = getParcelBaseStyle;
    global.recomputeParcelsWithAppliedSpatialProposals = recomputeParcelsWithAppliedSpatialProposals;
    global.refreshParcelStylesForAppliedProposals = refreshParcelStylesForAppliedProposals;
    global.parcelsWithAppliedSpatialProposals = parcelsWithAppliedSpatialProposals;
})(typeof window !== 'undefined' ? window : globalThis);

