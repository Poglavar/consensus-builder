// parcels/ui/locate.js — parcel layer toggles, the local parcel-data wipe, and locateParcelById (find a
// parcel by cadastral id and select it), which the map search box uses for parcel-id results.
(function (global) {
    'use strict';

    const Parcels = global.Parcels || {};
    const uiVisibility = Parcels.uiVisibility || {};
    const uiLabels = Parcels.uiLabels || {};
    const uiParcelPanel = Parcels.uiParcelPanel || global.ParcelsUIParcelPanel || {};

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    // Translate a sidebar.parcels.* key, falling back to English if i18n is
    // unavailable or the key is missing (translate() returns the key on a miss).
    const t = (key, fallback) => {
        const fn = global.i18n && typeof global.i18n.t === 'function' ? global.i18n.t : null;
        if (!fn) return fallback;
        const fullKey = `sidebar.parcels.${key}`;
        const result = fn(fullKey);
        return result && result !== fullKey ? result : fallback;
    };

    async function clearLocalParcelData() {
        if (typeof global.updateStatus === 'function') {
            global.updateStatus('Clearing local parcel data...');
        }
        let count = 0;
        const keysToDelete = [];
        for (let i = 0; i < PersistentStorage.length; i++) {
            const key = PersistentStorage.key(i);
            if (key === 'cadastre_blocks' ||
                key.startsWith('parcel_') ||
                key.startsWith('road_') ||
                key.includes('_geometry') ||
                key.includes('_properties') ||
                key.includes('_isRoad') ||
                key.includes('_roadName') ||
                key.includes('_split_')) {
                keysToDelete.push(key);
                count++;
            }
        }
        // Final message shown after clearing
        const clearedMessage = `Cleared ${count} parcel-related items from local storage`;

        if (!global.ProposalManager || typeof global.ProposalManager.releaseCadastralGround !== 'function') {
            throw new Error('ParcelMutation is unavailable for clearing cadastral ground.');
        }
        await global.ProposalManager.releaseCadastralGround('local parcel data reset', {
            storageKeys: keysToDelete
        });
        if (typeof blockStorage !== 'undefined' && typeof blockStorage.clear === 'function') blockStorage.clear();
        const clearLabels = uiLabels.clearParcelNumberLabels || global.clearParcelNumberLabels;
        if (typeof clearLabels === 'function') {
            clearLabels();
        }
        global.currentParcel = null;
        global.selectedParcelId = null;
        const hideParcelInfoPanel = uiParcelPanel.hideParcelInfoPanel || global.hideParcelInfoPanel;
        if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel();
        if (typeof global.hideBlockInfo === 'function') global.hideBlockInfo();
        if (typeof global.hideRoadInfoPanel === 'function') global.hideRoadInfoPanel();

        // Set the final status message after fetchParcelData has run its course
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(clearedMessage);
        }
    }

    function handleParcelLayerChange(checkbox) {
        const showParcelsCheckbox = document.getElementById('showParcels');
        const showRoadParcelsCheckbox = document.getElementById('showRoadParcels');
        if (checkbox.id === 'showParcels' && checkbox.checked) {
            showRoadParcelsCheckbox.checked = false;
        } else if (checkbox.id === 'showRoadParcels' && checkbox.checked) {
            showParcelsCheckbox.checked = false;
        }
        const showAll = uiVisibility.showAllParcels || global.showAllParcels;
        const showOnlyRoads = uiVisibility.showOnlyRoadParcels || global.showOnlyRoadParcels;
        const hideAll = uiVisibility.hideAllParcels || global.hideAllParcels;

        if (showParcelsCheckbox.checked) {
            if (typeof showAll === 'function') showAll();
        } else if (showRoadParcelsCheckbox.checked) {
            if (typeof showOnlyRoads === 'function') showOnlyRoads();
        } else if (typeof hideAll === 'function') {
            hideAll();
        }
    }

    // Find a parcel by its cadastral id and select it (which centres the map on it). The search
    // box (js/ui/map-search.js) calls this for parcel-id results. Resolves to
    // { ok: true, parcelId } or { ok: false, reason: 'empty' | 'notLoaded' | 'notFound', message }.
    // `deps` defaults to the page globals; backend/test/parcel-locate.test.js passes fakes.
    async function locateParcelById(rawValue, deps = global) {
        const value = String(rawValue == null ? '' : rawValue).trim();
        if (!value) return { ok: false, reason: 'empty', message: '' };
        const parcels = deps.Parcels || {};
        const labels = parcels.uiLabels || {};
        const selection = parcels.selection || {};

        // Parcel ids are what the person is looking for, so show them.
        const doc = deps.document;
        const showParcelNumbersCheckbox = doc && typeof doc.getElementById === 'function'
            ? doc.getElementById('showParcelNumbers')
            : null;
        if (showParcelNumbersCheckbox && !showParcelNumbersCheckbox.checked) {
            showParcelNumbersCheckbox.checked = true;
            const toggleParcelNumbers = labels.toggleParcelNumbers || deps.toggleParcelNumbers;
            if (typeof toggleParcelNumbers === 'function') toggleParcelNumbers();
        }

        if (!deps.LiveParcelFabric || !deps.ParcelPresenter) {
            return { ok: false, reason: 'notLoaded', message: t('locateDataNotLoaded', 'Parcel data not loaded') };
        }

        // Declare the id to the ground service. It decides whether this is a registry hit, an
        // in-flight join, a known absence, or a server load; locating only resolves the resulting
        // layer. selectParcel centres the map and loads the surrounding viewport.
        const ground = deps.CadastralParcelRepository;
        if (!ground || typeof ground.ensureIds !== 'function') {
            return { ok: false, reason: 'notFound', message: t('locateNotFound', 'Parcel not found') };
        }
        const selectParcel = selection.selectParcel || deps.selectParcel;
        try {
            await ground.ensureIds([value]);
        } catch (error) {
            console.info(`[${new Date().toISOString()}] [locate] lookup failed for`, value, error && error.message);
            return { ok: false, reason: 'notFound', message: t('locateNotFound', 'Parcel not found') };
        }
        const layer = deps.LiveParcelFabric.get(value) ? deps.ParcelPresenter.getLayer(value) : null;
        const foundId = layer ? ((deps.ParcelPresenter.getIdForLayer && deps.ParcelPresenter.getIdForLayer(layer)) || value) : null;
        if (!foundId || typeof selectParcel !== 'function') {
            return { ok: false, reason: 'notFound', message: t('locateNotFound', 'Parcel not found') };
        }
        selectParcel(foundId);
        return { ok: true, parcelId: foundId };
    }

    global.clearLocalParcelData = clearLocalParcelData;
    global.handleParcelLayerChange = handleParcelLayerChange;
    global.locateParcelById = locateParcelById;

    // Node: export the locator for its unit test. The browser path above is unchanged.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { locateParcelById };
    }
})(typeof window !== 'undefined' ? window : globalThis);
