(function (global) {
    'use strict';

    // Ownership type highlight colors (light but visible). Four hues that must stay apart at 30%
    // fill over a green basemap — private individual is red rather than green, which read as the
    // government blue's twin once both were washed over terrain.
    // THE definition: the sidebar legend swatches and parcel styling both read it from here
    // (ParcelsOwnershipHighlight.styleFor). Copies drift — styles.js used to hold two of them.
    const OWNERSHIP_HIGHLIGHT_COLORS = {
        'government': { fillColor: '#4a90e2', fillOpacity: 0.3, color: '#2e5c8a', weight: 2 },
        'institution': { fillColor: '#9b59b6', fillOpacity: 0.3, color: '#6b3d8f', weight: 2 },
        'company': { fillColor: '#f39c12', fillOpacity: 0.3, color: '#b8730d', weight: 2 },
        'private individual': { fillColor: '#e74c3c', fillOpacity: 0.3, color: '#a93226', weight: 2 }
    };

    const parcelIdFor = parcelOrId => {
        if (typeof parcelOrId === 'string' || typeof parcelOrId === 'number') return String(parcelOrId);
        const presentedId = global.ParcelPresenter?.getIdForLayer?.(parcelOrId);
        if (presentedId) return String(presentedId);
        if (parcelOrId?.type !== 'Feature') return null;
        const props = parcelOrId.properties || {};
        const id = props.parcelId ?? props.parcel_id ?? props.id;
        return id === undefined || id === null ? null : String(id);
    };

    let selectedOwnershipTypes = new Set();
    let ownershipTypeCache = new Map(); // Cache ownership types for parcels
    let ownershipTypeCacheScope = null;
    let ownershipHighlightMapListenersAttached = false;
    let ownershipHighlightHotkeyAttached = false;
    let ownershipHighlightDebounceTimer = null;
    const OWNERSHIP_HIGHLIGHT_DEBOUNCE_MS = 150;

    function ownershipCacheKey(parcelId) {
        const city = global.CityConfigManager?.getCurrentCityId?.() || 'default';
        const revision = global.LiveParcelFabric?.snapshot?.().revision ?? 'none';
        const scope = `${city}|${revision}`;
        if (scope !== ownershipTypeCacheScope) {
            ownershipTypeCache.clear();
            ownershipTypeCacheScope = scope;
        }
        return `${scope}\u0000${parcelId}`;
    }

    const isEditableTarget = (target) => {
        if (!target) return false;
        const tagName = target.tagName;
        return target.isContentEditable
            || tagName === 'INPUT'
            || tagName === 'TEXTAREA'
            || tagName === 'SELECT'
            || tagName === 'OPTION';
    };

    /**
     * Calculate ownership type for a parcel based on owner data
     * @param {string|Object} parcelOrId - A parcel id or its current presentation layer
     * @returns {string|null} Ownership type or null if cannot be determined
     */
    async function calculateOwnershipTypeForParcel(parcelOrId) {
        const parcelId = parcelIdFor(parcelOrId);
        if (!parcelId) {
            return null;
        }

        const parcelIdStr = parcelId.toString();
        const cacheKey = ownershipCacheKey(parcelIdStr);
        const feature = global.LiveParcelFabric?.get?.(parcelIdStr) || null;
        if (!feature) return null;

        // Check cache first
        if (ownershipTypeCache.has(cacheKey)) {
            return ownershipTypeCache.get(cacheKey);
        }

        const props = feature.properties || {};

        // First priority: Use ownershipType directly from backend (new format)
        if (props.ownershipType && typeof props.ownershipType === 'string') {
            const ownershipType = props.ownershipType.trim();
            if (ownershipType) {
                ownershipTypeCache.set(cacheKey, ownershipType);
                return ownershipType;
            }
        }

        // Second priority: Calculate from ownershipList if available (new format)
        if (Array.isArray(props.ownershipList) && props.ownershipList.length > 0) {
            const getOwnershipTypeFn = global.getOwnershipType;
            if (getOwnershipTypeFn && typeof getOwnershipTypeFn === 'function') {
                const ownerTypes = props.ownershipList
                    .map(owner => {
                        const ownerLabel = owner.ownerLabel || owner.label || owner.name || '';
                        if (!ownerLabel) return null;
                        return getOwnershipTypeFn(ownerLabel);
                    })
                    .filter(Boolean);

                if (ownerTypes.length > 0) {
                    const uniqueTypes = Array.from(new Set(ownerTypes));
                    const ownershipType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
                    ownershipTypeCache.set(cacheKey, ownershipType);
                    return ownershipType;
                }
            }
            // If ownershipList exists, we always return here (either with calculated type or default)
            // This prevents API calls when ownership data is already present in parcel properties
            const defaultType = 'private individual';
            ownershipTypeCache.set(cacheKey, defaultType);
            return defaultType;
        }

        // Fallback: Get owner information from old API methods
        const getRealParcelOwnersFn = global.getRealParcelOwners ||
            (global.Parcels && global.Parcels.ownership && global.Parcels.ownership.getRealParcelOwners) ||
            (global.Parcels && global.Parcels.ownershipUi && global.Parcels.ownershipUi.getRealParcelOwners);

        const getOwnershipTypeFn = global.getOwnershipType;

        if (!getOwnershipTypeFn) {
            // Default to private individual if no owner info and no function available
            const defaultType = 'private individual';
            ownershipTypeCache.set(cacheKey, defaultType);
            return defaultType;
        }

        let owners = [];
        if (typeof getRealParcelOwnersFn === 'function') {
            try {
                // Construct proper parcel ID format (HR-<maticni_broj_ko>-<broj_cestice>) if available
                let parcelIdForApi = parcelIdStr;
                const brojCestice = props.BROJ_CESTICE ?? props.broj_cestice;
                const maticniBrojKo = props.MATICNI_BROJ_KO ?? props.maticni_broj_ko ?? (props.cadastralMunicipality && props.cadastralMunicipality.id);
                if (brojCestice !== undefined && brojCestice !== null && maticniBrojKo !== undefined && maticniBrojKo !== null) {
                    const numberStr = String(brojCestice).trim();
                    const municipalityStr = String(maticniBrojKo).trim();
                    if (numberStr && municipalityStr) {
                        parcelIdForApi = `HR-${municipalityStr}-${numberStr}`;
                    }
                }
                owners = await getRealParcelOwnersFn(parcelIdForApi);
                if (!Array.isArray(owners)) {
                    owners = [];
                }
            } catch (err) {
                console.warn('Failed to fetch owners for parcel', parcelIdStr, err);
            }
        }

        // If no owners found, try to get from owner label in properties
        if (owners.length === 0) {
            const ownerLabel = props.VLASTNIK ||
                props.owner ||
                props.OWNER;
            if (ownerLabel) {
                const ownershipType = getOwnershipTypeFn(ownerLabel);
                if (ownershipType) {
                    ownershipTypeCache.set(cacheKey, ownershipType);
                    return ownershipType;
                }
            }
            // Default to private individual if no owner info
            const defaultType = 'private individual';
            ownershipTypeCache.set(cacheKey, defaultType);
            return defaultType;
        }

        // Calculate ownership type from owners
        const ownerTypes = owners.map(owner => {
            const ownerName = owner.name || owner.label || '';
            return getOwnershipTypeFn(ownerName);
        }).filter(Boolean);

        if (ownerTypes.length === 0) {
            const defaultType = 'private individual';
            ownershipTypeCache.set(cacheKey, defaultType);
            return defaultType;
        }

        // If all owners are the same type, use that type
        const uniqueTypes = Array.from(new Set(ownerTypes));
        const ownershipType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';

        ownershipTypeCache.set(cacheKey, ownershipType);
        return ownershipType;
    }

    /**
     * Calculate ownership types for all parcels currently in memory
     */
    async function calculateOwnershipTypesForAllParcels() {
        const fabric = global.LiveParcelFabric;
        if (!fabric || typeof fabric.list !== 'function' || typeof fabric.featureId !== 'function') {
            return;
        }

        const parcels = [];
        fabric.list().forEach(feature => {
            const parcelId = fabric.featureId(feature);
            if (!parcelId) return;
            const parcelIdStr = String(parcelId);
            const cacheKey = ownershipCacheKey(parcelIdStr);
            if (ownershipTypeCache.has(cacheKey)) return;
            if (feature.properties?.ownershipType) {
                ownershipTypeCache.set(cacheKey, feature.properties.ownershipType);
                return;
            }
            parcels.push(parcelIdStr);
        });

        // If all parcels already have ownership data, just refresh styles
        if (parcels.length === 0) {
            if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
                global.refreshParcelStylesForAppliedProposals();
            } else {
                refreshOwnershipHighlights();
            }
            return;
        }

        // Process parcels in batches to avoid blocking
        const batchSize = 50;
        for (let i = 0; i < parcels.length; i += batchSize) {
            const batch = parcels.slice(i, i + batchSize);
            await Promise.all(batch.map(parcel => calculateOwnershipTypeForParcel(parcel)));

            // Yield to browser every batch
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Refresh styles after calculation
        if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
            global.refreshParcelStylesForAppliedProposals();
        } else {
            refreshOwnershipHighlights();
        }
    }

    /**
     * Refresh parcel highlights based on selected ownership types
     * This function only applies ownership highlighting. For full style refresh,
     * use refreshParcelStylesForAppliedProposals instead.
     */
    function refreshOwnershipHighlights() {
        // Delegate to the main style refresh function which already handles ownership highlighting
        if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
            global.refreshParcelStylesForAppliedProposals();
        }
    }

    /**
     * Handle checkbox change for ownership type highlighting
     */
    function handleOwnershipTypeCheckboxChange(ownershipType, checked) {
        if (checked) {
            selectedOwnershipTypes.add(ownershipType);
            // Calculate ownership types for all parcels if not already calculated
            calculateOwnershipTypesForAllParcels();
        } else {
            selectedOwnershipTypes.delete(ownershipType);
            // If no ownership types selected, refresh all styles
            if (selectedOwnershipTypes.size === 0) {
                if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
                    global.refreshParcelStylesForAppliedProposals();
                } else {
                    refreshOwnershipHighlights();
                }
            } else {
                refreshOwnershipHighlights();
            }
        }

        updateOwnershipHighlightMapListeners();
    }

    // A pan brings parcels that were never classified, so the answer is to CLASSIFY, not merely to
    // repaint: restyling alone left every newly loaded parcel plain, and the ones re-ingested over
    // the same ground lost their tint with the feature object that carried it. Cached ids cost
    // nothing here — the pass skips them and goes straight to the repaint.
    function refreshOwnershipHighlightsIfActive() {
        if (selectedOwnershipTypes.size === 0) return;
        calculateOwnershipTypesForAllParcels();
    }

    function handleOwnershipHighlightMapChange() {
        refreshOwnershipHighlightsIfActive();
    }

    // Debounced version to avoid excessive redraws during rapid map movements
    function handleOwnershipHighlightMapChangeDebounced() {
        if (ownershipHighlightDebounceTimer) {
            clearTimeout(ownershipHighlightDebounceTimer);
        }
        ownershipHighlightDebounceTimer = setTimeout(() => {
            ownershipHighlightDebounceTimer = null;
            handleOwnershipHighlightMapChange();
        }, OWNERSHIP_HIGHLIGHT_DEBOUNCE_MS);
    }

    function attachOwnershipHighlightMapListeners() {
        if (!global.map || typeof global.map.on !== 'function' || ownershipHighlightMapListenersAttached) {
            return;
        }
        try {
            global.map.on('moveend', handleOwnershipHighlightMapChangeDebounced);
            global.map.on('zoomend', handleOwnershipHighlightMapChangeDebounced);
            // moveend fires before the parcels it triggered have arrived, so the map settling is
            // only half the signal — the fetch landing is the other half, and it is the one that
            // brings unclassified ground.
            global.addEventListener('parcelDataLoaded', handleOwnershipHighlightMapChangeDebounced);
            ownershipHighlightMapListenersAttached = true;
        } catch (_) { /* ignore */ }
    }

    function detachOwnershipHighlightMapListeners() {
        if (!ownershipHighlightMapListenersAttached || !global.map || typeof global.map.off !== 'function') {
            ownershipHighlightMapListenersAttached = false;
            return;
        }
        try {
            global.map.off('moveend', handleOwnershipHighlightMapChangeDebounced);
            global.map.off('zoomend', handleOwnershipHighlightMapChangeDebounced);
            global.removeEventListener('parcelDataLoaded', handleOwnershipHighlightMapChangeDebounced);
            // Clear any pending debounced call
            if (ownershipHighlightDebounceTimer) {
                clearTimeout(ownershipHighlightDebounceTimer);
                ownershipHighlightDebounceTimer = null;
            }
        } catch (_) { /* ignore */ }
        ownershipHighlightMapListenersAttached = false;
    }

    function updateOwnershipHighlightMapListeners() {
        if (selectedOwnershipTypes.size > 0) {
            attachOwnershipHighlightMapListeners();
        } else {
            detachOwnershipHighlightMapListeners();
        }
    }

    function toggleAllOwnershipTypeCheckboxes() {
        const checkboxes = Array.from(document.querySelectorAll('.ownership-type-checkbox'));
        if (!checkboxes.length) return;
        const shouldCheck = !checkboxes.every(box => box.checked);
        checkboxes.forEach(box => {
            if (box.checked === shouldCheck) return;
            box.checked = shouldCheck;
            box.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    function handleOwnershipHighlightHotkey(event) {
        if (!event || event.defaultPrevented) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isEditableTarget(event.target)) return;
        if (event.key !== 't' && event.key !== 'T') return;

        toggleAllOwnershipTypeCheckboxes();
        event.preventDefault();
    }

    function attachOwnershipHighlightHotkey() {
        if (ownershipHighlightHotkeyAttached) return;
        document.addEventListener('keydown', handleOwnershipHighlightHotkey);
        ownershipHighlightHotkeyAttached = true;
    }

    // Each row carries the colour it paints the map with, so the list IS the legend. Painted from
    // the same constant the highlighting uses — a second copy in CSS is a legend that can lie.
    function paintOwnershipLegendSwatches() {
        document.querySelectorAll('.ownership-type-checkbox').forEach(checkbox => {
            const label = checkbox.closest('label');
            const swatch = label ? label.querySelector('.ownership-legend-swatch') : null;
            const style = OWNERSHIP_HIGHLIGHT_COLORS[checkbox.getAttribute('data-ownership-type')];
            if (!swatch || !style) return;
            swatch.style.backgroundColor = style.fillColor;
            swatch.style.borderColor = style.color;
        });
    }

    /**
     * Initialize ownership type highlighting UI
     */
    function initializeOwnershipHighlighting() {
        const checkboxes = document.querySelectorAll('.ownership-type-checkbox');
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', function () {
                const ownershipType = this.getAttribute('data-ownership-type');
                handleOwnershipTypeCheckboxChange(ownershipType, this.checked);
            });
        });
        paintOwnershipLegendSwatches();

        updateOwnershipHighlightMapListeners();
        attachOwnershipHighlightHotkey();
    }

    // Initialize when DOM is ready
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initializeOwnershipHighlighting);
        } else {
            initializeOwnershipHighlighting();
        }
    }

    // Expose API
    global.ParcelsOwnershipHighlight = {
        calculateOwnershipTypesForAllParcels,
        refreshOwnershipHighlights,
        handleOwnershipTypeCheckboxChange,
        getSelectedOwnershipTypes: () => new Set(selectedOwnershipTypes),
        // The Leaflet style for an ownership type, or null when it has none. Every painter goes
        // through here so the map, the legend and any future consumer cannot disagree.
        styleFor: (ownershipType) => {
            const style = OWNERSHIP_HIGHLIGHT_COLORS[ownershipType];
            return style ? { ...style } : null;
        },
        // What a current parcel's ownership type is. Geometry and source properties always come
        // from the fabric; the derived classification cache is scoped to that fabric revision.
        typeFor: (parcelOrId) => {
            const parcelId = parcelIdFor(parcelOrId);
            const feature = parcelId ? global.LiveParcelFabric?.get?.(parcelId) : null;
            if (!feature?.properties) return null;
            const fromProps = feature.properties.ownershipType;
            if (fromProps) return fromProps;
            return ownershipTypeCache.get(ownershipCacheKey(parcelId)) || null;
        },
        clearCache: () => { ownershipTypeCache.clear(); ownershipTypeCacheScope = null; }
    };

})(typeof window !== 'undefined' ? window : globalThis);

