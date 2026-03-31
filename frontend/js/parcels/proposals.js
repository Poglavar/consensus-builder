(function (global) {
    'use strict';

    /**
     * Focus on a proposal when clicked from parcel info panel
     * @param {string} proposalIdOrHash - The proposal id (or legacy hash)
     */
    function focusOnProposal(proposalIdOrHash) {
        if (!proposalIdOrHash) {
            console.warn('focusOnProposal: missing proposal id');
            return;
        }

        // Resolve to stored proposal id for compatibility
        let proposalKey = proposalIdOrHash;
        const storageRef1 = (global.Proposals && global.Proposals.storage) ? global.Proposals.storage : global.proposalStorage;
        if (storageRef1 && typeof storageRef1.findProposalByIdOrHash === 'function') {
            const found = storageRef1.findProposalByIdOrHash(proposalIdOrHash);
            if (found) {
                proposalKey = found.proposalId || found.id || found.tokenId || proposalKey;
            }
        }

        // Do not force proposals mode; keep normal interactions available
        const storageRef2 = (global.Proposals && global.Proposals.storage) ? global.Proposals.storage : global.proposalStorage;
        if (typeof global.selectAndHighlightProposal === 'function' && storageRef2) {
            const proposal = storageRef2.get ? storageRef2.get(proposalKey) : (storageRef2.getProposal ? storageRef2.getProposal(proposalKey) : null);
            const parcels = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];
            if (proposal && parcels.length > 0) {
                global.selectAndHighlightProposal(proposalKey, parcels[0], true);
            }
        } else if (typeof global.centerOnProposal === 'function') {
            // Fallback to old function
            global.centerOnProposal(proposalKey);
        }
    }

    const uiParcelPanel = (global.Parcels && global.Parcels.uiParcelPanel) ? global.Parcels.uiParcelPanel : (global.ParcelsUIParcelPanel || {});

    function scheduleParcelPanelFocus(parcelId) {
        if (!global.parcelLayer || !parcelId) return;
        const parcelIdStr = parcelId.toString();
        const focus = () => {
            const parcel = global.parcelLayer.getLayers().find(layer => {
                return layer.feature && layer.feature.properties &&
                    layer.feature.properties.parcelId.toString() === parcelIdStr;
            });
            const showParcelInfoPanel = uiParcelPanel.showParcelInfoPanel || global.showParcelInfoPanel;
            if (parcel && typeof showParcelInfoPanel === 'function') {
                showParcelInfoPanel(parcel.feature);
            }
        };
        // Use rAF to wait for any UI updates instead of arbitrary timeouts.
        if (typeof global.requestAnimationFrame === 'function') {
            global.requestAnimationFrame(focus);
        } else {
            focus();
        }
    }

    /**
     * Handle user accepting a proposal from the parcel info panel
     * @param {string} proposalId - The proposal id
     * @param {string} parcelId - The parcel ID
     */
    async function acceptProposalFromParcelInfo(proposalId, parcelId, ownerKey = null, options = {}) {
        const normalizedOptions = options && typeof options === 'object' ? options : {};
        const skipParcelPanelFocus = normalizedOptions.skipParcelPanelFocus === true;
        let effectiveOwnerKey = ownerKey;
        if (!effectiveOwnerKey && typeof global.ensureParcelOwnerSlots === 'function') {
            const slots = await global.ensureParcelOwnerSlots(parcelId);
            if (Array.isArray(slots) && slots.length === 1) {
                effectiveOwnerKey = slots[0].key;
            }
        }

        if (typeof global.handleUserAcceptProposal === 'function') {
            await global.handleUserAcceptProposal(proposalId, parcelId, effectiveOwnerKey);
        }

        if (!skipParcelPanelFocus) {
            scheduleParcelPanelFocus(parcelId);
        }
    }

    /**
     * Handle user rejecting a proposal from the parcel info panel
     * @param {string} proposalId - The proposal id
     * @param {string} parcelId - The parcel ID
     */
    async function rejectProposalFromParcelInfo(proposalId, parcelId, ownerKey = null, options = {}) {
        const normalizedOptions = options && typeof options === 'object' ? options : {};
        const skipParcelPanelFocus = normalizedOptions.skipParcelPanelFocus === true;

        if (typeof global.handleUserRejectProposal === 'function') {
            await global.handleUserRejectProposal(proposalId, parcelId, ownerKey);
        } else if (typeof global.rejectProposal === 'function') {
            // Fallback to legacy behavior
            await global.rejectProposal(proposalId, parcelId, ownerKey);
        }

        if (!skipParcelPanelFocus) {
            scheduleParcelPanelFocus(parcelId);
        }
    }

    /**
     * Show proposal details panel when Details button is clicked
     * @param {string} proposalId - The proposal id
     * @param {string} parcelId - The parcel ID
     */
    function showProposalDetails(proposalId, parcelId) {
        // 1. Close the Parcel Info panel
        const hideParcelInfoPanel = uiParcelPanel.hideParcelInfoPanel || global.hideParcelInfoPanel;
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // 2. Select the proposal and show its details immediately
        if (typeof global.selectAndHighlightProposal === 'function') {
            global.selectAndHighlightProposal(proposalId, parcelId, true);
        } else if (typeof global.selectProposalFromList === 'function') {
            // Fallback to old function
            global.selectProposalFromList(proposalId, parcelId);
        }
    }

    /**
     * Switch between tabs in the parcel info panel
     * @param {HTMLElement} tabButton - The clicked tab button
     * @param {string} tabId - The ID of the tab content to show
     */
    function switchParcelTab(tabButton, tabId) {
        // Remove active class from all tab buttons
        const tabButtons = document.querySelectorAll('.parcel-tab-btn');
        tabButtons.forEach(btn => btn.classList.remove('active'));

        // Add active class to clicked button
        tabButton.classList.add('active');

        // Hide all tab contents
        const tabContents = document.querySelectorAll('.parcel-tab-content');
        tabContents.forEach(content => content.classList.remove('active'));

        // Show selected tab content
        const selectedTab = document.getElementById(tabId);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }

        if (tabId === 'tools-tab') {
            if (typeof global.triggerParcelToolsTabActivated === 'function') {
                global.triggerParcelToolsTabActivated();
            }
            // Reapply feature visibility when switching to tools tab
            // Use requestAnimationFrame to ensure DOM is ready
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(() => {
                    if (typeof global.CityConfigManager !== 'undefined' &&
                        typeof global.CityConfigManager.applyFeatureVisibility === 'function') {
                        global.CityConfigManager.applyFeatureVisibility();
                    }
                });
            } else if (typeof global.CityConfigManager !== 'undefined' &&
                typeof global.CityConfigManager.applyFeatureVisibility === 'function') {
                global.CityConfigManager.applyFeatureVisibility();
            }
        }
    }

    // Make these functions globally available
    global.focusOnProposal = focusOnProposal;
    global.acceptProposalFromParcelInfo = acceptProposalFromParcelInfo;
    global.rejectProposalFromParcelInfo = rejectProposalFromParcelInfo;
    global.showProposalDetails = showProposalDetails;
    global.switchParcelTab = switchParcelTab;
})(typeof window !== 'undefined' ? window : globalThis);
