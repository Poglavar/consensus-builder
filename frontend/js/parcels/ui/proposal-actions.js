(function (global) {
    'use strict';

    const tParcel = (key, params = {}, fallback = '') => {
        if (typeof global.tParcel === 'function') {
            return global.tParcel(key, params, fallback);
        }
        try {
            const api = global.i18n;
            if (api && typeof api.t === 'function') {
                const translated = api.t(key, params || {});
                if (translated !== undefined && translated !== null) {
                    return translated;
                }
            }
        } catch (_) { }
        return fallback || key || '';
    };

    function setProposalButtonLoading(button, isLoading) {
        if (!button) return;

        if (isLoading) {
            if (button.dataset.proposalLoading === 'true') return;
            button.dataset.proposalLoading = 'true';
            button.dataset.originalHtml = button.innerHTML;
            button.disabled = true;
            button.classList.add('is-loading');
            button.setAttribute('aria-busy', 'true');

            const loadingLabel = tParcel(
                'panel.parcel.proposalsSection.creating',
                {},
                tParcel('modal.createProposal.creating', {}, 'Creating...')
            );
            button.innerHTML = '';
            const spinner = global.document.createElement('span');
            spinner.className = 'metric-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            const label = global.document.createElement('span');
            label.textContent = loadingLabel;
            button.append(spinner, label);
            return;
        }

        const originalHtml = button.dataset.originalHtml;
        if (originalHtml !== undefined) {
            button.innerHTML = originalHtml;
        }
        button.disabled = false;
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        delete button.dataset.proposalLoading;
        delete button.dataset.originalHtml;
    }

    function runCreateProposalButtonAction(button, action) {
        if (button && button.dataset.proposalLoading === 'true') return;

        setProposalButtonLoading(button, true);
        const scheduleFrame = typeof global.requestAnimationFrame === 'function'
            ? global.requestAnimationFrame.bind(global)
            : (callback) => global.setTimeout(callback, 0);
        // Give the browser a chance to paint the spinner before the dialog does
        // synchronous parcel summary work.
        scheduleFrame(() => {
            scheduleFrame(() => {
                try {
                    action();
                } finally {
                    setProposalButtonLoading(button, false);
                }
            });
        });
    }

    function createProposalFromSingleParcel(button = null) {
        runCreateProposalButtonAction(button, () => {
            // Gate: require personalized profile to create proposals
            if (typeof global.requirePersonalizedUser === 'function' && global.requirePersonalizedUser()) {
                return;
            }

            if (!global.currentParcel || !global.currentParcel.layer) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('No parcel selected. Please select a parcel first.');
                }
                return;
            }
            if (typeof global.multiParcelSelection !== 'undefined') {
                if (!global.multiParcelSelection.isActive) {
                    global.multiParcelSelection.selectedParcels.clear();
                    global.multiParcelSelection.selectedParcels.add(global.currentParcel.id);
                    if (typeof global.showProposalDialog === 'function') {
                        global.showProposalDialog();
                    }
                } else {
                    console.warn('createProposalFromSingleParcel called while multi-select is active - this should not happen');
                    if (typeof global.updateStatus === 'function') {
                        global.updateStatus('Please use the main "Create Proposal" button when multiple parcels are selected.');
                    }
                }
            }
        });
    }

    function createProposalFromSelectedParcels(button = null) {
        runCreateProposalButtonAction(button, () => {
            // Gate: require personalized profile to create proposals
            if (typeof global.requirePersonalizedUser === 'function' && global.requirePersonalizedUser()) {
                return;
            }

            if (typeof global.multiParcelSelection === 'undefined' || !global.multiParcelSelection || !global.multiParcelSelection.isActive) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('Enable multi-parcel selection to use this action.');
                }
                return;
            }

            const hasSelection = global.multiParcelSelection.selectedParcels && global.multiParcelSelection.selectedParcels.size > 0;
            if (!hasSelection) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('Select at least one parcel to create a proposal.');
                }
                return;
            }

            if (typeof global.showProposalDialog === 'function') {
                global.showProposalDialog();
            }
        });
    }

    function renderParcelProposalActions(parcelIdOverride = null) {
        const container = document.getElementById('parcel-proposal-primary-actions')
            || document.getElementById('parcel-proposal-actions');
        if (!container) return;

        const hasMultiSelect = typeof global.multiParcelSelection !== 'undefined' && !!global.multiParcelSelection;
        const multiSelectActive = hasMultiSelect && global.multiParcelSelection.isActive;
        const selectionCount = multiSelectActive && global.multiParcelSelection.selectedParcels
            ? global.multiParcelSelection.selectedParcels.size
            : 0;

        if (multiSelectActive && selectionCount > 0) {
            const label = tParcel('panel.parcel.proposalsSection.create', {}, 'Create proposal');
            container.innerHTML = `
            <button type="button" class="btn btn-proposal" id="createProposalFromSelectionButton" onclick="createProposalFromSelectedParcels(this)">
                ${label}
            </button>
        `;
            return;
        }

        const parcelContextId = parcelIdOverride || (global.currentParcel && global.currentParcel.id);
        if (parcelContextId) {
            container.innerHTML = `
            <button type="button" class="btn btn-proposal" id="createProposalFromParcelButton" onclick="createProposalFromSingleParcel(this)">
                ${tParcel('panel.parcel.proposalsSection.create', {}, 'Create proposal')}
            </button>
        `;
        } else {
            container.innerHTML = '';
        }
    }

    global.createProposalFromSingleParcel = createProposalFromSingleParcel;
    global.createProposalFromSelectedParcels = createProposalFromSelectedParcels;
    global.renderParcelProposalActions = renderParcelProposalActions;
})(typeof window !== 'undefined' ? window : globalThis);

