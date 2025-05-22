// Parcel locating functionality for Consensus Builder
// Assumes parcelLayer and showParcelInfo are globally available

document.addEventListener('DOMContentLoaded', function () {
    const locateInput = document.getElementById('locateParcelInput');
    const locateButton = document.getElementById('locateParcelButton');
    const locateError = document.getElementById('locateParcelError');

    if (!locateInput || !locateButton || !locateError) {
        // UI elements not present
        return;
    }

    function locateParcel() {
        const value = locateInput.value.trim();
        locateError.textContent = '';
        if (!value) return;

        // Ensure the 'Show parcel numbers' checkbox is checked
        const showParcelNumbersCheckbox = document.getElementById('showParcelNumbers');
        if (showParcelNumbersCheckbox && !showParcelNumbersCheckbox.checked) {
            showParcelNumbersCheckbox.checked = true;
            if (typeof toggleParcelNumbers === 'function') {
                toggleParcelNumbers();
            }
        }

        if (typeof parcelLayer === 'undefined' || !parcelLayer) {
            locateError.textContent = 'Parcel data not loaded';
            return;
        }

        // Find the layer with the matching parcel number (BROJ_CESTICE)
        const foundLayer = parcelLayer.getLayers().find(layer =>
            layer.feature &&
            layer.feature.properties &&
            layer.feature.properties.BROJ_CESTICE &&
            layer.feature.properties.BROJ_CESTICE.toString() === value
        );

        if (foundLayer) {
            if (typeof showParcelInfo === 'function') {
                showParcelInfo(foundLayer.feature.properties.CESTICA_ID);
            }
            locateError.textContent = '';
        } else {
            locateError.textContent = 'Parcel not found';
        }
    }

    locateButton.addEventListener('click', locateParcel);
    locateInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            locateParcel();
        }
    });
}); 