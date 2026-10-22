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
            const parcels = Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
            if (proposal && parcels.length > 0) {
                global.selectAndHighlightProposal(proposalKey, parcels[0], true);
            }
        } else if (typeof global.centerOnProposal === 'function') {
            // Fallback to old function
            global.centerOnProposal(proposalKey);
        }
    }

    /**
     * Show proposal details panel when Details button is clicked
     * @param {string} proposalId - The proposal id
     * @param {string} parcelId - The parcel ID
     */
    function showProposalDetails(proposalId, parcelId) {
        // Keep the Parcel Info panel open: its Proposals list is the switcher — clicking another
        // entry just points the proposal button box at that proposal (its status badge says
        // applied/parked/etc.), it does not navigate away from the parcel.
        if (typeof global.selectAndHighlightProposal === 'function') {
            global.selectAndHighlightProposal(proposalId, parcelId, false, true);
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
        // Scoped to the parcel panel: the site panel reuses the tab classes with its own state.
        const panel = document.getElementById('parcel-info-panel');
        if (!panel) return;
        const activeButton = tabButton || panel.querySelector(`.parcel-tab-btn[data-parcel-tab-id="${tabId}"]`);

        if (!activeButton) {
            return;
        }

        // The selected tab is an ARIA state (cb-tabs, css/primitives.css), never a class.
        const tabButtons = panel.querySelectorAll('.parcel-tab-btn');
        tabButtons.forEach(btn => btn.setAttribute('aria-selected', String(btn === activeButton)));

        // Hide all tab contents (the hidden attribute, css/panels.css)
        const tabContents = panel.querySelectorAll('.parcel-tab-content');
        tabContents.forEach(content => { content.hidden = true; });

        // Show selected tab content
        const selectedTab = document.getElementById(tabId);
        if (selectedTab) {
            selectedTab.hidden = false;
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
    global.showProposalDetails = showProposalDetails;
    global.switchParcelTab = switchParcelTab;
})(typeof window !== 'undefined' ? window : globalThis);
