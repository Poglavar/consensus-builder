(function (global) {
    'use strict';

    const uiSelection = global.ParcelsUISelection || {};
    const uiParcelPanel = global.ParcelsUIParcelPanel || {};
    const uiMap = global.ParcelsUIMap || {};
    const uiClaim = global.ParcelsUIClaim || {};
    const uiVisibility = global.ParcelsUIVisibility || {};
    const uiProposalCompare = global.ParcelsUIProposalCompare || {};
    const uiAdParcels = global.ParcelsAdParcels || {};
    const ownershipUi = global.ParcelsOwnershipUi || {};
    const utils = global.ParcelsUtils || {};
    const state = global.ParcelsState || null;

    // Helper to prefer namespaced module APIs, with legacy global fallback for now.
    const from = (moduleObj, legacy) => moduleObj || legacy || null;

    const facade = {
        state,
        styles: {
            getParcelBaseStyle: global.getParcelBaseStyle,
            refreshParcelStylesForAppliedProposals: global.refreshParcelStylesForAppliedProposals,
            recomputeParcelsWithAppliedSpatialProposals: global.recomputeParcelsWithAppliedSpatialProposals,
            selectedParcelStyle: global.selectedParcelStyle
        },
        selection: {
            onEachFeature: from(uiSelection.onEachFeature, global.onEachFeature),
            highlightFeature: from(uiSelection.highlightFeature, global.highlightFeature),
            resetHighlight: from(uiSelection.resetHighlight, global.resetHighlight),
            selectParcel: from(uiSelection.selectParcel, global.selectParcel)
        },
        proposals: {
            focusOnProposal: global.focusOnProposal,
            acceptProposalFromParcelInfo: global.acceptProposalFromParcelInfo,
            rejectProposalFromParcelInfo: global.rejectProposalFromParcelInfo,
            showProposalDetails: global.showProposalDetails,
            switchParcelTab: global.switchParcelTab
        },
        ui: {
            buildCompactAcceptanceRow: global.buildCompactAcceptanceRow,
            buildParcelAcceptanceIndicators: global.buildParcelAcceptanceIndicators,
            buildOwnerAcceptanceIndicators: global.buildOwnerAcceptanceIndicators
        },
        uiRoad: {
            measureAsRoad: global.measureAsRoad
        },
        uiLabels: {
            toggleParcelNumbers: global.Parcels?.uiLabels?.toggleParcelNumbers || global.toggleParcelNumbers,
            drawParcelNumberLabels: global.Parcels?.uiLabels?.drawParcelNumberLabels || global.drawParcelNumberLabels,
            clearParcelNumberLabels: global.Parcels?.uiLabels?.clearParcelNumberLabels || global.clearParcelNumberLabels,
            refreshParcelNumberLabelsIfVisible: global.Parcels?.uiLabels?.refreshParcelNumberLabelsIfVisible || global.refreshParcelNumberLabelsIfVisible,
            setParcelNumberLabelFilter: global.Parcels?.uiLabels?.setParcelNumberLabelFilter || global.setParcelNumberLabelFilter
        },
        uiProposals: {
            createProposalFromSingleParcel: global.createProposalFromSingleParcel,
            createProposalFromSelectedParcels: global.createProposalFromSelectedParcels,
            renderParcelProposalActions: global.renderParcelProposalActions
        },
        uiProposalCompare: {
            showProposalCompareModal: from(uiProposalCompare.showProposalCompareModal, global.showProposalCompareModal),
            hideProposalCompareModal: from(uiProposalCompare.hideProposalCompareModal, global.hideProposalCompareModal)
        },
        adParcels: uiAdParcels,
        uiSelection,
        uiParcelPanel,
        uiMap,
        uiClaim,
        uiVisibility: {
            isRoad: from(uiVisibility.isRoad, global.isRoad),
            showAllParcels: from(uiVisibility.showAllParcels, global.showAllParcels),
            showOnlyRoadParcels: from(uiVisibility.showOnlyRoadParcels, global.showOnlyRoadParcels),
            hideAllParcels: from(uiVisibility.hideAllParcels, global.hideAllParcels),
            updateVisibleParcelsCount: from(uiVisibility.updateVisibleParcelsCount, global.updateVisibleParcelsCount)
        },
        storage: {
            getGridKey: global.getGridKey,
            getRequiredGridCells: global.getRequiredGridCells,
            computeGridKeysForBounds: global.computeGridKeysForBounds,
            indexParcelLayer: global.indexParcelLayer,
            unindexParcelLayer: global.unindexParcelLayer,
            clearParcelLayerIndex: global.clearParcelLayerIndex,
            resolveParcelLayerById: global.resolveParcelLayerById,
            removeParcelLayerById: global.removeParcelLayerById,
            ensureParcelLayerInitialized: global.ensureParcelLayerInitialized
        },
        fetch: {
            fetchParcelData: global.fetchParcelData,
            fetchSingleParcelById: global.fetchSingleParcelById,
            fetchParcelsByIds: global.fetchParcelsByIds,
            fetchParcelFeaturesByIds: global.fetchParcelFeaturesByIds,
            requestParcelBatchForCurrentCity: global.requestParcelBatchForCurrentCity,
            requestParcelBatchFromOss: global.requestParcelBatchFromOss,
            requestParcelBatchFromParcelBa: global.requestParcelBatchFromParcelBa,
            ingestParcelFeatures: global.ingestParcelFeatures,
            refreshParcelDataWithBusyState: global.refreshParcelDataWithBusyState
        },
        blocks: {
            selectBuenosAiresBlock: global.selectBuenosAiresBlock
        },
        blockchain: {
            normalizeChainIdValue: global.normalizeChainIdValue,
            chainKeyVariants: global.chainKeyVariants,
            resolveChainSlug: global.resolveChainSlug,
            resolveRpcUrlForChain: global.resolveRpcUrlForChain,
            normalizeContractAddress: global.normalizeContractAddress,
            deriveParcelIdentifier: global.deriveParcelIdentifier,
            deriveParcelDisplayName: global.deriveParcelDisplayName,
            resolveParcelNftAddress: global.resolveParcelNftAddress,
            resolveParcelClaimContext: global.resolveParcelClaimContext,
            isParcelTokenMissingError: global.isParcelTokenMissingError,
            buildClaimUrl: global.buildClaimUrl
        },
        ownership: {
            parseFraction: global.parseFraction,
            simplifyFraction: global.simplifyFraction,
            formatFraction: global.formatFraction,
            multiplyFractions: global.multiplyFractions,
            computeCondominiumSharePortion: global.computeCondominiumSharePortion,
            fetchOwnershipDetails: global.fetchOwnershipDetails,
            fetchOwnerDataForParcel: global.fetchOwnerDataForParcel,
            updateOwnershipCache: global.updateOwnershipCache,
            clearOwnershipCache: global.clearOwnershipCache
        },
        ownershipUi: {
            fetchAndDisplayRealOwners: ownershipUi.fetchAndDisplayRealOwners || global.fetchAndDisplayRealOwners,
            refreshParcelOwnerAcceptanceUI: ownershipUi.refreshParcelOwnerAcceptanceUI || global.refreshParcelOwnerAcceptanceUI,
            fetchOwnerDataForParcel: ownershipUi.fetchOwnerDataForParcel || global.fetchOwnerDataForParcel,
            getRealParcelOwners: ownershipUi.getRealParcelOwners
        },
        utils: {
            calculateArea: utils.calculateArea || global.calculateArea,
            cloneCoordinates: utils.cloneCoordinates || global.cloneCoordinates,
            convertGeoJSON: utils.convertGeoJSON || global.convertGeoJSON,
            cloneFeatureDeep: utils.cloneFeatureDeep || global.cloneFeatureDeep,
            yieldToMainThread: utils.yieldToMainThread || global.yieldToMainThread
        }
    };

    global.Parcels = facade;
})(typeof window !== 'undefined' ? window : globalThis);

