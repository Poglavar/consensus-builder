(function () {
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

    // The explore city (`?city=explore&at=lat,lon,zoom`): any place without parcel data, opened from
    // the world view. Its centre is the ?at= point, else the last explored point (kept in localStorage
    // so a reload stays put), else a world overview. Never a stored city, never a shared-link target.
    const EXPLORE_CITY_ID = 'explore';
    const EXPLORE_AT_KEY = 'cb_explore_at';
    const EXPLORE_DEFAULT_VIEW = { lat: 30, lon: 15, zoom: 3 };
    const exploreView = (function resolveExploreView() {
        const model = (typeof window !== 'undefined' && window.WorldEntryModel) ? window.WorldEntryModel : null;
        if (!model) return EXPLORE_DEFAULT_VIEW;
        let fromQuery = null;
        let fromStore = null;
        try {
            const params = new URLSearchParams(window.location.search || '');
            if ((params.get('city') || '').trim().toLowerCase() === EXPLORE_CITY_ID) fromQuery = model.parseAt(params.get('at'));
        } catch (_) { /* no location */ }
        try { fromStore = model.parseAt(localStorage.getItem(EXPLORE_AT_KEY)); } catch (_) { /* storage blocked */ }
        const view = fromQuery || fromStore;
        if (!view) return EXPLORE_DEFAULT_VIEW;
        return { lat: view.lat, lon: view.lon, zoom: Number.isFinite(view.zoom) ? view.zoom : model.EXPLORE_ZOOM.city };
    })();
    const exploreProjection = (typeof window !== 'undefined' && window.WorldEntryModel)
        ? window.WorldEntryModel.utmProjectionFor(exploreView.lat, exploreView.lon)
        : { crs: 'EPSG:3857', definition: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs' };

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
                liveSource: { sourceId: 'hr-dgu-oss-dkp-cestice', idPrefix: 'HR-', gridSize: 100 },
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
            },
            // Server-curated road classification (road_parcel_classification MV via the app
            // backend). Cities with this key get existing roads marked from the endpoint —
            // auto-fetched after parcels load — instead of client-side OSM/GUP/WFS detection.
            curatedRoads: {
                url: '/road-parcels'
            },
            // Immutable OSM-derived alignments shared by station snapping and 3D rendering.
            // Editable proposal corridors remain a separate game-data source.
            transitAlignments: {
                sources: [{
                    id: 'zagreb-heavy-rail',
                    url: 'data/zagreb_rail_tracks.geojson',
                    mode: 'heavy-rail',
                    stationTypes: ['elevated'],
                    elevationM: 7.5,
                    render3d: 'elevated'
                }, {
                    id: 'zagreb-tram',
                    url: 'data/zagreb_tram_tracks_osm.geojson',
                    mode: 'tram',
                    stationTypes: ['tram'],
                    elevationM: 0,
                    render3d: 'surface'
                }]
            }
        },
        split: {
            id: 'split',
            label: 'Split, Croatia',
            currency: { locale: 'hr-HR', code: 'EUR' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                defaultCenter: [43.5081, 16.4402],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.1
            },
            // Same national HTRS96 grid and DGU WFS as Zagreb — the dataset
            // covers all of Croatia, so parcels work here unchanged.
            projection: {
                datasetCrs: 'EPSG:3765',
                definition: '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.5081, 16.4402],
                fallbackDataset: [495165, 4818688],
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
                liveSource: { sourceId: 'hr-dgu-oss-dkp-cestice', idPrefix: 'HR-', gridSize: 100 },
                requiresBackend: true
            },
            buildings: {
                // Overture-Maps footprints + heights (shared overture_building_footprint table,
                // extruded server-side like Belgrade). 3D buildings load automatically in 3D mode.
                source: 'overture'
            },
            sidebar: {
                // Zagreb-only datasets (city blocks, GUP roads, area monitor) stay off until
                // ingested for Split; its Buildings section lists the Overture footprints.
                disabledSections: ['parcelBlocks', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            },
            // locParam rides onto the walk/drive URLs as ?loc=split so the 3D
            // sim picks Split's world sources (Overture buildings, sea layer).
            walk: {
                url: 'https://zagreb.lol/prijevoz/',
                locParam: 'split'
            }
        },
        sibenik: {
            id: 'sibenik',
            label: 'Šibenik, Croatia',
            currency: { locale: 'hr-HR', code: 'EUR' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: SHARED_DEFAULT_ZOOM
                },
                // Šibenik old town, by the cathedral. The city as configured is the coastal
                // corridor out to Vodice (~15 km NW): the 11 cadastral municipalities whose
                // ownership is loaded are Šibenik, Crnica, Mandalina, Gorica, Donje Polje,
                // Bilice, Martinska, Zaton-Raslina, Srima, Vodice and Tribunj.
                defaultCenter: [43.7350, 15.8896],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.1
            },
            // Same national HTRS96 grid and DGU parcel source as Zagreb and Split — one
            // countrywide dataset, so nothing about parcels is city-specific here.
            projection: {
                datasetCrs: 'EPSG:3765',
                definition: '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.7350, 15.8896],
                fallbackDataset: [450830, 4844075],
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
                liveSource: { sourceId: 'hr-dgu-oss-dkp-cestice', idPrefix: 'HR-', gridSize: 100 },
                requiresBackend: true
            },
            buildings: {
                // Overture-Maps footprints + heights, extruded server-side. Reads the shared
                // overture_building_footprint rows already ingested for the whole
                // Zadar–Šibenik–Knin area (see backend/buildings/overture-cities.js).
                source: 'overture'
            },
            sidebar: {
                // Zagreb-only datasets (city blocks, GUP roads, area monitor) stay off until
                // ingested for Šibenik; its Buildings section lists the Overture footprints.
                disabledSections: ['parcelBlocks', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            },
            // The transit sim's prepared location for this coast is the whole Zadar–Šibenik–Knin
            // area, so locParam is the region id, not the city id.
            walk: {
                url: 'https://zagreb.lol/prijevoz/',
                locParam: 'sjeverna-dalmacija'
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
                // Overture-Maps footprints + heights, ingested into the shared
                // overture_building_footprint table and extruded server-side
                // (backend/buildings/overture-3d.js). Resolved by city id, not this string.
                // Like NYC, the 3D buildings load automatically in 3D mode.
                source: 'overture'
            },
            sidebar: {
                // Belgrade's 3D buildings load automatically in 3D mode (Built/Both/Planned); the
                // Buildings section lists its Overture footprints (applyBuildingLayerChoices).
                disabledSections: ['parcelBlocks', 'roads', 'areaMonitor']
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
                liveSource: { sourceId: 'si-gurs-kn-parcele-wfs', idPrefix: 'SI-' },
                requiresBackend: true
            },
            buildings: {
                source: 'osm'
            },
            sidebar: {
                disabledSections: ['roads', 'areaMonitor']
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
                liveSource: { sourceId: 'ar-caba-idecaba-wfs-parcelas', idPrefix: 'AR-CABA-WFS-NAM-' },
                requiresBackend: true
            },
            buildings: {
                source: 'osm'
            },
            sidebar: {
                // Disable Parcel blocks, Buildings, and Roads for Buenos Aires
                // When 'roads' is disabled, the 'roadTools' feature is automatically disabled
                disabledSections: ['parcelBlocks', 'roads', 'areaMonitor']
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
                liveSource: { sourceId: 'us-co-oit-public-parcels-denver', idPrefix: 'US-CO-' },
                requiresBackend: true
            },
            buildings: {
                source: 'osm'
            },
            sidebar: {
                disabledSections: ['parcelBlocks', 'roads', 'areaMonitor']
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
                liveSource: { sourceId: 'us-nyc-dof-digital-tax-map', idPrefix: 'US-NYC-BBL-' },
                requiresBackend: true
            },
            buildings: {
                // Live NYC Open Data footprints + roof heights, extruded server-side
                // (backend/buildings/nyc-footprints.js). Resolved by city id, not this string.
                source: 'nyc'
            },
            sidebar: {
                // NYC's 3D buildings load automatically in 3D mode; its provider has no 2D footprints,
                // so the Buildings section offers only the OSM reference (applyBuildingLayerChoices).
                disabledSections: ['parcelBlocks', 'roads', 'areaMonitor']
            },
            parcelBuilder: {
                url: 'https://urbangametheory.xyz/codechecker/'
            }
        },
        bogota: {
            id: 'bogota',
            label: 'Bogotá, Colombia',
            currency: { locale: 'es-CO', code: 'COP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [4.60975, -74.08175],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [4.60975, -74.08175],
                fallbackDataset: [-74.08175, 4.60975]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'co-bogota-uaecd-lote',
                dataVersion: '2021-12',
                idPrefix: 'CO-BOGOTA-',
                requiresBackend: true,
                ownership: false,
                // A conservative entry area within Bogotá D.C.; Soacha uses separate data.
                liveRadiusKm: 12,
                attribution: '<a href="https://sig.car.gov.co/arcgis/rest/services/VISOR/Capas_base/FeatureServer/9">IDECA/UAECD lots · Dec 2021 · CAR mirror</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        shenzhen: {
            id: 'shenzhen',
            label: 'Shenzhen, China',
            currency: { locale: 'zh-CN', code: 'CNY' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [22.5405, 114.1005], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.01 },
            projection: { datasetCrs: 'EPSG:4326', metricCrs: 'EPSG:4547',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricDefinition: '+proj=tmerc +lat_0=0 +lon_0=114 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
                fallbackLatLng: [22.5405, 114.1005], fallbackDataset: [114.1005, 22.5405] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'cn-shenzhen-land-certain', idPrefix: 'CN-SZ-LANDCERTAIN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 1,
                attribution: 'Shenzhen Municipal Planning and Natural Resources Bureau · public cadastral-map service' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['areaMonitor'] },
            parcelBuilder: null
        },
        tbilisi: {
            id: 'tbilisi',
            label: translateCityText('city.labels.tbilisi', 'Tbilisi, Georgia'),
            currency: { locale: 'en-US', code: 'GEL' },
            map: { initialView: { type: 'center', zoom: 19 },
                defaultCenter: [41.7088867, 44.8067283], defaultZoom: 19,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', metricCrs: 'EPSG:32638',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricDefinition: '+proj=utm +zone=38 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.7088867, 44.8067283], fallbackDataset: [44.8067283, 41.7088867] },
            parcels: {
                strategy: 'point', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'ge-msda-napr-registered-land-plots', idPrefix: 'GE-NAPR-',
                parcelNumberField: 'cadCode', requiresBackend: true, ownership: false,
                liveRadiusKm: 0.1,
                raster: { url: 'https://nv.napr.gov.ge/geoserver/wms', layers: 'NG_REG_LAYER', version: '1.3.0',
                    params: { LR_ID: 261415 }, attribution: '<a href="https://ms.gov.ge/msmap/">NAPR · MSDA</a>' },
                attribution: '<a href="https://ms.gov.ge/msmap/">NAPR · MSDA</a> · Parcel lookup on click'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: null
        },
        istanbul: {
            id: 'istanbul',
            label: translateCityText('city.labels.istanbul', 'Istanbul, Turkey'),
            currency: { locale: 'tr-TR', code: 'TRY' },
            map: { initialView: { type: 'center', zoom: 19 },
                defaultCenter: [41.0139, 28.9497], defaultZoom: 19,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', metricCrs: 'EPSG:32635',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricDefinition: '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.0139, 28.9497], fallbackDataset: [28.9497, 41.0139] },
            parcels: { strategy: 'point', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'tr-tkgm-parselsorgu-api', idPrefix: 'TR-TKGM-',
                parcelNumberField: 'parselNo', requiresBackend: true, ownership: false, liveRadiusKm: 0.1,
                attribution: 'TKGM · parcel lookup on click' },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: null
        },
        toronto: {
            id: 'toronto',
            label: 'Toronto, Canada',
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.6535, -79.3825],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.6535, -79.3825],
                fallbackDataset: [-79.3825, 43.6535]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.005,
                source: 'parcel-source',
                sourceId: 'ca-on-toronto-property-boundary',
                idPrefix: 'CA-ON-TORONTO-',
                requiresBackend: true,
                ownership: false,
                // Conservative globe entry area; adjacent municipalities need their own adapters.
                liveRadiusKm: 15,
                attribution: '<a href="https://open.toronto.ca/dataset/property-boundaries/">City of Toronto Property Boundary</a> · <a href="https://open.toronto.ca/open-data-license/">Open Government Licence – Toronto</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        montreal: {
            id: 'montreal',
            label: translateCityText('city.labels.montreal', 'Montreal, Canada'),
            currency: { locale: 'fr-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.50375, -73.569],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [45.50375, -73.569], fallbackDataset: [-73.569, 45.50375]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre rénové</a> · indicative geometry only; no legal value'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        los_angeles: {
            id: 'los_angeles',
            label: translateCityText('city.labels.los_angeles', 'Los Angeles, USA'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [34.0522, -118.2437],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [34.0522, -118.2437],
                fallbackDataset: [-118.2437, 34.0522]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'us-ca-lacounty-assessor-parcels',
                idPrefix: 'US-CA-LA-',
                requiresBackend: true,
                ownership: false,
                // Conservative county entry area; adjacent counties need their own providers.
                liveRadiusKm: 15,
                attribution: '<a href="https://egis-lacounty.hub.arcgis.com/documents/4d67b154ae614d219c58535659128e71/about">County of Los Angeles · Assessor parcels · accessed Oct 2, 2026</a> · <a href="https://egis-lacounty.hub.arcgis.com/pages/terms-of-use">Terms of use</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        miami: {
            id: 'miami',
            label: translateCityText('city.labels.miami', 'Miami, USA'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [25.7749, -80.1936],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [25.7749, -80.1936],
                fallbackDataset: [-80.1936, 25.7749]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'us-fl-miamidade-pa-parcels',
                idPrefix: 'US-FL-MIAMI-DADE-',
                requiresBackend: true,
                ownership: false,
                // Conservative county entry area; adjacent counties need their own providers.
                liveRadiusKm: 12,
                attribution: '<a href="https://gis-mdc.opendata.arcgis.com/datasets/MDC::parcel/about">Miami-Dade County GIS · Property Appraiser parcels · data terms</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        washington_dc: {
            id: 'washington_dc',
            label: translateCityText('city.labels.washington_dc', 'Washington, D.C., USA'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.91025, -77.0425],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.91025, -77.0425],
                fallbackDataset: [-77.0425, 38.91025]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'us-dc-dcgis-tax-lots',
                idPrefix: 'US-DC-',
                requiresBackend: true,
                ownership: false,
                // Central D.C. entry area; Maryland and Virginia use different parcel sources.
                liveRadiusKm: 2,
                attribution: '<a href="https://opendata.dc.gov/datasets/DCGIS::tax-lots">District of Columbia · DCGIS tax lots</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        paris: {
            id: 'paris',
            label: translateCityText('city.labels.paris', 'Paris, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.8491, 2.3556],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [48.8491, 2.3556],
                fallbackDataset: [2.3556, 48.8491]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express',
                idPrefix: 'FR-PCI-',
                requiresBackend: true,
                ownership: false,
                // Conservative globe entry area; source scope is recorded in the backend catalogue.
                liveRadiusKm: 15,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP · Parcellaire Express · data &amp; updates</a> · <a href="https://www.data.gouv.fr/pages/legal/licences/etalab-2.0">Licence Ouverte 2.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        melbourne: {
            id: 'melbourne',
            label: translateCityText('city.labels.melbourne', 'Melbourne, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-37.8136, 144.9631],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32755',
                metricDefinition: '+proj=utm +zone=55 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-37.8136, 144.9631],
                fallbackDataset: [144.9631, -37.8136]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'au-vic-vicmap-parcel',
                idPrefix: 'AU-VIC-PARCEL-',
                requiresBackend: true,
                ownership: false,
                // Conservative globe entry area; source scope is recorded in the backend catalogue.
                liveRadiusKm: 20,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=b62e9a7b32fc49f090c2644b2a7ed871">State of Victoria · DTP · Vicmap Parcel</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cape_town: {
            id: 'cape_town',
            label: translateCityText('city.labels.cape_town', 'Cape Town, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-33.9258, 18.4194],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32734',
                metricDefinition: '+proj=utm +zone=34 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-33.9258, 18.4194],
                fallbackDataset: [18.4194, -33.9258]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'za-cct-land-parcels',
                idPrefix: 'ZA-CCT-',
                requiresBackend: true,
                ownership: false,
                // Conservative globe entry area; source scope is recorded in the backend catalogue.
                liveRadiusKm: 12,
                attribution: '<a href="https://odp-cctegis.opendata.arcgis.com/datasets/cctegis::land-parcels/about">City of Cape Town · Land Parcels · data terms</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        // National OGC API collection, exposed through the same canonical parcel gateway.
        amsterdam: {
            id: 'amsterdam',
            label: translateCityText('city.labels.amsterdam', 'Amsterdam, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.3725, 4.9000],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [52.3725, 4.9000],
                fallbackDataset: [4.9000, 52.3725]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'nl-pdok-brk-kadastrale-kaart',
                idPrefix: 'NL-BRK-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 12,
                attribution: '<a href="https://www.pdok.nl/ogc-apis/-/article/kadastrale-kaart">Kadaster / PDOK · Kadastrale Kaart</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        // Regional Flemish administrative parcel map, with permanent object IDs and version metadata.
        antwerp: {
            id: 'antwerp',
            label: translateCityText('city.labels.antwerp', 'Antwerp, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.2110, 4.4010],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.2110, 4.4010],
                fallbackDataset: [4.4010, 51.2110]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'be-vlaanderen-grb-adp',
                idPrefix: 'BE-GRB-ADP-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://www.vlaanderen.be/datavindplaats/catalogus/ogc-api-features-grb">Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen</a> · <a href="https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik">reuse terms</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        essen: {
            id: 'essen',
            label: translateCityText('city.labels.essen', 'Essen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.4556, 7.0123],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.4556, 7.0123],
                fallbackDataset: [7.0123, 51.4556]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'de-nrw-lika-flurstueck',
                idPrefix: 'DE-NRW-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://ogc-api.nrw.de/lika/v1/collections/flurstueck?f=json">Geobasis NRW · ALKIS</a> · <a href="https://www.govdata.de/dl-de/zero-2-0">DL-DE Zero 2.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        san_francisco: {
            id: 'san_francisco',
            label: translateCityText('city.labels.san_francisco', 'San Francisco, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [37.79125, -122.4065],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32610',
                metricDefinition: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [37.79125, -122.4065],
                fallbackDataset: [-122.4065, 37.79125]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'us-ca-sf-datasf-active-parcels',
                idPrefix: 'US-CA-SF-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://data.sf.gov/d/acdm-wktn">City and County of San Francisco · DataSF</a> · <a href="https://opendatacommons.org/licenses/pddl/1-0/">PDDL 1.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        berlin: {
            id: 'berlin',
            label: translateCityText('city.labels.berlin', 'Berlin, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.52, 13.405],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32633',
                metricDefinition: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [52.52, 13.405],
                fallbackDataset: [13.405, 52.52]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'de-be-alkis-flurstuecke-wfs',
                idPrefix: 'DE-BE-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://daten.berlin.de/datensaetze/alkis-berlin-flurstucke-wfs-1bc014d7">Land Berlin · ALKIS</a> · <a href="https://www.govdata.de/dl-de/zero-2-0">DL-DE Zero 2.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        // Private-lot WFS 1.1 uses paced, small bbox reads and the required provider logo.
        hong_kong: {
            id: 'hong_kong',
            label: translateCityText('city.labels.hong_kong', 'Hong Kong, Hong Kong SAR'),
            currency: { locale: 'en-HK', code: 'HKD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [22.315, 114.1838],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 19, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32650',
                metricDefinition: '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [22.315, 114.1838],
                fallbackDataset: [114.1838, 22.315]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'hk-landsd-lot-index-api',
                idPrefix: 'HK-LANDSD-LOT-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 6,
                attribution: '<a href="https://www.landsd.gov.hk/en/index.html"><img src="/assets/parcel-sources/landsd-logo.svg" alt="Lands Department" style="height:24px;width:auto;vertical-align:middle"></a> · Map from Lands Department · © Government of the Hong Kong SAR / <a href="https://portal.csdi.gov.hk/csdi-webpage/doc/TNC">CSDI</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lyon: {
            id: 'lyon',
            label: translateCityText('city.labels.lyon', 'Lyon, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.764, 4.8357],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [45.764, 4.8357],
                fallbackDataset: [4.8357, 45.764]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express',
                idPrefix: 'FR-PCI-',
                requiresBackend: true,
                ownership: false,
                // Conservative globe entry area; source scope is recorded in the backend catalogue.
                liveRadiusKm: 8,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP · Parcellaire Express · data &amp; updates</a> · <a href="https://www.data.gouv.fr/pages/legal/licences/etalab-2.0">Licence Ouverte 2.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rotterdam: {
            id: 'rotterdam',
            label: translateCityText('city.labels.rotterdam', 'Rotterdam, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.9225, 4.4792],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.9225, 4.4792],
                fallbackDataset: [4.4792, 51.9225]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'nl-pdok-brk-kadastrale-kaart',
                idPrefix: 'NL-BRK-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://www.pdok.nl/ogc-apis/-/article/kadastrale-kaart">Kadaster / PDOK · Kadastrale Kaart</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cologne: {
            id: 'cologne',
            label: translateCityText('city.labels.cologne', 'Cologne, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.9375, 6.9603],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [50.9375, 6.9603],
                fallbackDataset: [6.9603, 50.9375]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'de-nrw-lika-flurstueck',
                idPrefix: 'DE-NRW-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://ogc-api.nrw.de/lika/v1/collections/flurstueck?f=json">Geobasis NRW · ALKIS</a> · <a href="https://www.govdata.de/dl-de/zero-2-0">DL-DE Zero 2.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dortmund: {
            id: 'dortmund',
            label: translateCityText('city.labels.dortmund', 'Dortmund, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.51494, 7.466],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.51494, 7.466],
                fallbackDataset: [7.466, 51.51494]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'de-nrw-lika-flurstueck',
                idPrefix: 'DE-NRW-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 8,
                attribution: '<a href="https://ogc-api.nrw.de/lika/v1/collections/flurstueck?f=json">Geobasis NRW · ALKIS</a> · <a href="https://www.govdata.de/dl-de/zero-2-0">DL-DE Zero 2.0</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cotonou: {
            id: 'cotonou',
            label: translateCityText('city.labels.cotonou', 'Cotonou, Benin'),
            currency: { locale: 'fr-BJ', code: 'XOF' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [6.38646680667236, 2.3895186609943],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [6.38646680667236, 2.3895186609943],
                fallbackDataset: [2.3895186609943, 6.38646680667236]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'bj-andf-efoncier-geoserver',
                idPrefix: 'BJ-ANDF-',
                requiresBackend: true,
                ownership: false,
                // Bounded Cotonou entry; national service coverage is not established here.
                liveRadiusKm: 8,
                attribution: '<a href="https://cadastre.andf.bj/">ANDF e-Foncier cadastral parcels</a> · <a href="https://andf.bj/cadastre/">publisher conditions</a> · verified Cotonou samples · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bamako: {
            id: 'bamako',
            label: translateCityText('city.labels.bamako', 'Bamako, Mali'),
            currency: { locale: 'fr-ML', code: 'XOF' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [12.6765, -8.04225],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32629',
                metricDefinition: '+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [12.6765, -8.04225],
                fallbackDataset: [-8.04225, 12.6765]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'ml-sprdf-ninacad-parcelle-wfs',
                idPrefix: 'ML-NINACAD-',
                requiresBackend: true,
                ownership: false,
                // Conservative globe entry area; adjacent municipalities need their own adapters.
                liveRadiusKm: 5,
                attribution: '<a href="https://ninacad.sprdf.ml/">SPRDF / NINACAD · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tokyo: {
            id: 'tokyo',
            label: translateCityText('city.labels.tokyo', 'Tokyo, Japan'),
            currency: { locale: 'ja-JP', code: 'JPY' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.696623934, 139.766899192], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32654',
                metricDefinition: '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.696623934, 139.766899192], fallbackDataset: [139.766899192, 35.696623934]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'jp-moj-geospatial-2026', idPrefix: 'JP-MOJ-2026-',
                dataVersion: '2026', requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://www.geospatial.jp/ckan/dataset/aigid-moj-13101">MOJ / Geospatial Information Center · 2026</a> · Tokyo Chiyoda ward public-coordinate sheets only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        nagoya: {
            id: 'nagoya',
            label: translateCityText('city.labels.nagoya', 'Nagoya, Japan'),
            currency: { locale: 'ja-JP', code: 'JPY' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.163716454, 136.984010139], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32653',
                metricDefinition: '+proj=utm +zone=53 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.163716454, 136.984010139], fallbackDataset: [136.984010139, 35.163716454]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'jp-moj-geospatial-2026', idPrefix: 'JP-MOJ-2026-',
                dataVersion: '2026', requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://www.geospatial.jp/ckan/dataset/aigid-moj-23101">MOJ / Geospatial Information Center · 2026</a> · Nagoya Chikusa ward public-coordinate sheets only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        osaka: {
            id: 'osaka',
            label: translateCityText('city.labels.osaka', 'Osaka, Japan'),
            currency: { locale: 'ja-JP', code: 'JPY' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [34.677750586, 135.532507321], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32653',
                metricDefinition: '+proj=utm +zone=53 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [34.677750586, 135.532507321], fallbackDataset: [135.532507321, 34.677750586]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'jp-moj-geospatial-2026', idPrefix: 'JP-MOJ-2026-',
                dataVersion: '2026', requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://www.geospatial.jp/ckan/dataset/aigid-moj-27128">MOJ / Geospatial Information Center · 2026</a> · Osaka Chuo ward public-coordinate sheets only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        birmingham: {
            id: 'birmingham',
            label: translateCityText('city.labels.birmingham', 'Birmingham, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.4975, -1.978], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [52.4975, -1.978], fallbackDataset: [-1.978, 52.4975]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gb-arcgis-geodom-land-registry-inspire-2021', idPrefix: 'GB-HMLR-',
                dataVersion: '2021-10-22', requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://services2.arcgis.com/5K9ykSNwoxdIgeYH/arcgis/rest/services/Land_Registry_Inspire_20211022/FeatureServer/0">HM Land Registry title-index polygons · Geodom mirror · Oct 22, 2021</a> · partial extract · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sao_paulo: {
            id: 'sao_paulo',
            label: translateCityText('city.labels.sao_paulo', 'São Paulo, Brazil'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-23.55052, -46.6333], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32723',
                metricDefinition: '+proj=utm +zone=23 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-23.55052, -46.6333], fallbackDataset: [-46.6333, -23.55052]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'br-sp-geosampa-lote-cidadao', idPrefix: 'BR-SP-GEOSAMPA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://geosampa.prefeitura.sp.gov.br/">GeoSampa / Prefeitura do Município de São Paulo</a> · <a href="https://download.geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx">data and source conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sydney: {
            id: 'sydney',
            label: translateCityText('city.labels.sydney', 'Sydney, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-33.8585, 151.0795],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32756',
                metricDefinition: '+proj=utm +zone=56 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-33.8585, 151.0795], fallbackDataset: [151.0795, -33.8585]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'au-nsw-six-cadastre-lot', idPrefix: 'AU-NSW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9">NSW Spatial Services / Department of Customer Service</a> · <a href="https://www.spatial.nsw.gov.au/products_and_services/web_services/terms_and_conditions">publisher conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lima: {
            id: 'lima',
            label: translateCityText('city.labels.lima', 'Lima, Peru'),
            currency: { locale: 'es-PE', code: 'PEN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-12.015, -76.968],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32718',
                metricDefinition: '+proj=utm +zone=18 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-12.015, -76.968], fallbackDataset: [-76.968, -12.015]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'pe-sedapal-publicaciones-lotes', idPrefix: 'PE-SEDAPAL-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://gisprdsdp.sedapal.com.pe/arcgis/rest/services/Publicaciones/Proyectos_Sedapal/MapServer/21">SEDAPAL Lima lots</a> · adapted · source conditions apply'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        luanda: {
            id: 'luanda',
            label: translateCityText('city.labels.luanda', 'Luanda, Angola'),
            currency: { locale: 'pt-AO', code: 'AOA' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-8.83675, 13.234],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32733',
                metricDefinition: '+proj=utm +zone=33 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-8.83675, 13.234], fallbackDataset: [13.234, -8.83675]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'ao-arcgis-luanda-agt-property-polygons', idPrefix: 'AO-LUANDA-AGT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://services-eu1.arcgis.com/7r9gTPdSG9MPi1LZ/arcgis/rest/services/Luanda_AGT_Oficial_2_gdb/FeatureServer/0">GGPEN Luanda property polygons</a> · adapted · source conditions apply'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lusaka: {
            id: 'lusaka',
            label: translateCityText('city.labels.lusaka', 'Lusaka, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-15.40478133, 28.38004999],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-15.40478133, 28.38004999], fallbackDataset: [28.38004999, -15.40478133]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'zm-lusaka-mtendere-east-agol-unofficial', idPrefix: 'ZM-LUSAKA-GID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 12,
                attribution: '<a href="https://services8.arcgis.com/baO0mx1RSvBYn91a/arcgis/rest/services/Lusaka_parcels_creation/FeatureServer/0">Parcels_Mtendere_East — Lusaka_parcels_creation (ArcGIS Online)</a> · unofficial 28-polygon Mtendere East sample · publisher and source terms unverified'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        london: {
            id: 'london',
            label: translateCityText('city.labels.london', 'London, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.515, -0.09], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.515, -0.09], fallbackDataset: [-0.09, 51.515]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gb-hmlr-city-of-london', idPrefix: 'GB-HMLR-LONDON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 1.5,
                attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire/download">HM Land Registry INSPIRE Index Polygons</a> · City of London authority only · transformed from British National Grid; approximately 5 m Helmert transformation accuracy · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        manchester: {
            id: 'manchester',
            label: translateCityText('city.labels.manchester', 'Manchester, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [53.4808, -2.2426], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [53.4808, -2.2426], fallbackDataset: [-2.2426, 53.4808]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gb-hmlr-manchester', idPrefix: 'GB-HMLR-MANCHESTER-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire/download">HM Land Registry INSPIRE Index Polygons</a> · Manchester metropolitan borough only · transformed from British National Grid; approximately 5 m Helmert transformation accuracy · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        madrid: {
            id: 'madrid',
            label: translateCityText('city.labels.madrid', 'Madrid, Spain'),
            currency: { locale: 'es-ES', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.4168, -3.7038], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:25830',
                metricDefinition: '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.4168, -3.7038], fallbackDataset: [-3.7038, 40.4168]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'es-dgc-inspire-cp-wfs', idPrefix: 'ES-DGC-',
                requiresBackend: true, ownership: false, liveRadiusKm: 25,
                attribution: '<a href="https://www.catastro.hacienda.gob.es/webinspire/">Dirección General del Catastro · INSPIRE Cadastral Parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        barcelona: {
            id: 'barcelona',
            label: translateCityText('city.labels.barcelona', 'Barcelona, Spain'),
            currency: { locale: 'es-ES', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.387, 2.168], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:25831',
                metricDefinition: '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.387, 2.168], fallbackDataset: [2.168, 41.387]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'es-dgc-inspire-cp-wfs', idPrefix: 'ES-DGC-',
                requiresBackend: true, ownership: false, liveRadiusKm: 25,
                attribution: '<a href="https://www.catastro.hacienda.gob.es/webinspire/">Dirección General del Catastro · INSPIRE Cadastral Parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        savar: {
            id: 'savar',
            label: translateCityText('city.labels.savar', 'Savar, Bangladesh'),
            currency: { locale: 'en-BD', code: 'BDT' },
            map: {
                initialView: { type: 'center', zoom: 19 },
                defaultCenter: [23.9673, 90.2252], defaultZoom: 19,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32646',
                metricDefinition: '+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [23.9673, 90.2252], fallbackDataset: [90.2252, 23.9673]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'bd-dlrs-dhamsona-bds-sheet-001', idPrefix: 'BD-DLRS-201901-4105-010510026-001-',
                requiresBackend: true, ownership: false, liveRadiusKm: 0.35,
                attribution: '<a href="https://settlement.gov.bd/">Bangladesh Directorate of Land Records and Surveys</a> · Dhamsona BDS Sheet 001 draft survey only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        montgomery: {
            id: 'montgomery',
            label: translateCityText('city.labels.montgomery', 'Montgomery, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [32.3668, -86.3], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [32.3668, -86.3], fallbackDataset: [-86.3, 32.3668]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-al-montgomery-city-parcels', idPrefix: 'US-AL-MONTGOMERY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 5,
                attribution: '<a href="https://gis.montgomeryal.gov/server/rest/services/Parcels/FeatureServer/0">City of Montgomery GIS · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        juneau: {
            id: 'juneau',
            label: translateCityText('city.labels.juneau', 'Juneau, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [58.3016, -134.4202], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32608',
                metricDefinition: '+proj=utm +zone=8 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [58.3016, -134.4202], fallbackDataset: [-134.4202, 58.3016]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ak-cbj-parcels', idPrefix: 'US-AK-CBJ-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://juneau.org/finance/assessor-office">City and Borough of Juneau GIS · publisher &amp; conditions</a> · identified parcels; unassigned records excluded · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        phoenix: {
            id: 'phoenix',
            label: translateCityText('city.labels.phoenix', 'Phoenix, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.4484, -112.074], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32612',
                metricDefinition: '+proj=utm +zone=12 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [33.4484, -112.074], fallbackDataset: [-112.074, 33.4484]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-az-maricopa-assessor-parcels', idPrefix: 'US-AZ-MARICOPA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 10,
                attribution: '<a href="https://mcassessor.maricopa.gov/">Maricopa County Assessor&apos;s Office · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        little_rock: {
            id: 'little_rock',
            label: translateCityText('city.labels.little_rock', 'Little Rock, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [34.7465, -92.2896], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [34.7465, -92.2896], fallbackDataset: [-92.2896, 34.7465]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ar-ago-parcels-pulaski', idPrefix: 'US-AR-PULASKI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://gis.arkansas.gov/">Arkansas GIS Office · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sacramento: {
            id: 'sacramento',
            label: translateCityText('city.labels.sacramento', 'Sacramento, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.5816, -121.4944], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32610',
                metricDefinition: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.5816, -121.4944], fallbackDataset: [-121.4944, 38.5816]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ca-sacramento-active-parcels', idPrefix: 'US-CA-SACRAMENTO-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://data.saccounty.gov/">Sacramento County GIS · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hartford: {
            id: 'hartford',
            label: translateCityText('city.labels.hartford', 'Hartford, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.7658, -72.6734], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.7658, -72.6734], fallbackDataset: [-72.6734, 41.7658]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ct-hartford-parcels', idPrefix: 'US-CT-HARTFORD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer_2025/FeatureServer/0">Connecticut GIS Office · publisher &amp; conditions</a> · identified assessment parcel groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dover: {
            id: 'dover',
            label: translateCityText('city.labels.dover', 'Dover, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.1582, -75.5244], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.1582, -75.5244], fallbackDataset: [-75.5244, 39.1582]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-de-kent-dover-parcels', idPrefix: 'US-DE-KENT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://enterprise.firstmap.delaware.gov/arcgis/rest/services/PlanningCadastre/DE_StateParcels/FeatureServer/0">State of Delaware FirstMap (Delaware Geospatial Data Exchange) · publisher &amp; conditions</a> · Kent County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        atlanta: {
            id: 'atlanta',
            label: translateCityText('city.labels.atlanta', 'Atlanta, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.749, -84.388], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [33.749, -84.388], fallbackDataset: [-84.388, 33.749]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ga-fulton-atlanta-parcels', idPrefix: 'US-GA-FULTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/PropertyMapViewer/PropertyMapViewer/MapServer/11">Fulton County GIS · publisher &amp; conditions</a> · Fulton County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        honolulu: {
            id: 'honolulu',
            label: translateCityText('city.labels.honolulu', 'Honolulu, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [21.3099, -157.8581], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32604',
                metricDefinition: '+proj=utm +zone=4 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [21.3099, -157.8581], fallbackDataset: [-157.8581, 21.3099]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-hi-honolulu-parcels', idPrefix: 'US-HI-HONOLULU-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://geodata.hawaii.gov/arcgis/rest/services/ParcelsZoning/MapServer/25">Hawaii Statewide GIS Program · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        boise: {
            id: 'boise',
            label: translateCityText('city.labels.boise', 'Boise, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.615, -116.2023], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.615, -116.2023], fallbackDataset: [-116.2023, 43.615]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-id-ada-boise-parcels', idPrefix: 'US-ID-ADA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Public_Idaho_Parcels_/FeatureServer/7">Idaho Geospatial Office / The Idaho Map; parcel submissions stewarded by Ada County · publisher &amp; conditions</a> · Ada County assessment parcel groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        springfield: {
            id: 'springfield',
            label: translateCityText('city.labels.springfield', 'Springfield, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.7817, -89.6501], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.7817, -89.6501], fallbackDataset: [-89.6501, 39.7817]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-il-springfield-parcels', idPrefix: 'US-IL-SPRINGFIELD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://maps.springfield.il.us/server/rest/services/PW_Zoning/parcelZonesView/MapServer/2">City of Springfield GIS · publisher &amp; conditions</a> · city assessment parcel groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        baton_rouge: {
            id: 'baton_rouge',
            label: translateCityText('city.labels.baton_rouge', 'Baton Rouge, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [30.4515, -91.1871], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [30.4515, -91.1871], fallbackDataset: [-91.1871, 30.4515]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-la-ebr-baton-rouge-parcels', idPrefix: 'US-LA-EBR-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://catalog.data.gov/dataset/tax-parcel">EBRGIS; East Baton Rouge Parish Assessor&#x27;s Office; Department of Information Services · publisher &amp; conditions</a> · tax-account parcel groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        augusta: {
            id: 'augusta',
            label: translateCityText('city.labels.augusta', 'Augusta, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.3106, -69.7795], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32619',
                metricDefinition: '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.3106, -69.7795], fallbackDataset: [-69.7795, 44.3106]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-me-augusta-parcels', idPrefix: 'US-ME-AUGUSTA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://mainegeolibrary-maine.hub.arcgis.com/maps/maine::maine-parcels-organized-towns-feature/about">Maine GeoLibrary with voluntarily submitted municipality-maintained parcel data · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        annapolis: {
            id: 'annapolis',
            label: translateCityText('city.labels.annapolis', 'Annapolis, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.9784, -76.4922], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.9784, -76.4922], fallbackDataset: [-76.4922, 38.9784]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-md-annapolis-parcels', idPrefix: 'US-MD-ANNAPOLIS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://annapolis.gov/2324/GIS-and-Maps">City of Annapolis GIS · publisher &amp; conditions</a> · city development layer · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        boston: {
            id: 'boston',
            label: translateCityText('city.labels.boston', 'Boston, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [42.3601, -71.0589], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32619',
                metricDefinition: '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [42.3601, -71.0589], fallbackDataset: [-71.0589, 42.3601]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ma-boston-current-parcels', idPrefix: 'US-MA-BOSTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://gis.boston.gov/arcgis/rest/services/Parcels/Parcels_current/FeatureServer/0?f=pjson">City of Boston GIS / Assessing · publisher &amp; conditions</a> · fee parcel polygons only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        indianapolis: {
            id: 'indianapolis',
            label: translateCityText('city.labels.indianapolis', 'Indianapolis, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.7684, -86.1581], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.7684, -86.1581], fallbackDataset: [-86.1581, 39.7684]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-in-marion-indianapolis-parcels', idPrefix: 'US-IN-MARION-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://www.in.gov/gis/geoinsights/posts/data-harvest/">Indiana Geographic Information Office (IGIO), State of Indiana / IndianaMap · publisher &amp; conditions</a> · Marion County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        des_moines: {
            id: 'des_moines',
            label: translateCityText('city.labels.des_moines', 'Des Moines, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.5868, -93.625], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.5868, -93.625], fallbackDataset: [-93.625, 41.5868]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ia-des-moines-parcels', idPrefix: 'US-IA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://services3.arcgis.com/kd9gaiUExYqUbnoq/arcgis/rest/services/Iowa_Parcels_2017/FeatureServer/0">Iowa Department of Homeland Security &amp; Emergency Management; University of Iowa public mirror · publisher &amp; conditions</a> · 2017 snapshot · assessment parcel groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lansing: {
            id: 'lansing',
            label: translateCityText('city.labels.lansing', 'Lansing, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [42.7325, -84.5555], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [42.7325, -84.5555], fallbackDataset: [-84.5555, 42.7325]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-mi-lansing-parcels', idPrefix: 'US-MI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://services3.arcgis.com/ySzhFSJfYeginRjx/ArcGIS/rest/services/Ingham_County_Parcels_2025/FeatureServer/1">Ingham County Equalization parcel data; public publisher Ingham County Drain Office · publisher &amp; conditions</a> · Ingham County · 2025 data · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        saint_paul: {
            id: 'saint_paul',
            label: translateCityText('city.labels.saint_paul', 'Saint Paul, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.9537, -93.09], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.9537, -93.09], fallbackDataset: [-93.09, 44.9537]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-mn-ramsey-saint-paul-parcels', idPrefix: 'US-MN-RAMSEY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://www.stpaul.gov/departments/planning-and-economic-development/maps-and-data">Ramsey County GIS · publisher &amp; conditions</a> · Ramsey County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        jefferson_city: {
            id: 'jefferson_city',
            label: translateCityText('city.labels.jefferson_city', 'Jefferson City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.5767, -92.1735], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.5767, -92.1735], fallbackDataset: [-92.1735, 38.5767]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-mo-jefferson_city-parcels', idPrefix: 'US-MO-JEFFERSON_CITY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://www.colecounty.org/424/GISMapping">Cole County GIS / Jefferson City (JCMO_ADMIN) · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        helena: {
            id: 'helena',
            label: translateCityText('city.labels.helena', 'Helena, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.5891, -112.0391], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32612',
                metricDefinition: '+proj=utm +zone=12 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [46.5891, -112.0391], fallbackDataset: [-112.0391, 46.5891]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-mt-helena-parcels', idPrefix: 'US-MT-HELENA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://www.msl.mt.gov/geoinfo/msdi/cadastral/">Montana Department of Revenue and county GIS offices; integrated by Montana State Library · publisher &amp; conditions</a> · Identified parcels; rows without a native ID omitted · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lincoln: {
            id: 'lincoln',
            label: translateCityText('city.labels.lincoln', 'Lincoln, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.8136, -96.7026], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.8136, -96.7026], fallbackDataset: [-96.7026, 40.8136]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ne-lincoln-parcels', idPrefix: 'US-NE-LINCOLN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=1da5644990874ff2857daffa043b3617">City of Lincoln / Lancaster County (CountyCityPub) · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        concord: {
            id: 'concord',
            label: translateCityText('city.labels.concord', 'Concord, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.2081, -71.5376], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32619',
                metricDefinition: '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.2081, -71.5376], fallbackDataset: [-71.5376, 43.2081]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nh-concord-parcels', idPrefix: 'US-NH-CONCORD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.granit.unh.edu/">New Hampshire GRANIT / NH Department of Environmental Services · publisher &amp; conditions</a> · Identified parcels; ambiguous native key omitted · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        trenton: {
            id: 'trenton',
            label: translateCityText('city.labels.trenton', 'Trenton, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.2171, -74.7429], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.2171, -74.7429], fallbackDataset: [-74.7429, 40.2171]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nj-trenton-parcels', idPrefix: 'US-NJ-TRENTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://nj.gov/njgin/edata/parcels/">New Jersey Office of Information Technology, Office of GIS (NJOGIS) · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        santa_fe: {
            id: 'santa_fe',
            label: translateCityText('city.labels.santa_fe', 'Santa Fe, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.687, -105.9378], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32613',
                metricDefinition: '+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.687, -105.9378], fallbackDataset: [-105.9378, 35.687]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nm-santa-fe-parcels', idPrefix: 'US-NM-SANTA-FE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.santafecountynm.gov/growth-management/gis">Santa Fe County GIS Division · publisher &amp; conditions</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        albany: {
            id: 'albany',
            label: translateCityText('city.labels.albany', 'Albany, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [42.6526, -73.7562], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [42.6526, -73.7562], fallbackDataset: [-73.7562, 42.6526]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ny-albany-parcels', idPrefix: 'US-NY-ALBANY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://gis.ny.gov/parcel-polygon-metadata">New York State Office of Information Technology Services, Geospatial Services; contributing counties · publisher &amp; conditions</a> · Albany County · 2024 data, published May 2026 · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        raleigh: {
            id: 'raleigh',
            label: translateCityText('city.labels.raleigh', 'Raleigh, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.7796, -78.6382], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.7796, -78.6382], fallbackDataset: [-78.6382, 35.7796]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nc-wake-raleigh-parcels', idPrefix: 'US-NC-WAKE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.nconemap.gov/pages/parcels">North Carolina Geographic Information Coordinating Council / NC OneMap, county data contributors · publisher &amp; conditions</a> · Wake County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        new_hope: {
            id: 'new_hope',
            label: translateCityText('city.labels.new_hope', 'New Hope, North Carolina, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.8609596134079, -78.6416325645578], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.8609596134079, -78.6416325645578],
                fallbackDataset: [-78.6416325645578, 35.8609596134079]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nc-wake-raleigh-parcels', idPrefix: 'US-NC-WAKE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.nconemap.gov/pages/parcels">North Carolina Geographic Information Coordinating Council / NC OneMap, county data contributors · publisher &amp; conditions</a> · Wake County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        venjaramoodu: {
            id: 'venjaramoodu',
            label: translateCityText('city.labels.venjaramoodu', 'Venjaramoodu, India'),
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [8.65276906631116, 76.9124484846266], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [8.65276906631116, 76.9124484846266],
                fallbackDataset: [76.9124484846266, 8.65276906631116]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.005, source: 'parcel-source',
                sourceId: 'kerala-entebhoomi-ilms-map-proxy', idPrefix: 'IN-KL-ENTEBHOOMI-010309-',
                requiresBackend: true, ownership: false, liveRadiusKm: 1.5,
                attribution: '<a href="https://entebhoomi.kerala.gov.in/web/ilms/map">Kerala Survey and Land Records Department / NIC Kerala · Ente Bhoomi</a> · Manikkal village coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kochi: {
            id: 'kochi',
            label: translateCityText('city.labels.kochi', 'Kochi — Thiruvankulam, India'),
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [9.963406805925196, 76.36082896288808], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [9.963406805925196, 76.36082896288808],
                fallbackDataset: [76.36082896288808, 9.963406805925196]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'in-kl-entebhoomi-070211', idPrefix: 'IN-KL-ENTEBHOOMI-070211-',
                requiresBackend: true, ownership: false, liveRadiusKm: 1.5,
                attribution: '<a href="https://entebhoomi.kerala.gov.in/web/ilms/map">Kerala Survey and Land Records Department / NIC Kerala · Ente Bhoomi</a> · Thiruvankulam village coverage only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        iravipuram: {
            id: 'iravipuram',
            label: translateCityText('city.labels.iravipuram', 'Iravipuram (Kollam), India'),
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [8.847550832774829, 76.62751009273858], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [8.847550832774829, 76.62751009273858],
                fallbackDataset: [76.62751009273858, 8.847550832774829]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'in-kl-entebhoomi-020301', idPrefix: 'IN-KL-ENTEBHOOMI-020301-',
                requiresBackend: true, ownership: false, liveRadiusKm: 1.5,
                attribution: '<a href="https://entebhoomi.kerala.gov.in/web/ilms/map">Kerala Survey and Land Records Department / NIC Kerala · Ente Bhoomi</a> · Iravipuram village coverage only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ahmedabad: {
            id: 'ahmedabad',
            label: translateCityText('city.labels.ahmedabad', 'Ahmedabad, India'),
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                initialView: { type: 'center', zoom: 18 },
                defaultCenter: [23.02004, 72.59975], defaultZoom: 18,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [23.02004, 72.59975],
                fallbackDataset: [72.59975, 23.02004]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.005, source: 'parcel-source',
                sourceId: 'in-gj-tpvd-final-plots', idPrefix: 'IN-GJ-TPVD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://tpvd.openprp.in/ctpvd/index.html">Gujarat TPVD final planning plots · publisher &amp; conditions</a> · Ahmedabad Municipal Corporation (AMC) Final town-planning plots only · partial coverage; not ownership or current-title evidence · registration/currentness unverified'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        surat: {
            id: 'surat',
            label: translateCityText('city.labels.surat', 'Surat, India'),
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                initialView: { type: 'center', zoom: 18 },
                defaultCenter: [21.174179236185818, 72.78092615417103], defaultZoom: 18,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [21.174179236185818, 72.78092615417103],
                fallbackDataset: [72.78092615417103, 21.174179236185818]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.005, source: 'parcel-source',
                sourceId: 'in-gj-tpvd-surat-final-plots', idPrefix: 'IN-GJ-SURAT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://tpvd.openprp.in/ctpvd/index.html">Gujarat TPVD final planning plots · publisher &amp; conditions</a> · Surat Municipal Corporation Final plots only · partial coverage; not ownership or current-title evidence · registration/currentness unverified'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bismarck: {
            id: 'bismarck',
            label: translateCityText('city.labels.bismarck', 'Bismarck, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.8083, -100.7837], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [46.8083, -100.7837], fallbackDataset: [-100.7837, 46.8083]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nd-burleigh-bismarck-parcels', idPrefix: 'US-ND-BURLEIGH-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.gis.nd.gov/parcel-program">North Dakota Information Technology / ND GIS Hub · publisher &amp; conditions</a> · Burleigh County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        columbus: {
            id: 'columbus',
            label: translateCityText('city.labels.columbus', 'Columbus, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.9612, -82.9988], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.9612, -82.9988], fallbackDataset: [-82.9988, 39.9612]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-oh-franklin-columbus-parcels', idPrefix: 'US-OH-FRANKLIN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://auditor.franklincountyohio.gov/Auditor/Geographic-Information-Systems-GIS">Franklin County Auditor, GIS · publisher &amp; conditions</a> · Franklin County coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        salem: {
            id: 'salem',
            label: translateCityText('city.labels.salem', 'Salem, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.9429, -123.0351], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32610',
                metricDefinition: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.9429, -123.0351], fallbackDataset: [-123.0351, 44.9429]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-or-marion-salem-parcels', idPrefix: 'US-OR-MARION-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.co.marion.or.us/AO">Marion County Assessor and GIS · publisher &amp; conditions</a> · Marion County coverage; West Salem excluded · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        nashville: {
            id: 'nashville',
            label: translateCityText('city.labels.nashville', 'Nashville, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.1627, -86.7816], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [36.1627, -86.7816], fallbackDataset: [-86.7816, 36.1627]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-tn-nashville-parcels', idPrefix: 'US-TN-NASHVILLE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.nashville.gov/departments/planning/mapping-and-gis">Metro Nashville GIS · publisher &amp; conditions</a> · Davidson County; Bounded capital-area acceptance does not establish full county coverage or currency. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        austin: {
            id: 'austin',
            label: translateCityText('city.labels.austin', 'Austin, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [30.2672, -97.7431], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [30.2672, -97.7431], fallbackDataset: [-97.7431, 30.2672]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-tx-austin-parcels', idPrefix: 'US-TX-TRAVIS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://maps.austintexas.gov/arcgis/rest/services/Shared/AppraisalDistricts/MapServer/0">City of Austin / Travis Central Appraisal District · publisher &amp; conditions</a> · City of Austin official TCAD parcel layer; Travis County capital-area scope. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        salt_lake_city: {
            id: 'salt_lake_city',
            label: translateCityText('city.labels.salt_lake_city', 'Salt Lake City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.7608, -111.891], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32612',
                metricDefinition: '+proj=utm +zone=12 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.7608, -111.891], fallbackDataset: [-111.891, 40.7608]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ut-salt-lake-city-parcels', idPrefix: 'US-UT-SALTLAKE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://gis.utah.gov/products/sgid/cadastre/parcels/">Utah Geospatial Resource Center and local government · publisher &amp; conditions</a> · Official source; bounded capital-area checks do not establish full jurisdictional coverage. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        montpelier: {
            id: 'montpelier',
            label: translateCityText('city.labels.montpelier', 'Montpelier, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.2601, -72.5754], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.2601, -72.5754], fallbackDataset: [-72.5754, 44.2601]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-vt-montpelier-parcels', idPrefix: 'US-VT-MONTPELIER-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.montpelier-vt.org/528/Maps-GIS">Vermont Center for Geographic Information / local municipalities · publisher &amp; conditions</a> · 2025 assessment accounts · may include multiple lots; unidentified shapes excluded · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        richmond: {
            id: 'richmond',
            label: translateCityText('city.labels.richmond', 'Richmond, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [37.5407, -77.436], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [37.5407, -77.436], fallbackDataset: [-77.436, 37.5407]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management · publisher &amp; conditions</a> · Official source; bounded capital-area checks do not establish full jurisdictional coverage. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        carson_city: {
            id: 'carson_city',
            label: translateCityText('city.labels.carson_city', 'Carson City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.1638, -119.7674], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.1638, -119.7674], fallbackDataset: [-119.7674, 39.1638]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-nv-carson_city-parcels', idPrefix: 'US-NV-CARSON_CITY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 4,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=7816480981d44f8fbc30a326144d32e1">Nevada Division of Water Resources / State Demographer · publisher &amp; conditions</a> · State compilation · source date January 2026 · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        charleston: {
            id: 'charleston',
            label: translateCityText('city.labels.charleston', 'Charleston, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.3498, -81.6326], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.3498, -81.6326], fallbackDataset: [-81.6326, 38.3498]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-wv-charleston-parcels', idPrefix: 'US-WV-CHARLESTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/0">West Virginia GIS Technical Center / county assessors · publisher &amp; conditions</a> · Tax Year 2023 · assessment mapping · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cheyenne: {
            id: 'cheyenne',
            label: translateCityText('city.labels.cheyenne', 'Cheyenne, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.14, -104.8202], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32613',
                metricDefinition: '+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.14, -104.8202], fallbackDataset: [-104.8202, 41.14]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-wy-cheyenne-parcels', idPrefix: 'US-WY-CHEYENNE-LARAMIE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://maps.laramiecounty.com/arcgis/rest/services/features/CountyBaseMapFeatures/FeatureServer/2">Laramie County · publisher &amp; conditions</a> · Laramie County assessment parcels · unidentified shapes excluded · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        columbia: {
            id: 'columbia',
            label: translateCityText('city.labels.columbia', 'Columbia, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [34.0007, -81.0348], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [34.0007, -81.0348], fallbackDataset: [-81.0348, 34.0007]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-sc-columbia-parcels', idPrefix: 'US-SC-COLUMBIA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://enterprise.woolpert.com/server/rest/services/Hosted/City_of_Columbia_Parcel/FeatureServer/info/iteminfo">Woolpert / Richland and Lexington County tax-parcel data · publisher &amp; conditions</a> · Partial source: 456 polygons · update year not established · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        harrisburg: {
            id: 'harrisburg',
            label: translateCityText('city.labels.harrisburg', 'Harrisburg, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.2732, -76.8867], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.2732, -76.8867], fallbackDataset: [-76.8867, 40.2732]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-pa-harrisburg-parcels', idPrefix: 'US-PA-HARRISBURG-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://services5.arcgis.com/9n3LUAMi3B692MBL/ArcGIS/rest/services/Property_Tax_Parcels_September_2026/FeatureServer/0">City of Harrisburg GIS / Dauphin County Tax Assessment · publisher &amp; conditions</a> · September 2026 · complete native PID parcel groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        jackson: {
            id: 'jackson',
            label: translateCityText('city.labels.jackson', 'Jackson, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [32.2988, -90.1848], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [32.2988, -90.1848], fallbackDataset: [-90.1848, 32.2988]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ms-jackson-parcels', idPrefix: 'US-MS-JACKSON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://opcgis.deq.state.ms.us/opcgis/rest/services/Government/HINDS_PARCELS/MapServer">Mississippi Department of Environmental Quality / Hinds County Tax Assessor / Tristate Consulting · publisher &amp; conditions</a> · MDEQ Hinds County compilation · update year not established · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        madison: {
            id: 'madison',
            label: translateCityText('city.labels.madison', 'Madison, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.0731, -89.4012], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.0731, -89.4012], fallbackDataset: [-89.4012, 43.0731]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-wi-madison-parcels', idPrefix: 'US-WI-MADISON-DANE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0">Wisconsin State Cartographer’s Office / Dane County · publisher &amp; conditions</a> · V12 2026 compilation · Dane County · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        olympia: {
            id: 'olympia',
            label: translateCityText('city.labels.olympia', 'Olympia, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.0379, -122.9007], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32610',
                metricDefinition: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [47.0379, -122.9007], fallbackDataset: [-122.9007, 47.0379]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-wa-olympia-parcels', idPrefix: 'US-WA-OLYMPIA-THURSTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://tconline.co.thurston.wa.us/server/rest/services/Common_Layers/Parcels/FeatureServer/4">Thurston County · publisher &amp; conditions</a> · Active assessor-property footprints · may include multiple lots · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        providence: {
            id: 'providence',
            label: translateCityText('city.labels.providence', 'Providence, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.824, -71.4128], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32619',
                metricDefinition: '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [41.824, -71.4128], fallbackDataset: [-71.4128, 41.824]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ri-providence-parcels', idPrefix: 'US-RI-PROVIDENCE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=bab934a85fe94f1d885dcaa6b3f16229">City of Providence GIS · publisher &amp; conditions</a> · 2011–2018 canopy-study mirror · identified CAMA-link groups · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tallahassee: {
            id: 'tallahassee',
            label: translateCityText('city.labels.tallahassee', 'Tallahassee, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [30.4383, -84.2807], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [30.4383, -84.2807], fallbackDataset: [-84.2807, 30.4383]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-fl-tallahassee-parcels', idPrefix: 'US-FL-TALLAHASSEE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=0647430cc90e435093e9d064cb22481f">Tallahassee-Leon County Planning Department / TLCGIS · publisher &amp; conditions</a> · November 2025 parcel-based mirror · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        topeka: {
            id: 'topeka',
            label: translateCityText('city.labels.topeka', 'Topeka, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.0473, -95.6752], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.0473, -95.6752], fallbackDataset: [-95.6752, 39.0473]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ks-topeka-parcels', idPrefix: 'US-KS-TOPEKA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://snco.gov/ap/mapping.php">Shawnee County Appraiser GIS and Mapping Division · publisher &amp; conditions</a> · Shawnee County assessment parcels · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        doha: {
            id: 'doha',
            label: translateCityText('city.labels.doha', 'Doha, Qatar'),
            currency: { locale: 'ar-QA', code: 'QAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [25.2854, 51.531], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32639',
                metricDefinition: '+proj=utm +zone=39 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [25.2854, 51.531], fallbackDataset: [51.531, 25.2854]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'qa-cgis-approved-cadastre', idPrefix: 'qa-cgis:',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://geoportal.gisqatar.org.qa/printpin/">Centre for GIS, Qatar · publisher &amp; conditions</a> · Current approved plots only; 73 ended records excluded. Doha viewports verified; broader national viewport coverage not asserted. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        astana: {
            id: 'astana',
            label: translateCityText('city.labels.astana', 'Astana, Kazakhstan'),
            currency: { locale: 'ru-KZ', code: 'KZT' },
            map: {
                initialView: { type: 'center', zoom: 18 },
                defaultCenter: [51.1282, 71.4304], defaultZoom: 18,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32642',
                metricDefinition: '+proj=utm +zone=42 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.1282, 71.4304], fallbackDataset: [71.4304, 51.1282]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'kz-astana-pkk-esil', idPrefix: 'KZ-ASTANA-PKK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://map.gov4c.kz/egkn/">Kazakhstan EGKN public cadastral map</a> · Esil district only; partial Astana coverage · native cadastral numbers; ownership and boundary update dates unestablished'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dubai: {
            id: 'dubai',
            label: translateCityText('city.labels.dubai', 'Dubai, United Arab Emirates'),
            currency: { locale: 'ar-AE', code: 'AED' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [25.095, 55.157], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32640',
                metricDefinition: '+proj=utm +zone=40 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [25.095, 55.157], fallbackDataset: [55.157, 25.095]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'ae-dubai-dda-public-plots', idPrefix: 'AE-DDA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://gis.dda.gov.ae/dis/">Dubai Development Authority · publisher &amp; conditions</a> · Official public-viewer plot layer; Dubai Marina area verified. Other emirates are separate sources. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        amman: {
            id: 'amman',
            label: translateCityText('city.labels.amman', 'Amman, Jordan'),
            currency: { locale: 'ar-JO', code: 'JOD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [31.9836227976918, 35.9602148481902], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32636',
                metricDefinition: '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [31.9836227976918, 35.9602148481902], fallbackDataset: [35.9602148481902, 31.9836227976918]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'jo-dls-cassini-mapserver', idPrefix: 'jo-dls:',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://maps.dls.gov.jo/dlsweb/">Department of Lands and Survey, Jordan · publisher &amp; conditions</a> · Partial identified parcels. Central Amman verified. All source components for each native DLS parcel key are read before publication. · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        muscat: {
            id: 'muscat',
            label: translateCityText('city.labels.muscat', 'Muscat, Oman'),
            currency: { locale: 'ar-OM', code: 'OMR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [23.597065274496654, 58.55548313911143], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32640',
                metricDefinition: '+proj=utm +zone=40 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [23.597065274496654, 58.55548313911143], fallbackDataset: [58.55548313911143, 23.597065274496654]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'om-muscat-mutrah-plots', idPrefix: 'OM-MM-MUTRAH-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://geoportal.mm.gov.om/server/rest/services/Mutrah_Directorate_Map_Service_MIL1/MapServer/4">Muscat Municipality · publisher &amp; conditions</a> · Mutrah identified new-number plots only; partial Muscat coverage · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        frankfort: {
            id: 'frankfort',
            label: translateCityText('city.labels.frankfort', 'Frankfort, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.2009, -84.8733], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.2009, -84.8733], fallbackDataset: [-84.8733, 38.2009]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ky-frankfort-parcels', idPrefix: 'US-KY-FRANKFORT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://franklincountypva.com/">Franklin County Property Valuation Administrator / Schneider Geospatial · publisher &amp; conditions</a> · Identified Franklin County PVA map parcel groups; mixed record years, current boundary date unestablished · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        oklahoma_city: {
            id: 'oklahoma_city',
            label: translateCityText('city.labels.oklahoma_city', 'Oklahoma City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.4676, -97.5164], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.4676, -97.5164], fallbackDataset: [-97.5164, 35.4676]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-ok-oklahoma_city-parcels', idPrefix: 'US-OK-OKLAHOMA_CITY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=244ff1c03cf34c459092e10142b13b01">Oklahoma County Assessor · publisher &amp; conditions</a> · Oklahoma County assessment parcels; other Oklahoma City counties excluded · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        pierre: {
            id: 'pierre',
            label: translateCityText('city.labels.pierre', 'Pierre, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.3683, -100.351], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.3683, -100.351], fallbackDataset: [-100.351, 44.3683]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-sd-pierre-parcels', idPrefix: 'US-SD-PIERRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=c8dcdb4426b6464d908fed8ca24d4900">ISG (Missouri River Long Distance Trail project) · publisher &amp; conditions</a> · ISG third-party parcel mirror · 2023 snapshot · identified parcels only · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        houston: {
            id: 'houston',
            label: translateCityText('city.labels.houston', 'Houston, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [29.7604, -95.3698], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32615',
                metricDefinition: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [29.7604, -95.3698], fallbackDataset: [-95.3698, 29.7604]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'us-tx-harris-hcad-parcels', idPrefix: 'US-TX-HCAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0">Harris County Appraisal District / Harris County GIS · publisher &amp; conditions</a> · Harris County identified account parcels; other Houston counties excluded · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        curitiba: {
            id: 'curitiba',
            label: translateCityText('city.labels.curitiba', 'Curitiba, Brazil'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.429, -49.273], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32722',
                metricDefinition: '+proj=utm +zone=22 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-25.429, -49.273], fallbackDataset: [-49.273, -25.429]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'br-curitiba-ippuc-lote-cadastral', idPrefix: 'BR-CURITIBA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://geocuritiba.ippuc.org.br/server/rest/services/GeoCuritiba/Publico_GeoCuritiba_MapaCadastral/MapServer/15">IPPUC / Prefeitura de Curitiba · publisher &amp; conditions</a> · Curitiba municipal cadastral lots with fiscal identifiers · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        recife: {
            id: 'recife',
            label: translateCityText('city.labels.recife', 'Recife, Brazil'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-8.04622135042311, -34.9207751899257], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32725',
                metricDefinition: '+proj=utm +zone=25 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-8.04622135042311, -34.9207751899257], fallbackDataset: [-34.9207751899257, -8.04622135042311]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'br-recife-prefeitura-lotes', idPrefix: 'BR-RECIFE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://esigportal2.recife.pe.gov.br/arcgis/rest/services/Planejamento/BASES_BAIRRO_FACEQUADRA_LOGRADOURO_LOTE/FeatureServer/3">Prefeitura do Recife · publisher &amp; conditions</a> · Recife identified municipal lots; complete components for each lot code · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        durban: {
            id: 'durban',
            label: translateCityText('city.labels.durban', 'Durban, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-29.8585, 31.0218], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32736',
                metricDefinition: '+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-29.8585, 31.0218], fallbackDataset: [31.0218, -29.8585]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'za-ethekwini-cadastral-parcels', idPrefix: 'ZA-ETHEKWINI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 6,
                attribution: '<a href="https://gis.durban.gov.za/server/rest/services/WebViewers/EXT_Cadastral/MapServer/17">eThekwini Municipality, Corporate GIS · publisher &amp; conditions</a> · eThekwini municipal cadastral parcels; central Durban verified · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        johannesburg: {
            id: 'johannesburg',
            label: translateCityText('city.labels.johannesburg', 'Johannesburg, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.12045, 27.86009], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-26.12045, 27.86009], fallbackDataset: [27.86009, -26.12045]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'za-joburg-registered-stands', idPrefix: 'ZA-JOBURG-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://ags.joburg.org.za/server/rest/services/ConstructionPermitSystem/Property/MapServer/6">City of Johannesburg · publisher &amp; conditions</a> · Registered stand groups; western entry area verified · update year unestablished'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ennerdale: {
            id: 'ennerdale',
            label: translateCityText('city.labels.ennerdale', 'Ennerdale, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.4062859886009, 27.8459423386999], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-26.4062859886009, 27.8459423386999], fallbackDataset: [27.8459423386999, -26.4062859886009]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'za-joburg-registered-stands', idPrefix: 'ZA-JOBURG-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://ags.joburg.org.za/server/rest/services/ConstructionPermitSystem/Property/MapServer/6">City of Johannesburg · publisher &amp; conditions</a> · Registered stand groups; Ennerdale entry area verified · update year unestablished'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cosmo_city: {
            id: 'cosmo_city',
            label: translateCityText('city.labels.cosmo_city', 'Cosmo City, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.0359639124127, 27.9203632448749], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-26.0359639124127, 27.9203632448749], fallbackDataset: [27.9203632448749, -26.0359639124127]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'za-joburg-registered-stands', idPrefix: 'ZA-JOBURG-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://ags.joburg.org.za/server/rest/services/ConstructionPermitSystem/Property/MapServer/6">City of Johannesburg · publisher &amp; conditions</a> · Registered stand groups; Cosmo City entry area verified · update year unestablished'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        accra: {
            id: 'accra',
            label: translateCityText('city.labels.accra', 'Accra, Ghana'),
            currency: { locale: 'en-GH', code: 'GHS' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [5.5508, -0.2162], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [5.5508, -0.2162], fallbackDataset: [-0.2162, 5.5508]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gh-ama-public-property-app', idPrefix: 'GH-AMA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://gis.berryict.com/gis/gis/ama/propertyidentification.php">Accra Metro property app · Berry ICT host · conditions</a> · Partial app-PID footprints; official authority and legal cadastral meaning unconfirmed'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        mboloko: {
            id: 'mboloko',
            label: translateCityText('city.labels.mboloko', 'Mboloko, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.4662366387406, 27.8447650141456], defaultZoom: 18,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-25.4662366387406, 27.8447650141456], fallbackDataset: [27.8447650141456, -25.4662366387406]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'za-cgs-northwest-erven', idPrefix: 'ZA-CGS-NW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 2,
                attribution: '<a href="https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/46">CGS North West Erven · publisher &amp; conditions</a> · Surveyed approved parcels; Mboloko entry area verified; sampled records 2017-10-13; currentness and registration unestablished'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
                parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
            },
        nairobi: {
            id: 'nairobi',
            label: translateCityText('city.labels.nairobi', 'Nairobi, Kenya'),
            currency: { locale: 'en-KE', code: 'KES' },
            map: {
                initialView: { type: 'center', zoom: 18 },
                defaultCenter: [-1.26592113731299, 36.845161927435], defaultZoom: 18,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32737',
                metricDefinition: '+proj=utm +zone=37 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-1.26592113731299, 36.845161927435],
                fallbackDataset: [36.845161927435, -1.26592113731299]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'ke-nairobi-maps-outlines', idPrefix: 'KE-NAIROBI-NM-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://nairobimaps.com/">Nairobi Maps</a> · <a href="https://nairobimaps.com/gis-data/nairobi-parcels-cadastre.html">parcel outlines</a>. Public commercial outlines are for geometry references only; source registry numbers and ownership are unavailable.'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        athens: {
            id: 'athens',
            label: 'Athens, Greece',
            currency: { locale: 'el-GR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: 18 },
                defaultCenter: [37.99008, 23.72948],
                defaultZoom: 18,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32634',
                metricDefinition: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [37.99008, 23.72948],
                fallbackDataset: [23.72948, 37.99008]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'gr-ktimatologio-active-parcels-arcgis',
                idPrefix: 'GR-ATHENS-KAEK-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 0.1,
                attribution: '<a href="https://maps.ktimatologio.gr/">Hellenic Cadastre (Ktimatologio) active cadastral layer</a> · Athens-center sample only; broader coverage and currentness unverified'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gaborone: {
            id: 'gaborone',
            label: translateCityText('city.labels.gaborone', 'Gaborone, Botswana'),
            currency: { locale: 'en-BW', code: 'BWP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-24.6581, 25.9122],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-24.6581, 25.9122],
                fallbackDataset: [25.9122, -24.6581]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'gaborone-bofinet-plots-provisional',
                idPrefix: 'gaborone:bofinet:', requiresBackend: true, ownership: false,
                liveRadiusKm: 3,
                attribution: '<a href="https://bofinetarcgisportal.bofinet.co.bw/server/rest/services/PUBLIC/GABORONE_PLOTS/MapServer/0">BOFINET Gaborone city plots</a> · verified bounded samples · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bloemfontein: {
            id: 'bloemfontein',
            label: translateCityText('city.labels.bloemfontein', 'Bloemfontein, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-29.118, 26.214],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-29.118, 26.214],
                fallbackDataset: [26.214, -29.118]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'za-mangaung-cadastre-2025',
                idPrefix: 'za-mangaung-sgcode:', requiresBackend: true, ownership: false,
                liveRadiusKm: 3,
                attribution: '<a href="https://services6.arcgis.com/ho5ShYx4j27gPCg4/ArcGIS/rest/services/Map_For_Publishing_Internal_2_WFL1/FeatureServer/11">Mangaung Cadastre 2025 — Bloemfontein</a> · verified bounded samples · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        pretoria: {
            id: 'pretoria',
            label: translateCityText('city.labels.pretoria', 'Pretoria, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.7479, 28.2293],
                defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-25.7479, 28.2293],
                fallbackDataset: [28.2293, -25.7479]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'za-tshwane-registered-parcels',
                idPrefix: 'tshwane:lis-key:', requiresBackend: true, ownership: false,
                liveRadiusKm: 3,
                attribution: '<a href="https://e-gis003.tshwane.gov.za/server/rest/services/Other_WS/Land_Parcel/MapServer/1">City of Tshwane registered surveyed parcels — Pretoria</a> · verified bounded samples · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        vienna: {
            id: 'vienna',
            label: translateCityText('city.labels.vienna', 'Vienna, Austria'),
            currency: { locale: 'en-AT', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.2092, 16.37], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32633',
                metricDefinition: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [48.2092, 16.37], fallbackDataset: [16.37, 48.2092]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0005,
                source: 'parcel-source', sourceId: 'at-bev-kataster-vector-tiles', idPrefix: 'AT-BEV-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://kataster.bev.gv.at/">BEV cadastral vector tiles</a> · CC BY 4.0 · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cetinje: {
            id: 'cetinje',
            label: translateCityText('city.labels.cetinje', 'Cetinje, Montenegro'),
            currency: { locale: 'sr-ME', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [42.3908, 18.9215], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32634',
                metricDefinition: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [42.3908, 18.9215], fallbackDataset: [18.9215, 42.3908]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'me-water-cadastral-parcels', idPrefix: 'me-water:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://wis.gov.me/geoportal">Montenegro Water Administration cadastral parcels</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sanmarino: {
            id: 'sanmarino',
            label: translateCityText('city.labels.sanmarino', 'San Marino, San Marino'),
            currency: { locale: 'it-SM', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.936, 12.446], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32633',
                metricDefinition: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.936, 12.446], fallbackDataset: [12.446, 43.936]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'sm-public-cadastral-ground', idPrefix: 'sm-cadastre:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://mappeonline.pa.sm/maps/prgmobile/">San Marino public cadastral land</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        thehague: {
            id: 'thehague',
            label: translateCityText('city.labels.thehague', 'The Hague, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.08, 4.311], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [52.08, 4.311], fallbackDataset: [4.311, 52.08]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.pdok.nl/ogc-apis/-/article/kadastrale-kaart">Kadaster / PDOK cadastral map</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wellington: {
            id: 'wellington',
            label: translateCityText('city.labels.wellington', 'Wellington, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-41.2865, 174.7762], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32760',
                metricDefinition: '+proj=utm +zone=60 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-41.2865, 174.7762], fallbackDataset: [174.7762, -41.2865]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.linz.govt.nz/layer/50823-nz-primary-parcels/">LINZ primary parcels — public ArcGIS publication</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        beirut: {
            id: 'beirut',
            label: translateCityText('city.labels.beirut', 'Beirut, Lebanon'),
            currency: { locale: 'ar-LB', code: 'LBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.896, 35.5], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32636',
                metricDefinition: '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [33.896, 35.5], fallbackDataset: [35.5, 33.896]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'lb-bbed-beirut-parcels', idPrefix: 'LB-BBED-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.beiruturbanlab.com/ar/Details/666/municipal-beirut-basemap-available-for-download">Beirut Urban Lab municipal parcel basemap</a> · ODbL · 2019 research basemap'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        thimphu: {
            id: 'thimphu',
            label: translateCityText('city.labels.thimphu', 'Thimphu — Taba, Bhutan'),
            currency: { locale: 'en-BT', code: 'BTN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [27.515, 89.642], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32645',
                metricDefinition: '+proj=utm +zone=45 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [27.515, 89.642], fallbackDataset: [89.642, 27.515]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'bt-thimphu-taba-plots', idPrefix: 'bt-thimphu-taba:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://nsdi.systems.gov.bt/server/rest/services/Hosted/thimphu_thromde_1_view/FeatureServer/3">Thimphu Thromde Taba plot polygons (status unverified)</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bandarseribegawan: {
            id: 'bandarseribegawan',
            label: translateCityText('city.labels.bandarseribegawan', 'Bandar Seri Begawan, Brunei'),
            currency: { locale: 'en-BN', code: 'BND' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [4.894, 114.946], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32650',
                metricDefinition: '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [4.894, 114.946], fallbackDataset: [114.946, 4.894]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.004,
                source: 'parcel-source', sourceId: 'bn-survey-cadas-bsb', idPrefix: 'BN-SD-BSB-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://survey.gov.bn/">Brunei Survey Department G1_GDBD CADAS</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        jerusalem: {
            id: 'jerusalem',
            label: translateCityText('city.labels.jerusalem', 'Jerusalem, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [31.782, 35.214], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32636',
                metricDefinition: '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [31.782, 35.214], fallbackDataset: [35.214, 31.782]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:',
                idBatchSize: 3,
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.govmap.gov.il/">Govmap public cadastral parcel rows</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        eastjerusalem: {
            id: 'eastjerusalem',
            label: translateCityText('city.labels.eastjerusalem', 'East Jerusalem, Palestine'),
            currency: { locale: 'ar-PS', code: 'ILS' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [31.794, 35.25], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32636',
                metricDefinition: '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [31.794, 35.25], fallbackDataset: [35.25, 31.794]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001,
                source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:',
                idBatchSize: 3,
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.govmap.gov.il/">Govmap public cadastral parcel rows</a> · bounded public sample · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        philadelphia: {
            id: 'philadelphia',
            label: translateCityText('city.labels.philadelphia', 'Philadelphia, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.9809715945293, -75.1611281567456], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32618',
                metricDefinition: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [39.9809715945293, -75.1611281567456], fallbackDataset: [-75.1611281567456, 39.9809715945293]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-pa-philadelphia-dor-active-ground', idPrefix: 'US-PA-PHILADELPHIA-DOR-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://opendataphilly.org/datasets/department-of-records-property-parcels/">Philadelphia Department of Records active ground parcels</a> · active ground parcels · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lasvegas: {
            id: 'lasvegas',
            label: translateCityText('city.labels.lasvegas', 'Las Vegas, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.1515806137119, -115.164472767125], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [36.1515806137119, -115.164472767125], fallbackDataset: [-115.164472767125, 36.1515806137119]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-nv-clark-assessor-parcels', idPrefix: 'US-NV-CLARK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://maps.clarkcountynv.gov/arcgis/rest/services/GISMO/AssessorMap/FeatureServer/1">Clark County Assessor parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        macau: {
            id: 'macau',
            label: translateCityText('city.labels.macau', 'Macau, China, Macao SAR'),
            currency: { locale: 'pt-MO', code: 'MOP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [22.1940052, 113.5442146], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32649',
                metricDefinition: '+proj=utm +zone=49 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [22.1940052, 113.5442146], fallbackDataset: [113.5442146, 22.1940052]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'mo-dscc-cad-lote', idPrefix: 'MO-DSCC-CAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://cadastre.gis.gov.mo/MGSP_Cad/port/main.html?type=1">Macao DSCC Cad_lote cadastral reference polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sandiego: {
            id: 'sandiego',
            label: translateCityText('city.labels.sandiego', 'San Diego, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [32.728932496022, -117.086972512462], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [32.728932496022, -117.086972512462], fallbackDataset: [-117.086972512462, 32.728932496022]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ca-sangis-parcels-reference', idPrefix: 'US-CA-SANGIS-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.sangis.org/">SanGIS unstacked parcel reference polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        saogoncalo: {
            id: 'saogoncalo',
            label: translateCityText('city.labels.saogoncalo', 'São Gonçalo, Brazil'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-22.8357484330541, -43.0260274875774], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:31983',
                metricDefinition: '+proj=utm +zone=23 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [-22.8357484330541, -43.0260274875774], fallbackDataset: [-43.0260274875774, -22.8357484330541]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'br-sg-prefeitura-geoserver-lote-cadastro', idPrefix: 'BR-SG-CAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://topovision.pmsg.rj.gov.br/">São Gonçalo municipal cadastral lots (GeoServer WFS)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hamburg: {
            id: 'hamburg',
            label: translateCityText('city.labels.hamburg', 'Hamburg, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [53.5745088975748, 9.99288544960732], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:25832',
                metricDefinition: '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs +type=crs',
                fallbackLatLng: [53.5745088975748, 9.99288544960732], fallbackDataset: [9.99288544960732, 53.5745088975748]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'de-hh-alkis-flurstueck', idPrefix: 'DE-HH-ALKIS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://api.hamburg.de/datasets/v1/alkis_vereinfacht">Hamburg simplified ALKIS cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sanantonio: {
            id: 'sanantonio',
            label: translateCityText('city.labels.sanantonio', 'San Antonio, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [29.464389001765, -98.5436537993289], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:26914',
                metricDefinition: '+proj=utm +zone=14 +datum=NAD83 +units=m +no_defs +type=crs',
                fallbackLatLng: [29.464389001765, -98.5436537993289], fallbackDataset: [-98.5436537993289, 29.464389001765]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-bexar-bcad-public-archive-2022-propid', idPrefix: 'US-TX-BEXAR-BCAD-2022-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gbra.maps.arcgis.com/home/item.html?id=ddc97094771f45be81fc6cd4842a1901">San Antonio Bexar CAD parcels · public 2022 archive</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dallas: {
            id: 'dallas',
            label: translateCityText('city.labels.dallas', 'Dallas, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [32.8728161029652, -96.7273020350225], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [32.8728161029652, -96.7273020350225], fallbackDataset: [-96.7273020350225, 32.8728161029652]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-dallas-taxparcels', idPrefix: 'US-TX-DALLAS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.dallascounty.org/departments/pubworks/GIS.php">City of Dallas certified tax parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        oakland: {
            id: 'oakland',
            label: translateCityText('city.labels.oakland', 'Oakland, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [37.7460795032621, -122.171539055455], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32610',
                metricDefinition: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [37.7460795032621, -122.171539055455], fallbackDataset: [-122.171539055455, 37.7460795032621]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ca-oakland-parcels', idPrefix: 'US-CA-OAK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gismaps.oaklandca.gov/oaklandgis/rest/services/Parcel/MapServer/0">City of Oakland GIS parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        seattle: {
            id: 'seattle',
            label: translateCityText('city.labels.seattle', 'Seattle, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.680804084804, -122.278326020363], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32610',
                metricDefinition: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [47.680804084804, -122.278326020363], fallbackDataset: [-122.278326020363, 47.680804084804]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-wa-king-county-parcel-boundary', idPrefix: 'US-WA-KC-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gismaps.kingcounty.gov/parcelviewer2/">Seattle GIS King County parcel boundaries</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        mesa: {
            id: 'mesa',
            label: translateCityText('city.labels.mesa', 'Mesa, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.3793, -111.8075], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32612',
                metricDefinition: '+proj=utm +zone=12 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [33.3793, -111.8075], fallbackDataset: [-111.8075, 33.3793]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-az-mesa-city-parcels', idPrefix: 'US-MESA-CITY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://opengis.mesaaz.gov/">City of Mesa GIS parcel boundaries</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fortlauderdale: {
            id: 'fortlauderdale',
            label: translateCityText('city.labels.fortlauderdale', 'Fort Lauderdale, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [26.2136403895659, -80.2006810091933], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [26.2136403895659, -80.2006810091933], fallbackDataset: [-80.2006810091933, 26.2136403895659]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-fl-fort-lauderdale-taxparcels-ground', idPrefix: 'US-FL-FORT-LAUDERDALE-ROW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.fortlauderdale.gov/server/rest/services/TaxParcel/MapServer">Fort Lauderdale ground tax-parcel boundaries</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        valenciaspain: {
            id: 'valenciaspain',
            label: translateCityText('city.labels.valenciaspain', 'Valencia, Spain'),
            currency: { locale: 'es-ES', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.4704332385683, -0.39271003219546], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:25830',
                metricDefinition: '+proj=utm +zone=30 +ellps=GRS80 +units=m +no_defs',
                fallbackLatLng: [39.4704332385683, -0.39271003219546], fallbackDataset: [-0.39271003219546, 39.4704332385683]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'es-dgc-inspire-cp-wfs', idPrefix: 'ES-DGC-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.catastro.hacienda.gob.es/webinspire/">Dirección General del Catastro — Madrid, Barcelona and Valencia</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        klipgat: {
            id: 'klipgat',
            label: translateCityText('city.labels.klipgat', 'Klipgat, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.4785970466047, 28.1150225708436], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-25.4785970466047, 28.1150225708436], fallbackDataset: [28.1150225708436, -25.4785970466047]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General public Erven polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tembisa: {
            id: 'tembisa',
            label: translateCityText('city.labels.tembisa', 'Tembisa, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.0160233303594, 28.2050144110193], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-26.0160233303594, 28.2050144110193], fallbackDataset: [28.2050144110193, -26.0160233303594]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-ekurhuleni-stands', idPrefix: 'ZA-EKU-STAND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.ekurhuleni.gov.za/">City of Ekurhuleni municipal stands — Tembisa sample</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        vitoria: {
            id: 'vitoria',
            label: translateCityText('city.labels.vitoria', 'Vitória, Brazil'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-20.3155, -40.3128], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32724',
                metricDefinition: '+proj=utm +zone=24 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-20.3155, -40.3128], fallbackDataset: [-40.3128, -20.3155]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'br-vitoria-lotes', idPrefix: 'BR-VIX-LOTE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.vitoria.es.gov.br/arcgis/rest/services/MapaBaseImobiliario/MapServer/101">Vitória municipal Lote — central reference</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ciudadjuarez: {
            id: 'ciudadjuarez',
            label: translateCityText('city.labels.ciudadjuarez', 'Ciudad Juárez, Mexico'),
            currency: { locale: 'es-MX', code: 'MXN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [31.6633818209033, -106.421992448914], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32613',
                metricDefinition: '+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [31.6633818209033, -106.421992448914], fallbackDataset: [-106.421992448914, 31.6633818209033]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'mx-juarez-predios', idPrefix: 'MX-JUA-PREDIO-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.imip.org.mx/sigem/">IMIP Ciudad Juárez municipal Predios</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        calgary: {
            id: 'calgary',
            label: translateCityText('city.labels.calgary', 'Calgary, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.0353306517676, -114.105700735457], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.0353306517676, -114.105700735457], fallbackDataset: [-114.105700735457, 51.0353306517676]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-calgary-assessment-parcel', idPrefix: 'CA-CALGARY-CPID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.calgary.ca/Government/Current-Year-Property-Assessments-Parcel-/4bsw-nn7w">Calgary assessed registered-parcel geometries</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rosario: {
            id: 'rosario',
            label: translateCityText('city.labels.rosario', 'Rosario, Argentina'),
            currency: { locale: 'es-AR', code: 'ARS' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-32.9481688811101, -60.6765246060875], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32720',
                metricDefinition: '+proj=utm +zone=20 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-32.9481688811101, -60.6765246060875], fallbackDataset: [-60.6765246060875, -32.9481688811101]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ar-rosario-section9-parcel', idPrefix: 'AR-ROS-S9-MSLINK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://datosabiertos.rosario.gob.ar/api/1/metastore/schemas/dataset/items/0b4f7e3e-ac2e-4f32-b523-a974c6209e3f">Rosario municipal parcel Section 9</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        minneapolis: {
            id: 'minneapolis',
            label: translateCityText('city.labels.minneapolis', 'Minneapolis, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.9726015122978, -93.2378207757913], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:26915',
                metricDefinition: '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.9726015122978, -93.2378207757913], fallbackDataset: [-93.2378207757913, 44.9726015122978]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-mn-hennepin-county-parcels-metroc', idPrefix: 'us-mn-hennepin:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.data.mn.gov/maps/hennepin%3A%3Acounty-parcels/about">Hennepin County Parcels (Metropolitan Council public layer)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        auckland: {
            id: 'auckland',
            label: translateCityText('city.labels.auckland', 'Auckland, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-36.9024908859156, 174.777123817482], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32760',
                metricDefinition: '+proj=utm +zone=60 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-36.9024908859156, 174.777123817482], fallbackDataset: [174.777123817482, -36.9024908859156]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.linz.govt.nz/layer/50772-nz-primary-parcels/">LINZ primary parcels — public ArcGIS publication</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tuenmun: {
            id: 'tuenmun',
            label: translateCityText('city.labels.tuenmun', 'Tuen Mun, Hong Kong'),
            currency: { locale: 'en-HK', code: 'HKD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [22.4266355780752, 113.996366842382], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32650',
                metricDefinition: '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [22.4266355780752, 113.996366842382], fallbackDataset: [113.996366842382, 22.4266355780752]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'hk-landsd-csdi-lot', idPrefix: 'HK-LANDSD-CSDI-LOT-CSUID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.gov.hk/en-data/dataset/hk-landsd-openmap-landsd-lot/resource/92d24214-a295-4b8e-8d3f-27e9226e1287">Lands Department CSDI Lot polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dusseldorf: {
            id: 'dusseldorf',
            label: translateCityText('city.labels.dusseldorf', 'Düsseldorf, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.2180376209965, 6.78255471417581], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.2180376209965, 6.78255471417581], fallbackDataset: [6.78255471417581, 51.2180376209965]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://ogc-api.nrw.de/lika/v1/collections/flurstueck?f=json">Geobasis NRW ALKIS parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        marseille: {
            id: 'marseille',
            label: translateCityText('city.labels.marseille', 'Marseille, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.3060785068726, 5.40046021068172], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.3060785068726, 5.40046021068172], fallbackDataset: [5.40046021068172, 43.3060785068726]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">France IGN/DGFiP Parcellaire Express (PCI)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lille: {
            id: 'lille',
            label: translateCityText('city.labels.lille', 'Lille, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.6588228758037, 3.10526733091648], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [50.6588228758037, 3.10526733091648], fallbackDataset: [3.10526733091648, 50.6588228758037]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">France IGN/DGFiP Parcellaire Express (PCI)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        stuttgart: {
            id: 'stuttgart',
            label: translateCityText('city.labels.stuttgart', 'Stuttgart, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.7945602765168, 9.20116965816696], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [48.7945602765168, 9.20116965816696], fallbackDataset: [9.20116965816696, 48.7945602765168]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.lgl-bw.de/Produkte/Geodatendienste/ALKIS-Daten/index.html">Baden-Württemberg LGL ALKIS cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        frankfurt: {
            id: 'frankfurt',
            label: translateCityText('city.labels.frankfurt', 'Frankfurt, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.1196449235525, 8.67155930482746], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [50.1196449235525, 8.67155930482746], fallbackDataset: [8.67155930482746, 50.1196449235525]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'de-frankfurt-alkis-flurstueck', idPrefix: 'DE-FFM-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://frankfurt.de/themen/planen-bauen-und-wohnen/planen/geoinformationen">Frankfurt municipal ALKIS cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        saintpetersburgfl: {
            id: 'saintpetersburgfl',
            label: translateCityText('city.labels.saintpetersburgfl', 'Saint Petersburg, Florida, USA'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [27.8713699437531, -82.7305763266337], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [27.8713699437531, -82.7305763266337], fallbackDataset: [-82.7305763266337, 27.8713699437531]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-fl-pinellas-parcels', idPrefix: 'US-FL-PINELLAS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.pcpao.gov/learn-about/FAQs">Pinellas County public Land Polygon parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        detroit: {
            id: 'detroit',
            label: translateCityText('city.labels.detroit', 'Detroit, USA'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [42.418131146732, -83.1544751389422], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [42.418131146732, -83.1544751389422], fallbackDataset: [-83.1544751389422, 42.418131146732]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-mi-detroit-parcels', idPrefix: 'US-MI-DETROIT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.detroitmi.gov/maps/detroitmi::parcels-2">Detroit Office of the Assessor current parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        evaton: {
            id: 'evaton',
            label: translateCityText('city.labels.evaton', 'Evaton, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.525228941691, 27.8512191216245], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-26.525228941691, 27.8512191216245], fallbackDataset: [27.8512191216245, -26.525228941691]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General public Erven polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bonn: {
            id: 'bonn',
            label: translateCityText('city.labels.bonn', 'Bonn, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.7822226933759, 7.09388726064463], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [50.7822226933759, 7.09388726064463], fallbackDataset: [7.09388726064463, 50.7822226933759]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://ogc-api.nrw.de/lika/v1/collections/flurstueck?f=json">Geobasis NRW ALKIS parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        georgetown: {
            id: 'georgetown',
            label: translateCityText('city.labels.georgetown', 'George Town, Penang, Malaysia'),
            currency: { locale: 'en-MY', code: 'MYR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [5.37296693960077, 100.295715284095], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32647',
                metricDefinition: '+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [5.37296693960077, 100.295715284095], fallbackDataset: [100.295715284095, 5.37296693960077]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'my-penang-forestry-cadastral-lots', idPrefix: 'MY-PENANG-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geoformatik.forestry.gov.my/arcgis/rest/services/PULAU_PINANG_SDE/MapServer/45">JUPEM Penang cadastral lots (Forestry GIS host)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        thessaloniki: {
            id: 'thessaloniki',
            label: translateCityText('city.labels.thessaloniki', 'Thessaloniki, Greece'),
            currency: { locale: 'el-GR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.6343408556323, 22.945560253649], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32634',
                metricDefinition: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [40.6343408556323, 22.945560253649], fallbackDataset: [22.945560253649, 40.6343408556323]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'gr-thessaloniki-municipal-kaek', idPrefix: 'GR-THESS-KAEK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://maps.thessaloniki.gr/server/rest/services/DataMapImage/MapServer/160">Thessaloniki public cadastral parcels (KAEK)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bilbao: {
            id: 'bilbao',
            label: translateCityText('city.labels.bilbao', 'Bilbao, Spain'),
            currency: { locale: 'es-ES', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.2826941093508, -2.95997002575274], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.2826941093508, -2.95997002575274], fallbackDataset: [-2.95997002575274, 43.2826941093508]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'es-bizkaia-parcelas-rest', idPrefix: 'ES-BIZKAIA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://opendatabizkaia.eus/es/catalogo/parcelario-catastral-de-bizkaia">Bizkaia public cadastral Parcelas</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        milwaukee: {
            id: 'milwaukee',
            label: translateCityText('city.labels.milwaukee', 'Milwaukee, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.0472023941442, -87.9561409333908], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32616',
                metricDefinition: '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.0472023941442, -87.9561409333908], fallbackDataset: [-87.9561409333908, 43.0472023941442]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-wi-milwaukee-county-taxparcel-map-id', idPrefix: 'US-WI-MILWAUKEE-MAP-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://county.milwaukee.gov/EN/Administrative-Services/Land-Information-Office">Milwaukee County public cadastral polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        krakow: {
            id: 'krakow',
            label: translateCityText('city.labels.krakow', 'Kraków, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.0549669396486, 19.9647598843061], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32634',
                metricDefinition: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [50.0549669396486, 19.9647598843061], fallbackDataset: [19.9647598843061, 50.0549669396486]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'pl-krakow-msip-egib-parcels', idPrefix: 'PL-KRAKOW-EGIB-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://msip.krakow.pl/dataset/1562">Kraków MSIP public EGiB parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fresno: {
            id: 'fresno',
            label: translateCityText('city.labels.fresno', 'Fresno, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.7922501389848, -119.77157818531], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [36.7922501389848, -119.77157818531], fallbackDataset: [-119.77157818531, 36.7922501389848]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ca-fresno-county-parcels', idPrefix: 'US-CA-FRESNO-APN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.fresnocountyca.gov/Departments/Assessor/Mapping">Fresno County public parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        winnipeg: {
            id: 'winnipeg',
            label: translateCityText('city.labels.winnipeg', 'Winnipeg, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.8912776896545, -97.1447622935792], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32614',
                metricDefinition: '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [49.8912776896545, -97.1447622935792], fallbackDataset: [-97.1447622935792, 49.8912776896545]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-winnipeg-assessment-gisid', idPrefix: 'CA-WINNIPEG-GISID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.winnipeg.ca/Assessment-Taxation-Corporate/Assessment-Parcels/d4mq-wa44">Winnipeg public assessment parcel footprints</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        shatin: {
            id: 'shatin',
            label: translateCityText('city.labels.shatin', 'Sha Tin, Hong Kong'),
            currency: { locale: 'en-HK', code: 'HKD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [22.3934460524814, 114.204022607849], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32650',
                metricDefinition: '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [22.3934460524814, 114.204022607849], fallbackDataset: [114.204022607849, 22.3934460524814]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'hk-landsd-csdi-lot-polygons', idPrefix: 'HK-CSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://portal.csdi.gov.hk/csdi-webpage/dataset/landsd_rcd_1637217253134_22729">Hong Kong Lands Department CSDI lots</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        okara: {
            id: 'okara',
            label: translateCityText('city.labels.okara', 'Okara, Pakistan'),
            currency: { locale: 'en-PK', code: 'PKR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [30.8083288852812, 73.4521453260116], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [30.8083288852812, 73.4521453260116], fallbackDataset: [73.4521453260116, 30.8083288852812]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'pk-pulse-okara-parcels', idPrefix: 'PK-PULSE-OKARA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://lis.pulse.gop.pk/">Punjab PULSE Okara cadastral reference polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kitwe: {
            id: 'kitwe',
            label: translateCityText('city.labels.kitwe', 'Kitwe, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-12.8099306286313, 28.222405935667], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32735',
                metricDefinition: '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-12.8099306286313, 28.222405935667], fallbackDataset: [28.222405935667, -12.8099306286313]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Zambia NSDI ZILMIS lot polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wuppertal: {
            id: 'wuppertal',
            label: translateCityText('city.labels.wuppertal', 'Wuppertal, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.2196383633976, 7.10247286125364], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32632',
                metricDefinition: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.2196383633976, 7.10247286125364], fallbackDataset: [7.10247286125364, 51.2196383633976]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://ogc-api.nrw.de/lika/v1/collections/flurstueck?f=json">Geobasis NRW ALKIS parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        palermo: {
            id: 'palermo',
            label: translateCityText('city.labels.palermo', 'Palermo, Italy'),
            currency: { locale: 'it-IT', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.1207651044272, 13.3478178274778], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32633',
                metricDefinition: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [38.1207651044272, 13.3478178274778], fallbackDataset: [13.3478178274778, 38.1207651044272]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'it-sicilia-sitr-cadastral-parcels', idPrefix: 'IT-SICILIA-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.sitr.regione.sicilia.it/">Sicilia SITR public cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        toulouse: {
            id: 'toulouse',
            label: translateCityText('city.labels.toulouse', 'Toulouse, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.6041456701446, 1.42516148294357], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [43.6041456701446, 1.42516148294357], fallbackDataset: [1.42516148294357, 43.6041456701446]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">France IGN/DGFiP Parcellaire Express (PCI)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bordeaux: {
            id: 'bordeaux',
            label: translateCityText('city.labels.bordeaux', 'Bordeaux, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.8360390353827, -0.592897717816896], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [44.8360390353827, -0.592897717816896], fallbackDataset: [-0.592897717816896, 44.8360390353827]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">France IGN/DGFiP Parcellaire Express (PCI)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        elpaso: {
            id: 'elpaso',
            label: translateCityText('city.labels.elpaso', 'El Paso'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [31.7867212643232, -106.36486464215], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32613',
                metricDefinition: '+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [31.7867212643232, -106.36486464215], fallbackDataset: [-106.36486464215, 31.7867212643232]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-el-paso-city-gis-parcels', idPrefix: 'US-TX-ELPASO-OBJECTID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://opendata.elpasotexas.gov/">City of El Paso GIS Parcels (EPCAD source, GIS OID namespace)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        westpalmbeach: {
            id: 'westpalmbeach',
            label: translateCityText('city.labels.westpalmbeach', 'West Palm Beach'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [26.6223516519297, -80.1012894536897], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32617',
                metricDefinition: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [26.6223516519297, -80.1012894536897], fallbackDataset: [-80.1012894536897, 26.6223516519297]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-palm-beach-county-pao-parcels-ground-oid', idPrefix: 'US-PBC-OID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://pbcpao.gov/departments/gis.htm">Palm Beach County Property Appraiser parcel polygons using service OID</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lodz: {
            id: 'lodz',
            label: translateCityText('city.labels.lodz', 'Łódź'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.7666527325011, 19.4560942606722], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32634',
                metricDefinition: '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.7666527325011, 19.4560942606722], fallbackDataset: [19.4560942606722, 51.7666527325011]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'lodz-gml-wfs', idPrefix: 'PL-LODZ-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://nowa.mapa.lodz.pl/dla-profesjonalistow/">Łódź municipal EGiB cadastral parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        poznan: {
            id: 'poznan',
            label: translateCityText('city.labels.poznan', 'Poznań'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.4033374848812, 16.9139953760299], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:2180',
                metricDefinition: '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +units=m +no_defs',
                fallbackLatLng: [52.4033374848812, 16.9139953760299], fallbackDataset: [16.9139953760299, 52.4033374848812]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'poznan-gml-wfs', idPrefix: 'PL-POZNAN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geopoz.poznan.pl/">Poznań municipal EGiB cadastral parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dresden: {
            id: 'dresden',
            label: translateCityText('city.labels.dresden', 'Dresden'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.0412590520933, 13.7515873602205], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32633',
                metricDefinition: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.0412590520933, 13.7515873602205], fallbackDataset: [13.7515873602205, 51.0412590520933]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'dresden-saxony-gml-wfs', idPrefix: 'DE-SN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.geodaten.sachsen.de/alkis-wfs-4968.html">GeoSN Saxony simplified ALKIS cadastral parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leipzig: {
            id: 'leipzig',
            label: translateCityText('city.labels.leipzig', 'Leipzig'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.3403873460544, 12.3749392867142], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32633',
                metricDefinition: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [51.3403873460544, 12.3749392867142], fallbackDataset: [12.3749392867142, 51.3403873460544]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'dresden-saxony-gml-wfs', idPrefix: 'DE-SN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.geodaten.sachsen.de/alkis-wfs-4968.html">GeoSN Saxony simplified ALKIS cadastral parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        joinville: {
            id: 'joinville',
            label: translateCityText('city.labels.joinville', 'Joinville'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.3054119242896, -48.8298392070888], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32722',
                metricDefinition: '+proj=utm +zone=22 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-26.3054119242896, -48.8298392070888], fallbackDataset: [-48.8298392070888, -26.3054119242896]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'br-joinville-simgeo-lotes', idPrefix: 'BR-JOINVILLE-IQ-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.joinville.sc.gov.br/servicos/acessar-sistema-de-informacoes-municipais-georreferenciadas-simgeo/">Joinville SIMGeo municipal cadastral lot polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        utrecht: {
            id: 'utrecht',
            label: translateCityText('city.labels.utrecht', 'Utrecht'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.0840427734495, 5.08101362175478], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32631',
                metricDefinition: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [52.0840427734495, 5.08101362175478], fallbackDataset: [5.08101362175478, 52.0840427734495]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.pdok.nl/ogc-apis/-/article/kadastrale-kaart">Netherlands Kadaster / PDOK cadastral map</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bukit_mertajam: {
            id: 'bukit_mertajam',
            label: translateCityText('city.labels.bukit_mertajam', 'Bukit Mertajam'),
            currency: { locale: 'ms-MY', code: 'MYR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [5.37430818562544, 100.428386608375], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32647',
                metricDefinition: '+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [5.37430818562544, 100.428386608375], fallbackDataset: [100.428386608375, 5.37430818562544]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'my-penang-forestry-cadastral-lots', idPrefix: 'MY-PENANG-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geoformatik.forestry.gov.my/arcgis/rest/services/PULAU_PINANG_SDE/MapServer/45">JUPEM Penang cadastral lots (Forestry GIS host)</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        juiz_de_fora: {
            id: 'juiz_de_fora',
            label: translateCityText('city.labels.juiz_de_fora', 'Juiz de Fora'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-21.7520452174457, -43.3632723968038], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32723',
                metricDefinition: '+proj=utm +zone=23 +south +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [-21.7520452174457, -43.3632723968038], fallbackDataset: [-43.3632723968038, -21.7520452174457]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'br-juiz-de-fora-sisurb-lotes', idPrefix: 'BR-JF-SISURB-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://sisurb.pjf.mg.gov.br/server/rest/services/uso_cad_lotes/MapServer">Juiz de Fora SISURB municipal cadastral lots</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        malaga: {
            id: 'malaga',
            label: translateCityText('city.labels.malaga', 'Málaga'),
            currency: { locale: 'es-ES', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.719979707331, -4.43788341316648], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32630',
                metricDefinition: '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [36.719979707331, -4.43788341316648], fallbackDataset: [-4.43788341316648, 36.719979707331]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'es-malaga-municipal-parcel-snapshot', idPrefix: 'ES-MALAGA-PARCELA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://datosabiertos.malaga.eu/tr/dataset/sistema-de-informacion-cartografica-parcela">Ayuntamiento de Málaga municipal parcel polygons</a> · CC BY 4.0 · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bakersfield: {
            id: 'bakersfield',
            label: translateCityText('city.labels.bakersfield', 'Bakersfield'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.3492651317935, -119.024876869726], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32611',
                metricDefinition: '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [35.3492651317935, -119.024876869726], fallbackDataset: [-119.024876869726, 35.3492651317935]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-bakersfield-municipal-cadastral-parcels', idPrefix: 'US-BAKERSFIELD-APN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.bakersfieldcity.us/webmaps/rest/services/General/Cadastre/MapServer">City of Bakersfield cadastral parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        // Not a city: the generic place-without-parcels view (see EXPLORE_CITY_ID above). Left out
        // of getAvailableCities/findNearestCity, the search box city list, the stored-city pointer and
        // scripts/build-world-coverage.mjs (which skips `explore: true`).
        orlando: {
            id: 'orlando',
            label: translateCityText('city.labels.orlando', 'Orlando'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [28.5718526010057, -81.3224429681126], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:26917',
                metricDefinition: '+proj=utm +zone=17 +datum=NAD83 +units=m +no_defs +type=crs',
                fallbackLatLng: [28.5718526010057, -81.3224429681126], fallbackDataset: [-81.3224429681126, 28.5718526010057]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'orlando-ocpa-arcgis', idPrefix: 'US-ORANGE-COUNTY-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://webmap.ocpafl.org/search">Orange County Property Appraiser assessment parcel polygons</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dublin: {
            id: 'dublin',
            label: translateCityText('city.labels.dublin', 'Dublin'),
            currency: { locale: 'en-IE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [53.330243126706, -6.27332800239088], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:2157',
                metricDefinition: '+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m +no_defs',
                fallbackLatLng: [53.330243126706, -6.27332800239088], fallbackDataset: [-6.27332800239088, 53.330243126706]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ie-tailte-hvd-freehold', idPrefix: 'IE-SP-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.gov.ie/dataset/high-value-dataset-cadastral-parcels-freehold1">© Tailte Éireann freehold title boundaries only</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        riga: {
            id: 'riga',
            label: translateCityText('city.labels.riga', 'Riga'),
            currency: { locale: 'lv-LV', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [56.9551247864813, 24.1200225203638], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:3059',
                metricDefinition: '+proj=tmerc +lat_0=0 +lon_0=24 +k=0.9996 +x_0=500000 +y_0=-6000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
                fallbackLatLng: [56.9551247864813, 24.1200225203638], fallbackDataset: [24.1200225203638, 56.9551247864813]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'lv-vzd-geolatvija-vraa-wfs', idPrefix: 'LV-VZD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geolatvija.lv/">State Land Service of Latvia / Geolatvija cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tallinn: {
            id: 'tallinn',
            label: translateCityText('city.labels.tallinn', 'Tallinn'),
            currency: { locale: 'et-EE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [59.4231329005097, 24.7413568470487], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:3301',
                metricDefinition: '+proj=lcc +lat_0=57.5175539305556 +lon_0=24 +lat_1=59.3333333333333 +lat_2=58 +x_0=500000 +y_0=6375000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
                fallbackLatLng: [59.4231329005097, 24.7413568470487], fallbackDataset: [24.7413568470487, 59.4231329005097]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ee-maaamet-kataster-wfs', idPrefix: 'EE-KATASTER-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gsavalik.envir.ee/geoserver/kataster/wfs">Estonian Land and Spatial Development Board / public cadastral WFS cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        vilnius: {
            id: 'vilnius',
            label: translateCityText('city.labels.vilnius', 'Vilnius'),
            currency: { locale: 'lt-LT', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [54.695435447302, 25.2704077979851], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:32635',
                metricDefinition: '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs',
                fallbackLatLng: [54.695435447302, 25.2704077979851], fallbackDataset: [25.2704077979851, 54.695435447302]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'lt-inspire-cp-wfs', idPrefix: 'LT-INSP-CADASTRAL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.inspire-geoportal.lt/geoserver/cp/ows">Lithuanian INSPIRE Geoportal / National Land Service cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        jundiai: {
            id: 'jundiai',
            label: translateCityText('city.labels.jundiai', 'Jundiaí'),
            currency: { locale: 'pt-BR', code: 'BRL' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-23.1976446911945, -46.8554383147568], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                metricCrs: 'EPSG:31983',
                metricDefinition: '+proj=utm +zone=23 +south +ellps=GRS80 +units=m +no_defs',
                fallbackLatLng: [-23.1976446911945, -46.8554383147568], fallbackDataset: [-46.8554383147568, -23.1976446911945]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'br-jundiai-geojundiai-lotes-jund-gid', idPrefix: 'BR-JUNDIAI-LOTES-JUND-GID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geo.jundiai.sp.gov.br/geojundiai/">Município de Jundiaí / GeoJundiaí cadastral parcels</a> · adapted'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        explore: {
            id: 'explore',
            explore: true,
            label: 'Explore',
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: {
                    type: 'center',
                    zoom: exploreView.zoom
                },
                defaultCenter: [exploreView.lat, exploreView.lon],
                defaultZoom: exploreView.zoom,
                parcelZoomRange: { min: 17, max: Infinity },
                latLngPadding: 0.1
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
                // Measurement and buffers need metres: the UTM zone of the explored point.
                metricCrs: exploreProjection.crs,
                metricDefinition: exploreProjection.definition,
                fallbackLatLng: [exploreView.lat, exploreView.lon],
                fallbackDataset: [exploreView.lon, exploreView.lat]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.005,
                // No cadastre: hasParcelData() is false, and the parcel fetch paths return nothing.
                source: 'none',
                requiresBackend: false
            },
            buildings: {
                // OpenStreetMap, the default for every city without its own source (backend
                // buildings/osm-3d.js): live Overpass anywhere on Earth.
                source: 'osm'
            },
            sidebar: {
                // Everything that needs parcels; Measure, Activity and Settings stay. Proposals and
                // stations need none (PARCEL-OPTIONAL.md): a site drawn here has an empty binding
                // and can only execute through an authority's verdict.
                disabledSections: ['parcels', 'parcelBlocks', 'roads', 'areaMonitor', 'game']
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
                if (stored && CITY_CONFIGS[stored] && stored !== EXPLORE_CITY_ID) {
                    return stored;
                }
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.getItem === 'function') {
                const stored = PersistentStorage.getItem(STORAGE_KEY);
                if (stored && CITY_CONFIGS[stored] && stored !== EXPLORE_CITY_ID) {
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
            // Exploring is not choosing a city: the pointer keeps the last real city (or none).
            if (queryCityId !== storedCityId && queryCityId !== EXPLORE_CITY_ID) {
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
        if (cityId === EXPLORE_CITY_ID) return translateCityText('city.labels.explore', 'Explore');
        const config = CITY_CONFIGS[cityId];
        return (config && config.label) ? config.label : (cityId || '');
    }

    // Did the user actually choose this city, or did we fall back to the default? Only a defaulted
    // city may be overridden by the one recovered from a pre-upgrade database. Read before
    // setScope, since determineCurrentCityId writes the pointer as a side effect.
    const cityWasExplicitlyChosen = !!(getCityIdFromQuery() || getStoredCityId());

    let currentCityId = determineCurrentCityId();
    // Remember where exploring happened, so a reload of ?city=explore (its ?at= is stripped after
    // boot, js/map-core.js) opens at the same place.
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
            PersistentStorage.setScope(currentCityId, { explicit: cityWasExplicitlyChosen || currentCityId === EXPLORE_CITY_ID });
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
        currentCityId = CITY_CONFIGS[id] && id !== EXPLORE_CITY_ID ? id : DEFAULT_CITY_ID;
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

    // A person's own building source (ParcelSourceSettings, kind 'building') replaces the city's
    // buildings for every /buildings/* request, which then carries it as `source`. The city's own
    // source stays on record as `defaultSource`, so "Use the city default" can name it.
    function getCityConfig(id) {
        const config = parcelConfigFor(id);
        if (!config) return null;
        const building = window.ParcelSourceSettings?.choiceForCity?.(id, window, 'building');
        if (!building) return config;
        return { ...config, buildings: { ...(config.buildings || {}), source: 'custom', sourceId: building.id,
            name: building.name, defaultSource: config.buildings?.source || 'gdi' } };
    }

    function getBuildingSourceId() {
        return getCurrentCityConfig()?.buildings?.sourceId || undefined;
    }

    // Live alternatives are opt-in for this boot. A reload switches providers without changing
    // the city/plan storage scope; retained parcel facts live only in the current runtime.
    function parcelConfigFor(id) {
        const config = CITY_CONFIGS[id] || null;
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
        return getCityConfig(currentCityId) || getCityConfig(DEFAULT_CITY_ID);
    }

    function getProjectionConfig(cityId = null) {
        const config = cityId && CITY_CONFIGS[cityId]
            ? CITY_CONFIGS[cityId]
            : getCurrentCityConfig();
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

    // False for the explore city: no cadastre, so nothing may fetch or draw parcels.
    function hasParcelData() {
        const source = getParcelSettings().source;
        return !!source && source !== 'none';
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
        // Config names that differ from the markup's data-section
        const sectionToDataSection = {
            'parcelBlocks': 'blocks'
        };

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
            document.querySelectorAll(`.accordion-section[data-section="${dataSection}"]`).forEach(section => {
                section.style.display = 'none';
            });
        });

        applyBuildingLayerChoices();
        // Apply feature visibility after sidebar configuration
        applyFeatureVisibility();
    }

    // Every city has buildings now (OpenStreetMap at the least), so the Layers Buildings section is
    // always on; which surveys it lists depends on the city's source. GDI and DGU are Zagreb's; the
    // separate OSM reference only adds something where OSM is not already the working set; NYC's
    // provider has no 2D footprints at all.
    function applyBuildingLayerChoices() {
        const source = getCurrentCityConfig()?.buildings?.source || 'gdi';
        const row = id => document.getElementById(id)?.closest('label');
        const show = (id, visible) => { const label = row(id); if (label) label.hidden = !visible; };
        show('showBuildings', source !== 'nyc');
        show('showBuildingsDgu', source === 'gdi');
        show('showBuildingsOsm', source !== 'osm');
        const text = row('showBuildings')?.querySelector('[data-i18n-key]');
        if (!text) return;
        const key = source === 'osm' ? 'sidebar.buildings.showOsm'
            : source === 'overture' ? 'sidebar.buildings.showOverture'
            : source === 'custom' ? 'sidebar.buildings.showCustom'
            : 'sidebar.buildings.showGdi';
        text.setAttribute('data-i18n-key', key);
        text.textContent = translateCityText(key, text.textContent);
    }

    // Reload into another city. The path is kept by default, so a shared link (/proposals/<id>,
    // /parcel/<id>) re-runs there; `clearRoute` drops it, for a plain "go to this city" (the search
    // box) that should not carry the link being viewed into the next city.
    function navigateToCity(nextId, options = {}) {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('city', nextId);
            // `at` opens the next city at a given view (js/map-core.js applies and strips it);
            // `world` (force the globe) must not follow the visitor into the city they just picked.
            url.searchParams.delete('at');
            url.searchParams.delete('world');
            if (options.at && window.WorldEntryModel) url.searchParams.set('at', window.WorldEntryModel.formatAt(options.at));
            if (options.clearRoute) {
                if (/^\/(proposals|plans|parcel)\//.test(url.pathname)) url.pathname = '/';
                ['proposalShare', 'shared', 'parcel'].forEach(param => url.searchParams.delete(param));
            }
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
            at = null
        } = options;

        if (!nextId || !CITY_CONFIGS[nextId] || nextId === currentCityId) {
            return false;
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

        return navigateToCity(nextId, { clearRoute, at });
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

            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');

            const translated = (key, fallback) => {
                const value = window.i18n && typeof window.i18n.t === 'function' ? window.i18n.t(key) : null;
                return value && value !== key ? value : fallback;
            };

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = options.cancelText || translated('common.cancel', 'Cancel');

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'btn btn-action';
            okBtn.textContent = options.okText || translated('common.ok', 'OK');
            // A destructive confirm ("Discard") must not be the inviting blue primary: the safe
            // choice (cancel / keep editing) becomes the primary and the OK reads as destructive.
            if (options.destructive) {
                okBtn.className = 'btn btn-secondary cb-confirm-destructive';
                cancelBtn.className = 'btn btn-action';
            }

            function cleanup(result) {
                unregisterEscape?.();
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                resolve(result);
            }

            // The shared capture router cancels this prompt before an underlying sheet/editor can
            // see Escape, so a nested confirmation never closes both layers.
            const unregisterEscape = window.ModalEscape?.register(overlay, () => cleanup(false));

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
            // Focus the primary-styled button (cancel for a destructive confirm), as showStyledChoice
            // does, so the keyboard answers the dialog rather than the control behind it.
            const focusTarget = options.destructive ? cancelBtn : okBtn;
            requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
        });
    }

    window.showStyledConfirm = showStyledConfirm;

    // Multi-button variant of showStyledConfirm: choices = [{value, label, primary}].
    // Resolves with the clicked choice's value, or null on overlay click / Escape.
    // Fully keyboard-driven: the primary choice is focused on open (Enter accepts it),
    // Tab and arrow keys move between the buttons.
    function showStyledChoice(message, choices = []) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'cb-confirm-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'cb-confirm-dialog';

            const text = document.createElement('div');
            text.className = 'cb-confirm-message';
            renderMessageLines(text, message);

            const buttons = document.createElement('div');
            buttons.className = 'cb-confirm-buttons cb-confirm-buttons-stacked';

            function cleanup(result) {
                document.removeEventListener('keydown', onKeydown, true);
                unregisterEscape?.();
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                resolve(result);
            }

            const buttonEls = [];
            choices.forEach(choice => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = choice.primary ? 'btn btn-action' : 'btn btn-secondary';
                btn.textContent = choice.label;
                btn.addEventListener('click', () => cleanup(choice.value));
                buttons.appendChild(btn);
                buttonEls.push(btn);
            });

            function onKeydown(event) {
                // Enter must ALWAYS mean the primary choice, even when something stole the
                // focus after the dialog opened (then no button would receive the key).
                if (event.key === 'Enter' && !dialog.contains(document.activeElement)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const primaryIndex = Math.max(0, choices.findIndex(choice => choice.primary));
                    cleanup(choices[primaryIndex] ? choices[primaryIndex].value : null);
                    return;
                }
                if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const current = buttonEls.indexOf(document.activeElement);
                    const delta = (event.key === 'ArrowDown' || event.key === 'ArrowRight') ? 1 : -1;
                    const next = current === -1 ? 0 : (current + delta + buttonEls.length) % buttonEls.length;
                    buttonEls[next]?.focus();
                }
                // Enter activates the focused button natively (default action, unaffected by
                // stopPropagation); Tab cycles natively. Everything else must not leak to the
                // page behind the dialog — drawing hotkeys (F/U/R) listen on document too.
                event.stopPropagation();
            }
            const unregisterEscape = window.ModalEscape?.register(overlay, () => cleanup(null));
            document.addEventListener('keydown', onKeydown, true);

            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    cleanup(null);
                }
            });

            dialog.appendChild(text);
            dialog.appendChild(buttons);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            const primaryIndex = Math.max(0, choices.findIndex(choice => choice.primary));
            // Focus after layout — a synchronous focus on a prompt opened from inside another
            // event handler loses to whatever refocuses afterwards (the map container does).
            requestAnimationFrame(() => buttonEls[primaryIndex]?.focus({ preventScroll: true }));
        });
    }

    window.showStyledChoice = showStyledChoice;

    function showStyledAlert(message, options = {}) {
        return new Promise(resolve => {
            const previousFocus = document.activeElement;
            let closed = false;
            const overlay = document.createElement('div');
            overlay.className = 'cb-confirm-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'cb-confirm-dialog cb-alert-dialog';
            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');

            const text = document.createElement('div');
            text.className = 'cb-confirm-message';
            showStyledAlert.messageSequence = (showStyledAlert.messageSequence || 0) + 1;
            text.id = `cb-alert-message-${showStyledAlert.messageSequence}`;
            dialog.setAttribute('aria-describedby', text.id);

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
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKeydown, true);
                unregisterEscape?.();
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
                    previousFocus.focus({ preventScroll: true });
                }
                resolve();
            }

            function onKeydown(event) {
                event.stopPropagation();
                event.stopImmediatePropagation();
                if (event.key === 'Tab') {
                    event.preventDefault();
                    const targets = Array.from(dialog.querySelectorAll('a[href], button'));
                    const current = targets.indexOf(document.activeElement);
                    const next = current < 0 ? (event.shiftKey ? targets.length - 1 : 0)
                        : (current + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
                    targets[next]?.focus({ preventScroll: true });
                } else if (event.key === 'Enter' && !dialog.contains(document.activeElement)) {
                    event.preventDefault();
                    cleanup();
                }
            }
            const unregisterEscape = window.ModalEscape?.register(overlay, cleanup);
            document.addEventListener('keydown', onKeydown, true);

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
            requestAnimationFrame(() => { if (!closed) okBtn.focus({ preventScroll: true }); });
        });
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
        Object.values(CITY_CONFIGS).forEach(config => {
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

    // The cities whose parcels come from a given backend source ('oss-wfs' is the Croatian DGU
    // cadastre, shared by Zagreb, Split and Šibenik). Adding a fourth Croatian city automatically
    // joins this set — nothing else needs updating for deep links to resolve to it.
    function getCitiesByParcelSource(source) {
        return Object.values(CITY_CONFIGS).filter(config => config.parcels?.source === source);
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
                setStoredCityId(nearest.id);
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
                && (window.__CB_SIM_URL__ || (window.localStorage && window.localStorage.getItem('cb_sim_url')))) || '';
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
        setCurrentCityId: setStoredCityId,
        switchCity,
        navigateToCity,
        getCityLabel,
        getCurrentCityConfig,
        getAvailableCities: () => Object.keys(CITY_CONFIGS).map(getCityConfig).filter(config => !config.explore),
        EXPLORE_CITY_ID,
        isExplore: () => currentCityId === EXPLORE_CITY_ID,
        // Whether this boot had a city chosen (?city= or a stored pointer) rather than the default:
        // the world view opens on a first visit only (js/ui/world-entry.js).
        wasCityChosenAtBoot: () => cityWasExplicitlyChosen,
        // Keep a city the visitor picked on the globe without a reload (the default city it booted on).
        // Writes only the pointer: the city is unchanged, so no cityChanged event.
        rememberCurrentCity: () => {
            if (currentCityId === EXPLORE_CITY_ID) return;
            try { localStorage.setItem(STORAGE_KEY, currentCityId); } catch (_) { /* storage blocked */ }
        },
        rememberExploreView,
        getCityConfig,
        hasParcelData,
        getCityCodeForCityId,
        findNearestCity,
        getCityCenter,
        detectNearestCity,
        getCitiesByParcelSource,
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
