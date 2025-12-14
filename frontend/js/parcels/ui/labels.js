(function (global) {
    'use strict';

    let parcelNumberLabels = [];
    let parcelNumberLabelFilter = null;

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    function toggleParcelNumbers() {
        const checkbox = document.getElementById('showParcelNumbers');
        const show = checkbox ? checkbox.checked : false;
        if (show) {
            drawParcelNumberLabels();
        } else {
            clearParcelNumberLabels();
        }
    }

    function drawParcelNumberLabels() {
        clearParcelNumberLabels();
        if (!global.parcelLayer) return;

        const cityId = global.getCurrentCityId ? global.getCurrentCityId() : null;
        const parcelNumberProperty = cityId === 'buenos_aires'
            ? 'smp'
            : cityId === 'belgrade'
                ? 'parcelNum'
                : 'BROJ_CESTICE';

        global.parcelLayer.eachLayer(layer => {
            if (!layer?.feature?.properties) return;
            const parcelNumber = layer.feature.properties[parcelNumberProperty];
            if (!parcelNumber) return;
            const parcelId = resolveParcelId(layer.feature);
            if (parcelNumberLabelFilter && parcelId && !parcelNumberLabelFilter.has(parcelId)) {
                return;
            }

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
                    console.warn('Unable to compute centroid for parcel label', error);
                }
            }

            if (!labelLatLng && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && typeof bounds.getCenter === 'function') {
                    const center = bounds.getCenter();
                    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
                        labelLatLng = center;
                    }
                }
            }

            if (!labelLatLng) return;

            // Create a temporary element to measure the text size
            const tempDiv = document.createElement('div');
            tempDiv.className = 'parcel-number-label';
            tempDiv.textContent = parcelNumber;
            tempDiv.style.position = 'absolute';
            tempDiv.style.visibility = 'hidden';
            tempDiv.style.whiteSpace = 'nowrap';
            document.body.appendChild(tempDiv);
            const width = tempDiv.offsetWidth;
            const height = tempDiv.offsetHeight;
            document.body.removeChild(tempDiv);

            const label = L.marker(labelLatLng, {
                icon: L.divIcon({
                    className: 'parcel-number-label',
                    html: `${parcelNumber}`,
                    iconSize: [width, height],
                    iconAnchor: [width / 2, height / 2]
                }),
                interactive: false
            }).addTo(global.map);
            parcelNumberLabels.push(label);
        });
    }

    function clearParcelNumberLabels() {
        parcelNumberLabels.forEach(label => global.map.removeLayer(label));
        parcelNumberLabels = [];
    }

    function refreshParcelNumberLabelsIfVisible() {
        const checkbox = document.getElementById('showParcelNumbers');
        if (checkbox && checkbox.checked) {
            drawParcelNumberLabels();
        }
    }

    function setParcelNumberLabelFilter(ids) {
        if (ids && ids.size) {
            parcelNumberLabelFilter = new Set(Array.from(ids).map(id => id.toString()));
        } else {
            parcelNumberLabelFilter = null;
        }
        refreshParcelNumberLabelsIfVisible();
    }

    global.toggleParcelNumbers = toggleParcelNumbers;
    global.drawParcelNumberLabels = drawParcelNumberLabels;
    global.clearParcelNumberLabels = clearParcelNumberLabels;
    global.refreshParcelNumberLabelsIfVisible = refreshParcelNumberLabelsIfVisible;
    global.setParcelNumberLabelFilter = setParcelNumberLabelFilter;
})(typeof window !== 'undefined' ? window : globalThis);

