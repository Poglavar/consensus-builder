/**
 * Proposal Count Labels UI
 * Shows the number of proposals per parcel as blue circles with white text
 */

(function (global) {
    'use strict';

    let proposalCountLabels = [];
    let proposalCountLabelFilter = null;
    let proposalCountMapListenersAttached = false;
    let proposalCountHotkeyAttached = false;
    let proposalCountDebounceTimer = null;
    const PROPOSAL_COUNT_DEBOUNCE_MS = 150;

    const isEditableTarget = (target) => {
        if (!target) return false;
        const tagName = target.tagName;
        return target.isContentEditable
            || tagName === 'INPUT'
            || tagName === 'TEXTAREA'
            || tagName === 'SELECT'
            || tagName === 'OPTION';
    };

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    /**
     * Get proposal count for a parcel from ALL proposals
     */
    function getProposalCountFromParcel(parcelId) {
        if (!parcelId) return 0;

        const normalizedId = typeof global.normalizeParcelId === 'function'
            ? global.normalizeParcelId(parcelId)
            : parcelId.toString();

        // Get all proposals
        if (typeof global.proposalStorage === 'undefined' ||
            typeof global.proposalStorage.getProposalsForParcel !== 'function') {
            return 0;
        }

        try {
            // Get all proposals for this parcel
            const proposals = global.proposalStorage.getProposalsForParcel(normalizedId, { hydrateRoadAssets: false });

            // Return count of all proposals (local, server, and blockchain)
            return proposals.length;
        } catch (error) {
            console.warn('Failed to get proposal count for parcel', parcelId, error);
            return 0;
        }
    }

    function getProposalCountFromFeature(feature) {
        if (!feature || !feature.properties) return 0;

        const parcelId = resolveParcelId(feature);
        if (!parcelId) return 0;

        return getProposalCountFromParcel(parcelId);
    }

    function toggleProposalCounts() {
        const checkbox = document.getElementById('showProposalCounts');
        const show = checkbox ? checkbox.checked : false;
        if (show) {
            attachProposalCountMapListeners();
            drawProposalCountLabels();
        } else {
            detachProposalCountMapListeners();
            clearProposalCountLabels();
        }
    }

    function drawProposalCountLabels() {
        clearProposalCountLabels();
        if (!global.parcelLayer) return;
        // Refresh the Canton public counts in the background (redraws on update).
        if (global.CantonCounts && typeof global.CantonCounts.ensureFresh === 'function') {
            global.CantonCounts.ensureFresh();
        }

        const bounds = (global.map && typeof global.map.getBounds === 'function')
            ? global.map.getBounds()
            : null;

        // Early bounds filtering: only process parcels within current viewport
        // This is much more efficient than iterating all parcels and checking bounds later
        const parcelsToProcess = (typeof global.getParcelsInBounds === 'function' && bounds)
            ? global.getParcelsInBounds(bounds)
            : null;

        // If we couldn't get filtered parcels, fall back to iterating all (less efficient)
        if (!parcelsToProcess) {
            global.parcelLayer.eachLayer(layer => processLayerForCount(layer, bounds));
            return;
        }

        // Process only visible parcels
        for (let i = 0; i < parcelsToProcess.length; i++) {
            processLayerForCount(parcelsToProcess[i], bounds);
        }
    }

    function processLayerForCount(layer, bounds) {
        if (!layer?.feature?.properties) return;
        const parcelId = resolveParcelId(layer.feature);
        if (proposalCountLabelFilter && parcelId && !proposalCountLabelFilter.has(parcelId)) {
            return;
        }

        const proposalCount = getProposalCountFromFeature(layer.feature);
        // Canton proposals are private — we only know a public count (existence
        // signal), not terms. Shown as a separate, distinctly-styled badge.
        const cantonCount = (global.CantonCounts && parcelId) ? global.CantonCounts.getCount(parcelId) : 0;

        // Don't show anything if there are no proposals of either kind.
        if (proposalCount === 0 && cantonCount === 0) return;

        let labelLatLng = null;
        const geometry = layer.feature.geometry;

        if (geometry && typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
            try {
                const centroid = turf.centerOfMass(geometry);
                const coords = centroid?.geometry?.coordinates;
                if (Array.isArray(coords) && coords.length >= 2) {
                    const [lng, lat] = coords;
                    if (Number.isFinite(lat) && Number.isFinite(lng)) {
                        labelLatLng = L.latLng(lat, lng);
                    }
                }
            } catch (error) {
                console.warn('Unable to compute centroid for proposal count label', error);
            }
        }

        if (!labelLatLng && typeof layer.getBounds === 'function') {
            const layerBounds = layer.getBounds();
            if (layerBounds && typeof layerBounds.getCenter === 'function') {
                const center = layerBounds.getCenter();
                if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
                    labelLatLng = center;
                }
            }
        }

        if (!labelLatLng) return;

        // Double-check the label is in bounds (for edge cases where parcel crosses boundary)
        if (bounds && !bounds.contains(labelLatLng)) {
            return;
        }

        if (proposalCount > 0) {
            const label = L.marker(labelLatLng, {
                icon: L.divIcon({
                    className: 'parcel-proposal-count-label',
                    html: `${proposalCount}`,
                    iconSize: [20, 20],
                    // Shift left when a Canton badge will sit beside it.
                    iconAnchor: cantonCount > 0 ? [22, 10] : [10, 10]
                }),
                interactive: false
            }).addTo(global.map);
            proposalCountLabels.push(label);
        }

        if (cantonCount > 0) {
            const cantonLabel = L.marker(labelLatLng, {
                icon: L.divIcon({
                    className: 'parcel-proposal-count-label parcel-canton-count-label',
                    html: `${cantonCount}`,
                    iconSize: [20, 20],
                    iconAnchor: proposalCount > 0 ? [-2, 10] : [10, 10]
                }),
                title: 'Canton proposal(s) — terms private',
                interactive: false
            }).addTo(global.map);
            proposalCountLabels.push(cantonLabel);
        }
    }

    function clearProposalCountLabels() {
        proposalCountLabels.forEach(label => global.map.removeLayer(label));
        proposalCountLabels = [];
    }

    function refreshProposalCountLabelsIfVisible() {
        const checkbox = document.getElementById('showProposalCounts');
        if (checkbox && checkbox.checked) {
            drawProposalCountLabels();
        }
    }

    // Debounced version to avoid excessive redraws during rapid map movements
    function refreshProposalCountLabelsDebounced() {
        if (proposalCountDebounceTimer) {
            clearTimeout(proposalCountDebounceTimer);
        }
        proposalCountDebounceTimer = setTimeout(() => {
            proposalCountDebounceTimer = null;
            refreshProposalCountLabelsIfVisible();
        }, PROPOSAL_COUNT_DEBOUNCE_MS);
    }

    function attachProposalCountMapListeners() {
        if (!global.map || typeof global.map.on !== 'function' || proposalCountMapListenersAttached) {
            return;
        }
        try {
            global.map.on('moveend', refreshProposalCountLabelsDebounced);
            global.map.on('zoomend', refreshProposalCountLabelsDebounced);
            proposalCountMapListenersAttached = true;
        } catch (_) { /* ignore */ }
    }

    function detachProposalCountMapListeners() {
        if (!global.map || typeof global.map.off !== 'function' || !proposalCountMapListenersAttached) {
            return;
        }
        try {
            global.map.off('moveend', refreshProposalCountLabelsDebounced);
            global.map.off('zoomend', refreshProposalCountLabelsDebounced);
            // Clear any pending debounced call
            if (proposalCountDebounceTimer) {
                clearTimeout(proposalCountDebounceTimer);
                proposalCountDebounceTimer = null;
            }
            proposalCountMapListenersAttached = false;
        } catch (_) { /* ignore */ }
    }

    function setProposalCountLabelFilter(ids) {
        if (ids && ids.size) {
            proposalCountLabelFilter = new Set(Array.from(ids).map(id => id.toString()));
        } else {
            proposalCountLabelFilter = null;
        }
        refreshProposalCountLabelsIfVisible();
    }

    // Toggle proposal count labels with the "P" keyboard shortcut when not typing in a form field.
    function handleProposalCountHotkey(event) {
        if (!event || event.defaultPrevented) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isEditableTarget(event.target)) return;
        if (event.key !== 'p' && event.key !== 'P') return;

        const checkbox = document.getElementById('showProposalCounts');
        if (!checkbox) return;

        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        event.preventDefault();
    }

    function attachProposalCountHotkey() {
        if (proposalCountHotkeyAttached) return;
        document.addEventListener('keydown', handleProposalCountHotkey);
        proposalCountHotkeyAttached = true;
    }

    /**
     * Hook to refresh counts when proposals are added or removed
     */
    function setupProposalChangeListeners() {
        // Listen for proposal storage changes
        if (global.proposalStorage) {
            const originalAdd = global.proposalStorage.addProposal;
            if (originalAdd && typeof originalAdd === 'function') {
                global.proposalStorage.addProposal = function(...args) {
                    const result = originalAdd.apply(this, args);
                    // Refresh proposal counts after a short delay
                    setTimeout(() => {
                        refreshProposalCountLabelsIfVisible();
                    }, 100);
                    return result;
                };
            }

            // Also hook into save to catch updates
            const originalSave = global.proposalStorage.save;
            if (originalSave && typeof originalSave === 'function') {
                global.proposalStorage.save = function(...args) {
                    const result = originalSave.apply(this, args);
                    setTimeout(() => {
                        refreshProposalCountLabelsIfVisible();
                    }, 100);
                    return result;
                };
            }
        }
    }

    // Export functions
    if (typeof global.Parcels === 'undefined') {
        global.Parcels = {};
    }
    if (typeof global.Parcels.uiProposalCounts === 'undefined') {
        global.Parcels.uiProposalCounts = {};
    }
    global.Parcels.uiProposalCounts.toggleProposalCounts = toggleProposalCounts;
    global.Parcels.uiProposalCounts.drawProposalCountLabels = drawProposalCountLabels;
    global.Parcels.uiProposalCounts.clearProposalCountLabels = clearProposalCountLabels;
    global.Parcels.uiProposalCounts.refreshProposalCountLabelsIfVisible = refreshProposalCountLabelsIfVisible;
    global.Parcels.uiProposalCounts.setProposalCountLabelFilter = setProposalCountLabelFilter;

    // Also make available globally for backward compatibility
    global.toggleProposalCounts = toggleProposalCounts;
    global.drawProposalCountLabels = drawProposalCountLabels;
    global.clearProposalCountLabels = clearProposalCountLabels;
    global.refreshProposalCountLabelsIfVisible = refreshProposalCountLabelsIfVisible;
    global.setProposalCountLabelFilter = setProposalCountLabelFilter;

    // Redraw labels when the Canton public counts update.
    global.addEventListener('canton-counts-updated', refreshProposalCountLabelsIfVisible);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            attachProposalCountHotkey();
            setupProposalChangeListeners();
        }, { once: true });
    } else {
        attachProposalCountHotkey();
        setupProposalChangeListeners();
    }
})(typeof window !== 'undefined' ? window : globalThis);
