(function () {
    const STORAGE_KEY = 'cb_current_city';
    const DEFAULT_CITY_ID = 'new_york';
    const LANGUAGE_STORAGE_KEY = 'cb_language';
    const CITY_QUERY_MAP = {
        ba: 'buenos_aires',
        bg: 'belgrade',
        zg: 'zagreb',
        lj: 'ljubljana',
        co: 'colorado',
        ny: 'new_york'
    };

    const SHARED_DEFAULT_ZOOM = 19;

    const formatCityText = (template, params = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    };

    const translateCityText = (key, fallback, params = {}) => {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            const translated = api.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return formatCityText(fallback, params);
    };

    const showCityAlert = (key, fallback, params = {}) => {
        const message = translateCityText(`alerts.messages.${key}`, fallback, params);
        const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
            ? window.showStyledAlert
            : window.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
        return message;
    };

    function getStoredLanguagePreference() {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.getItem === 'function') {
                const stored = PersistentStorage.getItem(LANGUAGE_STORAGE_KEY);
                if (stored) {
                    return stored;
                }
            }
        } catch (_) { /* ignore */ }

        return null;
    }

    function applyCityLanguagePreference(cityConfig) {
        if (!cityConfig || !cityConfig.language || !cityConfig.language.default) {
            return;
        }

        // Respect any previously chosen language
        if (getStoredLanguagePreference()) {
            return;
        }

        const targetLang = cityConfig.language.default;
        const i18n = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (i18n && typeof i18n.getLanguage === 'function' && i18n.getLanguage() === targetLang) {
            return;
        }

        if (i18n && typeof i18n.setLanguage === 'function') {
            try {
                i18n.setLanguage(targetLang);
            } catch (_) { /* ignore */ }
        }
    }

    const CITY_CONFIGS = {
        zagreb: {
            id: 'zagreb',
            label: 'Zagreb, Croatia',
            currency: { locale: 'hr-HR', code: 'EUR' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                defaultCenter: [45.804503, 15.978786],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.12
            },
            projection: {
                datasetCrs: 'EPSG:3765',
                definition: '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [45.804503, 15.978786],
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
                source: 'oss-wfs',
                requiresBackend: true
            },
            sidebar: {
                // No disabled sections for Zagreb - all sections enabled
                // All features (including roadTools) are automatically enabled
                disabledSections: []
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            },
            // Street-level "walk through it" launcher shown in 3D mode (the yellow-guy button).
            // Currently powered by the Zagreb transit planner's 3D walk overlay. Only cities
            // that set `walk.url` show the button; everyone else hides it (see three-mode.js).
            walk: {
                url: 'https://zagreb.lol/prijevoz/'
            }
        },
        belgrade: {
            id: 'belgrade',
            label: 'Belgrade, Serbia',
            currency: { locale: 'sr-RS', code: 'RSD' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                defaultCenter: [44.810918, 20.438859],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                // Parcels arrive in degrees; geometry needs metres. UTM 34N covers Belgrade.
                metricCrs: 'EPSG:32634',
                metricDefinition: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.810918, 20.438859],
                fallbackDataset: [20.438859, 44.810918]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.005, // degrees (~500 m)
                source: 'parcel-bg',
                requiresBackend: true
            },
            buildings: {
                // Overture-Maps footprints + heights, ingested into overture_feature (layer=buildings)
                // and extruded server-side (backend/buildings/overture-3d.js). Resolved by city id, not
                // this string. Like NYC, the 3D buildings load automatically in 3D mode.
                source: 'overture'
            },
            sidebar: {
                // 'buildings' stays disabled: that sidebar toggle is the Zagreb 2D WFS layer.
                // Belgrade's 3D buildings load automatically in 3D mode (Built/Both/Planned), the
                // same as NYC, independent of this section.
                disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            },
            language: {
                default: 'sr'
            }
        },
        ljubljana: {
            id: 'ljubljana',
            label: 'Ljubljana, Slovenia',
            currency: { locale: 'sl-SI', code: 'EUR' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                defaultCenter: [46.051, 14.506],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.1
            },
            projection: {
                datasetCrs: 'EPSG:3794',
                definition: '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +units=m +no_defs',
                fallbackLatLng: [46.051, 14.506],
                fallbackDataset: [461969.2, 101119.53]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 500,
                source: 'parcel-lj',
                requiresBackend: true
            },
            buildings: {
                source: 'none'
            },
            sidebar: {
                disabledSections: ['buildings', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            },
            language: {
                default: 'sl'
            }
        },
        buenos_aires: {
            id: 'buenos_aires',
            label: 'Buenos Aires, Argentina',
            currency: { locale: 'es-AR', code: 'ARS' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                defaultCenter: [-34.6089, -58.3724],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.04
            },
            projection: {
                datasetCrs: 'BA_CADASTRE',
                definition: '+proj=tmerc +lat_0=-34.6297166 +lon_0=-58.4627 +k=0.999998 +x_0=100000 +y_0=100000 +ellps=intl +towgs84=-148,136,90,0,0,0,0 +units=m +no_defs',
                fallbackLatLng: [-34.6089, -58.3724],
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
            },
            sidebar: {
                // Disable Parcel blocks, Buildings, and Roads for Buenos Aires
                // When 'roads' is disabled, the 'roadTools' feature is automatically disabled
                disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://ciudad3d.buenosaires.gob.ar/'
            }
        },
        colorado: {
            id: 'colorado',
            label: translateCityText('city.labels.denver', 'Denver, USA'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                defaultCenter: [39.7392, -104.9903],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                // Parcels arrive in degrees; geometry needs metres. UTM 13N covers Colorado.
                metricCrs: 'EPSG:32613',
                metricDefinition: '+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.7392, -104.9903],
                fallbackDataset: [-104.9903, 39.7392]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.005,
                source: 'parcel-co',
                requiresBackend: true
            },
            buildings: {
                source: 'none'
            },
            sidebar: {
                disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            }
        }
        ,
        new_york: {
            id: 'new_york',
            label: 'New York, USA',
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: 19
                },
                defaultCenter: [40.7128, -74.0060],
                defaultZoom: 19,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                // Parcels arrive in degrees; geometry needs metres. UTM 18N covers New York City.
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.7128, -74.0060],
                fallbackDataset: [-74.0060, 40.7128]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.005,
                source: 'parcel-nyc',
                requiresBackend: true
            },
            buildings: {
                // Live NYC Open Data footprints + roof heights, extruded server-side
                // (backend/buildings/nyc-footprints.js). Resolved by city id, not this string.
                source: 'nyc'
            },
            sidebar: {
                // 'buildings' stays disabled: its 2D "Show Existing Buildings" toggle is the
                // Zagreb WFS layer. NYC's 3D buildings load automatically in 3D mode (driven by
                // the Built/Both/Planned controls), independent of this sidebar section.
                disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            }
        }
    };

    function ensureProjectionDefinitions() {
        if (typeof proj4 === 'undefined') {
            return;
        }
        Object.values(CITY_CONFIGS).forEach(config => {
            const dataset = config.projection;
            if (dataset && dataset.metricCrs && dataset.metricDefinition) {
                try {
                    if (!proj4.defs(dataset.metricCrs)) {
                        proj4.defs(dataset.metricCrs, dataset.metricDefinition);
                    }
                } catch (error) {
                    console.warn('[CityConfig] Failed to register metric projection', dataset.metricCrs, error);
                }
            }
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

    function getCityIdFromQuery() {
        if (typeof window === 'undefined' || typeof window.location === 'undefined') {
            return null;
        }
        try {
            const params = new URLSearchParams(window.location.search || '');
            const rawValue = params.get('city');
            if (!rawValue) {
                return null;
            }
            const normalized = rawValue.trim().toLowerCase();
            const mappedId = CITY_QUERY_MAP[normalized] || normalized;
            return CITY_CONFIGS[mappedId] ? mappedId : null;
        } catch (_) {
            return null;
        }
    }

    // The city pointer lives in localStorage because it must be readable *synchronously*, before
    // anything else: it decides which IndexedDB database PersistentStorage opens. (It used to live
    // only in PersistentStorage, whose cache primes asynchronously — so this read was racing the
    // very store it was reading from.) PersistentStorage keeps a copy for backwards compatibility
    // and so the legacy-database migration can tell whose data it is looking at.
    function getStoredCityId() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage) {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored && CITY_CONFIGS[stored]) {
                    return stored;
                }
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.getItem === 'function') {
                const stored = PersistentStorage.getItem(STORAGE_KEY);
                if (stored && CITY_CONFIGS[stored]) {
                    return stored;
                }
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    // Each city has its own database (see js/persistent-storage.js), so adopting the city named in
    // a link takes nothing away: the city you were in keeps its parcels, proposals and settings, and
    // they are all still there when you go back. Nothing is wiped here, and nothing needs asking.
    function determineCurrentCityId() {
        const storedCityId = getStoredCityId();
        const queryCityId = getCityIdFromQuery();

        if (queryCityId && CITY_CONFIGS[queryCityId]) {
            if (queryCityId !== storedCityId) {
                try {
                    if (typeof localStorage !== 'undefined' && localStorage) {
                        localStorage.setItem(STORAGE_KEY, queryCityId);
                    }
                } catch (_) { /* ignore */ }
            }
            return queryCityId;
        }

        return storedCityId || DEFAULT_CITY_ID;
    }

    function getCityLabel(cityId) {
        const config = CITY_CONFIGS[cityId];
        return (config && config.label) ? config.label : (cityId || '');
    }

    // Did the user actually choose this city, or did we fall back to the default? Only a defaulted
    // city may be overridden by the one recovered from a pre-upgrade database. Read before
    // setScope, since determineCurrentCityId writes the pointer as a side effect.
    const cityWasExplicitlyChosen = !!(getCityIdFromQuery() || getStoredCityId());

    let currentCityId = determineCurrentCityId();
    // Bind persistent storage to this city's database before anything reads from it. Nothing has
    // been read yet: PersistentStorage deliberately does not open a database until told which one.
    try {
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.setScope === 'function') {
            PersistentStorage.setScope(currentCityId, { explicit: cityWasExplicitlyChosen });
        }
    } catch (_) { /* ignore */ }
    applyCityLanguagePreference(getCurrentCityConfig());

    function maybeApplyGeoDefaultCity() {
        // Temporarily disable IP-based city detection; default stays NYC for all users.
        return;
        // Only auto-guess if the user hasn't explicitly chosen a city and no query override exists.
        if (getCityIdFromQuery()) return;
        if (getStoredCityId()) return;

        const backendBase = (typeof window !== 'undefined' && typeof window.getBackendBase === 'function')
            ? window.getBackendBase()
            : null;
        if (!backendBase) return;

        const url = `${backendBase.replace(/\/+$/, '')}/geo/default-city`;
        fetch(url, { headers: { 'Accept': 'application/json' } })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                const nextId = data && data.cityId ? String(data.cityId) : null;
                if (!nextId || !CITY_CONFIGS[nextId]) {
                    // Store the default so we do not keep retrying geo detection on every load.
                    setStoredCityId(DEFAULT_CITY_ID);
                    return;
                }

                const previousCityId = currentCityId;
                const cityChanged = nextId !== previousCityId;

                setStoredCityId(nextId);

                if (cityChanged) {
                    try {
                        window.location.reload();
                    } catch (_) { /* ignore */ }
                }
            })
            .catch(() => { /* ignore */ });
    }

    // Register early so we run before other DOMContentLoaded listeners in later scripts.
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', maybeApplyGeoDefaultCity, { once: true });
        } else {
            maybeApplyGeoDefaultCity();
        }
    }


    function setStoredCityId(id) {
        currentCityId = CITY_CONFIGS[id] ? id : DEFAULT_CITY_ID;
        try {
            if (typeof localStorage !== 'undefined' && localStorage) {
                localStorage.setItem(STORAGE_KEY, currentCityId);
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.setItem === 'function') {
                PersistentStorage.setItem(STORAGE_KEY, currentCityId);
            }
        } catch (_) { /* ignore */ }
        applyCityLanguagePreference(getCurrentCityConfig());
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

    // ---------------------------------------------------------------------
    // The metric working projection.
    //
    // A city's *dataset* CRS is whatever its parcels arrive in — for Zagreb a metric one (EPSG:3765),
    // for New York and Belgrade plain WGS84 degrees. Geometry code (road corridors, buffers, areas,
    // lengths) needs METRES, and using the dataset CRS for that silently treats degrees as metres:
    // a 10 m road in New York came out 1113 km wide.
    //
    // So every city also declares a metric CRS. Where the dataset CRS is already metric it is the same
    // projection, and nothing changes.
    // ---------------------------------------------------------------------
    function getMetricCrs() {
        const projection = getProjectionConfig();
        if (!projection) return null;
        const crs = projection.metricCrs || projection.datasetCrs;
        if (!crs || typeof proj4 === 'undefined' || !proj4.defs(crs)) return null;
        return crs;
    }

    function latLngToMetric(lat, lon) {
        const crs = getMetricCrs();
        if (!crs) return [lon, lat];
        try {
            const [x, y] = proj4('EPSG:4326', crs, [lon, lat]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('invalid conversion');
            return [x, y];
        } catch (_) {
            return [lon, lat];
        }
    }

    function metricToLatLng(x, y) {
        const crs = getMetricCrs();
        if (!crs) return [y, x];
        try {
            const [lon, lat] = proj4(crs, 'EPSG:4326', [x, y]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('invalid conversion');
            return [lat, lon];
        } catch (_) {
            return [y, x];
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

    function getSidebarConfig() {
        return getCurrentCityConfig().sidebar || { disabledSections: [] };
    }

    function getParcelBuilderConfig() {
        return getCurrentCityConfig().parcelBuilder || null;
    }

    /**
     * Map sidebar section names to feature names
     * When a sidebar section is disabled, the corresponding feature is also disabled
     */
    const SECTION_TO_FEATURE_MAP = {
        'roads': 'roadTools',
        'parcelBlocks': 'parcelBlocks',  // Can be extended for other features
        'buildings': 'buildings'          // Can be extended for other features
    };

    /**
     * Get feature configuration, automatically deriving from sidebar config
     * Sidebar config takes precedence: if a sidebar section is disabled, 
     * the corresponding feature is disabled regardless of explicit feature settings
     */
    function getFeatureConfig() {
        const cityConfig = getCurrentCityConfig();
        const explicitFeatures = cityConfig.features || {};
        const sidebarConfig = getSidebarConfig();
        const disabledSections = sidebarConfig.disabledSections || [];

        // Start with explicit feature config
        const features = { ...explicitFeatures };

        // Automatically derive feature flags from disabled sidebar sections
        // Sidebar config takes precedence over explicit feature settings
        disabledSections.forEach(sectionName => {
            const featureName = SECTION_TO_FEATURE_MAP[sectionName];
            if (featureName) {
                // Sidebar config overrides explicit feature settings
                features[featureName] = false;
            }
        });

        // Ensure all mapped features have a value (default to true if not disabled)
        Object.values(SECTION_TO_FEATURE_MAP).forEach(featureName => {
            if (!(featureName in features)) {
                features[featureName] = true;
            }
        });

        return features;
    }

    /**
     * Check if a feature is enabled
     * @param {string} featureName - Name of the feature to check
     * @returns {boolean} - True if feature is enabled, false otherwise
     */
    function isFeatureEnabled(featureName) {
        const features = getFeatureConfig();
        return features[featureName] === true;
    }

    /**
     * Apply feature visibility to elements marked with data-feature attributes
     * Elements with data-feature="featureName" will be hidden if the feature is disabled
     */
    function applyFeatureVisibility() {
        if (typeof document === 'undefined') return;

        const features = getFeatureConfig();

        // Hide/show elements based on feature flags
        Object.keys(features).forEach(featureName => {
            const isEnabled = features[featureName] === true;
            const selector = `[data-feature="${featureName}"]`;
            const elements = document.querySelectorAll(selector);

            elements.forEach(element => {
                if (isEnabled) {
                    // Show element (remove inline display:none if it was set by this function)
                    if (element.getAttribute('data-feature-hidden') === 'true') {
                        element.removeAttribute('data-feature-hidden');
                        element.style.display = '';
                    }
                } else {
                    // Hide element
                    element.setAttribute('data-feature-hidden', 'true');
                    element.style.display = 'none';
                }
            });
        });
    }

    function applySidebarConfiguration() {
        if (typeof document === 'undefined') return;

        const sidebarConfig = getSidebarConfig();
        const disabledSections = sidebarConfig.disabledSections || [];

        // Map section names to checkbox IDs (proposals, data, roads, and buildings have no section checkbox)
        const sectionToCheckboxId = {
            'parcelBlocks': 'parcelBlocksCheckbox'
        };

        // Disable sections that are in the disabled list
        disabledSections.forEach(sectionName => {
            // For sections with checkboxes, disable the checkbox
            const checkboxId = sectionToCheckboxId[sectionName];
            if (checkboxId) {
                const checkbox = document.getElementById(checkboxId);
                if (checkbox) {
                    checkbox.disabled = true;
                    checkbox.checked = false;
                    // Also hide the entire section
                    const section = checkbox.closest('.accordion-section');
                    if (section) {
                        section.style.display = 'none';
                    }
                }
            } else {
                // For sections without checkboxes, hide the section using the data-section attribute
                const selector = `.accordion-section[data-section="${sectionName}"]`;
                const sections = document.querySelectorAll(selector);
                sections.forEach(section => {
                    section.style.display = 'none';
                });
            }
        });

        // Apply feature visibility after sidebar configuration
        applyFeatureVisibility();
    }

    async function handleCitySelectChange(event) {
        const nextId = event.target.value;
        if (!nextId || nextId === currentCityId) {
            event.target.value = currentCityId;
            return;
        }
        const switched = await switchCity(nextId, { requireConfirmation: true });
        if (!switched) {
            event.target.value = currentCityId;
        }
    }


    function navigateToCity(nextId) {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('city', nextId);
            window.location.href = url.toString();
            return true;
        } catch (_) {
            setStoredCityId(nextId);
            window.location.reload();
            return true;
        }
    }

    async function switchCity(nextId, options = {}) {
        const {
            requireConfirmation = false,
            confirmationMessage = null,
            confirmationOptions = null
        } = options;

        if (!nextId || !CITY_CONFIGS[nextId] || nextId === currentCityId) {
            return false;
        }

        if (requireConfirmation) {
            const confirmFn = window.showStyledConfirm || showStyledConfirm;
            // Each city keeps its own local store, so switching costs nothing but a reload — the
            // city you leave is exactly as you left it when you return.
            const confirmMessage = confirmationMessage || translateCityText(
                'city.switch.confirm',
                'Switching city will reload the app. Your work in this city is kept and will be here when you come back.\n\nDo you want to continue?'
            );
            const proceed = await confirmFn(confirmMessage, confirmationOptions || undefined);
            if (!proceed) {
                if (typeof updateStatus === 'function') {
                    updateStatus('City change cancelled');
                }
                return false;
            }
        }

        return navigateToCity(nextId);
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

    function showStyledAlert(message, options = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'cb-confirm-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'cb-confirm-dialog';

            const text = document.createElement('div');
            text.className = 'cb-confirm-message';

            const linkUrl = options && options.linkUrl ? options.linkUrl : null;
            const linkText = (options && options.linkText) ? options.linkText : null;
            const placeholder = '{{txLink}}';
            const msgString = String(message || '');
            const containsPlaceholder = linkUrl && msgString.includes(placeholder);

            if (containsPlaceholder) {
                const lines = msgString.split('\n');
                lines.forEach((line, lineIndex) => {
                    const parts = line.split(placeholder);
                    parts.forEach((part, partIndex) => {
                        if (part) {
                            text.appendChild(document.createTextNode(part));
                        }
                        if (partIndex < parts.length - 1) {
                            const link = document.createElement('a');
                            link.href = linkUrl;
                            link.target = '_blank';
                            link.rel = 'noopener noreferrer';
                            link.textContent = linkText || 'See transaction on Etherscan';
                            text.appendChild(link);
                        }
                    });
                    if (lineIndex < lines.length - 1) {
                        text.appendChild(document.createElement('br'));
                    }
                });
            } else {
                renderMessageLines(text, message);
            }

            const buttons = document.createElement('div');
            buttons.className = 'cb-confirm-buttons';
            buttons.style.gridTemplateColumns = '1fr'; // Single button, full width

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'btn btn-action';
            okBtn.textContent = 'OK';

            function cleanup() {
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                resolve();
            }

            okBtn.addEventListener('click', cleanup);
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    cleanup();
                }
            });

            buttons.appendChild(okBtn);
            dialog.appendChild(text);
            dialog.appendChild(buttons);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
        });
    }

    window.showStyledAlert = showStyledAlert;

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
            const confirmMessage = translateCityText('city.detect.confirm', 'Allow Consensus Builder to use your approximate location to pick the closest city?');
            const proceed = await confirmFn(confirmMessage);
            if (!proceed) {
                return;
            }
            if (!navigator.geolocation) {
                showCityAlert('geolocation_is_not_supported_by_this_browser', 'Geolocation is not supported by this browser.');
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const { latitude, longitude } = position.coords;
                    const nearest = findNearestCity(latitude, longitude);
                    if (!nearest) {
                        showCityAlert('unable_to_determine_the_nearest_city', 'Unable to determine the nearest city.');
                        return;
                    }
                    const detectedMessage = translateCityText('city.detect.success', 'Location detected: {{label}}', { label: nearest.label });
                    const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') ? window.showStyledAlert : window.alert;
                    if (typeof alertFn === 'function') {
                        alertFn(detectedMessage);
                    }
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
                    showCityAlert('unable_to_detect_your_location', 'Unable to detect your location.');
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

    function getCityCodeForCityId(cityId) {
        if (!cityId) return null;
        // Build reverse map from CITY_QUERY_MAP
        for (const [code, mappedCityId] of Object.entries(CITY_QUERY_MAP)) {
            if (mappedCityId === cityId) {
                return code;
            }
        }
        return null;
    }

    window.CityConfigManager = {
        getCurrentCityId: () => currentCityId,
        setCurrentCityId: setStoredCityId,
        switchCity,
        navigateToCity,
        getCityLabel,
        getCurrentCityConfig,
        getAvailableCities: () => Object.values(CITY_CONFIGS),
        getCityCodeForCityId,
        datasetToLatLng,
        latLngToDataset,
        latLngToMetric,
        metricToLatLng,
        getMetricCrs,
        formatCurrency,
        getParcelStrategy,
        getParcelGridSize,
        getLatLngPadding,
        getParcelZoomRange,
        requiresBackendDataSource,
        getCurrencyConfig,
        getMapConfig: () => getCurrentCityConfig().map || {},
        getSidebarConfig,
        getParcelBuilderConfig,
        getWalkConfig: () => getCurrentCityConfig().walk || null,
        applySidebarConfiguration,
        getFeatureConfig,
        isFeatureEnabled,
        applyFeatureVisibility
    };
})();

