// The city configuration manager: which city this page runs in and how its data is read. The
// configurations themselves live in data/city-configs.js, split by scripts/build-city-files.mjs into
// the index every page loads (data/city-index.js) and one file per city (data/cities/<id>.js), of
// which a page loads exactly one: see loadCurrentCityConfig below.
(function () {
    const localStorage = window.BrowserWorkspace?.storage || window.localStorage;
    const STORAGE_KEY = 'cb_current_city';
    const DEFAULT_CITY_ID = 'new_york';
    const LANGUAGE_STORAGE_KEY = 'cb_language';
    const CITY_QUERY_MAP = {
        ba: 'buenos_aires',
        bg: 'belgrade',
        zg: 'zagreb',
        st: 'split',
        si: 'sibenik',
        lj: 'ljubljana',
        co: 'colorado',
        ny: 'new_york'
    };

    const SHARED_DEFAULT_ZOOM = 19;
    const requestedParcelSource = new URLSearchParams(window.location?.search || '').get('parcelSource');

    // Where the configurations come from (frontend/data/city-configs.js is the source of truth):
    //   root.__cityConfigs  full configurations by id. In the browser only the city the page runs in,
    //                       from data/cities/<id>.js, written into the page below once the city is
    //                       known; under node every city, from data/city-configs.js itself.
    //   root.__cityIndex    every city's light configuration (data/city-index.js, rows expanded on
    //                       first use by js/city-light-config.js); absent under node.
    const root = typeof window !== 'undefined' ? window : globalThis;
    const fullConfigs = root.__cityConfigs = root.__cityConfigs || {};
    const cityIndex = root.__cityIndex || null;
    const indexRows = cityIndex ? new Map(cityIndex.rows.map(row => [row[0], row])) : null;
    const lightConfigs = {};
    function hasCity(id) {
        return !!id && (Object.prototype.hasOwnProperty.call(fullConfigs, id) || (!!indexRows && indexRows.has(id)));
    }
    function cityIds() {
        return indexRows ? [...indexRows.keys()] : Object.keys(fullConfigs);
    }
    // A city's configuration as this page knows it: full for the city it runs in, light for the others.
    function configOf(id) {
        if (!id) return null;
        let config = Object.prototype.hasOwnProperty.call(fullConfigs, id) ? fullConfigs[id] : null;
        if (!config && indexRows && indexRows.has(id)) {
            if (!lightConfigs[id]) lightConfigs[id] = root.__cityLightConfig.expand(cityIndex, indexRows.get(id));
            config = lightConfigs[id];
        }
        return config ? withExploreView(config) : null;
    }
    // The current city's full configuration, which this page must have loaded.
    function requireFullConfig(id) {
        if (Object.prototype.hasOwnProperty.call(fullConfigs, id)) return;
        throw new Error(`[city-config] the full configuration of "${id}" is not loaded (data/cities/${id}.js)`);
    }
    // The current city's full configuration: one more script, written into the page right here so it
    // runs before the scripts that follow this one (map-core.js reads the configuration at parse time).
    // A second, inline script written after it resolves cityConfigLoaded: work that must wait for the
    // configuration but is scheduled from a promise (the stored language below) waits on that, since
    // a microtask can run between this script and the written one while the file is still in flight.
    let resolveCityConfigLoaded = null;
    const cityConfigLoaded = new Promise(resolve => { resolveCityConfigLoaded = resolve; });
    function markCityConfigLoaded() {
        requireFullConfig(currentCityId);
        resolveCityConfigLoaded();
    }
    function loadCurrentCityConfig() {
        if (Object.prototype.hasOwnProperty.call(fullConfigs, currentCityId)) { resolveCityConfigLoaded(); return; }
        if (typeof document === 'undefined') return;
        if (document.readyState !== 'loading' || typeof document.write !== 'function') {
            throw new Error(`[city-config] cannot load data/cities/${currentCityId}.js: city-config.js must run as a synchronous script while the page is parsing`);
        }
        const path = `data/cities/${encodeURIComponent(currentCityId)}.js`;
        const src = typeof root.appendBuildToken === 'function' ? root.appendBuildToken(path) : path;
        document.write(`<script src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"><\/script>`
            + '<script>window.CityConfigManager.markCityConfigLoaded();<\/script>');
    }

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
        // An explicit ?lang= in the URL outranks the city default for the session.
        if (i18n && typeof i18n.getUrlLanguage === 'function' && i18n.getUrlLanguage()) {
            return;
        }
        if (i18n && typeof i18n.getLanguage === 'function' && i18n.getLanguage() === targetLang) {
            return;
        }

        if (i18n && typeof i18n.setLanguage === 'function') {
            try {
                i18n.setLanguage(targetLang);
            } catch (_) { /* ignore */ }
        }
    }

    // The explore city: any place without parcel data (an ?at= no city's parcels reach, see
    // WorldEntryModel.resolveEntry). Its centre is the ?at= point, else the last explored point (kept
    // in localStorage so a reload stays put), else a world overview. Never a stored city, never a
    // shared-link target.
    const EXPLORE_CITY_ID = 'explore';
    const EXPLORE_AT_KEY = 'cb_explore_at';
    const EXPLORE_DEFAULT_VIEW = { lat: 30, lon: 15, zoom: 3 };
    const exploreView = (function resolveExploreView() {
        const model = (typeof window !== 'undefined' && window.WorldEntryModel) ? window.WorldEntryModel : null;
        if (!model) return EXPLORE_DEFAULT_VIEW;
        let fromQuery = null;
        let fromStore = null;
        try {
            fromQuery = model.parseAt(new URLSearchParams(window.location.search || '').get('at'));
        } catch (_) { /* no location */ }
        try { fromStore = model.parseAt(localStorage.getItem(EXPLORE_AT_KEY)); } catch (_) { /* storage blocked */ }
        const view = fromQuery || fromStore;
        if (!view) return EXPLORE_DEFAULT_VIEW;
        return { lat: view.lat, lon: view.lon, zoom: Number.isFinite(view.zoom) ? view.zoom : model.EXPLORE_ZOOM };
    })();
    // The explore entry rests at a world view in data/city-configs.js; this page's explore view (?at=,
    // else the last explored point) goes over it, exactly the fields the entry used to compute itself.
    let exploreConfig = null;
    function withExploreView(config) {
        if (config.id !== EXPLORE_CITY_ID) return config;
        if (!exploreConfig || exploreConfig.base !== config) {
            const { lat, lon, zoom } = exploreView;
            exploreConfig = { base: config, config: { ...config,
                map: { ...config.map, initialView: { ...(config.map?.initialView || {}), zoom }, defaultCenter: [lat, lon], defaultZoom: zoom },
                projection: { ...config.projection, fallbackLatLng: [lat, lon], fallbackDataset: [lon, lat] } } };
        }
        return exploreConfig.config;
    }

    function ensureProjectionDefinitions() {
        if (typeof proj4 === 'undefined') {
            return;
        }
        const projections = cityIndex ? cityIndex.tables.projection : Object.values(fullConfigs).map(config => config.projection);
        projections.forEach(dataset => {
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

    // A ?city= value (an id or short code) -> the configured city id, or null.
    function resolveCityParam(rawValue) {
        if (!rawValue) return null;
        const normalized = String(rawValue).trim().toLowerCase();
        const mappedId = CITY_QUERY_MAP[normalized] || normalized;
        return hasCity(mappedId) ? mappedId : null;
    }

    // The boot coverage (frontend/data/boot-coverage.js, loaded before this file) answers which city's
    // parcels apply at a point, exactly as the globe and the server do (world/world-coverage.js).
    function createBootJurisdiction() {
        if (typeof window === 'undefined') return null;
        if (!window.BOOT_COVERAGE || !window.WorldCoverage) {
            console.error(`[${new Date().toISOString()}] [city-config] boot coverage missing (data/boot-coverage.js, js/world/world-coverage.js): ?at= cannot choose the city`);
            return null;
        }
        const coverage = window.WorldCoverage.create(window.BOOT_COVERAGE);
        return (lat, lon) => coverage.jurisdictionAt(lat, lon);
    }
    let bootJurisdictionFn;
    function bootJurisdiction() {
        if (bootJurisdictionFn === undefined) bootJurisdictionFn = createBootJurisdiction();
        return bootJurisdictionFn;
    }

    // The city whose data applies at a point (explore where none does): what a geography request
    // for that point reads, whatever city the session booted in (location-first.md). Without the
    // boot coverage it can only say the current city.
    function cityAt(lat, lon) {
        const jurisdiction = bootJurisdiction();
        if (!jurisdiction || !Number.isFinite(lat) || !Number.isFinite(lon)) return currentCityId;
        return jurisdiction(lat, lon) || EXPLORE_CITY_ID;
    }

    // That city's config; the current city's own (with the visitor's source choices) when it is the one.
    function getCityConfigAt(lat, lon) {
        const id = cityAt(lat, lon);
        return id === currentCityId ? getCurrentCityConfig() : getCityConfig(id);
    }

    // Consumer-side source selection for a geometry, independent of the current map view.
    function getDataContext(geometry, cityId = currentCityId) {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        function walk(node) {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number') {
                if (Number.isFinite(node[0]) && Number.isFinite(node[1])) {
                    minLon = Math.min(minLon, node[0]); maxLon = Math.max(maxLon, node[0]);
                    minLat = Math.min(minLat, node[1]); maxLat = Math.max(maxLat, node[1]);
                }
            } else node.forEach(walk);
        }
        function visit(value) {
            if (value?.type === 'Feature') return visit(value.geometry);
            if (value?.type === 'GeometryCollection') return value.geometries.forEach(visit);
            walk(value?.coordinates);
        }
        visit(geometry);
        const config = Number.isFinite(minLon)
            ? getCityConfigAt((minLat + maxLat) / 2, (minLon + maxLon) / 2)
            : getCityConfig(resolveCityId(cityId) || cityId);
        const parcels = config?.parcels;
        return { city: config?.id || cityId, parcelSourceId: parcels?.sourceId || parcels?.source || null,
            buildingSourceId: config?.buildings?.sourceId || (config?.buildings?.source === 'osm' ? 'osm' : null),
            floorModelNamespace: config?.floorModels?.namespace };
    }

    function getParcelContext(geometry, cityId) {
        const { city, parcelSourceId } = getDataContext(geometry, cityId);
        return { city, parcelSourceId };
    }

    // How this boot chose its city (WorldEntryModel.resolveEntry, location-first.md "URL rules").
    function resolveBootEntry() {
        const model = typeof window !== 'undefined' ? window.WorldEntryModel : null;
        const storedCityId = getStoredCityId();
        if (!model || typeof window.location === 'undefined') {
            // No entry model (a page or test without it): ?city=, else the stored city.
            let cityParam = null;
            try { cityParam = resolveCityParam(new URLSearchParams(window.location.search || '').get('city')); } catch (_) { cityParam = null; }
            const cityId = cityParam || storedCityId;
            return { cityId, view: null, source: cityParam ? 'city' : (storedCityId ? 'stored' : 'default'), cityParam, ignoredCity: null, dropCityParam: false };
        }
        return model.resolveEntry({
            pathname: window.location.pathname,
            search: window.location.search,
            storedCityId,
            resolveCityParam,
            jurisdictionAt: bootJurisdiction()
        });
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
                if (stored && hasCity(stored) && stored !== EXPLORE_CITY_ID) {
                    return stored;
                }
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.getItem === 'function') {
                const stored = PersistentStorage.getItem(STORAGE_KEY);
                if (stored && hasCity(stored) && stored !== EXPLORE_CITY_ID) {
                    return stored;
                }
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    // Each city has its own database (see js/persistent-storage.js), so adopting the city named in
    // a link takes nothing away: the city you were in keeps its parcels, proposals and settings, and
    // they are all still there when you go back. Nothing is wiped here, and nothing needs asking.
    function determineCurrentCityId(entry) {
        const cityId = hasCity(entry.cityId) ? entry.cityId : DEFAULT_CITY_ID;
        if (entry.ignoredCity) {
            console.info(`[${new Date().toISOString()}] [city-config] city=${entry.ignoredCity} ignored: at= lies in ${cityId}`);
        }
        // Exploring is not choosing a city: the pointer keeps the last real city (or none).
        if (entry.source !== 'stored' && entry.source !== 'default' && cityId !== EXPLORE_CITY_ID && cityId !== getStoredCityId()) {
            try {
                if (typeof localStorage !== 'undefined' && localStorage) {
                    localStorage.setItem(STORAGE_KEY, cityId);
                }
            } catch (_) { /* ignore */ }
        }
        return cityId;
    }

    function getCityLabel(cityId) {
        if (cityId === EXPLORE_CITY_ID) return translateCityText('city.labels.explore', 'Explore');
        const config = configOf(cityId);
        return (config && config.label) ? config.label : (cityId || '');
    }

    // Did the user actually choose this city, or did we fall back to the default? Only a defaulted
    // city may be overridden by the one recovered from a pre-upgrade database. Read before
    // setScope, since determineCurrentCityId writes the pointer as a side effect.
    const bootEntry = resolveBootEntry();
    const cityWasExplicitlyChosen = !!bootEntry.cityId;

    let currentCityId = determineCurrentCityId(bootEntry);
    loadCurrentCityConfig();
    // Remember where exploring happened, so the explore view outlives an address without ?at=.
    if (currentCityId === EXPLORE_CITY_ID) rememberExploreView(exploreView);

    function rememberExploreView(view) {
        try {
            const model = window.WorldEntryModel;
            if (model && view) localStorage.setItem(EXPLORE_AT_KEY, model.formatAt(view));
        } catch (_) { /* storage blocked: a reload falls back to the world overview */ }
    }
    // Bind persistent storage to this city's database before anything reads from it. Nothing has
    // been read yet: PersistentStorage deliberately does not open a database until told which one.
    try {
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.setScope === 'function') {
            PersistentStorage.setScope(currentCityId);
        }
    } catch (_) { /* ignore */ }
    // The city's default language applies only once the city's stored values are read: before that a
    // language the visitor chose reads as unset, and setting the default then replaced it on every
    // boot (English chosen in Belgrade came back Serbian). It also waits for the city's full
    // configuration (cityConfigLoaded), which carries the default.
    {
        const applyStoredLanguage = () => cityConfigLoaded.then(() => applyCityLanguagePreference(getCurrentCityConfig()));
        const ready = typeof PersistentStorage !== 'undefined' && PersistentStorage ? PersistentStorage.ready : null;
        if (ready && typeof ready.then === 'function') ready.then(applyStoredLanguage, applyStoredLanguage);
        else applyStoredLanguage();
    }



    // Stores the city the next page load opens. The running page stays in its own city: it holds
    // only that city's full configuration, so a switch is always a reload (switchCity).
    function setStoredCityId(id) {
        const nextId = hasCity(id) && id !== EXPLORE_CITY_ID ? id : DEFAULT_CITY_ID;
        try {
            if (typeof localStorage !== 'undefined' && localStorage) {
                localStorage.setItem(STORAGE_KEY, nextId);
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.setItem === 'function') {
                PersistentStorage.setItem(STORAGE_KEY, nextId);
            }
        } catch (_) { /* ignore */ }
    }

    // A person's own building source (ParcelSourceSettings, kind 'building') replaces the city's
    // buildings for every /buildings/* request, which then carries it as `source`. The city's own
    // source stays on record as `defaultSource`, so "Use the city default" can name it.
    function getCityConfig(id) {
        const config = parcelConfigFor(id);
        if (!config) return null;
        const building = window.ParcelSourceSettings?.choiceForCity?.(id, window, 'building');
        if (!building) return config;
        return { ...config, buildings: { ...(config.buildings || {}), source: 'custom', sourceId: building.id,
            name: building.name, fallback: undefined, attribution: undefined, defaultSource: config.buildings?.source || 'gdi',
            defaultSourceName: config.buildings?.name } };
    }

    function getBuildingSourceId() {
        return getDataContext(null).buildingSourceId || undefined;
    }

    // Live alternatives are opt-in for this boot. A reload switches providers without changing
    // the city/plan storage scope; retained parcel facts live only in the current runtime.
    function parcelConfigFor(id) {
        const config = configOf(id);
        if (!config) return null;
        const custom = window.ParcelSourceSettings?.choiceForCity?.(id, window);
        if (custom) return { ...config, parcels: { ...config.parcels, source: 'parcel-source',
            sourceId: custom.id, idPrefix: custom.idPrefix,
            gridSize: config.parcels?.gridSize > 1 ? Math.min(100, config.parcels.gridSize) : 0.001,
            strategy: 'grid', requiresBackend: true, ownership: false,
            attribution: translateCityText('parcelSources.attribution', 'User-selected parcel source') + ' · ' + new URL(custom.endpoint).hostname } };
        const live = config.parcels?.liveSource;
        if (!live || (requestedParcelSource !== 'live' && requestedParcelSource !== live.sourceId)) return config;
        return { ...config, parcels: { ...config.parcels, source: 'parcel-source',
            sourceId: live.sourceId, idPrefix: live.idPrefix, gridSize: live.gridSize || config.parcels.gridSize, requiresBackend: true, ownership: false } };
    }

    function getCurrentCityConfig() {
        requireFullConfig(currentCityId);
        return getCityConfig(currentCityId);
    }

    function getProjectionConfig(cityId = null) {
        const config = cityId && hasCity(cityId) ? configOf(cityId) : getCurrentCityConfig();
        return config.projection || null;
    }

    function datasetToLatLng(easting, northing, cityId = null) {
        const projection = getProjectionConfig(cityId);
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
    // Metres are not a city's business. A city's *dataset* CRS is whatever its parcels arrive in (for
    // Zagreb EPSG:3765, for New York and Belgrade plain WGS84 degrees) and is used for dataset I/O
    // only. Everything measured or built in metres works in an explicit frame on its own geometry
    // (metric-frame.js, projections.md §2): a city-wide metric CRS made a 19 m street in Zagreb
    // 13.65 m wide whenever New York was the active city.
    // ---------------------------------------------------------------------
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

    // Explore has no register, but a visitor's local source supplies usable parcel geometry.
    function hasParcelData() {
        if (globalThis.ParcelGroundFallback?.activeSource?.(getCurrentCityId())) return true;
        const source = getParcelSettings().source;
        return !!source && source !== 'none';
    }

    function requiresBackendDataSource() {
        return Boolean(getParcelSettings().requiresBackend);
    }

    // The side of the road traffic keeps to (the 3D cars): a city's own `drivingSide` ('left' or
    // 'right'), else its country's, read from the region of its currency locale (en-GB: GB). These
    // countries and territories drive on the left; everywhere else drives on the right.
    const LEFT_HAND_TRAFFIC = new Set(['GB', 'IE', 'IM', 'JE', 'GG', 'MT', 'CY', 'IN', 'PK', 'BD', 'LK', 'NP',
        'BT', 'MV', 'JP', 'MY', 'SG', 'BN', 'ID', 'TH', 'TL', 'HK', 'MO', 'AU', 'NZ', 'PG', 'FJ', 'WS', 'TO',
        'SB', 'KI', 'TV', 'NR', 'ZA', 'ZM', 'ZW', 'BW', 'NA', 'LS', 'SZ', 'MZ', 'MW', 'TZ', 'KE', 'UG', 'MU',
        'SC', 'JM', 'TT', 'BS', 'BB', 'GY', 'SR', 'AG', 'DM', 'GD', 'KN', 'LC', 'VC', 'AI', 'BM', 'VG', 'KY',
        'MS', 'TC', 'FK', 'SH', 'CK', 'NU']);
    function getDrivingSide(cityId = null) {
        const config = cityId ? configOf(resolveCityId(cityId) || cityId) : getCurrentCityConfig();
        if (config?.drivingSide === 'left' || config?.drivingSide === 'right') return config.drivingSide;
        const region = String(config?.currency?.locale || '').split('-')[1] || '';
        return LEFT_HAND_TRAFFIC.has(region.toUpperCase()) ? 'left' : 'right';
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
    // 'roads' is deliberately absent: that section holds Zagreb's road DATASETS (GUP/DGU/OSM
    // detection, the government plan), which most cities lack, while drawing a road or track needs
    // no dataset and no parcels (PARCEL-OPTIONAL.md). Mapping it to `roadTools` switched road
    // drawing off in every city without those datasets, explore included. A city that really must
    // not draw roads sets `features: { roadTools: false }`.
    const SECTION_TO_FEATURE_MAP = {
        'parcelBlocks': 'parcelBlocks',  // Can be extended for other features
        'buildings': 'buildings'          // Can be extended for other features
    };
    // Every feature a city has unless its config switches it off.
    const DEFAULT_ENABLED_FEATURES = ['parcelBlocks', 'buildings', 'roadTools'];

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
        DEFAULT_ENABLED_FEATURES.forEach(featureName => {
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
        // Config names that differ from the markup's data-section. parcelBlocks is not a section:
        // it hides the cadastral half of the Parcel blocks section (data-feature="parcelBlocks",
        // applyFeatureVisibility), while blocks from OSM roads stay available in every city.
        const sectionToDataSection = {};

        // Disable sections that are in the disabled list. A section can appear in more than one
        // sheet (Blocks and Roads have their layer toggles in Layers and their actions in Tools),
        // so every wrapper with that data-section is hidden.
        disabledSections.forEach(sectionName => {
            const checkboxId = sectionToCheckboxId[sectionName];
            if (checkboxId) {
                const checkbox = document.getElementById(checkboxId);
                if (checkbox) {
                    checkbox.disabled = true;
                    checkbox.checked = false;
                }
            }
            const dataSection = sectionToDataSection[sectionName] || sectionName;
            document.querySelectorAll(`[data-section="${dataSection}"]`).forEach(section => {
                section.style.display = 'none';
            });
        });

        applyBuildingLayerChoices();
        // Apply feature visibility after sidebar configuration
        applyFeatureVisibility();
    }

    // Every city has buildings now (OpenStreetMap at the least), so the Layers Buildings section is
    // always on; which surveys it lists depends on the city's source. GDI and DGU are Zagreb's; the
    // separate OSM reference only adds something where OSM is not already the working set.
    function applyBuildingLayerChoices() {
        const source = getCurrentCityConfig()?.buildings?.source || 'gdi';
        const row = id => document.getElementById(id)?.closest('label');
        const show = (id, visible) => {
            const label = row(id);
            if (!label) return;
            label.hidden = !visible;
            // The palette shares the source gate, even while its parent sheet is closed.
            if (visible) label.removeAttribute('data-feature-hidden');
            else label.setAttribute('data-feature-hidden', 'true');
        };
        show('showBuildings', source !== 'none');
        show('showBuildingsDgu', source === 'gdi');
        show('showBuildingsOsm', source !== 'osm');
        const text = row('showBuildings')?.querySelector('[data-i18n-key]');
        if (!text) return;
        const key = source === 'osm' ? 'sidebar.buildings.showOsm'
            : source === 'cadastre' ? 'sidebar.buildings.showCadastre'
            : source === 'nyc' ? 'sidebar.buildings.showLayer'
            : source === 'custom' ? 'sidebar.buildings.showCustom'
            : 'sidebar.buildings.showGdi';
        text.setAttribute('data-i18n-key', key);
        text.textContent = translateCityText(key, text.textContent);
    }

    // Reload into another city. The path is kept by default, so a shared link (/proposals/<id>,
    // /parcel/<id>) re-runs there; `clearRoute` drops it, for a plain "go to this city" (the search
    // box) that should not carry the link being viewed into the next city.
    // `url`: where to go instead of the current address (a route into the next city, such as a
    // proposal to open there). The page being left keeps its own history entry, so Back returns to
    // it; rewriting that entry first made Back land on the new route in the old city instead.
    function navigateToCity(nextId, options = {}) {
        try {
            const url = new URL(options.url || window.location.href, window.location.href);
            url.searchParams.set('city', nextId);
            // `at` opens at a given view, and then decides the city (WorldEntryModel.resolveEntry) unless
            // a record route stays in the address;
            // `world` (force the globe) must not follow the visitor into the city they just picked.
            url.searchParams.delete('at');
            url.searchParams.delete('world');
            if (options.at && window.WorldEntryModel) url.searchParams.set('at', window.WorldEntryModel.formatAt(options.at));
            if (options.clearRoute) {
                // Every route the boot acts on: left in, a proposal focused before the switch reopened
                // in the next city, and a monitor asked to switch back.
                if (/^\/(proposals|designs|agreements|plans|parcel|bets|monitors)(?:\/|$)/.test(url.pathname)) url.pathname = '/';
                ['parcel', 'bets', 'focusProposal', 'arrive', 'activity', 'scene', 'draft',
                    'planningSelection', 'camera', 'rotate']
                    .forEach(param => url.searchParams.delete(param));
            }
            // The page is leaving this city: work for it (the applied plan's replay) stops now
            // instead of holding the thread, and writing, until the next page replaces this one.
            try { window.dispatchEvent(new CustomEvent('cityLeaving', { detail: { cityId: nextId } })); } catch (_) { /* best-effort notice */ }
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
            confirmationOptions = null,
            clearRoute = false,
            at = null,
            url = null
        } = options;

        if (!nextId || !hasCity(nextId) || nextId === currentCityId) {
            return false;
        }

        // A road drawn or reshaped right now reaches the draft store only when it is finished; a
        // switch (the search box asks nothing) used to drop it. Kept as a draft of this city instead,
        // to resume on return.
        try {
            if (window.roadDrawingMode === true && typeof window.saveCurrentCorridorDrawingDraft === 'function') {
                const kept = window.saveCurrentCorridorDrawingDraft();
                if (kept) console.info(`[${new Date().toISOString()}] [city-switch] kept the unfinished drawing as draft ${kept.draftId || kept.id} of ${currentCityId}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [city-switch] could not keep the unfinished drawing`, error);
        }
        try { window.proposalDraftStore?.flush?.(); } catch (_) { }

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
                    updateStatus(translateCityText('city.switch.cancelled', 'City change cancelled'));
                }
                return false;
            }
        }

        return navigateToCity(nextId, { clearRoute, at, url });
    }

    // The styled prompts are the dialog helper's (js/ui/dialogs.js): one chrome for every confirm,
    // choice and alert in the app. The names stay for their many callers.
    function showStyledConfirm(message, options = {}) {
        return window.CbDialog.confirm(message, options);
    }

    window.showStyledConfirm = showStyledConfirm;

    // Multi-button variant: choices = [{value, label, primary}]. Resolves with the clicked
    // choice's value, or null on backdrop click / Escape.
    function showStyledChoice(message, choices = []) {
        return window.CbDialog.choice(message, choices);
    }

    window.showStyledChoice = showStyledChoice;

    function showStyledAlert(message, options = {}) {
        return window.CbDialog.alert(message, options);
    }

    window.showStyledAlert = showStyledAlert;

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

    // Nearest configured city to a point. `options.filter` narrows the candidates — used to answer
    // "which of the cities that serve THIS dataset is this parcel in?", where letting every city
    // compete would be wrong: eastern Croatia is closer to Belgrade than to Zagreb, but a Croatian
    // cadastre parcel can never belong to a city whose parcels come from the Serbian source.
    function findNearestCity(lat, lon, options = {}) {
        const filter = typeof options.filter === 'function' ? options.filter : null;
        let best = null;
        let bestDistance = Infinity;
        cityIds().forEach(id => {
            const config = configOf(id);
            if (config.explore) return;
            if (filter && !filter(config)) return;
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

    // A city id as links, records and the server spell it ('zagreb', the short code 'zg', any case),
    // or null when it names no configured city (an old placeholder such as 'city', a typo).
    function resolveCityId(raw) {
        const value = String(raw ?? '').trim().toLowerCase();
        if (!value) return null;
        const id = CITY_QUERY_MAP[value] || value;
        return hasCity(id) ? id : null;
    }

    // The city a proposal must be opened in when it is not this one: its own city, when that reads
    // other parcel data than the current city (projections.md §10 M8). null = it belongs here — the
    // same city, a city on the same cadastre (a Split record in Zagreb: one countrywide cadastre), or
    // a record whose city names no configured city (legacy rows; nothing to route to). Storage
    // refuses to import a record anywhere else (proposals/data.js importProposal), and the link and
    // list routes send it home.
    function foreignCityFor(rawCity) {
        const cityId = resolveCityId(rawCity);
        if (!cityId || cityId === currentCityId) return null;
        const key = getCadastreKey(cityId);
        return key && key === getCadastreKey(currentCityId) ? null : cityId;
    }

    // A record label cannot choose its ground source. Only designs with bound cadastral
    // dependencies can require switching source context; locate that source by authored geometry.
    // Accepts the current published index row or its local authored record.
    function foreignGroundContextFor(record) {
        const bound = record?.binding?.parcels || record?.cadastreParcelIds || [];
        if (!bound.length) return null;
        const body = record.content || record;
        const geometry = body.site || window.__planOrder?.footprintOf?.(body)?.geometry;
        // Import can retain a definition before cadastral facts/geometry are available. Its ids
        // still determine eligibility during reconstruction; there is no label-based destination.
        if (!geometry) return null;
        const context = getParcelContext(geometry);
        return context.parcelSourceId && context.parcelSourceId !== 'none'
            && context.parcelSourceId !== getCadastreKey(currentCityId) ? context.city : null;
    }

    // Which cadastre a city's parcels come from, for "is that the same parcel data?" (the search
    // box's in-place moves, the globe's countrywide picks): the source id when the city reads a
    // catalogue or custom source, else its own provider ('oss-wfs': Croatia's countrywide cadastre).
    // Every catalogue city's source is 'parcel-source', so comparing that would make San Francisco
    // and Oakland one cadastre. null = no cadastre (explore).
    function getCadastreKey(cityId) {
        const parcels = getCityConfig(cityId)?.parcels;
        if (!parcels || !parcels.source || parcels.source === 'none') return null;
        return parcels.sourceId || parcels.source;
    }

    // Which location data a city reads — its cadastre and its building footprints — for "can the map
    // move there without reloading?" (the search box's in-place moves). Croatia's cities share one
    // cadastre but not buildings: Zagreb's are its own survey (GDI, Zagreb only), Split's and
    // Šibenik's OpenStreetMap; a move from Zagreb to Split in place loaded no buildings there, so a road
    // had nothing to demolish. null = no cadastre.
    function getPlaceDataKey(cityId) {
        const cadastre = getCadastreKey(cityId);
        if (!cadastre) return null;
        const buildings = getCityConfig(cityId)?.buildings;
        return `${cadastre}|${(buildings && (buildings.sourceId || buildings.source)) || 'gdi'}`;
    }

    // The cities whose parcels come from a given backend source ('oss-wfs' is the Croatian DGU
    // cadastre, shared by Zagreb, Split and Šibenik). Adding a fourth Croatian city automatically
    // joins this set — nothing else needs updating for deep links to resolve to it.
    function getCitiesByParcelSource(source) {
        return cityIds().map(configOf).filter(config => config.parcels?.source === source);
    }

    // "Use my location": ask, read the browser's position, and open the nearest configured city.
    // The search box's "Use my location" item and the settings.detectCity command call this.
    async function detectNearestCity() {
        const confirmFn = window.showStyledConfirm || showStyledConfirm;
        const confirmMessage = translateCityText('city.detect.confirm', 'Allow Consensus Builder to use your approximate location to pick the closest city?');
        const proceed = await confirmFn(confirmMessage);
        if (!proceed) {
            return false;
        }
        if (!navigator.geolocation) {
            showCityAlert('geolocation_is_not_supported_by_this_browser', 'Geolocation is not supported by this browser.');
            return false;
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
                // Through the address, as every switch: the boot obeys ?city=, so writing only the
                // pointer (into the database of the city being left) and reloading reopened that city.
                switchCity(nearest.id, { clearRoute: true });
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
        return true;
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

    // The Walk/Drive launchers open an external tram-sim deployment whose URL is baked into each
    // city's `walk.url` (production: zagreb.lol/prijevoz/). When consensus-builder itself is served
    // from localhost, that hard-coded prod URL is wrong for local testing — you want a locally-served
    // copy of the sim (which then auto-targets localhost:3000 for proposals, see the isochrone repo's
    // world/proposals.js). So on a local origin we rewrite the sim base to a local one. Override the
    // base with `window.__CB_SIM_URL__` or localStorage `cb_sim_url` to serve the sim on any host/port;
    // the default assumes `python3 -m http.server 8090` in zagreb-isochrone-main/website, whose
    // transit.html is the sim entry point. Non-local origins keep the city's configured prod URL.
    function isLocalOrigin() {
        const h = (typeof window !== 'undefined' && window.location && window.location.hostname || '').toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h.endsWith('.local');
    }
    function localSimUrl() {
        try {
            const override = (typeof window !== 'undefined'
                && (window.__CB_SIM_URL__ || (localStorage && localStorage.getItem('cb_sim_url')))) || '';
            if (override) return String(override);
        } catch (_e) { /* localStorage can throw in locked-down contexts */ }
        const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'localhost';
        return `http://${host}:8090/transit.html`;
    }
    // Returns the walk/drive config with its `url` swapped for the local sim when on a local origin.
    // Preserves `locParam` and any other fields; leaves null/urlless configs untouched.
    function withLocalSimUrl(config) {
        if (!config || !config.url || !isLocalOrigin()) return config;
        return { ...config, url: localSimUrl() };
    }

    window.CityConfigManager = {
        getCurrentCityId: () => currentCityId,
        // Whether the visitor has actually CHOSEN a city, as opposed to sitting on the default.
        // A deep link needs the difference: following the link's city over an untouched default is
        // doing what the reader asked, while overriding a city they picked themselves is not.
        hasStoredCityId: () => !!getStoredCityId(),
        setStoredCityId,
        switchCity,
        navigateToCity,
        getCityLabel,
        getCurrentCityConfig,
        getAvailableCities: () => cityIds().map(getCityConfig).filter(config => !config.explore),
        EXPLORE_CITY_ID,
        isExplore: () => currentCityId === EXPLORE_CITY_ID,
        // Whether this boot had a city chosen (?at=, ?city=, a record link's city or a stored
        // pointer) rather than the default:
        // the world view opens on a first visit only (js/ui/world-entry.js).
        wasCityChosenAtBoot: () => cityWasExplicitlyChosen,
        // How the boot chose the city (WorldEntryModel.resolveEntry): js/map-core.js drops ?city=
        // from the address when the entry says so.
        getBootEntry: () => Object.assign({}, bootEntry),
        cityAt,
        resolveCityParam,
        getCityConfigAt,
        getDataContext,
        getParcelContext,
        // Keep a city the visitor picked on the globe without a reload (the default city it booted on).
        // Writes only the pointer: the city is unchanged, so no cityChanged event.
        rememberCurrentCity: () => {
            if (currentCityId === EXPLORE_CITY_ID) return;
            try { localStorage.setItem(STORAGE_KEY, currentCityId); } catch (_) { /* storage blocked */ }
        },
        rememberExploreView,
        markCityConfigLoaded,
        getCityConfig,
        hasParcelData,
        getCityCodeForCityId,
        findNearestCity,
        getCityCenter,
        detectNearestCity,
        getCitiesByParcelSource,
        getCadastreKey,
        getPlaceDataKey,
        resolveCityId,
        foreignCityFor,
        foreignGroundContextFor,
        datasetToLatLng,
        latLngToDataset,
        formatCurrency,
        getParcelStrategy,
        getParcelGridSize,
        getLatLngPadding,
        getParcelZoomRange,
        requiresBackendDataSource,
        getCurrencyConfig,
        getDrivingSide,
        getMapConfig: () => getCurrentCityConfig().map || {},
        getSidebarConfig,
        getParcelBuilderConfig,
        getWalkConfig: () => withLocalSimUrl(getCurrentCityConfig().walk || null),
        getCuratedRoadsConfig: () => getCurrentCityConfig().curatedRoads || null,
        getTransitAlignmentConfig: () => getCurrentCityConfig().transitAlignments || null,
        // Sim launcher for the "Drive this track" button. Unlike the walk button (gated per
        // city because it depends on city street data), driving a drawn track works at any
        // location — the track, rails and corridor come from the proposal itself — so every
        // city falls back to the shared sim deployment. Cities may still override via `walk`.
        getDriveConfig: () => withLocalSimUrl(getCurrentCityConfig().walk || { url: 'https://zagreb.lol/prijevoz/' }),
        applySidebarConfiguration,
        getFeatureConfig,
        isFeatureEnabled,
        getBuildingSourceId,
        applyFeatureVisibility
    };
})();
