(function (global) {
    'use strict';

    const fetchApi = (global.Parcels && global.Parcels.fetch) ? global.Parcels.fetch : {};

    function isRoad(parcelId) {
        return global.PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
    }

    function showAllParcels() {
        if (global.parcelLayer) {
            global.parcelLayer.addTo(global.map);
            global.parcelLayer.eachLayer(layer => {
                layer.addTo(global.map);
            });
        } else if (typeof fetchApi.fetchParcelData === 'function') {
            fetchApi.fetchParcelData();
        } else if (typeof global.fetchParcelData === 'function') {
            global.fetchParcelData();
        }
    }

    function showOnlyRoadParcels() {
        if (!global.parcelLayer) {
            if (typeof fetchApi.fetchParcelData === 'function') {
                fetchApi.fetchParcelData();
            } else if (typeof global.fetchParcelData === 'function') {
                global.fetchParcelData();
            }
            setTimeout(() => showOnlyRoadParcels(), 1000);
            return;
        }
        global.parcelLayer.addTo(global.map);
        let roadCount = 0;
        global.parcelLayer.eachLayer(layer => {
            const parcelId = layer.feature.properties.CESTICA_ID;
            const isRoad = global.PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
            if (isRoad) {
                if (!global.map.hasLayer(layer)) {
                    global.map.addLayer(layer);
                }
                roadCount++;
            } else {
                if (global.map.hasLayer(layer)) {
                    global.map.removeLayer(layer);
                }
            }
        });
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`Showing ${roadCount} road parcels only`);
        }
    }

    function hideAllParcels() {
        if (global.parcelLayer) {
            global.map.removeLayer(global.parcelLayer);
        }
        if (typeof global.updateStatus === 'function') {
            global.updateStatus('All parcels hidden');
        }
    }

    function updateVisibleParcelsCount() {
        const label = document.getElementById('parcels-in-view');
        if (!label) return;

        const i18nApi = (typeof global !== 'undefined') ? global.i18n : null;
        const setLabel = (key, params, fallback) => {
            label.setAttribute('data-i18n-key', key);
            if (params) {
                label.setAttribute('data-i18n-params', JSON.stringify(params));
            } else {
                label.removeAttribute('data-i18n-params');
            }
            if (i18nApi && typeof i18nApi.t === 'function') {
                label.textContent = i18nApi.t(key, params || {});
            } else {
                label.textContent = fallback;
            }
        };

        if (!global.parcelLayer || typeof global.parcelLayer.getLayers !== 'function' || typeof global.map === 'undefined' || !global.map) {
            setLabel('sidebar.parcels.inViewDefault', null, 'Parcels in map view / total: 0 / 0');
            return;
        }

        const layers = global.parcelLayer.getLayers();
        const totalParcels = layers.length;

        if (!totalParcels) {
            setLabel('sidebar.parcels.inViewDefault', null, 'Parcels in map view / total: 0 / 0');
            return;
        }

        const bounds = global.map.getBounds();
        if (!bounds || typeof bounds.intersects !== 'function') {
            setLabel('sidebar.parcels.inViewTemplate', { visible: 0, total: totalParcels }, `Parcels in map view / total: 0 / ${totalParcels}`);
            return;
        }

        const visibleParcels = layers.filter(layer => {
            try {
                const layerBounds = layer && typeof layer.getBounds === 'function' ? layer.getBounds() : null;
                return layerBounds ? bounds.intersects(layerBounds) : false;
            } catch (_) {
                return false;
            }
        });

        setLabel(
            'sidebar.parcels.inViewTemplate',
            { visible: visibleParcels.length, total: totalParcels },
            `Parcels in map view / total: ${visibleParcels.length} / ${totalParcels}`
        );
    }

    global.isRoad = isRoad;
    global.showAllParcels = showAllParcels;
    global.showOnlyRoadParcels = showOnlyRoadParcels;
    global.hideAllParcels = hideAllParcels;
    global.updateVisibleParcelsCount = updateVisibleParcelsCount;

    global.ParcelsUIVisibility = {
        isRoad,
        showAllParcels,
        showOnlyRoadParcels,
        hideAllParcels,
        updateVisibleParcelsCount
    };
})(typeof window !== 'undefined' ? window : globalThis);

