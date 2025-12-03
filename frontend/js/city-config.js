(function () {
    const STORAGE_KEY = 'cb_current_city';
    const DEFAULT_CITY_ID = 'zagreb';

    const CITY_CONFIGS = {
        zagreb: {
            id: 'zagreb',
            label: 'Zagreb, Croatia',
            currency: { locale: 'hr-HR', code: 'EUR' },
            map: {
                initialView: {
                    type: 'bounds',
                    value: [
                        [45.7645, 15.9572],
                        [45.7647, 15.9582]
                    ]
                },
                defaultCenter: [45.815, 15.982],
                defaultZoom: 17,
                parcelZoomRange: { min: 17, max: 19 },
                latLngPadding: 0.12
            },
            projection: {
                datasetCrs: 'EPSG:3765',
                definition: '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [45.815, 15.982],
                fallbackDataset: [458900, 5074000],
                datasetBounds: {
                    minX: 240000,
                    maxX: 730000,
                    minY: 4460000,
                    maxY: 5160000
                }
            },
            parcels: {
                strategy: 'grid',
                gridSize: 500,
                source: 'oss-wfs'
            }
        },
        buenos_aires: {
            id: 'buenos_aires',
            label: 'Buenos Aires, Argentina',
            currency: { locale: 'es-AR', code: 'ARS' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: 17
                },
                defaultCenter: [-34.6037, -58.3816],
                defaultZoom: 17,
                parcelZoomRange: { min: 17, max: 19 },
                latLngPadding: 0.04
            },
            projection: {
                datasetCrs: 'BA_CADASTRE',
                definition: '+proj=tmerc +lat_0=-34.6297166 +lon_0=-58.4627 +k=0.999998 +x_0=100000 +y_0=100000 +ellps=intl +towgs84=-148,136,90,0,0,0,0 +units=m +no_defs',
                fallbackLatLng: [-34.6037, -58.3816],
                fallbackDataset: [100000, 100000]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 500,
                source: 'parcel-ba',
                requiresBackend: true
            },
            buildings: {
                source: 'none'
            }
        }
    };

    function ensureProjectionDefinitions() {
        if (typeof proj4 === 'undefined') {
            return;
        }
        Object.values(CITY_CONFIGS).forEach(config => {
            const dataset = config.projection;
            if (dataset && dataset.datasetCrs && dataset.definition) {
                try {
                    if (!proj4.defs(dataset.datasetCrs)) {
                        proj4.defs(dataset.datasetCrs, dataset.definition);
                    }
                } catch (error) {
                    console.warn('[CityConfig] Failed to register projection', dataset.datasetCrs, error);
                }
            }
        });
        if (!proj4.defs('EPSG:4326')) {
            proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
        }
    }

    ensureProjectionDefinitions();

    function getStoredCityId() {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (stored && CITY_CONFIGS[stored]) {
                return stored;
            }
        } catch (_) { /* ignore */ }
        return DEFAULT_CITY_ID;
    }

    let currentCityId = getStoredCityId();

    function setStoredCityId(id) {
        currentCityId = CITY_CONFIGS[id] ? id : DEFAULT_CITY_ID;
        try {
            window.localStorage.setItem(STORAGE_KEY, currentCityId);
        } catch (_) { /* ignore */ }
        try {
            window.dispatchEvent(new CustomEvent('cityChanged', { detail: { cityId: currentCityId } }));
        } catch (_) { /* ignore */ }
    }

    function getCurrentCityConfig() {
        return CITY_CONFIGS[currentCityId] || CITY_CONFIGS[DEFAULT_CITY_ID];
    }

    function getProjectionConfig() {
        return getCurrentCityConfig().projection || null;
    }

    function datasetToLatLng(easting, northing) {
        const projection = getProjectionConfig();
        if (!projection) {
            return [northing, easting];
        }
        const datasetCrs = projection.datasetCrs;
        if (!datasetCrs || typeof proj4 === 'undefined' || !proj4.defs(datasetCrs)) {
            return [northing, easting];
        }
        try {
            const [lon, lat] = proj4(datasetCrs, 'EPSG:4326', [easting, northing]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                throw new Error('invalid conversion');
            }
            return [lat, lon];
        } catch (_) {
            return projection.fallbackLatLng || [northing, easting];
        }
    }

    function latLngToDataset(lat, lon) {
        const projection = getProjectionConfig();
        if (!projection) {
            return [lon, lat];
        }
        const datasetCrs = projection.datasetCrs;
        if (!datasetCrs || typeof proj4 === 'undefined' || !proj4.defs(datasetCrs)) {
            return [lon, lat];
        }
        try {
            const [x, y] = proj4('EPSG:4326', datasetCrs, [lon, lat]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                throw new Error('invalid conversion');
            }
            return [x, y];
        } catch (_) {
            return projection.fallbackDataset || [lon, lat];
        }
    }

    function formatCurrency(value) {
        const { currency } = getCurrentCityConfig();
        if (!currency) {
            return `${value}`;
        }
        try {
            const formatter = new Intl.NumberFormat(currency.locale || 'en-US', {
                style: 'currency',
                currency: currency.code || 'USD',
                maximumFractionDigits: 0
            });
            return formatter.format(value);
        } catch (_) {
            return `${value} ${currency.code || ''}`.trim();
        }
    }

    function getParcelSettings() {
        return getCurrentCityConfig().parcels || {};
    }

    function getParcelStrategy() {
        return getParcelSettings().strategy || 'grid';
    }

    function getParcelGridSize() {
        return getParcelSettings().gridSize || 500;
    }

    function getLatLngPadding() {
        const { map } = getCurrentCityConfig();
        return typeof map?.latLngPadding === 'number' ? map.latLngPadding : 0.12;
    }

    function getParcelZoomRange() {
        const { map } = getCurrentCityConfig();
        return map?.parcelZoomRange || { min: 17, max: 19 };
    }

    function requiresBackendDataSource() {
        return Boolean(getParcelSettings().requiresBackend);
    }

    function getCurrencyConfig() {
        return getCurrentCityConfig().currency;
    }

    async function handleCitySelectChange(event) {
        const nextId = event.target.value;
        if (!nextId || nextId === currentCityId) {
            event.target.value = currentCityId;
            return;
        }
        const confirmFn = window.showStyledConfirm || showStyledConfirm;
        const proceed = await confirmFn('Switching city will clear locally cached data (parcels, proposals, settings) and reload the app.\n\nDo you want to continue?');
        if (!proceed) {
            event.target.value = currentCityId;
            if (typeof updateStatus === 'function') {
                updateStatus('City change cancelled');
            }
            return;
        }

        try {
            if (typeof clearLocalParcelData === 'function') {
                clearLocalParcelData();
            }
        } catch (_) { /* ignore */ }

        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.clear === 'function') {
                PersistentStorage.clear();
            }
        } catch (_) { /* ignore */ }

        setStoredCityId(nextId);
        window.location.reload();
    }

function renderMessageLines(container, message) {
        const lines = String(message || '').split('\n');
        lines.forEach((line, index) => {
            const span = document.createElement('span');
            span.textContent = line;
            container.appendChild(span);
            if (index < lines.length - 1) {
                container.appendChild(document.createElement('br'));
            }
        });
    }

function showStyledConfirm(message, options = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';

        const text = document.createElement('div');
        text.className = 'cb-confirm-message';
        renderMessageLines(text, message);

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = options.cancelText || 'Cancel';

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn btn-action';
        okBtn.textContent = options.okText || 'OK';

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        okBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup(false);
            }
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(okBtn);
        dialog.appendChild(text);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

window.showStyledConfirm = showStyledConfirm;

function populateCitySelect() {
        if (typeof document === 'undefined') {
            return;
        }
        const select = document.getElementById('city-select');
        if (!select) {
            return;
        }
        // Clear existing options
        while (select.firstChild) {
            select.removeChild(select.firstChild);
        }
        Object.values(CITY_CONFIGS).forEach(config => {
            const option = document.createElement('option');
            option.value = config.id;
            option.textContent = config.label;
            select.appendChild(option);
        });
        select.value = currentCityId;
        select.addEventListener('change', handleCitySelectChange);
    }

    function haversineDistance(lat1, lon1, lat2, lon2) {
        const toRad = deg => deg * (Math.PI / 180);
        const R = 6371; // km
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function getCityCenter(config) {
        if (config.map && Array.isArray(config.map.defaultCenter)) {
            return config.map.defaultCenter;
        }
        if (config.map && config.map.initialView && Array.isArray(config.map.initialView.center)) {
            return config.map.initialView.center;
        }
        if (config.map && config.map.initialView && config.map.initialView.value && Array.isArray(config.map.initialView.value[0])) {
            const bounds = config.map.initialView.value;
            const sw = bounds[0];
            const ne = bounds[1];
            return [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
        }
        return config.projection?.fallbackLatLng || null;
    }

    function findNearestCity(lat, lon) {
        let best = null;
        let bestDistance = Infinity;
        Object.values(CITY_CONFIGS).forEach(config => {
            const center = getCityCenter(config);
            if (!center) return;
            const d = haversineDistance(lat, lon, center[0], center[1]);
            if (d < bestDistance) {
                bestDistance = d;
                best = config;
            }
        });
        return best;
    }

    function setupDetectCityButton() {
        if (typeof document === 'undefined') return;
        const button = document.getElementById('detect-city-button');
        if (!button) return;
        button.addEventListener('click', async () => {
            const confirmFn = window.showStyledConfirm || showStyledConfirm;
            const proceed = await confirmFn('Allow Consensus Builder to use your approximate location to pick the closest city?');
            if (!proceed) {
                return;
            }
            if (!navigator.geolocation) {
                window.alert('Geolocation is not supported by this browser.');
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const { latitude, longitude } = position.coords;
                    const nearest = findNearestCity(latitude, longitude);
                    if (!nearest) {
                        window.alert('Unable to determine the nearest city.');
                        return;
                    }
                    window.alert(`Location detected: ${nearest.label}`);
                    setStoredCityId(nearest.id);
                    if (typeof document !== 'undefined') {
                        const select = document.getElementById('city-select');
                        if (select) {
                            select.value = nearest.id;
                        }
                    }
                    window.location.reload();
                },
                (error) => {
                    console.warn('Geolocation error:', error);
                    window.alert('Unable to detect your location.');
                },
                {
                    enableHighAccuracy: false,
                    maximumAge: 60_000,
                    timeout: 15_000
                }
            );
        });
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            populateCitySelect();
            setupDetectCityButton();
        }, { once: true });
    }

    window.CityConfigManager = {
        getCurrentCityId: () => currentCityId,
        setCurrentCityId: setStoredCityId,
        getCurrentCityConfig,
        getAvailableCities: () => Object.values(CITY_CONFIGS),
        datasetToLatLng,
        latLngToDataset,
        formatCurrency,
        getParcelStrategy,
        getParcelGridSize,
        getLatLngPadding,
        getParcelZoomRange,
        requiresBackendDataSource,
        getCurrencyConfig,
        getMapConfig: () => getCurrentCityConfig().map || {}
    };
})();


