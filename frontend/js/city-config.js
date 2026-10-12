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
        // BEGIN qualification admission 2026-10-11 round2
        arlington_va: {
            id: 'arlington_va', wupCityCode: '8123',
            label: translateCityText('city.labels.arlington_va', 'Arlington (Washington urban area), United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.9039833204685, -77.1038638561717], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [38.9039833204685, -77.1038638561717], fallbackDataset: [-77.1038638561717, 38.9039833204685]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        norfolk: {
            id: 'norfolk', wupCityCode: '8102',
            label: translateCityText('city.labels.norfolk', 'Norfolk, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.8489951683071, -76.206100528634], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [36.8489951683071, -76.206100528634], fallbackDataset: [-76.206100528634, 36.8489951683071]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        quebec: {
            id: 'quebec', wupCityCode: '4103',
            label: translateCityText('city.labels.quebec', 'Quebec, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.8389003853526, -71.2572062217076], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [46.8389003853526, -71.2572062217076], fallbackDataset: [-71.2572062217076, 46.8389003853526]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        point_cook: {
            id: 'point_cook', wupCityCode: '1336',
            label: translateCityText('city.labels.point_cook', 'Point Cook, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-37.8751576905159, 144.700997109625], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-37.8751576905159, 144.700997109625], fallbackDataset: [144.700997109625, -37.8751576905159]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-vic-vicmap-parcel', idPrefix: 'AU-VIC-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=b62e9a7b32fc49f090c2644b2a7ed871">State of Victoria, Department of Transport and Planning, Vicmap Parcel. CC BY 4.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        mansa: {
            id: 'mansa', wupCityCode: '2412',
            label: translateCityText('city.labels.mansa', 'Mansa, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-11.2019915432278, 28.8911174838639], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-11.2019915432278, 28.8911174838639], fallbackDataset: [28.8911174838639, -11.2019915432278]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        chingola: {
            id: 'chingola', wupCityCode: '1183',
            label: translateCityText('city.labels.chingola', 'Chingola, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-12.5459298146707, 27.8723779018079], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-12.5459298146707, 27.8723779018079], fallbackDataset: [27.8723779018079, -12.5459298146707]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-lots', idPrefix: 'ZM-NSDI-LOTS-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        madadeni: {
            id: 'madadeni', wupCityCode: '5074',
            label: translateCityText('city.labels.madadeni', 'Madadeni, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-27.7708606886661, 30.0898860571651], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-27.7708606886661, 30.0898860571651], fallbackDataset: [30.0898860571651, -27.7708606886661]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        kabwe: {
            id: 'kabwe', wupCityCode: '1945',
            label: translateCityText('city.labels.kabwe', 'Kabwe, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-14.4336039608812, 28.4446474227614], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-14.4336039608812, 28.4446474227614], fallbackDataset: [28.4446474227614, -14.4336039608812]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        rennes: {
            id: 'rennes', wupCityCode: '1037',
            label: translateCityText('city.labels.rennes', 'Rennes, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.1077099658178, -1.66805550111597], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.1077099658178, -1.66805550111597], fallbackDataset: [-1.66805550111597, 48.1077099658178]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        cinco_ranch: {
            id: 'cinco_ranch', wupCityCode: '6201',
            label: translateCityText('city.labels.cinco_ranch', 'Cinco Ranch, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [29.7637175582969, -95.7466412885247], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [29.7637175582969, -95.7466412885247], fallbackDataset: [-95.7466412885247, 29.7637175582969]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-harris-hcad-parcels', idPrefix: 'US-TX-HCAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0">Harris County Appraisal District / Harris County GIS. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        cannes: {
            id: 'cannes', wupCityCode: '4760',
            label: translateCityText('city.labels.cannes', 'Cannes, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.5719458326226, 7.04733103055821], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.5719458326226, 7.04733103055821], fallbackDataset: [7.04733103055821, 43.5719458326226]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        rustenburg: {
            id: 'rustenburg', wupCityCode: '3294',
            label: translateCityText('city.labels.rustenburg', 'Rustenburg, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.647609084368, 27.2136775618594], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-25.647609084368, 27.2136775618594], fallbackDataset: [27.2136775618594, -25.647609084368]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        tours: {
            id: 'tours', wupCityCode: '2162',
            label: translateCityText('city.labels.tours', 'Tours, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.3855108210304, 0.68814656071703], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.3855108210304, 0.68814656071703], fallbackDataset: [0.68814656071703, 47.3855108210304]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        nancy: {
            id: 'nancy', wupCityCode: '4503',
            label: translateCityText('city.labels.nancy', 'Nancy, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.684976784432, 6.17652544178752], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.684976784432, 6.17652544178752], fallbackDataset: [6.17652544178752, 48.684976784432]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        maurepas: {
            id: 'maurepas', wupCityCode: '2809',
            label: translateCityText('city.labels.maurepas', 'Maurepas, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.7790545654258, 2.01232272915475], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.7790545654258, 2.01232272915475], fallbackDataset: [2.01232272915475, 48.7790545654258]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        orleans: {
            id: 'orleans', wupCityCode: '2745',
            label: translateCityText('city.labels.orleans', 'Orléans, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.9070309670625, 1.910333917362], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.9070309670625, 1.910333917362], fallbackDataset: [1.910333917362, 47.9070309670625]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        burien: {
            id: 'burien', wupCityCode: '5359',
            label: translateCityText('city.labels.burien', 'Burien, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.5111975110014, -122.347924002959], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.5111975110014, -122.347924002959], fallbackDataset: [-122.347924002959, 47.5111975110014]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-wa-king-county-parcel-boundary', idPrefix: 'US-WA-KC-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gismaps.kingcounty.gov/parcelviewer2/">City of Seattle GIS · King County parcel boundaries</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        livingstone: {
            id: 'livingstone', wupCityCode: '429',
            label: translateCityText('city.labels.livingstone', 'Livingstone, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-17.8443175114028, 25.8579818245686], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-17.8443175114028, 25.8579818245686], fallbackDataset: [25.8579818245686, -17.8443175114028]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        dale_city: {
            id: 'dale_city', wupCityCode: '8116',
            label: translateCityText('city.labels.dale_city', 'Dale City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.6538966219803, -77.3154953850735], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [38.6538966219803, -77.3154953850735], fallbackDataset: [-77.3154953850735, 38.6538966219803]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        dijon: {
            id: 'dijon', wupCityCode: '4153',
            label: translateCityText('city.labels.dijon', 'Dijon, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.3224500591218, 5.03455990082728], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.3224500591218, 5.03455990082728], fallbackDataset: [5.03455990082728, 47.3224500591218]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        clermont_ferrand: {
            id: 'clermont_ferrand', wupCityCode: '3704',
            label: translateCityText('city.labels.clermont_ferrand', 'Clermont-Ferrand, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.7788192599618, 3.09538089789519], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.7788192599618, 3.09538089789519], fallbackDataset: [3.09538089789519, 45.7788192599618]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        reims: {
            id: 'reims', wupCityCode: '3847',
            label: translateCityText('city.labels.reims', 'Reims, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.2522532111006, 4.02982535965047], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.2522532111006, 4.02982535965047], fallbackDataset: [4.02982535965047, 49.2522532111006]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        le_havre: {
            id: 'le_havre', wupCityCode: '1922',
            label: translateCityText('city.labels.le_havre', 'Le Havre, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.4981726752836, 0.134070399129953], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.4981726752836, 0.134070399129953], fallbackDataset: [0.134070399129953, 49.4981726752836]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        lens: {
            id: 'lens', wupCityCode: '3390',
            label: translateCityText('city.labels.lens', 'Lens, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.4236894177911, 2.85912943634957], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.4236894177911, 2.85912943634957], fallbackDataset: [2.85912943634957, 50.4236894177911]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        surprise: {
            id: 'surprise', wupCityCode: '4893',
            label: translateCityText('city.labels.surprise', 'Surprise, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.6188868133642, -112.372924484317], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [33.6188868133642, -112.372924484317], fallbackDataset: [-112.372924484317, 33.6188868133642]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-az-maricopa-assessor-parcels', idPrefix: 'US-AZ-MARICOPA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://mcassessor.maricopa.gov/">Maricopa County Assessor&#x27;s Office. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        angers: {
            id: 'angers', wupCityCode: '1659',
            label: translateCityText('city.labels.angers', 'Angers, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.4675805985513, -0.546475968773458], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.4675805985513, -0.546475968773458], fallbackDataset: [-0.546475968773458, 47.4675805985513]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        cork: {
            id: 'cork', wupCityCode: '218',
            label: translateCityText('city.labels.cork', 'Cork, Ireland'),
            currency: { locale: 'en-IE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.8919175232513, -8.46231743765622], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [51.8919175232513, -8.46231743765622], fallbackDataset: [-8.46231743765622, 51.8919175232513]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ie-tailte-hvd-freehold', idPrefix: 'IE-SP-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.gov.ie/dataset/high-value-dataset-cadastral-parcels-freehold1">© Tailte Éireann · freehold title boundaries only · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        sakhrol: {
            id: 'sakhrol', wupCityCode: '2761',
            label: translateCityText('city.labels.sakhrol', 'Sakhrol, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.8915238480992, 26.5946978926275], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-26.8915238480992, 26.5946978926275], fallbackDataset: [26.5946978926275, -26.8915238480992]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        laveen: {
            id: 'laveen', wupCityCode: '4928',
            label: translateCityText('city.labels.laveen', 'Laveen, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.3870634428889, -112.090183211919], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [33.3870634428889, -112.090183211919], fallbackDataset: [-112.090183211919, 33.3870634428889]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-az-maricopa-assessor-parcels', idPrefix: 'US-AZ-MARICOPA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://mcassessor.maricopa.gov/">Maricopa County Assessor&#x27;s Office. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        caen: {
            id: 'caen', wupCityCode: '1838',
            label: translateCityText('city.labels.caen', 'Caen, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.1817332399594, -0.359577786626392], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.1817332399594, -0.359577786626392], fallbackDataset: [-0.359577786626392, 49.1817332399594]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        le_mans: {
            id: 'le_mans', wupCityCode: '2005',
            label: translateCityText('city.labels.le_mans', 'Le Mans, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.993038069969, 0.19931326476688], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.993038069969, 0.19931326476688], fallbackDataset: [0.19931326476688, 47.993038069969]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        metz: {
            id: 'metz', wupCityCode: '4429',
            label: translateCityText('city.labels.metz', 'Metz, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.1140645064827, 6.17540051586319], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.1140645064827, 6.17540051586319], fallbackDataset: [6.17540051586319, 49.1140645064827]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        homestead: {
            id: 'homestead', wupCityCode: '7263',
            label: translateCityText('city.labels.homestead', 'Homestead, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [25.4832250785167, -80.4466277419018], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [25.4832250785167, -80.4466277419018], fallbackDataset: [-80.4466277419018, 25.4832250785167]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-fl-miamidade-pa-parcels', idPrefix: 'US-FL-MIAMI-DADE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis-mdc.opendata.arcgis.com/datasets/MDC::parcel/about">Miami-Dade County GIS, Property Appraiser parcels. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        brest: {
            id: 'brest', wupCityCode: '524',
            label: translateCityText('city.labels.brest', 'Brest, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.3970003572057, -4.49027666677197], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.3970003572057, -4.49027666677197], fallbackDataset: [-4.49027666677197, 48.3970003572057]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        nimes: {
            id: 'nimes', wupCityCode: '4025',
            label: translateCityText('city.labels.nimes', 'Nimes, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.8363271141078, 4.35451021750621], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.8363271141078, 4.35451021750621], fallbackDataset: [4.35451021750621, 43.8363271141078]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        kwanobuhle: {
            id: 'kwanobuhle', wupCityCode: '1858',
            label: translateCityText('city.labels.kwanobuhle', 'KwaNobuhle, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-33.8165435653616, 25.3876641088701], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-33.8165435653616, 25.3876641088701], fallbackDataset: [25.3876641088701, -33.8165435653616]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        annecy: {
            id: 'annecy', wupCityCode: '4577',
            label: translateCityText('city.labels.annecy', 'Annecy, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.9079585806247, 6.11731386325407], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.9079585806247, 6.11731386325407], fallbackDataset: [6.11731386325407, 45.9079585806247]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        dallas_au: {
            id: 'dallas_au', wupCityCode: '1724',
            label: translateCityText('city.labels.dallas_au', 'Dallas, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-37.6257503775702, 144.925301017964], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-37.6257503775702, 144.925301017964], fallbackDataset: [144.925301017964, -37.6257503775702]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-vic-vicmap-parcel', idPrefix: 'AU-VIC-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=b62e9a7b32fc49f090c2644b2a7ed871">State of Victoria, Department of Transport and Planning, Vicmap Parcel. CC BY 4.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        gatineau: {
            id: 'gatineau', wupCityCode: '3541',
            label: translateCityText('city.labels.gatineau', 'Gatineau, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.4900584387138, -75.6695508443772], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.4900584387138, -75.6695508443772], fallbackDataset: [-75.6695508443772, 45.4900584387138]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        coalbrook: {
            id: 'coalbrook', wupCityCode: '3762',
            label: translateCityText('city.labels.coalbrook', 'Coalbrook, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.8555457508788, 27.8680543147876], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-26.8555457508788, 27.8680543147876], fallbackDataset: [27.8680543147876, -26.8555457508788]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        limoges: {
            id: 'limoges', wupCityCode: '2316',
            label: translateCityText('city.labels.limoges', 'Limoges, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.8323551960741, 1.25663886918468], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.8323551960741, 1.25663886918468], fallbackDataset: [1.25663886918468, 45.8323551960741]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        amiens: {
            id: 'amiens', wupCityCode: '3112',
            label: translateCityText('city.labels.amiens', 'Amiens, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.8915394519759, 2.30099003995009], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.8915394519759, 2.30099003995009], fallbackDataset: [2.30099003995009, 49.8915394519759]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        mpumalanga: {
            id: 'mpumalanga', wupCityCode: '5167',
            label: translateCityText('city.labels.mpumalanga', 'Mpumalanga, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-29.8105831623784, 30.626783378393], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-29.8105831623784, 30.626783378393], fallbackDataset: [30.626783378393, -29.8105831623784]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        stellenbosch: {
            id: 'stellenbosch', wupCityCode: '1173',
            label: translateCityText('city.labels.stellenbosch', 'Stellenbosch, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-33.9220058023364, 18.8581408012698], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-33.9220058023364, 18.8581408012698], fallbackDataset: [18.8581408012698, -33.9220058023364]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        pau: {
            id: 'pau', wupCityCode: '1749',
            label: translateCityText('city.labels.pau', 'Pau, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.3068960617087, -0.366814327032866], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.3068960617087, -0.366814327032866], fallbackDataset: [-0.366814327032866, 43.3068960617087]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        troyes: {
            id: 'troyes', wupCityCode: '3938',
            label: translateCityText('city.labels.troyes', 'Troyes, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.2934364366475, 4.06880952558493], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.2934364366475, 4.06880952558493], fallbackDataset: [4.06880952558493, 48.2934364366475]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        valenciennes: {
            id: 'valenciennes', wupCityCode: '3753',
            label: translateCityText('city.labels.valenciennes', 'Valenciennes, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.3601124544803, 3.5177086135875], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.3601124544803, 3.5177086135875], fallbackDataset: [3.5177086135875, 50.3601124544803]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        campbelltown: {
            id: 'campbelltown', wupCityCode: '1981',
            label: translateCityText('city.labels.campbelltown', 'Campbelltown, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-34.063620251064, 150.818086470537], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-34.063620251064, 150.818086470537], fallbackDataset: [150.818086470537, -34.063620251064]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-nsw-six-cadastre-lot', idPrefix: 'AU-NSW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9">NSW Spatial Services / Department of Customer Service, cadastral lots; adapted to WGS84. See publisher conditions.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        trois_rivieres: {
            id: 'trois_rivieres', wupCityCode: '4017',
            label: translateCityText('city.labels.trois_rivieres', 'Trois-Rivières, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.3564663630225, -72.5642843762759], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [46.3564663630225, -72.5642843762759], fallbackDataset: [-72.5642843762759, 46.3564663630225]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        repentigny: {
            id: 'repentigny', wupCityCode: '3930',
            label: translateCityText('city.labels.repentigny', 'Repentigny, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.7562771986768, -73.4524389608457], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.7562771986768, -73.4524389608457], fallbackDataset: [-73.4524389608457, 45.7562771986768]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        bayonne: {
            id: 'bayonne', wupCityCode: '1367',
            label: translateCityText('city.labels.bayonne', 'Bayonne, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.488520194426, -1.50621665272733], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.488520194426, -1.50621665272733], fallbackDataset: [-1.50621665272733, 43.488520194426]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        sainte_foy: {
            id: 'sainte_foy', wupCityCode: '4060',
            label: translateCityText('city.labels.sainte_foy', 'Sainte-Foy, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.761890089852, -71.3243530969267], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [46.761890089852, -71.3243530969267], fallbackDataset: [-71.3243530969267, 46.761890089852]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        poitiers: {
            id: 'poitiers', wupCityCode: '2083',
            label: translateCityText('city.labels.poitiers', 'Poitiers, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.5809521856312, 0.345786397743728], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [46.5809521856312, 0.345786397743728], fallbackDataset: [0.345786397743728, 46.5809521856312]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        montoya: {
            id: 'montoya', wupCityCode: '5247',
            label: translateCityText('city.labels.montoya', 'Montoya, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [31.8488538212543, -106.54653350243], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [31.8488538212543, -106.54653350243], fallbackDataset: [-106.54653350243, 31.8488538212543]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-el-paso-city-gis-parcels', idPrefix: 'US-TX-ELPASO-OBJECTID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://opendata.elpasotexas.gov/">El Paso public parcel reference map · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        kafue: {
            id: 'kafue', wupCityCode: '1396',
            label: translateCityText('city.labels.kafue', 'Kafue, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-15.7608203662575, 28.1749561677829], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-15.7608203662575, 28.1749561677829], fallbackDataset: [28.1749561677829, -15.7608203662575]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        jerusalem_za: {
            id: 'jerusalem_za', wupCityCode: '5395',
            label: translateCityText('city.labels.jerusalem_za', 'Jerusalem, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.1551904236958, 31.1295161397507], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-25.1551904236958, 31.1295161397507], fallbackDataset: [31.1295161397507, -25.1551904236958]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        le_mee_sur_seine: {
            id: 'le_mee_sur_seine', wupCityCode: '3227',
            label: translateCityText('city.labels.le_mee_sur_seine', 'Le Mée-sur-Seine, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.534769008477, 2.65180134337815], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.534769008477, 2.65180134337815], fallbackDataset: [2.65180134337815, 48.534769008477]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        sherbrooke: {
            id: 'sherbrooke', wupCityCode: '3974',
            label: translateCityText('city.labels.sherbrooke', 'Sherbrooke, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.4019145613402, -71.9004339251759], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.4019145613402, -71.9004339251759], fallbackDataset: [-71.9004339251759, 45.4019145613402]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        dunkirk: {
            id: 'dunkirk', wupCityCode: '3053',
            label: translateCityText('city.labels.dunkirk', 'Dunkirk, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.030649843182, 2.37038693978408], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [51.030649843182, 2.37038693978408], fallbackDataset: [2.37038693978408, 51.030649843182]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        cambridge_park: {
            id: 'cambridge_park', wupCityCode: '2060',
            label: translateCityText('city.labels.cambridge_park', 'Cambridge Park, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-33.761537051073, 150.704178051856], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-33.761537051073, 150.704178051856], fallbackDataset: [150.704178051856, -33.761537051073]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-nsw-six-cadastre-lot', idPrefix: 'AU-NSW-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9">NSW Spatial Services / Department of Customer Service, cadastral lots; adapted to WGS84. See publisher conditions.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        langwarrin: {
            id: 'langwarrin', wupCityCode: '1440',
            label: translateCityText('city.labels.langwarrin', 'Langwarrin, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-38.1424007782017, 145.147328797441], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-38.1424007782017, 145.147328797441], fallbackDataset: [145.147328797441, -38.1424007782017]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-vic-vicmap-parcel', idPrefix: 'AU-VIC-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=b62e9a7b32fc49f090c2644b2a7ed871">State of Victoria, Department of Transport and Planning, Vicmap Parcel. CC BY 4.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        lakeside: {
            id: 'lakeside', wupCityCode: '8074',
            label: translateCityText('city.labels.lakeside', 'Lakeside, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [37.6237420873137, -77.5466662646729], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [37.6237420873137, -77.5466662646729], fallbackDataset: [-77.5466662646729, 37.6237420873137]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        aix_en_provence: {
            id: 'aix_en_provence', wupCityCode: '4314',
            label: translateCityText('city.labels.aix_en_provence', 'Aix-en-Provence, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.5281700432726, 5.44089902875396], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.5281700432726, 5.44089902875396], fallbackDataset: [5.44089902875396, 43.5281700432726]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        annemasse: {
            id: 'annemasse', wupCityCode: '4614',
            label: translateCityText('city.labels.annemasse', 'Annemasse, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.1920523464964, 6.23337531803031], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [46.1920523464964, 6.23337531803031], fallbackDataset: [6.23337531803031, 46.1920523464964]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        lorient: {
            id: 'lorient', wupCityCode: '666',
            label: translateCityText('city.labels.lorient', 'Lorient, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.7496741766556, -3.36747847296714], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.7496741766556, -3.36747847296714], fallbackDataset: [-3.36747847296714, 47.7496741766556]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        poissy: {
            id: 'poissy', wupCityCode: '2934',
            label: translateCityText('city.labels.poissy', 'Poissy, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.9373728992024, 2.04485612042936], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.9373728992024, 2.04485612042936], fallbackDataset: [2.04485612042936, 48.9373728992024]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        nassau_bay: {
            id: 'nassau_bay', wupCityCode: '6429',
            label: translateCityText('city.labels.nassau_bay', 'Nassau Bay, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [29.5718416890512, -95.1251905565392], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [29.5718416890512, -95.1251905565392], fallbackDataset: [-95.1251905565392, 29.5718416890512]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-harris-hcad-parcels', idPrefix: 'US-TX-HCAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0">Harris County Appraisal District / Harris County GIS. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        avondale: {
            id: 'avondale', wupCityCode: '4822',
            label: translateCityText('city.labels.avondale', 'Avondale, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.4298305052063, -112.300758489489], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [33.4298305052063, -112.300758489489], fallbackDataset: [-112.300758489489, 33.4298305052063]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-az-maricopa-assessor-parcels', idPrefix: 'US-AZ-MARICOPA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://mcassessor.maricopa.gov/">Maricopa County Assessor&#x27;s Office. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        valence: {
            id: 'valence', wupCityCode: '4195',
            label: translateCityText('city.labels.valence', 'Valence, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.9310525128625, 4.90029987187105], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [44.9310525128625, 4.90029987187105], fallbackDataset: [4.90029987187105, 44.9310525128625]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        avignon: {
            id: 'avignon', wupCityCode: '4111',
            label: translateCityText('city.labels.avignon', 'Avignon, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.9435782595834, 4.82508109892887], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.9435782595834, 4.82508109892887], fallbackDataset: [4.82508109892887, 43.9435782595834]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        galway: {
            id: 'galway', wupCityCode: '47',
            label: translateCityText('city.labels.galway', 'Galway, Ireland'),
            currency: { locale: 'en-IE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [53.2754032975264, -9.05394189330571], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [53.2754032975264, -9.05394189330571], fallbackDataset: [-9.05394189330571, 53.2754032975264]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ie-tailte-hvd-freehold', idPrefix: 'IE-SP-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.gov.ie/dataset/high-value-dataset-cadastral-parcels-freehold1">© Tailte Éireann · freehold title boundaries only · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        henderson: {
            id: 'henderson', wupCityCode: '4786',
            label: translateCityText('city.labels.henderson', 'Henderson, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.0189560326963, -114.964137432928], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [36.0189560326963, -114.964137432928], fallbackDataset: [-114.964137432928, 36.0189560326963]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-nv-clark-assessor-parcels', idPrefix: 'US-NV-CLARK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://maps.clarkcountynv.gov/arcgis/rest/services/GISMO/AssessorMap/FeatureServer/1">Clark County Assessor / GISMO · parcel reference polygons</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        saint_jean_sur_richelieu: {
            id: 'saint_jean_sur_richelieu', wupCityCode: '3885',
            label: translateCityText('city.labels.saint_jean_sur_richelieu', 'Saint-Jean-sur-Richelieu, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.3244754486743, -73.2692282789854], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.3244754486743, -73.2692282789854], fallbackDataset: [-73.2692282789854, 45.3244754486743]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        manassas_park: {
            id: 'manassas_park', wupCityCode: '8109',
            label: translateCityText('city.labels.manassas_park', 'Manassas Park, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.7805995376932, -77.4907009907728], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [38.7805995376932, -77.4907009907728], fallbackDataset: [-77.4907009907728, 38.7805995376932]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        calais: {
            id: 'calais', wupCityCode: '2678',
            label: translateCityText('city.labels.calais', 'Calais, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.9510067614361, 1.86975615934025], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.9510067614361, 1.86975615934025], fallbackDataset: [1.86975615934025, 50.9510067614361]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        swords: {
            id: 'swords', wupCityCode: '663',
            label: translateCityText('city.labels.swords', 'Swords, Ireland'),
            currency: { locale: 'en-IE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [53.4523651121946, -6.20262009552807], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [53.4523651121946, -6.20262009552807], fallbackDataset: [-6.20262009552807, 53.4523651121946]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ie-tailte-hvd-freehold', idPrefix: 'IE-SP-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.gov.ie/dataset/high-value-dataset-cadastral-parcels-freehold1">© Tailte Éireann · freehold title boundaries only · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        saint_constant: {
            id: 'saint_constant', wupCityCode: '3745',
            label: translateCityText('city.labels.saint_constant', 'Saint-Constant, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.3858907489289, -73.550741926208], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.3858907489289, -73.550741926208], fallbackDataset: [-73.550741926208, 45.3858907489289]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        mankweng: {
            id: 'mankweng', wupCityCode: '5197',
            label: translateCityText('city.labels.mankweng', 'Mankweng, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-23.8927880512037, 29.7200189295319], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-23.8927880512037, 29.7200189295319], fallbackDataset: [29.7200189295319, -23.8927880512037]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        boulogne_sur_mer: {
            id: 'boulogne_sur_mer', wupCityCode: '2541',
            label: translateCityText('city.labels.boulogne_sur_mer', 'Boulogne-sur-Mer, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.7208164221729, 1.60460239298483], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.7208164221729, 1.60460239298483], fallbackDataset: [1.60460239298483, 50.7208164221729]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        melton: {
            id: 'melton', wupCityCode: '1541',
            label: translateCityText('city.labels.melton', 'Melton, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-37.6814071531491, 144.569508451494], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-37.6814071531491, 144.569508451494], fallbackDataset: [144.569508451494, -37.6814071531491]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-vic-vicmap-parcel', idPrefix: 'AU-VIC-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=b62e9a7b32fc49f090c2644b2a7ed871">State of Victoria, Department of Transport and Planning, Vicmap Parcel. CC BY 4.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        rosedale: {
            id: 'rosedale', wupCityCode: '3213',
            label: translateCityText('city.labels.rosedale', 'Rosedale, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.4078977941674, -119.108769926261], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [35.4078977941674, -119.108769926261], fallbackDataset: [-119.108769926261, 35.4078977941674]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-bakersfield-municipal-cadastral-parcels', idPrefix: 'US-BAKERSFIELD-APN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.bakersfieldcity.us/webmaps/rest/services/General/Cadastre/MapServer/1">City of Bakersfield GIS · cadastral parcel APN references · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        ekangala: {
            id: 'ekangala', wupCityCode: '4655',
            label: translateCityText('city.labels.ekangala', 'Ekangala, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.6765958332362, 28.738105593779], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-25.6765958332362, 28.738105593779], fallbackDataset: [28.738105593779, -25.6765958332362]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        chartres: {
            id: 'chartres', wupCityCode: '2466',
            label: translateCityText('city.labels.chartres', 'Chartres, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.4399842486095, 1.47900906363337], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.4399842486095, 1.47900906363337], fallbackDataset: [1.47900906363337, 48.4399842486095]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        beziers: {
            id: 'beziers', wupCityCode: '3800',
            label: translateCityText('city.labels.beziers', 'Béziers, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.3486761582679, 3.23146610496642], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.3486761582679, 3.23146610496642], fallbackDataset: [3.23146610496642, 43.3486761582679]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        asbury_park: {
            id: 'asbury_park', wupCityCode: '8367',
            label: translateCityText('city.labels.asbury_park', 'Asbury Park, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.2076369877962, -74.0242410688984], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [40.2076369877962, -74.0242410688984], fallbackDataset: [-74.0242410688984, 40.2076369877962]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-nj-trenton-parcels', idPrefix: 'US-NJ-TRENTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://nj.gov/njgin/edata/parcels/">New Jersey Office of Information Technology, Office of GIS (NJOGIS). Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        terrebonne: {
            id: 'terrebonne', wupCityCode: '3839',
            label: translateCityText('city.labels.terrebonne', 'Terrebonne, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.7085641674979, -73.6476016264373], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.7085641674979, -73.6476016264373], fallbackDataset: [-73.6476016264373, 45.7085641674979]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        atascocita: {
            id: 'atascocita', wupCityCode: '6509',
            label: translateCityText('city.labels.atascocita', 'Atascocita, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [29.9939041523149, -95.1780429611103], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [29.9939041523149, -95.1780429611103], fallbackDataset: [-95.1780429611103, 29.9939041523149]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-harris-hcad-parcels', idPrefix: 'US-TX-HCAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0">Harris County Appraisal District / Harris County GIS. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        douai: {
            id: 'douai', wupCityCode: '3602',
            label: translateCityText('city.labels.douai', 'Douai, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.3748780609615, 3.08623150802197], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.3748780609615, 3.08623150802197], fallbackDataset: [3.08623150802197, 50.3748780609615]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        meridian: {
            id: 'meridian', wupCityCode: '5494',
            label: translateCityText('city.labels.meridian', 'Meridian, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.6297298219097, -116.409780592603], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.6297298219097, -116.409780592603], fallbackDataset: [-116.409780592603, 43.6297298219097]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-id-ada-boise-parcels', idPrefix: 'US-ID-ADA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Public_Idaho_Parcels_/FeatureServer/7">Idaho Geospatial Office / The Idaho Map; parcel submissions stewarded by Ada County. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        mumbwa: {
            id: 'mumbwa', wupCityCode: '838',
            label: translateCityText('city.labels.mumbwa', 'Mumbwa, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-14.9896385277852, 27.0614658156504], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-14.9896385277852, 27.0614658156504], fallbackDataset: [27.0614658156504, -14.9896385277852]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.map.gov.zm/arcgis/rest/services/NSDI_Vector/CadasterNew/MapServer">Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        ajaccio: {
            id: 'ajaccio', wupCityCode: '4902',
            label: translateCityText('city.labels.ajaccio', 'Ajaccio, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.9323362354918, 8.7448317165461], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [41.9323362354918, 8.7448317165461], fallbackDataset: [8.7448317165461, 41.9323362354918]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        arras: {
            id: 'arras', wupCityCode: '3282',
            label: translateCityText('city.labels.arras', 'Arras, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.2884743408313, 2.7712389505543], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.2884743408313, 2.7712389505543], fallbackDataset: [2.7712389505543, 50.2884743408313]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        cherbourg_en_cotentin: {
            id: 'cherbourg_en_cotentin', wupCityCode: '1261',
            label: translateCityText('city.labels.cherbourg_en_cotentin', 'Cherbourg-en-Cotentin, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.6441780814002, -1.63397465947901], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.6441780814002, -1.63397465947901], fallbackDataset: [-1.63397465947901, 49.6441780814002]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        bohlokong: {
            id: 'bohlokong', wupCityCode: '4119',
            label: translateCityText('city.labels.bohlokong', 'Bohlokong, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-28.201963040675, 28.3267786786967], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-28.201963040675, 28.3267786786967], fallbackDataset: [28.3267786786967, -28.201963040675]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        saint_brieuc: {
            id: 'saint_brieuc', wupCityCode: '799',
            label: translateCityText('city.labels.saint_brieuc', 'Saint-Brieuc, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.5091567792358, -2.75448986561707], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.5091567792358, -2.75448986561707], fallbackDataset: [-2.75448986561707, 48.5091567792358]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        brits: {
            id: 'brits', wupCityCode: '3946',
            label: translateCityText('city.labels.brits', 'Brits, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.6123104329217, 27.791871188497], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-25.6123104329217, 27.791871188497], fallbackDataset: [27.791871188497, -25.6123104329217]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        ezakheni: {
            id: 'ezakheni', wupCityCode: '4975',
            label: translateCityText('city.labels.ezakheni', 'Ezakheni, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-28.6198900929786, 29.9129601172082], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-28.6198900929786, 29.9129601172082], fallbackDataset: [29.9129601172082, -28.6198900929786]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        cary: {
            id: 'cary', wupCityCode: '7997',
            label: translateCityText('city.labels.cary', 'Cary, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [35.784901551333, -78.7870570250863], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [35.784901551333, -78.7870570250863], fallbackDataset: [-78.7870570250863, 35.784901551333]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-nc-wake-raleigh-parcels', idPrefix: 'US-NC-WAKE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.nconemap.gov/pages/parcels">North Carolina Geographic Information Coordinating Council / NC OneMap, county data contributors. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        pittsville: {
            id: 'pittsville', wupCityCode: '6541',
            label: translateCityText('city.labels.pittsville', 'Pittsville, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [30.0640585361082, -95.1971592355123], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [30.0640585361082, -95.1971592355123], fallbackDataset: [-95.1971592355123, 30.0640585361082]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-harris-hcad-parcels', idPrefix: 'US-TX-HCAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0">Harris County Appraisal District / Harris County GIS. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        greenspoint: {
            id: 'greenspoint', wupCityCode: '6397',
            label: translateCityText('city.labels.greenspoint', 'Greenspoint, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [29.9325205499184, -95.3988351002803], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [29.9325205499184, -95.3988351002803], fallbackDataset: [-95.3988351002803, 29.9325205499184]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-tx-harris-hcad-parcels', idPrefix: 'US-TX-HCAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0">Harris County Appraisal District / Harris County GIS. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        pakenham: {
            id: 'pakenham', wupCityCode: '1813',
            label: translateCityText('city.labels.pakenham', 'Pakenham, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-38.071609200146, 145.471217620277], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-38.071609200146, 145.471217620277], fallbackDataset: [145.471217620277, -38.071609200146]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'au-vic-vicmap-parcel', idPrefix: 'AU-VIC-PARCEL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=b62e9a7b32fc49f090c2644b2a7ed871">State of Victoria, Department of Transport and Planning, Vicmap Parcel. CC BY 4.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        sugarland_run: {
            id: 'sugarland_run', wupCityCode: '8144',
            label: translateCityText('city.labels.sugarland_run', 'Sugarland Run, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [39.0426212119399, -77.3883142250015], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [39.0426212119399, -77.3883142250015], fallbackDataset: [-77.3883142250015, 39.0426212119399]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-va-richmond-parcels', idPrefix: 'US-VA-RICHMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.rva.gov/index.php/assessor-real-estate/gismapping">Virginia Geographic Information Network / Virginia Department of Emergency Management. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        bussy_saint_georges: {
            id: 'bussy_saint_georges', wupCityCode: '3443',
            label: translateCityText('city.labels.bussy_saint_georges', 'Bussy-Saint-Georges, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [48.840494113858, 2.71958855946101], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [48.840494113858, 2.71958855946101], fallbackDataset: [2.71958855946101, 48.840494113858]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        prairie_oaks: {
            id: 'prairie_oaks', wupCityCode: '4418',
            label: translateCityText('city.labels.prairie_oaks', 'Prairie Oaks, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [38.6720225936686, -121.148601042322], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [38.6720225936686, -121.148601042322], fallbackDataset: [-121.148601042322, 38.6720225936686]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ca-sacramento-active-parcels', idPrefix: 'US-CA-SACRAMENTO-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.saccounty.gov/">Sacramento County GIS. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        matsulu: {
            id: 'matsulu', wupCityCode: '5476',
            label: translateCityText('city.labels.matsulu', 'Matsulu, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-25.5098756982165, 31.3435761774052], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-25.5098756982165, 31.3435761774052], fallbackDataset: [31.3435761774052, -25.5098756982165]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        saint_jerome: {
            id: 'saint_jerome', wupCityCode: '3696',
            label: translateCityText('city.labels.saint_jerome', 'Saint-Jérôme, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.7822725905303, -73.9977167770777], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.7822725905303, -73.9977167770777], fallbackDataset: [-73.9977167770777, 45.7822725905303]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-cadastre-bd-allegee', idPrefix: 'CA-QC-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=07cfbd0ce7dc4d8ab53e7566b7055a55">Gouvernement du Québec · cadastre_bd_allegee / GO01_Polygones_Lots. Indicative cadastral geometry; coordinates have no legal value. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        khuma: {
            id: 'khuma', wupCityCode: '3126',
            label: translateCityText('city.labels.khuma', 'Khuma, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [-26.8507332371509, 26.8472605527769], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [-26.8507332371509, 26.8472605527769], fallbackDataset: [26.8472605527769, -26.8507332371509]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://csg.dlrrd.gov.za/data.htm">Chief Surveyor-General · DFFE hosted Erven · adapted</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        saint_nazaire: {
            id: 'saint_nazaire', wupCityCode: '921',
            label: translateCityText('city.labels.saint_nazaire', 'Saint-Nazaire, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [47.2768743201976, -2.22008257060929], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [47.2768743201976, -2.22008257060929], fallbackDataset: [-2.22008257060929, 47.2768743201976]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        // END qualification admission 2026-10-11 round2
        // BEGIN qualification admission 2026-10-11
        west_valley_city: {
            id: 'west_valley_city',
            wupCityCode: '5646',
            label: translateCityText('city.labels.west_valley_city', 'West Valley City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.65163559641750, -111.98751176472101], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [40.65163559641750, -111.98751176472101], fallbackDataset: [-111.98751176472101, 40.65163559641750]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ut-salt-lake-city-parcels', idPrefix: 'US-UT-SALTLAKE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.utah.gov/products/sgid/cadastre/parcels/">Utah Geospatial Resource Center and local government. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        surrey: {
            id: 'surrey',
            wupCityCode: '632',
            label: translateCityText('city.labels.surrey', 'Surrey, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.15784119960070, -122.84221420213500], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.15784119960070, -122.84221420213500], fallbackDataset: [-122.84221420213500, 49.15784119960070]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-bc-surrey-lots', idPrefix: 'CA-BC-SURREY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.surrey.ca/services-payments/online-services/maps-cosmos">City of Surrey cadastral lots</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        bologna: {
            id: 'bologna',
            wupCityCode: '3342',
            label: translateCityText('city.labels.bologna', 'Bologna, Italy'),
            currency: { locale: 'it-IT', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [44.49425276469090, 11.33834693403270], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [44.49425276469090, 11.33834693403270], fallbackDataset: [11.33834693403270, 44.49425276469090]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'it-bologna-sit-parcels', idPrefix: 'IT-BOLOGNA-SIT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://sitmappe.comune.bologna.it/arcgis/rest/services/CATASTO/CATASTO/MapServer">Comune di Bologna — Sistema Informativo Territoriale</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        geneva: {
            id: 'geneva',
            wupCityCode: '60',
            label: translateCityText('city.labels.geneva', 'Geneva, Switzerland'),
            currency: { locale: 'de-CH', code: 'CHF' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [46.20175209710790, 6.13622539632436], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [46.20175209710790, 6.13622539632436], fallbackDataset: [6.13622539632436, 46.20175209710790]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ch-ge-sitg-cadastre-rdppf', idPrefix: 'CH-GE-SITG-EGRID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://sitg.ge.ch/donnees/cad-parcelle-mensu">République et canton de Genève - Département du territoire / SITG</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        hamilton: {
            id: 'hamilton',
            wupCityCode: '2668',
            label: translateCityText('city.labels.hamilton', 'Hamilton, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.23353789189630, -79.85415871369750], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.23353789189630, -79.85415871369750], fallbackDataset: [-79.85415871369750, 43.23353789189630]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-on-hamilton-assessment-parcel', idPrefix: 'CA-ON-HAMILTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.arcgis.com/sharing/rest/content/items/b18cec4690d241029935df1b02bb19db?f=json">City of Hamilton; Teranet data received February 9, 2024.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        nice: {
            id: 'nice',
            wupCityCode: '4796',
            label: translateCityText('city.labels.nice', 'Nice, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.69871079052020, 7.23303214314509], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.69871079052020, 7.23303214314509], fallbackDataset: [7.23303214314509, 43.69871079052020]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'nice-cotedazur-cadastre-arcgis', idPrefix: 'FR-NCA-CADASTRE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://opendata.nicecotedazur.org/data/dataset/parcelles-cadastrales-de-la-metropole-nice-cote-d-azur">Métropole Nice Côte d’Azur / Direction de l’Information Géographique; service attribution DGFIP 2025; layer attribution DGFIP 2020.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        escondido: {
            id: 'escondido',
            wupCityCode: '3039',
            label: translateCityText('city.labels.escondido', 'Escondido, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.17850000000000, -117.16550000000001], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [33.17850000000000, -117.16550000000001], fallbackDataset: [-117.16550000000001, 33.17850000000000]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ca-escondido-parcels', idPrefix: 'US-CA-ESCONDIDO-',
                requiresBackend: true, ownership: false, liveRadiusKm: 0.75,
                attribution: '<a href="https://gis.escondido.gov/server/rest/services/Data/Parcels/FeatureServer/0">City of Escondido</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        stockton: {
            id: 'stockton',
            wupCityCode: '3536',
            label: translateCityText('city.labels.stockton', 'Stockton, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [37.98382553747830, -121.30363247299000], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [37.98382553747830, -121.30363247299000], fallbackDataset: [-121.30363247299000, 37.98382553747830]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'san-joaquin-county-diesel-wfl1-parcels', idPrefix: 'US-CA-SAN-JOAQUIN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://services3.arcgis.com/nUD9ady1mS8uVvoJ/ArcGIS/rest/services/Diesel_WFL1/FeatureServer/1">San Jouquin County CD/GIS & City of Stockton IT/GIS; Data Steward: San Joaquin County Assessor\'s Office</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        pittsburgh: {
            id: 'pittsburgh',
            wupCityCode: '8067',
            label: translateCityText('city.labels.pittsburgh', 'Pittsburgh, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [40.41968784797190, -79.97032616470270], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [40.41968784797190, -79.97032616470270], fallbackDataset: [-79.97032616470270, 40.41968784797190]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-pa-allegheny-parcels', idPrefix: 'US-PA-ALLEGHENY-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.wprdc.org/dataset/allegheny-county-parcel-boundaries1">Allegheny County DCS-GIS parcel boundaries</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        pasto: {
            id: 'pasto',
            wupCityCode: '351',
            label: translateCityText('city.labels.pasto', 'Pasto, Colombia'),
            currency: { locale: 'es-CO', code: 'COP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [1.20894437270640, -77.27726798642379], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [1.20894437270640, -77.27726798642379], fallbackDataset: [-77.27726798642379, 1.20894437270640]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'co-pasto-urban-parcels', idPrefix: 'CO-PASTO-URBAN-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geoportal.pasto.gov.co/server/rest/services/Planeacion/Mapa_base_registro_de_descargas/MapServer/29">Instituto Geográfico Agustín Codazzi - IGAC; Alcaldía de Pasto Geoportal</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        riverside: {
            id: 'riverside',
            wupCityCode: '3430',
            label: translateCityText('city.labels.riverside', 'Riverside, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [33.93519283447910, -117.44382199471600], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [33.93519283447910, -117.44382199471600], fallbackDataset: [-117.44382199471600, 33.93519283447910]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us.ca.riverside-city-parcels', idPrefix: 'us-ca-riverside-city:',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://mapriverside.riversideca.gov/server/rest/services/Cadastral/Cadastral_Public/MapServer/86">City of Riverside cadastral parcels</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        grenoble: {
            id: 'grenoble',
            wupCityCode: '4353',
            label: translateCityText('city.labels.grenoble', 'Grenoble, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.18061565493560, 5.72378420259572], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.18061565493560, 5.72378420259572], fallbackDataset: [5.72378420259572, 45.18061565493560]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.data.gouv.fr/datasets/parcellaire-express-pci">IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        longueuil: {
            id: 'longueuil',
            wupCityCode: '3792',
            label: translateCityText('city.labels.longueuil', 'Longueuil, Canada'),
            currency: { locale: 'fr-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [45.49950925363950, -73.46600805601641], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [45.49950925363950, -73.46600805601641], fallbackDataset: [-73.46600805601641, 45.49950925363950]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-qc-longueuil-cadastre', idPrefix: 'CA-QC-LONGUEUIL-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://geohub.longueuil.quebec/">Ville de Longueuil · municipal Cadastre</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        wazirabad: {
            id: 'wazirabad',
            wupCityCode: '7979',
            label: translateCityText('city.labels.wazirabad', 'Wazirabad, Pakistan'),
            currency: { locale: 'ur-PK', code: 'PKR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [32.43555460899340, 74.12484853458390], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [32.43555460899340, 74.12484853458390], fallbackDataset: [74.12484853458390, 32.43555460899340]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'pk-pulse-wazirabad-parcels', idPrefix: 'PK-PULSE-WAZIRABAD-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/35">Punjab PULSE / Punjab Land Records Authority; indicative cadastral reference polygons</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        buffalo: {
            id: 'buffalo',
            wupCityCode: '8207',
            label: translateCityText('city.labels.buffalo', 'Buffalo, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [42.93599285092330, -78.83904210082140], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [42.93599285092330, -78.83904210082140], fallbackDataset: [-78.83904210082140, 42.93599285092330]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-ny-erie-parcels', idPrefix: 'US-NY-ERIE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www3.erie.gov/gis/internet-mapping">Erie County Office of GIS</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        oshawa: {
            id: 'oshawa',
            wupCityCode: '3218',
            label: translateCityText('city.labels.oshawa', 'Oshawa, Canada'),
            currency: { locale: 'en-CA', code: 'CAD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.90387939224220, -78.88264500917960], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.90387939224220, -78.88264500917960], fallbackDataset: [-78.88264500917960, 43.90387939224220]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'ca-on-oshawa-assessed-parcels', idPrefix: 'CA-ON-OSHAWA-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://map.oshawa.ca/OpenData/Metadata/Parcel%20Metadata.pdf">City of Oshawa GIS</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        arlington: {
            id: 'arlington',
            wupCityCode: '6413',
            label: translateCityText('city.labels.arlington', 'Arlington, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [32.72350000000000, -97.06550000000000], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [32.72350000000000, -97.06550000000000], fallbackDataset: [-97.06550000000000, 32.72350000000000]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'arlington-tax-parcels', idPrefix: 'US-TX-ARLINGTON-',
                requiresBackend: true, ownership: false, liveRadiusKm: 0.75,
                attribution: '<a href="https://gis2.arlingtontx.gov/agsext2/rest/services/OpenData/OD_Property/MapServer/2">City of Arlington, Texas GIS / OpenData</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        brno: {
            id: 'brno',
            wupCityCode: '1168',
            label: translateCityText('city.labels.brno', 'Brno, Czechia'),
            currency: { locale: 'cs-CZ', code: 'CZK' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [49.20321041395900, 16.60972759299960], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [49.20321041395900, 16.60972759299960], fallbackDataset: [16.60972759299960, 49.20321041395900]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'brno-city-gis-katastr-g-parcely', idPrefix: 'CZ-BRNO-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://gis.brno.cz/ags3/rest/services/PUBLIC/katastr_g/MapServer">GIS města Brna PUBLIC/katastr_g ArcGIS Feature Layer 5 Parcely</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        hammond: {
            id: 'hammond',
            wupCityCode: '7729',
            label: translateCityText('city.labels.hammond', 'Hammond, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [41.58350000000000, -87.49850000000001], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [41.58350000000000, -87.49850000000001], fallbackDataset: [-87.49850000000001, 41.58350000000000]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'us-in-lake-hammond-parcels', idPrefix: 'US-IN-LAKE-HAMMOND-',
                requiresBackend: true, ownership: false, liveRadiusKm: 0.75,
                attribution: '<a href="https://www.arcgis.com/home/item.html?id=18b6b08c8c7e403cbd9451360c8f5a61">Lake County Surveyor\'s Office; parcel fabric maintained by Lake County Auditor\'s Office.</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        takasaki: {
            id: 'takasaki',
            wupCityCode: '5785',
            label: translateCityText('city.labels.takasaki', 'Takasaki, Japan'),
            currency: { locale: 'ja-JP', code: 'JPY' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [36.36229386639790, 139.03883816222501], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [36.36229386639790, 139.03883816222501], fallbackDataset: [139.03883816222501, 36.36229386639790]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'jp-takasaki-parcel-map', idPrefix: 'JP-TAKASAKI-FUDEID-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.city.takasaki.gunma.jp/uploaded/attachment/42714.zip">Takasaki City parcel-number map polygons</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        wiesbaden: {
            id: 'wiesbaden',
            wupCityCode: '2998',
            label: translateCityText('city.labels.wiesbaden', 'Wiesbaden, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.03241608752290, 8.24497585586087], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.03241608752290, 8.24497585586087], fallbackDataset: [8.24497585586087, 50.03241608752290]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.gds.hessen.de/wfs2/aaa-suite/cgi-bin/alkis/vereinf/wfs">Hessen simplified ALKIS cadastral parcels</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        gdansk: {
            id: 'gdansk',
            wupCityCode: '2093',
            label: translateCityText('city.labels.gdansk', 'Gdańsk, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [54.37291959618290, 18.61016516091930], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [54.37291959618290, 18.61016516091930], fallbackDataset: [18.61016516091930, 54.37291959618290]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'gdansk-gml-wfs', idPrefix: 'PL-GDANSK-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://ewid-wms.gdansk.gda.pl/iip/ows?service=WFS&amp;request=GetCapabilities&amp;version=2.0.0">Urząd Miejski w Gdańsku — EGiB</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        sosnowiec: {
            id: 'sosnowiec',
            wupCityCode: '3234',
            label: translateCityText('city.labels.sosnowiec', 'Sosnowiec, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [50.29225744192920, 19.14602055224050], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [50.29225744192920, 19.14602055224050], fallbackDataset: [19.14602055224050, 50.29225744192920]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'sosnowiec-gml-wfs', idPrefix: 'PL-SOSNOWIEC-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://www.sosnowiec.pl/2023/07/aktualnosci/teraz-wniosek-o-dane-zgromadzone-w-zasobie-geodezyjnym-zlozysz-przez-profil-zaufany-lub-konto-bankowe/">Sosnowiec municipal EGiB parcel polygons</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        montpellier: {
            id: 'montpellier',
            wupCityCode: '3893',
            label: translateCityText('city.labels.montpellier', 'Montpellier, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [43.61537014852960, 3.86647003777739], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [43.61537014852960, 3.86647003777739], fallbackDataset: [3.86647003777739, 43.61537014852960]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.001, source: 'parcel-source',
                sourceId: 'fr-mmm-montpellier-cadastre', idPrefix: 'FR-MMM-MONTPELLIER-CODEIDENT-',
                requiresBackend: true, ownership: false, liveRadiusKm: 3,
                attribution: '<a href="https://data.montpellier3m.fr/dataset/cadastre-de-montpellier">Montpellier municipal PCI cadastral parcels</a>'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }
        },
        // END qualification admission 2026-10-11
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
            projection: { datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
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
            projection: { datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
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
            projection: { datasetCrs: 'EPSG:4326',
                definition: '+proj=longlat +datum=WGS84 +no_defs',
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
            id: 'birmingham', wupCityCode: '3979',
            label: translateCityText('city.labels.birmingham', 'Birmingham, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [52.5053948519651, -1.95888767064615], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [52.5053948519651, -1.95888767064615], fallbackDataset: [-1.95888767064615, 52.5053948519651]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-',
                // IDs saved before the shared HMLR source still load from the source that issued them.
                historicalSources: [{ sourceId: 'gb-arcgis-geodom-land-registry-inspire-2021', idPrefix: 'GB-HMLR-' }],
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.'
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
            id: 'london', wupCityCode: '5938',
            label: translateCityText('city.labels.london', 'London, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [51.5097885891913, -0.126303973484058], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [51.5097885891913, -0.126303973484058], fallbackDataset: [-0.126303973484058, 51.5097885891913]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-',
                // IDs saved before the shared HMLR source still load from the source that issued them.
                historicalSources: [{ sourceId: 'gb-hmlr-city-of-london', idPrefix: 'GB-HMLR-LONDON-' }],
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.'
            },
            buildings: { source: 'osm' },
            sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        manchester: {
            id: 'manchester', wupCityCode: '3388',
            label: translateCityText('city.labels.manchester', 'Manchester, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: {
                initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM },
                defaultCenter: [53.4932710593779, -2.25653313803415], defaultZoom: SHARED_DEFAULT_ZOOM,
                parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08
            },
            projection: {
                datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs',
                fallbackLatLng: [53.4932710593779, -2.25653313803415], fallbackDataset: [-2.25653313803415, 53.4932710593779]
            },
            parcels: {
                strategy: 'grid', gridSize: 0.0025, source: 'parcel-source',
                sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-',
                // IDs saved before the shared HMLR source still load from the source that issued them.
                historicalSources: [{ sourceId: 'gb-hmlr-manchester', idPrefix: 'GB-HMLR-MANCHESTER-' }],
                requiresBackend: true, ownership: false, liveRadiusKm: 8,
                attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.'
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
        },
        newcastle: {
            id: 'newcastle', wupCityCode: '4536',
            label: translateCityText('city.labels.newcastle', 'Newcastle upon Tyne, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.9872907396255, -1.55381600364981], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.9872907396255, -1.55381600364981], fallbackDataset: [-1.55381600364981, 54.9872907396255] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        oxford: {
            id: 'oxford', wupCityCode: '5278',
            label: translateCityText('city.labels.oxford', 'Oxford, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.7487806598031, -1.2342485885213], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.7487806598031, -1.2342485885213], fallbackDataset: [-1.2342485885213, 51.7487806598031] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        cardiff: {
            id: 'cardiff', wupCityCode: '2001',
            label: translateCityText('city.labels.cardiff', 'Cardiff, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.4941598754672, -3.18365738997209], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.4941598754672, -3.18365738997209], fallbackDataset: [-3.18365738997209, 51.4941598754672] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bristol: {
            id: 'bristol', wupCityCode: '3110',
            label: translateCityText('city.labels.bristol', 'Bristol, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.4622070766796, -2.56948973765957], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.4622070766796, -2.56948973765957], fallbackDataset: [-2.56948973765957, 51.4622070766796] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        stoke_on_trent: {
            id: 'stoke_on_trent', wupCityCode: '3890',
            label: translateCityText('city.labels.stoke_on_trent', 'Stoke-on-Trent, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.0159155643046, -2.17437344168429], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.0159155643046, -2.17437344168429], fallbackDataset: [-2.17437344168429, 53.0159155643046] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bournemouth: {
            id: 'bournemouth', wupCityCode: '4108',
            label: translateCityText('city.labels.bournemouth', 'Bournemouth, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.7377349576354, -1.90482883545276], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.7377349576354, -1.90482883545276], fallbackDataset: [-1.90482883545276, 50.7377349576354] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leeds: {
            id: 'leeds', wupCityCode: '4425',
            label: translateCityText('city.labels.leeds', 'Leeds, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.80098765836, -1.64273048308533], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.80098765836, -1.64273048308533], fallbackDataset: [-1.64273048308533, 53.80098765836] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        coventry: {
            id: 'coventry', wupCityCode: '4647',
            label: translateCityText('city.labels.coventry', 'Coventry, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.4197855108422, -1.50597012431852], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.4197855108422, -1.50597012431852], fallbackDataset: [-1.50597012431852, 52.4197855108422] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        southampton: {
            id: 'southampton', wupCityCode: '4684',
            label: translateCityText('city.labels.southampton', 'Southampton, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.9183161488384, -1.39571519357], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.9183161488384, -1.39571519357], fallbackDataset: [-1.39571519357, 50.9183161488384] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sheffield: {
            id: 'sheffield', wupCityCode: '4792',
            label: translateCityText('city.labels.sheffield', 'Sheffield, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.3706060761954, -1.45914222195097], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.3706060761954, -1.45914222195097], fallbackDataset: [-1.45914222195097, 53.3706060761954] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        nottingham: {
            id: 'nottingham', wupCityCode: '5220',
            label: translateCityText('city.labels.nottingham', 'Nottingham, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.9581733581744, -1.18066491650301], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.9581733581744, -1.18066491650301], fallbackDataset: [-1.18066491650301, 52.9581733581744] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        middlesbrough: {
            id: 'middlesbrough', wupCityCode: '5250',
            label: translateCityText('city.labels.middlesbrough', 'Middlesbrough, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.560753928282, -1.26260886474088], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.560753928282, -1.26260886474088], fallbackDataset: [-1.26260886474088, 54.560753928282] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        portsmouth: {
            id: 'portsmouth', wupCityCode: '5388',
            label: translateCityText('city.labels.portsmouth', 'Portsmouth, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8299919480642, -1.08350256594045], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8299919480642, -1.08350256594045], fallbackDataset: [-1.08350256594045, 50.8299919480642] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leicester: {
            id: 'leicester', wupCityCode: '5469',
            label: translateCityText('city.labels.leicester', 'Leicester, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.6309139939256, -1.125767851843], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.6309139939256, -1.125767851843], fallbackDataset: [-1.125767851843, 52.6309139939256] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        brighton: {
            id: 'brighton', wupCityCode: '6034',
            label: translateCityText('city.labels.brighton', 'Brighton, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.832718747559, -0.232087060115579], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.832718747559, -0.232087060115579], fallbackDataset: [-0.232087060115579, 50.832718747559] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hull: {
            id: 'hull', wupCityCode: '6053',
            label: translateCityText('city.labels.hull', 'Hull, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.7628896052307, -0.354103477578705], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.7628896052307, -0.354103477578705], fallbackDataset: [-0.354103477578705, 53.7628896052307] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        southend_on_sea: {
            id: 'southend_on_sea', wupCityCode: '6431',
            label: translateCityText('city.labels.southend_on_sea', 'Southend-on-Sea, United Kingdom'),
            currency: { locale: 'en-GB', code: 'GBP' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.5551240047725, 0.668467014701583], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.5551240047725, 0.668467014701583], fallbackDataset: [0.668467014701583, 51.5551240047725] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: '<a href="https://use-land-property-data.service.gov.uk/datasets/inspire">HM Land Registry INSPIRE Index Polygons</a>, Crown copyright and database right. Application ground derived by deterministic overlap resolution.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        mongu: {
            id: 'mongu', wupCityCode: '104',
            label: translateCityText('city.labels.mongu', 'Mongu, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-15.2698331723381, 23.1518886178753], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-15.2698331723381, 23.1518886178753], fallbackDataset: [23.1518886178753, -15.2698331723381] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        la_rochelle: {
            id: 'la_rochelle', wupCityCode: '1469',
            label: translateCityText('city.labels.la_rochelle', 'La Rochelle, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [46.1625399538636, -1.16258542365523], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [46.1625399538636, -1.16258542365523], fallbackDataset: [-1.16258542365523, 46.1625399538636] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        luanshya: {
            id: 'luanshya', wupCityCode: '2025',
            label: translateCityText('city.labels.luanshya', 'Luanshya, Zambia'),
            currency: { locale: 'en-ZM', code: 'ZMW' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-13.1437301508279, 28.4228139265333], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-13.1437301508279, 28.4228139265333], fallbackDataset: [28.4228139265333, -13.1437301508279] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'zm-nsdi-zilmis-lots', idPrefix: 'ZM-NSDI-LOT-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Government of Zambia National Spatial Data Infrastructure / ZILMIS · cadastral-reference polygons · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        encinitas: {
            id: 'encinitas', wupCityCode: '2660',
            label: translateCityText('city.labels.encinitas', 'Encinitas, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [33.0602781384953, -117.267811873962], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [33.0602781384953, -117.267811873962], fallbackDataset: [-117.267811873962, 33.0602781384953] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ca-sangis-parcels-reference', idPrefix: 'US-CA-SANGIS-PARCEL-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'SanGIS / County of San Diego · unstacked reference parcel polygons' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lenasia: {
            id: 'lenasia', wupCityCode: '3855',
            label: translateCityText('city.labels.lenasia', 'Lenasia, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-26.3478558274038, 27.876034282466], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-26.3478558274038, 27.876034282466], fallbackDataset: [27.876034282466, -26.3478558274038] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Chief Surveyor-General · DFFE hosted Erven · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        vosman: {
            id: 'vosman', wupCityCode: '4800',
            label: translateCityText('city.labels.vosman', 'Vosman, South Africa'),
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-25.8573418214821, 29.1180026432058], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-25.8573418214821, 29.1180026432058], fallbackDataset: [29.1180026432058, -25.8573418214821] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'za-csg-dffe-erven', idPrefix: 'ZA-CSG-DFFE-ERVEN-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Chief Surveyor-General · DFFE hosted Erven · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        acireale: {
            id: 'acireale', wupCityCode: '5104',
            label: translateCityText('city.labels.acireale', 'Acireale, Italy'),
            currency: { locale: 'it-IT', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [37.6049746892746, 15.1470464254041], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [37.6049746892746, 15.1470464254041], fallbackDataset: [15.1470464254041, 37.6049746892746] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'it-sicilia-sitr-cadastral-parcels', idPrefix: 'IT-SICILIA-PARCEL-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Regione Siciliana SITR · cadastral-reference polygons · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lindberg: {
            id: 'lindberg', wupCityCode: '6345',
            label: translateCityText('city.labels.lindberg', 'Lindberg, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.6471024349277, -97.1431006262883], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.6471024349277, -97.1431006262883], fallbackDataset: [-97.1431006262883, 32.6471024349277] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'arlington-tax-parcels', idPrefix: 'US-TX-ARLINGTON-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'City of Arlington, Texas GIS / OpenData' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        buenaventura_lakes: {
            id: 'buenaventura_lakes', wupCityCode: '7367',
            label: translateCityText('city.labels.buenaventura_lakes', 'Buenaventura Lakes, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [28.3522565261019, -81.3782104985266], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [28.3522565261019, -81.3782104985266], fallbackDataset: [-81.3782104985266, 28.3522565261019] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'orlando-ocpa-arcgis', idPrefix: 'US-ORANGE-COUNTY-PARCEL-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Orange County Property Appraiser · assessment parcel references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        alafaya: {
            id: 'alafaya', wupCityCode: '7468',
            label: translateCityText('city.labels.alafaya', 'Alafaya, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [28.5645463354798, -81.1884381841486], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [28.5645463354798, -81.1884381841486], fallbackDataset: [-81.1884381841486, 28.5645463354798] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'orlando-ocpa-arcgis', idPrefix: 'US-ORANGE-COUNTY-PARCEL-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Orange County Property Appraiser · assessment parcel references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lackawanna: {
            id: 'lackawanna', wupCityCode: '8193',
            label: translateCityText('city.labels.lackawanna', 'Lackawanna, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.8429861120278, -78.8135507251543], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.8429861120278, -78.8135507251543], fallbackDataset: [-78.8135507251543, 42.8429861120278] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ny-erie-parcels', idPrefix: 'US-NY-ERIE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Erie County Office of GIS' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tung_chung: {
            id: 'tung_chung', wupCityCode: '11554',
            label: translateCityText('city.labels.tung_chung', 'Tung Chung, Hong Kong'),
            currency: { locale: 'zh-HK', code: 'HKD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [22.2862518536, 113.942260841835], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [22.2862518536, 113.942260841835], fallbackDataset: [113.942260841835, 22.2862518536] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hk-landsd-csdi-lot', idPrefix: 'HK-LANDSD-CSDI-LOT-CSUID-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hong Kong Lands Department · CSDI Lots · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        aachen: {
            id: 'aachen', wupCityCode: '58',
            label: translateCityText('city.labels.aachen', 'Aachen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.7798266066411, 6.10963543428455], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.7798266066411, 6.10963543428455], fallbackDataset: [6.10963543428455, 50.7798266066411] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        szczecin: {
            id: 'szczecin', wupCityCode: '71',
            label: translateCityText('city.labels.szczecin', 'Szczecin, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.4353064484097, 14.5350485616163], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.4353064484097, 14.5350485616163], fallbackDataset: [14.5350485616163, 53.4353064484097] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        liepaja: {
            id: 'liepaja', wupCityCode: '85',
            label: translateCityText('city.labels.liepaja', 'Liepaja, Latvia'),
            currency: { locale: 'lv-LV', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [56.512130385031, 21.0132738810649], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [56.512130385031, 21.0132738810649], fallbackDataset: [21.0132738810649, 56.512130385031] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'lv-vzd-geolatvija-vraa-wfs', idPrefix: 'LV-VZD-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'State Land Service of Latvia / Geolatvija · cadastral references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        klaipeda: {
            id: 'klaipeda', wupCityCode: '87',
            label: translateCityText('city.labels.klaipeda', 'Klaipėda, Lithuania'),
            currency: { locale: 'lt-LT', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [55.6958163069443, 21.1516808865547], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [55.6958163069443, 21.1516808865547], fallbackDataset: [21.1516808865547, 55.6958163069443] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'lt-inspire-cp-wfs', idPrefix: 'LT-INSP-CADASTRAL-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Lithuanian INSPIRE Geoportal / National Land Service · cadastral references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ioannina: {
            id: 'ioannina', wupCityCode: '99',
            label: translateCityText('city.labels.ioannina', 'Ioannina, Greece'),
            currency: { locale: 'el-GR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [39.661766124509, 20.8488973626991], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [39.661766124509, 20.8488973626991], fallbackDataset: [20.8488973626991, 39.661766124509] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gr-ktimatologio-active-parcels-arcgis', idPrefix: 'GR-ATHENS-KAEK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hellenic Cadastre (Ktimatologio) active cadastral layer, adapted to WGS84. Athens-center sample only; broader coverage and currentness unverified.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ashkelon: {
            id: 'ashkelon', wupCityCode: '118',
            label: translateCityText('city.labels.ashkelon', 'Ashkelon, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [31.6704500086532, 34.5726448021409], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [31.6704500086532, 34.5726448021409], fallbackDataset: [34.5726448021409, 31.6704500086532] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bruges: {
            id: 'bruges', wupCityCode: '226',
            label: translateCityText('city.labels.bruges', 'Bruges, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.2050163863974, 3.22000581359789], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.2050163863974, 3.22000581359789], fallbackDataset: [3.22000581359789, 51.2050163863974] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        stargard: {
            id: 'stargard', wupCityCode: '241',
            label: translateCityText('city.labels.stargard', 'Stargard, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.3382279105169, 15.030564201468], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.3382279105169, 15.030564201468], fallbackDataset: [15.030564201468, 53.3382279105169] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tartu: {
            id: 'tartu', wupCityCode: '267',
            label: translateCityText('city.labels.tartu', 'Tartu, Estonia'),
            currency: { locale: 'et-EE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [58.3707823955219, 26.7215611740785], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [58.3707823955219, 26.7215611740785], fallbackDataset: [26.7215611740785, 58.3707823955219] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'ee-maaamet-kataster-wfs', idPrefix: 'EE-KATASTER-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Estonian Land and Spatial Development Board / public cadastral WFS · cadastral references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ashdod: {
            id: 'ashdod', wupCityCode: '285',
            label: translateCityText('city.labels.ashdod', 'Ashdod, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [31.7987303087695, 34.65004462462], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [31.7987303087695, 34.65004462462], fallbackDataset: [34.65004462462, 31.7987303087695] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        christchurch: {
            id: 'christchurch', wupCityCode: '336',
            label: translateCityText('city.labels.christchurch', 'Christchurch, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-43.5242720408165, 172.621043454784], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-43.5242720408165, 172.621043454784], fallbackDataset: [172.621043454784, -43.5242720408165] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kortrijk: {
            id: 'kortrijk', wupCityCode: '385',
            label: translateCityText('city.labels.kortrijk', 'Kortrijk, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8375977978937, 3.28211721466875], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8375977978937, 3.28211721466875], fallbackDataset: [3.28211721466875, 50.8375977978937] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        krefeld: {
            id: 'krefeld', wupCityCode: '389',
            label: translateCityText('city.labels.krefeld', 'Krefeld, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3332048663585, 6.57862288660859], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3332048663585, 6.57862288660859], fallbackDataset: [6.57862288660859, 51.3332048663585] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gorzow_wielkopolski: {
            id: 'gorzow_wielkopolski', wupCityCode: '399',
            label: translateCityText('city.labels.gorzow_wielkopolski', 'Gorzów Wielkopolski, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.7429409230698, 15.2389393766615], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.7429409230698, 15.2389393766615], fallbackDataset: [15.2389393766615, 52.7429409230698] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        daugavpils: {
            id: 'daugavpils', wupCityCode: '420',
            label: translateCityText('city.labels.daugavpils', 'Daugavpils, Latvia'),
            currency: { locale: 'lv-LV', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [55.8797490625731, 26.5364228926285], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [55.8797490625731, 26.5364228926285], fallbackDataset: [26.5364228926285, 55.8797490625731] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'lv-vzd-geolatvija-vraa-wfs', idPrefix: 'LV-VZD-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'State Land Service of Latvia / Geolatvija · cadastral references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        larissa: {
            id: 'larissa', wupCityCode: '422',
            label: translateCityText('city.labels.larissa', 'Larissa, Greece'),
            currency: { locale: 'el-GR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [39.6319994376837, 22.418368874792], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [39.6319994376837, 22.418368874792], fallbackDataset: [22.418368874792, 39.6319994376837] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gr-ktimatologio-active-parcels-arcgis', idPrefix: 'GR-ATHENS-KAEK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hellenic Cadastre (Ktimatologio) active cadastral layer, adapted to WGS84. Athens-center sample only; broader coverage and currentness unverified.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ghent: {
            id: 'ghent', wupCityCode: '531',
            label: translateCityText('city.labels.ghent', 'Ghent, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.054687121172, 3.73169926424364], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.054687121172, 3.73169926424364], fallbackDataset: [3.73169926424364, 51.054687121172] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bocholt: {
            id: 'bocholt', wupCityCode: '534',
            label: translateCityText('city.labels.bocholt', 'Bocholt, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.837162361442, 6.61679793943415], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.837162361442, 6.61679793943415], fallbackDataset: [6.61679793943415, 51.837162361442] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        zielona_gora: {
            id: 'zielona_gora', wupCityCode: '544',
            label: translateCityText('city.labels.zielona_gora', 'Zielona Góra, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.9373160500613, 15.5023625952977], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.9373160500613, 15.5023625952977], fallbackDataset: [15.5023625952977, 51.9373160500613] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        panevezys: {
            id: 'panevezys', wupCityCode: '559',
            label: translateCityText('city.labels.panevezys', 'Panevėžys, Lithuania'),
            currency: { locale: 'lt-LT', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [55.7321711890858, 24.3528850529477], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [55.7321711890858, 24.3528850529477], fallbackDataset: [24.3528850529477, 55.7321711890858] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'lt-inspire-cp-wfs', idPrefix: 'LT-INSP-CADASTRAL-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Lithuanian INSPIRE Geoportal / National Land Service · cadastral references · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        haifa: {
            id: 'haifa', wupCityCode: '583',
            label: translateCityText('city.labels.haifa', 'Haifa, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.812430848624, 35.0251596262198], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.812430848624, 35.0251596262198], fallbackDataset: [35.0251596262198, 32.812430848624] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lower_hutt: {
            id: 'lower_hutt', wupCityCode: '629',
            label: translateCityText('city.labels.lower_hutt', 'Lower Hutt, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-41.2116311605753, 174.915386248703], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-41.2116311605753, 174.915386248703], fallbackDataset: [174.915386248703, -41.2116311605753] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leiden: {
            id: 'leiden', wupCityCode: '674',
            label: translateCityText('city.labels.leiden', 'Leiden, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.1673646768043, 4.4726761074768], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.1673646768043, 4.4726761074768], fallbackDataset: [4.4726761074768, 52.1673646768043] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        koszalin: {
            id: 'koszalin', wupCityCode: '685',
            label: translateCityText('city.labels.koszalin', 'Koszalin, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.19411056018, 16.1902100834576], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.19411056018, 16.1902100834576], fallbackDataset: [16.1902100834576, 54.19411056018] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        palmerston_north: {
            id: 'palmerston_north', wupCityCode: '763',
            label: translateCityText('city.labels.palmerston_north', 'Palmerston North, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-40.352703279079, 175.614308591725], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-40.352703279079, 175.614308591725], fallbackDataset: [175.614308591725, -40.352703279079] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        aalst: {
            id: 'aalst', wupCityCode: '804',
            label: translateCityText('city.labels.aalst', 'Aalst, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.9435433390796, 4.03960887199254], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.9435433390796, 4.03960887199254], fallbackDataset: [4.03960887199254, 50.9435433390796] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        zoetermeer: {
            id: 'zoetermeer', wupCityCode: '806',
            label: translateCityText('city.labels.zoetermeer', 'Zoetermeer, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.0580064519999, 4.50259377674063], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.0580064519999, 4.50259377674063], fallbackDataset: [4.50259377674063, 52.0580064519999] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lubin: {
            id: 'lubin', wupCityCode: '816',
            label: translateCityText('city.labels.lubin', 'Lubin, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3979869466992, 16.1963940635763], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3979869466992, 16.1963940635763], fallbackDataset: [16.1963940635763, 51.3979869466992] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        netanya: {
            id: 'netanya', wupCityCode: '844',
            label: translateCityText('city.labels.netanya', 'Netanya, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.3143145554001, 34.8598375549541], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.3143145554001, 34.8598375549541], fallbackDataset: [34.8598375549541, 32.3143145554001] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hamilton_nz: {
            id: 'hamilton_nz', wupCityCode: '888',
            label: translateCityText('city.labels.hamilton_nz', 'Hamilton, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-37.7752941478825, 175.273989779784], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-37.7752941478825, 175.273989779784], fallbackDataset: [175.273989779784, -37.7752941478825] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sint_niklaas: {
            id: 'sint_niklaas', wupCityCode: '926',
            label: translateCityText('city.labels.sint_niklaas', 'Sint-Niklaas, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.1653252425065, 4.14783441472725], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.1653252425065, 4.14783441472725], fallbackDataset: [4.14783441472725, 51.1653252425065] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        legnica: {
            id: 'legnica', wupCityCode: '937',
            label: translateCityText('city.labels.legnica', 'Legnica, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.2058512284457, 16.1741221611038], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.2058512284457, 16.1741221611038], fallbackDataset: [16.1741221611038, 51.2058512284457] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        chania: {
            id: 'chania', wupCityCode: '951',
            label: translateCityText('city.labels.chania', 'Chania, Greece'),
            currency: { locale: 'el-GR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [35.508865587634, 24.0224198967439], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [35.508865587634, 24.0224198967439], fallbackDataset: [24.0224198967439, 35.508865587634] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'gr-ktimatologio-active-parcels-arcgis', idPrefix: 'GR-ATHENS-KAEK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hellenic Cadastre (Ktimatologio) active cadastral layer, adapted to WGS84. Athens-center sample only; broader coverage and currentness unverified.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hadera: {
            id: 'hadera', wupCityCode: '961',
            label: translateCityText('city.labels.hadera', 'Hadera, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.4372849491784, 34.9185599229164], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.4372849491784, 34.9185599229164], fallbackDataset: [34.9185599229164, 32.4372849491784] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        heemskerk: {
            id: 'heemskerk', wupCityCode: '1043',
            label: translateCityText('city.labels.heemskerk', 'Heemskerk, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.4875107568307, 4.64912920315651], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.4875107568307, 4.64912920315651], fallbackDataset: [4.64912920315651, 52.4875107568307] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        slupsk: {
            id: 'slupsk', wupCityCode: '1053',
            label: translateCityText('city.labels.slupsk', 'Słupsk, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.4636975832782, 17.0213199178476], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.4636975832782, 17.0213199178476], fallbackDataset: [17.0213199178476, 54.4636975832782] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rehovot: {
            id: 'rehovot', wupCityCode: '1075',
            label: translateCityText('city.labels.rehovot', 'Rehovot, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [31.8958134072658, 34.8097538728296], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [31.8958134072658, 34.8097538728296], fallbackDataset: [34.8097538728296, 31.8958134072658] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        papakura: {
            id: 'papakura', wupCityCode: '1120',
            label: translateCityText('city.labels.papakura', 'Papakura, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-37.0379819273102, 174.906818249879], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-37.0379819273102, 174.906818249879], fallbackDataset: [174.906818249879, -37.0379819273102] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        nantes: {
            id: 'nantes', wupCityCode: '1152',
            label: translateCityText('city.labels.nantes', 'Nantes, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [47.2226716545731, -1.55741025412737], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [47.2226716545731, -1.55741025412737], fallbackDataset: [-1.55741025412737, 47.2226716545731] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        haarlem: {
            id: 'haarlem', wupCityCode: '1158',
            label: translateCityText('city.labels.haarlem', 'Haarlem, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.3821638892441, 4.64006831462338], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.3821638892441, 4.64006831462338], fallbackDataset: [4.64006831462338, 52.3821638892441] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        pila: {
            id: 'pila', wupCityCode: '1167',
            label: translateCityText('city.labels.pila', 'Pila, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.1513682979439, 16.7464328052244], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.1513682979439, 16.7464328052244], fallbackDataset: [16.7464328052244, 53.1513682979439] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        glenfield: {
            id: 'glenfield', wupCityCode: '1232',
            label: translateCityText('city.labels.glenfield', 'Glenfield, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-36.769531623771, 174.735780487087], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-36.769531623771, 174.735780487087], fallbackDataset: [174.735780487087, -36.769531623771] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hoofddorp: {
            id: 'hoofddorp', wupCityCode: '1267',
            label: translateCityText('city.labels.hoofddorp', 'Hoofddorp, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.3054351617886, 4.66703282561631], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.3054351617886, 4.66703282561631], fallbackDataset: [4.66703282561631, 52.3054351617886] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leszno: {
            id: 'leszno', wupCityCode: '1275',
            label: translateCityText('city.labels.leszno', 'Leszno, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.8427843893659, 16.5773027600746], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.8427843893659, 16.5773027600746], fallbackDataset: [16.5773027600746, 51.8427843893659] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        otumoetai: {
            id: 'otumoetai', wupCityCode: '1338',
            label: translateCityText('city.labels.otumoetai', 'Otūmoetai, New Zealand'),
            currency: { locale: 'en-NZ', code: 'NZD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-37.6995938088887, 176.14886316288], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-37.6995938088887, 176.14886316288], fallbackDataset: [176.14886316288, -37.6995938088887] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nz-linz-primary-parcels-arcgis', idPrefix: 'nz-linz:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Toitū Te Whenua Land Information New Zealand primary parcels; public ArcGIS publication. Retain LINZ attribution and published CC BY conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        dordrecht: {
            id: 'dordrecht', wupCityCode: '1373',
            label: translateCityText('city.labels.dordrecht', 'Dordrecht, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.8143926922208, 4.67469211847365], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.8143926922208, 4.67469211847365], fallbackDataset: [4.67469211847365, 51.8143926922208] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hurth: {
            id: 'hurth', wupCityCode: '1375',
            label: translateCityText('city.labels.hurth', 'Hürth, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8574852314233, 6.89340663734576], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8574852314233, 6.89340663734576], fallbackDataset: [6.89340663734576, 50.8574852314233] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        daliyat_al_karmel: {
            id: 'daliyat_al_karmel', wupCityCode: '1400',
            label: translateCityText('city.labels.daliyat_al_karmel', 'Daliyat al-Karmel, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.7014534889277, 35.0558952294538], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.7014534889277, 35.0558952294538], fallbackDataset: [35.0558952294538, 32.7014534889277] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        mechelen: {
            id: 'mechelen', wupCityCode: '1474',
            label: translateCityText('city.labels.mechelen', 'Mechelen, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.025998805418, 4.48126862657754], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.025998805418, 4.48126862657754], fallbackDataset: [4.48126862657754, 51.025998805418] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        alphen_aan_den_rijn: {
            id: 'alphen_aan_den_rijn', wupCityCode: '1475',
            label: translateCityText('city.labels.alphen_aan_den_rijn', 'Alphen aan den Rijn, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.1332574588064, 4.65782890208914], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.1332574588064, 4.65782890208914], fallbackDataset: [4.65782890208914, 52.1332574588064] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tira: {
            id: 'tira', wupCityCode: '1502',
            label: translateCityText('city.labels.tira', 'Tira, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.2342787180447, 34.9544323813687], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.2342787180447, 34.9544323813687], fallbackDataset: [34.9544323813687, 32.2342787180447] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        alkmaar: {
            id: 'alkmaar', wupCityCode: '1571',
            label: translateCityText('city.labels.alkmaar', 'Alkmaar, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.6522439366888, 4.78238265594386], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.6522439366888, 4.78238265594386], fallbackDataset: [4.78238265594386, 52.6522439366888] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leuven: {
            id: 'leuven', wupCityCode: '1572',
            label: translateCityText('city.labels.leuven', 'Leuven, Belgium'),
            currency: { locale: 'nl-BE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8812852650943, 4.70774709568462], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8812852650943, 4.70774709568462], fallbackDataset: [4.70774709568462, 50.8812852650943] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'be-vlaanderen-grb-adp', idPrefix: 'BE-GRB-ADP-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        marl: {
            id: 'marl', wupCityCode: '1573',
            label: translateCityText('city.labels.marl', 'Marl, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.6681556413441, 7.10509206272269], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.6681556413441, 7.10509206272269], fallbackDataset: [7.10509206272269, 51.6681556413441] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wroclaw: {
            id: 'wroclaw', wupCityCode: '1580',
            label: translateCityText('city.labels.wroclaw', 'Wrocław, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.1052197969447, 17.0226844994164], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.1052197969447, 17.0226844994164], fallbackDataset: [17.0226844994164, 51.1052197969447] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rosh_haayin: {
            id: 'rosh_haayin', wupCityCode: '1597',
            label: translateCityText('city.labels.rosh_haayin', 'Rosh HaAyin, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.105795719819, 34.9640712304425], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.105795719819, 34.9640712304425], fallbackDataset: [34.9640712304425, 32.105795719819] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gouda: {
            id: 'gouda', wupCityCode: '1664',
            label: translateCityText('city.labels.gouda', 'Gouda, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.020062520535, 4.71398619919552], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.020062520535, 4.71398619919552], fallbackDataset: [4.71398619919552, 52.020062520535] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gniezno: {
            id: 'gniezno', wupCityCode: '1673',
            label: translateCityText('city.labels.gniezno', 'Gniezno, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.5344430787909, 17.6064312677703], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.5344430787909, 17.6064312677703], fallbackDataset: [17.6064312677703, 52.5344430787909] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kafr_yasif: {
            id: 'kafr_yasif', wupCityCode: '1688',
            label: translateCityText('city.labels.kafr_yasif', 'Kafr Yasif, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.9538350684818, 35.1826472209271], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.9538350684818, 35.1826472209271], fallbackDataset: [35.1826472209271, 32.9538350684818] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        remscheid: {
            id: 'remscheid', wupCityCode: '1756',
            label: translateCityText('city.labels.remscheid', 'Remscheid, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.1817871834151, 7.2043470437967], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.1817871834151, 7.2043470437967], fallbackDataset: [7.2043470437967, 51.1817871834151] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wejherowo: {
            id: 'wejherowo', wupCityCode: '1763',
            label: translateCityText('city.labels.wejherowo', 'Wejherowo, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.6054036640665, 18.2391802227089], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.6054036640665, 18.2391802227089], fallbackDataset: [18.2391802227089, 54.6054036640665] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        beersheba: {
            id: 'beersheba', wupCityCode: '1864',
            label: translateCityText('city.labels.beersheba', 'Beersheba, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [31.2545180899882, 34.7869140000578], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [31.2545180899882, 34.7869140000578], fallbackDataset: [34.7869140000578, 31.2545180899882] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wollongong: {
            id: 'wollongong', wupCityCode: '1898',
            label: translateCityText('city.labels.wollongong', 'Wollongong, Australia'),
            currency: { locale: 'en-AU', code: 'AUD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [-34.3954725106608, 150.8905776549], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [-34.3954725106608, 150.8905776549], fallbackDataset: [150.8905776549, -34.3954725106608] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'au-nsw-six-cadastre-lot', idPrefix: 'AU-NSW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'NSW Spatial Services / Department of Customer Service, cadastral lots; adapted to WGS84. See publisher conditions.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        purmerend: {
            id: 'purmerend', wupCityCode: '1927',
            label: translateCityText('city.labels.purmerend', 'Purmerend, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.5033693716876, 4.96148509531992], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.5033693716876, 4.96148509531992], fallbackDataset: [4.96148509531992, 52.5033693716876] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hagen: {
            id: 'hagen', wupCityCode: '1928',
            label: translateCityText('city.labels.hagen', 'Hagen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3659087620314, 7.46735353305389], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3659087620314, 7.46735353305389], fallbackDataset: [7.46735353305389, 51.3659087620314] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gdynia: {
            id: 'gdynia', wupCityCode: '1935',
            label: translateCityText('city.labels.gdynia', 'Gdynia, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.5322041862711, 18.5076341710355], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.5322041862711, 18.5076341710355], fallbackDataset: [18.5076341710355, 54.5322041862711] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        taibe: {
            id: 'taibe', wupCityCode: '1947',
            label: translateCityText('city.labels.taibe', 'Taibe, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.2649299482491, 35.0081305909969], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.2649299482491, 35.0081305909969], fallbackDataset: [35.0081305909969, 32.2649299482491] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hoorn: {
            id: 'hoorn', wupCityCode: '2008',
            label: translateCityText('city.labels.hoorn', 'Hoorn, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.6558213441406, 5.06975918263357], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.6558213441406, 5.06975918263357], fallbackDataset: [5.06975918263357, 52.6558213441406] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ostrow_wielkopolski: {
            id: 'ostrow_wielkopolski', wupCityCode: '2014',
            label: translateCityText('city.labels.ostrow_wielkopolski', 'Ostrów Wielkopolski, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.6497384459528, 17.8138050881419], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.6497384459528, 17.8138050881419], fallbackDataset: [17.8138050881419, 51.6497384459528] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        munster: {
            id: 'munster', wupCityCode: '2088',
            label: translateCityText('city.labels.munster', 'Münster, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.9527203351823, 7.6263298998742], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.9527203351823, 7.6263298998742], fallbackDataset: [7.6263298998742, 51.9527203351823] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        umm_al_fahm: {
            id: 'umm_al_fahm', wupCityCode: '2105',
            label: translateCityText('city.labels.umm_al_fahm', 'Umm al-Fahm, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [32.5239214711844, 35.1523058461333], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [32.5239214711844, 35.1523058461333], fallbackDataset: [35.1523058461333, 32.5239214711844] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        unna: {
            id: 'unna', wupCityCode: '2167',
            label: translateCityText('city.labels.unna', 'Unna, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.5396885168331, 7.65878768202864], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.5396885168331, 7.65878768202864], fallbackDataset: [7.65878768202864, 51.5396885168331] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        inowroclaw: {
            id: 'inowroclaw', wupCityCode: '2172',
            label: translateCityText('city.labels.inowroclaw', 'Inowrocław, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.7902336993022, 18.2590588435053], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.7902336993022, 18.2590588435053], fallbackDataset: [18.2590588435053, 52.7902336993022] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        modiin_maccabim_reut: {
            id: 'modiin_maccabim_reut', wupCityCode: '2184',
            label: translateCityText('city.labels.modiin_maccabim_reut', 'Modiin-Maccabim-Reut, Israel'),
            currency: { locale: 'he-IL', code: 'ILS' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [31.8986246886273, 35.0077621307069], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [31.8986246886273, 35.0077621307069], fallbackDataset: [35.0077621307069, 31.8986246886273] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'il-govmap-cadastral-parcel-rows', idPrefix: 'govmap:row:', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Govmap public cadastral parcel rows; public geometry, publisher conditions informational. 123 complete source parcel rows in 13 separate city cells; fresh shared-identity and footprint/binding checks pass. Provider OBJECTID references are not statutory parcel numbers. Wider completeness and legal currentness unverified. Geographic city scope does not express a political boundary or recognition claim. Large exact-ID batches can be slow (40 rows took 85 seconds); original transient timeouts are retained in evidence.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        livermore: {
            id: 'livermore', wupCityCode: '2218',
            label: translateCityText('city.labels.livermore', 'Livermore, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [37.678488891042, -121.767840355486], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [37.678488891042, -121.767840355486], fallbackDataset: [-121.767840355486, 37.678488891042] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ca-calfire-statewide-parcels', idPrefix: 'US-CA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'CAL FIRE, California Statewide Parcels Public View (county assessor parcel data). Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rouen: {
            id: 'rouen', wupCityCode: '2239',
            label: translateCityText('city.labels.rouen', 'Rouen, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.4334014958952, 1.08426580718412], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.4334014958952, 1.08426580718412], fallbackDataset: [1.08426580718412, 49.4334014958952] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ludenscheid: {
            id: 'ludenscheid', wupCityCode: '2244',
            label: translateCityText('city.labels.ludenscheid', 'Lüdenscheid, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.2199872933547, 7.63018199810285], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.2199872933547, 7.63018199810285], fallbackDataset: [7.63018199810285, 51.2199872933547] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kalisz: {
            id: 'kalisz', wupCityCode: '2249',
            label: translateCityText('city.labels.kalisz', 'Kalisz, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.7549404064184, 18.0833173060179], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.7549404064184, 18.0833173060179], fallbackDataset: [18.0833173060179, 51.7549404064184] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bussum: {
            id: 'bussum', wupCityCode: '2319',
            label: translateCityText('city.labels.bussum', 'Bussum, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2773118416372, 5.16304422962181], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2773118416372, 5.16304422962181], fallbackDataset: [5.16304422962181, 52.2773118416372] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        iserlohn: {
            id: 'iserlohn', wupCityCode: '2320',
            label: translateCityText('city.labels.iserlohn', 'Iserlohn, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3791903656589, 7.68570083680636], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3791903656589, 7.68570083680636], fallbackDataset: [7.68570083680636, 51.3791903656589] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tczew: {
            id: 'tczew', wupCityCode: '2325',
            label: translateCityText('city.labels.tczew', 'Tczew, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.0908371715605, 18.7843364944908], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.0908371715605, 18.7843364944908], fallbackDataset: [18.7843364944908, 54.0908371715605] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hilversum: {
            id: 'hilversum', wupCityCode: '2395',
            label: translateCityText('city.labels.hilversum', 'Hilversum, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2216945481736, 5.17282299607963], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2216945481736, 5.17282299607963], fallbackDataset: [5.17282299607963, 52.2216945481736] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        opole: {
            id: 'opole', wupCityCode: '2401',
            label: translateCityText('city.labels.opole', 'Opole, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.6681692860732, 17.9404125955347], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.6681692860732, 17.9404125955347], fallbackDataset: [17.9404125955347, 50.6681692860732] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        almere: {
            id: 'almere', wupCityCode: '2470',
            label: translateCityText('city.labels.almere', 'Almere, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.377455091164, 5.24278468537167], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.377455091164, 5.24278468537167], fallbackDataset: [5.24278468537167, 52.377455091164] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hamm: {
            id: 'hamm', wupCityCode: '2471',
            label: translateCityText('city.labels.hamm', 'Hamm, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.6789688105277, 7.78773684717369], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.6789688105277, 7.78773684717369], fallbackDataset: [7.78773684717369, 51.6789688105277] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        torun: {
            id: 'torun', wupCityCode: '2476',
            label: translateCityText('city.labels.torun', 'Toruń, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.0245852712266, 18.6212481126872], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.0245852712266, 18.6212481126872], fallbackDataset: [18.6212481126872, 53.0245852712266] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        zeist: {
            id: 'zeist', wupCityCode: '2544',
            label: translateCityText('city.labels.zeist', 'Zeist, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.0897846498778, 5.23582173112321], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.0897846498778, 5.23582173112321], fallbackDataset: [5.23582173112321, 52.0897846498778] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        grudziadz: {
            id: 'grudziadz', wupCityCode: '2549',
            label: translateCityText('city.labels.grudziadz', 'Grudziądz, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.4788249167263, 18.7571110836073], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.4788249167263, 18.7571110836073], fallbackDataset: [18.7571110836073, 53.4788249167263] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        s_hertogenbosch: {
            id: 's_hertogenbosch', wupCityCode: '2615',
            label: translateCityText('city.labels.s_hertogenbosch', '\'s-Hertogenbosch, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.7066884581067, 5.31629111142042], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.7066884581067, 5.31629111142042], fallbackDataset: [5.31629111142042, 51.7066884581067] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        elblag: {
            id: 'elblag', wupCityCode: '2620',
            label: translateCityText('city.labels.elblag', 'Elbląg, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.1668551128978, 19.4103120545885], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.1668551128978, 19.4103120545885], fallbackDataset: [19.4103120545885, 54.1668551128978] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        amersfoort: {
            id: 'amersfoort', wupCityCode: '2682',
            label: translateCityText('city.labels.amersfoort', 'Amersfoort, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.1691038816767, 5.39728040800154], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.1691038816767, 5.39728040800154], fallbackDataset: [5.39728040800154, 52.1691038816767] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wloclawek: {
            id: 'wloclawek', wupCityCode: '2687',
            label: translateCityText('city.labels.wloclawek', 'Włocławek, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.6505942526297, 19.0626658622382], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.6505942526297, 19.0626658622382], fallbackDataset: [19.0626658622382, 52.6505942526297] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lelystad: {
            id: 'lelystad', wupCityCode: '2749',
            label: translateCityText('city.labels.lelystad', 'Lelystad, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.5058770190195, 5.47327676910043], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.5058770190195, 5.47327676910043], fallbackDataset: [5.47327676910043, 52.5058770190195] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        siegen: {
            id: 'siegen', wupCityCode: '2750',
            label: translateCityText('city.labels.siegen', 'Siegen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8899005634816, 8.02247385221933], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8899005634816, 8.02247385221933], fallbackDataset: [8.02247385221933, 50.8899005634816] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rybnik: {
            id: 'rybnik', wupCityCode: '2754',
            label: translateCityText('city.labels.rybnik', 'Rybnik, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.099180479429, 18.5383788655106], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.099180479429, 18.5383788655106], fallbackDataset: [18.5383788655106, 50.099180479429] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        eindhoven: {
            id: 'eindhoven', wupCityCode: '2813',
            label: translateCityText('city.labels.eindhoven', 'Eindhoven, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.4432163203009, 5.45844256201511], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.4432163203009, 5.45844256201511], fallbackDataset: [5.45844256201511, 51.4432163203009] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        freiburg_im_breisgau: {
            id: 'freiburg_im_breisgau', wupCityCode: '2814',
            label: translateCityText('city.labels.freiburg_im_breisgau', 'Freiburg im Breisgau, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.0006635061131, 7.83778338402154], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.0006635061131, 7.83778338402154], fallbackDataset: [7.83778338402154, 48.0006635061131] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        jastrzebie_zdroj: {
            id: 'jastrzebie_zdroj', wupCityCode: '2818',
            label: translateCityText('city.labels.jastrzebie_zdroj', 'Jastrzębie-Zdrój, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.9518257086113, 18.5908434066578], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.9518257086113, 18.5908434066578], fallbackDataset: [18.5908434066578, 49.9518257086113] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        oss: {
            id: 'oss', wupCityCode: '2876',
            label: translateCityText('city.labels.oss', 'Oss, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.7661201043065, 5.52895010311022], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.7661201043065, 5.52895010311022], fallbackDataset: [5.52895010311022, 51.7661201043065] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gliwice: {
            id: 'gliwice', wupCityCode: '2881',
            label: translateCityText('city.labels.gliwice', 'Gliwice, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.2974825733379, 18.6726701509765], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.2974825733379, 18.6726701509765], fallbackDataset: [18.6726701509765, 50.2974825733379] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        veenendaal: {
            id: 'veenendaal', wupCityCode: '2937',
            label: translateCityText('city.labels.veenendaal', 'Veenendaal, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.0224599462408, 5.55574016955085], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.0224599462408, 5.55574016955085], fallbackDataset: [5.55574016955085, 52.0224599462408] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gutersloh: {
            id: 'gutersloh', wupCityCode: '2938',
            label: translateCityText('city.labels.gutersloh', 'Gütersloh, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.9044262053087, 8.38418745049793], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.9044262053087, 8.38418745049793], fallbackDataset: [8.38418745049793, 51.9044262053087] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ede: {
            id: 'ede', wupCityCode: '2997',
            label: translateCityText('city.labels.ede', 'Ede, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.0353765306542, 5.65323487609329], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.0353765306542, 5.65323487609329], fallbackDataset: [5.65323487609329, 52.0353765306542] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        helmond: {
            id: 'helmond', wupCityCode: '3056',
            label: translateCityText('city.labels.helmond', 'Helmond, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.4711841170888, 5.66069182320304], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.4711841170888, 5.66069182320304], fallbackDataset: [5.66069182320304, 51.4711841170888] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        pabianice: {
            id: 'pabianice', wupCityCode: '3061',
            label: translateCityText('city.labels.pabianice', 'Pabianice, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.6609967628735, 19.3534282663508], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.6609967628735, 19.3534282663508], fallbackDataset: [19.3534282663508, 51.6609967628735] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        leeuwarden: {
            id: 'leeuwarden', wupCityCode: '3115',
            label: translateCityText('city.labels.leeuwarden', 'Leeuwarden, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.2003327872053, 5.80785745182904], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.2003327872053, 5.80785745182904], fallbackDataset: [5.80785745182904, 53.2003327872053] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        nijmegen: {
            id: 'nijmegen', wupCityCode: '3173',
            label: translateCityText('city.labels.nijmegen', 'Nijmegen, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.8273681725996, 5.82030557604345], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.8273681725996, 5.82030557604345], fallbackDataset: [5.82030557604345, 51.8273681725996] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bielefeld: {
            id: 'bielefeld', wupCityCode: '3174',
            label: translateCityText('city.labels.bielefeld', 'Bielefeld, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.0195333690261, 8.54753242156078], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.0195333690261, 8.54753242156078], fallbackDataset: [8.54753242156078, 52.0195333690261] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tychy: {
            id: 'tychy', wupCityCode: '3178',
            label: translateCityText('city.labels.tychy', 'Tychy, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.1188429468754, 18.987175031002], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.1188429468754, 18.987175031002], fallbackDataset: [18.987175031002, 50.1188429468754] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        maastricht: {
            id: 'maastricht', wupCityCode: '3230',
            label: translateCityText('city.labels.maastricht', 'Maastricht, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8485108833663, 5.69710839005175], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8485108833663, 5.69710839005175], fallbackDataset: [5.69710839005175, 50.8485108833663] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        arnhem: {
            id: 'arnhem', wupCityCode: '3285',
            label: translateCityText('city.labels.arnhem', 'Arnhem, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.9720027817995, 5.91461730519761], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.9720027817995, 5.91461730519761], fallbackDataset: [5.91461730519761, 51.9720027817995] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        herford: {
            id: 'herford', wupCityCode: '3286',
            label: translateCityText('city.labels.herford', 'Herford, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.1186742740275, 8.67431041713781], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.1186742740275, 8.67431041713781], fallbackDataset: [8.67431041713781, 52.1186742740275] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        plock: {
            id: 'plock', wupCityCode: '3289',
            label: translateCityText('city.labels.plock', 'Płock, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.5430998887522, 19.7195485490596], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.5430998887522, 19.7195485490596], fallbackDataset: [19.7195485490596, 52.5430998887522] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        apeldoorn: {
            id: 'apeldoorn', wupCityCode: '3340',
            label: translateCityText('city.labels.apeldoorn', 'Apeldoorn, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2088941318488, 5.97243707164198], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2088941318488, 5.97243707164198], fallbackDataset: [5.97243707164198, 52.2088941318488] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        russelsheim_am_main: {
            id: 'russelsheim_am_main', wupCityCode: '3341',
            label: translateCityText('city.labels.russelsheim_am_main', 'Rüsselsheim am Main, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.990515288114, 8.43382940878915], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.990515288114, 8.43382940878915], fallbackDataset: [8.43382940878915, 49.990515288114] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hessisches Landesamt für Bodenmanagement und Geoinformation · parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        zwolle: {
            id: 'zwolle', wupCityCode: '3393',
            label: translateCityText('city.labels.zwolle', 'Zwolle, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.5132062071371, 6.09243811399258], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.5132062071371, 6.09243811399258], fallbackDataset: [6.09243811399258, 52.5132062071371] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        karlsruhe: {
            id: 'karlsruhe', wupCityCode: '3394',
            label: translateCityText('city.labels.karlsruhe', 'Karlsruhe, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.0084967221897, 8.4011625005132], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.0084967221897, 8.4011625005132], fallbackDataset: [8.4011625005132, 49.0084967221897] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bielsko_biala: {
            id: 'bielsko_biala', wupCityCode: '3397',
            label: translateCityText('city.labels.bielsko_biala', 'Bielsko-Biała, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.8178778643515, 19.0423255904236], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.8178778643515, 19.0423255904236], fallbackDataset: [19.0423255904236, 49.8178778643515] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        heerlen: {
            id: 'heerlen', wupCityCode: '3446',
            label: translateCityText('city.labels.heerlen', 'Heerlen, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.9001389828976, 5.99426673932929], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.9001389828976, 5.99426673932929], fallbackDataset: [5.99426673932929, 50.9001389828976] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        mannheim: {
            id: 'mannheim', wupCityCode: '3447',
            label: translateCityText('city.labels.mannheim', 'Mannheim, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.485482134892, 8.47482558079509], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.485482134892, 8.47482558079509], fallbackDataset: [8.47482558079509, 49.485482134892] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        piotrkow_trybunalski: {
            id: 'piotrkow_trybunalski', wupCityCode: '3449',
            label: translateCityText('city.labels.piotrkow_trybunalski', 'Piotrków Trybunalski, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.4086733870137, 19.6836162711193], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.4086733870137, 19.6836162711193], fallbackDataset: [19.6836162711193, 51.4086733870137] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        deventer: {
            id: 'deventer', wupCityCode: '3499',
            label: translateCityText('city.labels.deventer', 'Deventer, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2589851524138, 6.17977057589214], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2589851524138, 6.17977057589214], fallbackDataset: [6.17977057589214, 52.2589851524138] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        olsztyn: {
            id: 'olsztyn', wupCityCode: '3502',
            label: translateCityText('city.labels.olsztyn', 'Olsztyn, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.7665732876546, 20.4978271160328], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.7665732876546, 20.4978271160328], fallbackDataset: [20.4978271160328, 53.7665732876546] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        groningen: {
            id: 'groningen', wupCityCode: '3552',
            label: translateCityText('city.labels.groningen', 'Groningen, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.2187480982514, 6.5694015697624], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.2187480982514, 6.5694015697624], fallbackDataset: [6.5694015697624, 53.2187480982514] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        paderborn: {
            id: 'paderborn', wupCityCode: '3553',
            label: translateCityText('city.labels.paderborn', 'Paderborn, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.7199802103556, 8.75710708517565], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.7199802103556, 8.75710708517565], fallbackDataset: [8.75710708517565, 51.7199802103556] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-nrw-lika-flurstueck', idPrefix: 'DE-NRW-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Bezirksregierung Köln / Geobasis NRW, ALKIS simplified schema. Datenlizenz Deutschland – Zero 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tomaszow_mazowiecki: {
            id: 'tomaszow_mazowiecki', wupCityCode: '3555',
            label: translateCityText('city.labels.tomaszow_mazowiecki', 'Tomaszów Mazowiecki, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.5340194073462, 20.0135606379077], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.5340194073462, 20.0135606379077], fallbackDataset: [20.0135606379077, 51.5340194073462] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        almelo: {
            id: 'almelo', wupCityCode: '3605',
            label: translateCityText('city.labels.almelo', 'Almelo, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.3551248247847, 6.65940688231402], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.3551248247847, 6.65940688231402], fallbackDataset: [6.65940688231402, 52.3551248247847] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hengelo: {
            id: 'hengelo', wupCityCode: '3656',
            label: translateCityText('city.labels.hengelo', 'Hengelo, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2689917662346, 6.80085741213038], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2689917662346, 6.80085741213038], fallbackDataset: [6.80085741213038, 52.2689917662346] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        giessen: {
            id: 'giessen', wupCityCode: '3657',
            label: translateCityText('city.labels.giessen', 'Gießen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.5871854112385, 8.67930634779687], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.5871854112385, 8.67930634779687], fallbackDataset: [8.67930634779687, 50.5871854112385] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hessisches Landesamt für Bodenmanagement und Geoinformation · parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        warszawa_warsaw: {
            id: 'warszawa_warsaw', wupCityCode: '3660',
            label: translateCityText('city.labels.warszawa_warsaw', 'Warszawa (Warsaw), Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2229170530915, 21.0008161096485], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2229170530915, 21.0008161096485], fallbackDataset: [21.0008161096485, 52.2229170530915] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        enschede: {
            id: 'enschede', wupCityCode: '3707',
            label: translateCityText('city.labels.enschede', 'Enschede, Netherlands'),
            currency: { locale: 'nl-NL', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.2156183904437, 6.88434157506402], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.2156183904437, 6.88434157506402], fallbackDataset: [6.88434157506402, 52.2156183904437] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'nl-pdok-brk-kadastrale-kaart', idPrefix: 'NL-BRK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Kadaster / PDOK, Kadastrale Kaart, CC BY 4.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        darmstadt: {
            id: 'darmstadt', wupCityCode: '3708',
            label: translateCityText('city.labels.darmstadt', 'Darmstadt, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.8775164874442, 8.65106829046502], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.8775164874442, 8.65106829046502], fallbackDataset: [8.65106829046502, 49.8775164874442] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hessisches Landesamt für Bodenmanagement und Geoinformation · parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        legionowo: {
            id: 'legionowo', wupCityCode: '3710',
            label: translateCityText('city.labels.legionowo', 'Legionowo, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.4039665953965, 20.9252703477092], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.4039665953965, 20.9252703477092], fallbackDataset: [20.9252703477092, 52.4039665953965] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        heidelberg: {
            id: 'heidelberg', wupCityCode: '3756',
            label: translateCityText('city.labels.heidelberg', 'Heidelberg, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.3910185824291, 8.6720920591206], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.3910185824291, 8.6720920591206], fallbackDataset: [8.6720920591206, 49.3910185824291] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kielce: {
            id: 'kielce', wupCityCode: '3758',
            label: translateCityText('city.labels.kielce', 'Kielce, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8750758566059, 20.6275441266407], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8750758566059, 20.6275441266407], fallbackDataset: [20.6275441266407, 50.8750758566059] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wolomin: {
            id: 'wolomin', wupCityCode: '3805',
            label: translateCityText('city.labels.wolomin', 'Wołomin, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.342697415251, 21.2337346051155], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.342697415251, 21.2337346051155], fallbackDataset: [21.2337346051155, 52.342697415251] },
            parcels: { strategy: 'point', gridSize: 0.0025, source: 'parcel-source', sourceId: 'pl-gugik-uldk', idPrefix: 'PL-ULDK-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK ULDK · county EGiB cadastral parcels · parcel lookup on click' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        pforzheim: {
            id: 'pforzheim', wupCityCode: '3849',
            label: translateCityText('city.labels.pforzheim', 'Pforzheim, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.8884978124238, 8.69418460384127], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.8884978124238, 8.69418460384127], fallbackDataset: [8.69418460384127, 48.8884978124238] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        radom: {
            id: 'radom', wupCityCode: '3851',
            label: translateCityText('city.labels.radom', 'Radom, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3964628828514, 21.1526507651136], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3964628828514, 21.1526507651136], fallbackDataset: [21.1526507651136, 51.3964628828514] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hanau: {
            id: 'hanau', wupCityCode: '3895',
            label: translateCityText('city.labels.hanau', 'Hanau, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.1192991264763, 8.92227699927494], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.1192991264763, 8.92227699927494], fallbackDataset: [8.92227699927494, 50.1192991264763] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hessisches Landesamt für Bodenmanagement und Geoinformation · parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        nowy_sacz: {
            id: 'nowy_sacz', wupCityCode: '3897',
            label: translateCityText('city.labels.nowy_sacz', 'Nowy Sącz, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.6140452924349, 20.6998999214814], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.6140452924349, 20.6998999214814], fallbackDataset: [20.6998999214814, 49.6140452924349] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        davis: {
            id: 'davis', wupCityCode: '3926',
            label: translateCityText('city.labels.davis', 'Davis, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [38.553067679527, -121.743239448172], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [38.553067679527, -121.743239448172], fallbackDataset: [-121.743239448172, 38.553067679527] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ca-calfire-statewide-parcels', idPrefix: 'US-CA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'CAL FIRE, California Statewide Parcels Public View (county assessor parcel data). Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tarnow: {
            id: 'tarnow', wupCityCode: '3942',
            label: translateCityText('city.labels.tarnow', 'Tarnów, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.0164917071665, 20.9877709077343], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.0164917071665, 20.9877709077343], fallbackDataset: [20.9877709077343, 50.0164917071665] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sindelfingen: {
            id: 'sindelfingen', wupCityCode: '3984',
            label: translateCityText('city.labels.sindelfingen', 'Sindelfingen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.6952777912253, 9.00720562643213], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.6952777912253, 9.00720562643213], fallbackDataset: [9.00720562643213, 48.6952777912253] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lomza: {
            id: 'lomza', wupCityCode: '3986',
            label: translateCityText('city.labels.lomza', 'Łomża, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.1714002876591, 22.0646901929271], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.1714002876591, 22.0646901929271], fallbackDataset: [22.0646901929271, 53.1714002876591] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        gerlingen: {
            id: 'gerlingen', wupCityCode: '4027',
            label: translateCityText('city.labels.gerlingen', 'Gerlingen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.8110813845571, 9.09691074394977], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.8110813845571, 9.09691074394977], fallbackDataset: [9.09691074394977, 48.8110813845571] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        elk: {
            id: 'elk', wupCityCode: '4029',
            label: translateCityText('city.labels.elk', 'Elk, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [53.8234849792281, 22.3576680534356], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [53.8234849792281, 22.3576680534356], fallbackDataset: [22.3576680534356, 53.8234849792281] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        madera: {
            id: 'madera', wupCityCode: '4056',
            label: translateCityText('city.labels.madera', 'Madera, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [36.9636127025836, -120.063186461836], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [36.9636127025836, -120.063186461836], fallbackDataset: [-120.063186461836, 36.9636127025836] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ca-calfire-statewide-parcels', idPrefix: 'US-CA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'CAL FIRE, California Statewide Parcels Public View (county assessor parcel data). Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        siedlce: {
            id: 'siedlce', wupCityCode: '4072',
            label: translateCityText('city.labels.siedlce', 'Siedlce, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [52.1656867656902, 22.2767061227765], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [52.1656867656902, 22.2767061227765], fallbackDataset: [22.2767061227765, 52.1656867656902] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        suwalki: {
            id: 'suwalki', wupCityCode: '4115',
            label: translateCityText('city.labels.suwalki', 'Suwałki, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [54.1043061997561, 22.9331027875897], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [54.1043061997561, 22.9331027875897], fallbackDataset: [22.9331027875897, 54.1043061997561] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        stalowa_wola: {
            id: 'stalowa_wola', wupCityCode: '4157',
            label: translateCityText('city.labels.stalowa_wola', 'Stalowa Wola, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.5664297325734, 22.0568167437462], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.5664297325734, 22.0568167437462], fallbackDataset: [22.0568167437462, 50.5664297325734] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kassel: {
            id: 'kassel', wupCityCode: '4197',
            label: translateCityText('city.labels.kassel', 'Kassel, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3151466598024, 9.48755550595054], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3151466598024, 9.48755550595054], fallbackDataset: [9.48755550595054, 51.3151466598024] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hessisches Landesamt für Bodenmanagement und Geoinformation · parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        rzeszow: {
            id: 'rzeszow', wupCityCode: '4199',
            label: translateCityText('city.labels.rzeszow', 'Rzeszów, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.0320723876861, 22.0039593163143], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.0320723876861, 22.0039593163143], fallbackDataset: [22.0039593163143, 50.0320723876861] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        heilbronn: {
            id: 'heilbronn', wupCityCode: '4238',
            label: translateCityText('city.labels.heilbronn', 'Heilbronn, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.1519115615472, 9.21652129447529], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.1519115615472, 9.21652129447529], fallbackDataset: [9.21652129447529, 49.1519115615472] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lublin: {
            id: 'lublin', wupCityCode: '4280',
            label: translateCityText('city.labels.lublin', 'Lublin, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.2411675205158, 22.5517979898529], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.2411675205158, 22.5517979898529], fallbackDataset: [22.5517979898529, 51.2411675205158] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        przemysl: {
            id: 'przemysl', wupCityCode: '4318',
            label: translateCityText('city.labels.przemysl', 'Przemyśl, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [49.7865703940357, 22.7720844417991], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [49.7865703940357, 22.7720844417991], fallbackDataset: [22.7720844417991, 49.7865703940357] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        reutlingen: {
            id: 'reutlingen', wupCityCode: '4354',
            label: translateCityText('city.labels.reutlingen', 'Reutlingen, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.494515205626, 9.2093446638816], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.494515205626, 9.2093446638816], fallbackDataset: [9.2093446638816, 48.494515205626] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        zamosc: {
            id: 'zamosc', wupCityCode: '4356',
            label: translateCityText('city.labels.zamosc', 'Zamość, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.7217702281141, 23.2609637553334], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.7217702281141, 23.2609637553334], fallbackDataset: [23.2609637553334, 50.7217702281141] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        chelm: {
            id: 'chelm', wupCityCode: '4394',
            label: translateCityText('city.labels.chelm', 'Chełm, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.1343001957731, 23.4775917479072], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.1343001957731, 23.4775917479072], fallbackDataset: [23.4775917479072, 51.1343001957731] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        constance: {
            id: 'constance', wupCityCode: '4430',
            label: translateCityText('city.labels.constance', 'Constance, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [47.6744214989573, 9.17309580098738], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [47.6744214989573, 9.17309580098738], fallbackDataset: [9.17309580098738, 47.6744214989573] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fulda: {
            id: 'fulda', wupCityCode: '4504',
            label: translateCityText('city.labels.fulda', 'Fulda, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.5519779322862, 9.69246242762928], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.5519779322862, 9.69246242762928], fallbackDataset: [9.69246242762928, 50.5519779322862] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'hessen-alkis-vereinfacht-wfs', idPrefix: 'DE-HE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Hessisches Landesamt für Bodenmanagement und Geoinformation · parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        toulon: {
            id: 'toulon', wupCityCode: '4540',
            label: translateCityText('city.labels.toulon', 'Toulon, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [43.1183148051142, 5.91190474692264], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [43.1183148051142, 5.91190474692264], fallbackDataset: [5.91190474692264, 43.1183148051142] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ravensburg: {
            id: 'ravensburg', wupCityCode: '4689',
            label: translateCityText('city.labels.ravensburg', 'Ravensburg, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [47.7945532106953, 9.62553797821608], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [47.7945532106953, 9.62553797821608], fallbackDataset: [9.62553797821608, 47.7945532106953] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        strasbourg: {
            id: 'strasbourg', wupCityCode: '4832',
            label: translateCityText('city.labels.strasbourg', 'Strasbourg, France'),
            currency: { locale: 'fr-FR', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.5776653862353, 7.74205726308135], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.5776653862353, 7.74205726308135], fallbackDataset: [7.74205726308135, 48.5776653862353] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'fr-ign-parcellaire-express', idPrefix: 'FR-PCI-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'IGN/DGFiP, Parcellaire Express (PCI), catalogue and updates linked; accessed October 2, 2026. Licence Ouverte 2.0. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ulm: {
            id: 'ulm', wupCityCode: '4833',
            label: translateCityText('city.labels.ulm', 'Ulm, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [48.3989825933644, 9.98693462795703], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [48.3989825933644, 9.98693462795703], fallbackDataset: [9.98693462795703, 48.3989825933644] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'de-bw-lgl-alkis-flurstueck', idPrefix: 'DE-BW-ALKIS-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'LGL Baden-Württemberg · ALKIS Flurstücke · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        hazel_dell: {
            id: 'hazel_dell', wupCityCode: '5217',
            label: translateCityText('city.labels.hazel_dell', 'Hazel Dell, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [45.6532383734832, -122.569426017328], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [45.6532383734832, -122.569426017328], fallbackDataset: [-122.569426017328, 45.6532383734832] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-wa-watech-statewide-parcels', idPrefix: 'US-WA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Washington Technology Solutions (WaTech) and Washington State counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bellevue: {
            id: 'bellevue', wupCityCode: '5413',
            label: translateCityText('city.labels.bellevue', 'Bellevue, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [47.6694577413674, -122.166399898028], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [47.6694577413674, -122.166399898028], fallbackDataset: [-122.166399898028, 47.6694577413674] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-wa-watech-statewide-parcels', idPrefix: 'US-WA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Washington Technology Solutions (WaTech) and Washington State counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        yakima: {
            id: 'yakima', wupCityCode: '5440',
            label: translateCityText('city.labels.yakima', 'Yakima, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [46.5950341911278, -120.53759265329], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [46.5950341911278, -120.53759265329], fallbackDataset: [-120.53759265329, 46.5950341911278] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-wa-watech-statewide-parcels', idPrefix: 'US-WA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Washington Technology Solutions (WaTech) and Washington State counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        zwickau: {
            id: 'zwickau', wupCityCode: '5472',
            label: translateCityText('city.labels.zwickau', 'Zwickau, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.7132491597848, 12.4833751663692], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.7132491597848, 12.4833751663692], fallbackDataset: [12.4833751663692, 50.7132491597848] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'dresden-saxony-gml-wfs', idPrefix: 'DE-SN-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GeoSN Saxony ALKIS parcel geometry · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        chemnitz: {
            id: 'chemnitz', wupCityCode: '5551',
            label: translateCityText('city.labels.chemnitz', 'Chemnitz, Germany'),
            currency: { locale: 'de-DE', code: 'EUR' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8270132341809, 12.9110519091696], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8270132341809, 12.9110519091696], fallbackDataset: [12.9110519091696, 50.8270132341809] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'dresden-saxony-gml-wfs', idPrefix: 'DE-SN-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GeoSN Saxony ALKIS parcel geometry · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        anchorage: {
            id: 'anchorage', wupCityCode: '5571',
            label: translateCityText('city.labels.anchorage', 'Anchorage, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [61.2001872597905, -149.82840565615], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [61.2001872597905, -149.82840565615], fallbackDataset: [-149.82840565615, 61.2001872597905] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ak-statewide-parcels-agol', idPrefix: 'US-AK-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Alaska local governments; compiled ArcGIS Online layer AK_Parcels. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        layton: {
            id: 'layton', wupCityCode: '5788',
            label: translateCityText('city.labels.layton', 'Layton, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.1024668531369, -112.008818127792], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.1024668531369, -112.008818127792], fallbackDataset: [-112.008818127792, 41.1024668531369] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ut-ugrc-statewide-parcels', idPrefix: 'US-UT-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Utah Geospatial Resource Center and Utah counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ogden: {
            id: 'ogden', wupCityCode: '5810',
            label: translateCityText('city.labels.ogden', 'Ogden, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.2172850013019, -111.961087851707], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.2172850013019, -111.961087851707], fallbackDataset: [-111.961087851707, 41.2172850013019] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ut-ugrc-statewide-parcels', idPrefix: 'US-UT-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Utah Geospatial Resource Center and Utah counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        boulder: {
            id: 'boulder', wupCityCode: '6089',
            label: translateCityText('city.labels.boulder', 'Boulder, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [40.0140689394027, -105.261838065455], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [40.0140689394027, -105.261838065455], fallbackDataset: [-105.261838065455, 40.0140689394027] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-co-oit-statewide-parcels', idPrefix: 'US-COLORADO-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Colorado Governor\'s Office of Information Technology GIS and contributing counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        greeley: {
            id: 'greeley', wupCityCode: '6165',
            label: translateCityText('city.labels.greeley', 'Greeley, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [40.4065900589356, -104.71555057375], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [40.4065900589356, -104.71555057375], fallbackDataset: [-104.71555057375, 40.4065900589356] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-co-oit-statewide-parcels', idPrefix: 'US-COLORADO-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Colorado Governor\'s Office of Information Technology GIS and contributing counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        south_central: {
            id: 'south_central', wupCityCode: '6665',
            label: translateCityText('city.labels.south_central', 'South Central, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [45.7817768816123, -108.549285709368], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [45.7817768816123, -108.549285709368], fallbackDataset: [-108.549285709368, 45.7817768816123] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-mt-helena-parcels', idPrefix: 'US-MT-HELENA-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Montana Department of Revenue and county GIS offices; integrated by Montana State Library. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        urbandale: {
            id: 'urbandale', wupCityCode: '7009',
            label: translateCityText('city.labels.urbandale', 'Urbandale, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.6149025063095, -93.6594933902087], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.6149025063095, -93.6594933902087], fallbackDataset: [-93.6594933902087, 41.6149025063095] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ia-des-moines-parcels', idPrefix: 'US-IA-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Iowa Department of Homeland Security & Emergency Management; University of Iowa public mirror. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bradenton: {
            id: 'bradenton', wupCityCode: '7093',
            label: translateCityText('city.labels.bradenton', 'Bradenton, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [27.461361061327, -82.582711212242], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [27.461361061327, -82.582711212242], fallbackDataset: [-82.582711212242, 27.461361061327] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        sarasota: {
            id: 'sarasota', wupCityCode: '7107',
            label: translateCityText('city.labels.sarasota', 'Sarasota, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [27.3213005254979, -82.5086315166656], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [27.3213005254979, -82.5086315166656], fallbackDataset: [-82.5086315166656, 27.3213005254979] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        bayonet_point: {
            id: 'bayonet_point', wupCityCode: '7120',
            label: translateCityText('city.labels.bayonet_point', 'Bayonet Point, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [28.2700137222575, -82.7070769589785], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [28.2700137222575, -82.7070769589785], fallbackDataset: [-82.7070769589785, 28.2700137222575] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        tampa: {
            id: 'tampa', wupCityCode: '7159',
            label: translateCityText('city.labels.tampa', 'Tampa, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [28.0030986140797, -82.4702888424246], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [28.0030986140797, -82.4702888424246], fallbackDataset: [-82.4702888424246, 28.0030986140797] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fargo: {
            id: 'fargo', wupCityCode: '7198',
            label: translateCityText('city.labels.fargo', 'Fargo, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [46.8614438595037, -96.8024909909751], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [46.8614438595037, -96.8024909909751], fallbackDataset: [-96.8024909909751, 46.8614438595037] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-nd-gishub-statewide-parcels', idPrefix: 'US-ND-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'North Dakota GIS Hub State Parcel Program and North Dakota counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ventura_bay: {
            id: 'ventura_bay', wupCityCode: '7211',
            label: translateCityText('city.labels.ventura_bay', 'Ventura Bay, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [27.9100995716056, -82.3147524355478], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [27.9100995716056, -82.3147524355478], fallbackDataset: [-82.3147524355478, 27.9100995716056] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lakeland: {
            id: 'lakeland', wupCityCode: '7250',
            label: translateCityText('city.labels.lakeland', 'Lakeland, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [28.0176498923629, -81.9426377334415], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [28.0176498923629, -81.9426377334415], fallbackDataset: [-81.9426377334415, 28.0176498923629] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        forest_city: {
            id: 'forest_city', wupCityCode: '7419',
            label: translateCityText('city.labels.forest_city', 'Forest City, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [28.6545129049095, -81.4377636401185], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [28.6545129049095, -81.4377636401185], fallbackDataset: [-81.4377636401185, 28.6545129049095] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        port_saint_lucie: {
            id: 'port_saint_lucie', wupCityCode: '7528',
            label: translateCityText('city.labels.port_saint_lucie', 'Port Saint Lucie, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [27.2987598439619, -80.357237726397], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [27.2987598439619, -80.357237726397], fallbackDataset: [-80.357237726397, 27.2987598439619] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        saint_johns_park: {
            id: 'saint_johns_park', wupCityCode: '7540',
            label: translateCityText('city.labels.saint_johns_park', 'Saint Johns Park, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [30.2820297974115, -81.7388077386963], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [30.2820297974115, -81.7388077386963], fallbackDataset: [-81.7388077386963, 30.2820297974115] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        holiday_hill: {
            id: 'holiday_hill', wupCityCode: '7573',
            label: translateCityText('city.labels.holiday_hill', 'Holiday Hill, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [30.3432082180442, -81.5857638197135], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [30.3432082180442, -81.5857638197135], fallbackDataset: [-81.5857638197135, 30.3432082180442] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        jacksonville_beach: {
            id: 'jacksonville_beach', wupCityCode: '7584',
            label: translateCityText('city.labels.jacksonville_beach', 'Jacksonville Beach, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [30.3079308989275, -81.4038356066191], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [30.3079308989275, -81.4038356066191], fallbackDataset: [-81.4038356066191, 30.3079308989275] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-fl-dor-statewide-cadastral', idPrefix: 'US-FL-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Florida Department of Revenue, Property Tax Oversight, and Florida county property appraisers. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        kenosha: {
            id: 'kenosha', wupCityCode: '7828',
            label: translateCityText('city.labels.kenosha', 'Kenosha, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.5784858065008, -87.8410657652837], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.5784858065008, -87.8410657652837], fallbackDataset: [-87.8410657652837, 42.5784858065008] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-wi-v12-statewide-parcels', idPrefix: 'US-WI-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Wisconsin State Cartographer\'s Office, Wisconsin Land Information Program and Wisconsin counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        racine: {
            id: 'racine', wupCityCode: '7837',
            label: translateCityText('city.labels.racine', 'Racine, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.7232104953445, -87.8044867117979], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.7232104953445, -87.8044867117979], fallbackDataset: [-87.8044867117979, 42.7232104953445] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-wi-v12-statewide-parcels', idPrefix: 'US-WI-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Wisconsin State Cartographer\'s Office, Wisconsin Land Information Program and Wisconsin counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        ludlow: {
            id: 'ludlow', wupCityCode: '7855',
            label: translateCityText('city.labels.ludlow', 'Ludlow, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [39.1283327727324, -84.5943579148481], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [39.1283327727324, -84.5943579148481], fallbackDataset: [-84.5943579148481, 39.1283327727324] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-oh-ogrip-statewide-parcels', idPrefix: 'US-OH-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Ohio Geographically Referenced Information Program (OGRIP) and Ohio county auditors. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fort_wayne: {
            id: 'fort_wayne', wupCityCode: '7913',
            label: translateCityText('city.labels.fort_wayne', 'Fort Wayne, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.0690939195421, -85.1300955495992], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.0690939195421, -85.1300955495992], fallbackDataset: [-85.1300955495992, 41.0690939195421] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-in-indianamap-statewide-parcels', idPrefix: 'US-IN-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'IndianaMap / Indiana Geographic Information Office and Indiana counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        greensboro: {
            id: 'greensboro', wupCityCode: '7969',
            label: translateCityText('city.labels.greensboro', 'Greensboro, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [36.0643485281769, -79.7946139332298], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [36.0643485281769, -79.7946139332298], fallbackDataset: [-79.7946139332298, 36.0643485281769] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-nc-onemap-statewide-parcels', idPrefix: 'US-NC-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'NC OneMap, NC Center for Geographic Information and Analysis, and North Carolina counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        toledo: {
            id: 'toledo', wupCityCode: '7983',
            label: translateCityText('city.labels.toledo', 'Toledo, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.6697459831271, -83.5721153382202], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.6697459831271, -83.5721153382202], fallbackDataset: [-83.5721153382202, 41.6697459831271] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-oh-ogrip-statewide-parcels', idPrefix: 'US-OH-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Ohio Geographically Referenced Information Program (OGRIP) and Ohio county auditors. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        firestone_park: {
            id: 'firestone_park', wupCityCode: '8053',
            label: translateCityText('city.labels.firestone_park', 'Firestone Park, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.0591020042923, -81.487870623553], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.0591020042923, -81.487870623553], fallbackDataset: [-81.487870623553, 41.0591020042923] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-oh-ogrip-statewide-parcels', idPrefix: 'US-OH-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Ohio Geographically Referenced Information Program (OGRIP) and Ohio county auditors. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        euclid: {
            id: 'euclid', wupCityCode: '8060',
            label: translateCityText('city.labels.euclid', 'Euclid, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.510843325213, -81.57541713518], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.510843325213, -81.57541713518], fallbackDataset: [-81.57541713518, 41.510843325213] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-oh-ogrip-statewide-parcels', idPrefix: 'US-OH-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'Ohio Geographically Referenced Information Program (OGRIP) and Ohio county auditors. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fairland: {
            id: 'fairland', wupCityCode: '8158',
            label: translateCityText('city.labels.fairland', 'Fairland, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [39.0669362280002, -76.9540592052469], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [39.0669362280002, -76.9540592052469], fallbackDataset: [-76.9540592052469, 39.0669362280002] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-md-imap-statewide-parcel-boundaries', idPrefix: 'US-MD-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MD iMAP, Maryland Department of Planning, SDAT. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        columbia_md: {
            id: 'columbia_md', wupCityCode: '8165',
            label: translateCityText('city.labels.columbia_md', 'Columbia (MD), United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [39.2048448908618, -76.8403726722015], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [39.2048448908618, -76.8403726722015], fallbackDataset: [-76.8403726722015, 39.2048448908618] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-md-imap-statewide-parcel-boundaries', idPrefix: 'US-MD-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MD iMAP, Maryland Department of Planning, SDAT. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        wilmington: {
            id: 'wilmington', wupCityCode: '8228',
            label: translateCityText('city.labels.wilmington', 'Wilmington, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [39.7459671684999, -75.5615080662526], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [39.7459671684999, -75.5615080662526], fallbackDataset: [-75.5615080662526, 39.7459671684999] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-de-firstmap-statewide-parcels', idPrefix: 'US-DE-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'State of Delaware FirstMap and Delaware counties. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        springfield_ma: {
            id: 'springfield_ma', wupCityCode: '8463',
            label: translateCityText('city.labels.springfield_ma', 'Springfield (MA), United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.1113118931937, -72.5784998231599], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.1113118931937, -72.5784998231599], fallbackDataset: [-72.5784998231599, 42.1113118931937] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ma-massgis-l3-tax-parcels', idPrefix: 'US-MA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        worcester: {
            id: 'worcester', wupCityCode: '8469',
            label: translateCityText('city.labels.worcester', 'Worcester, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.2597734886551, -71.8070882719052], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.2597734886551, -71.8070882719052], fallbackDataset: [-71.8070882719052, 42.2597734886551] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ma-massgis-l3-tax-parcels', idPrefix: 'US-MA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        fall_river: {
            id: 'fall_river', wupCityCode: '8481',
            label: translateCityText('city.labels.fall_river', 'Fall River, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [41.6955271095878, -71.1534456550269], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [41.6955271095878, -71.1534456550269], fallbackDataset: [-71.1534456550269, 41.6955271095878] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ma-massgis-l3-tax-parcels', idPrefix: 'US-MA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lowell: {
            id: 'lowell', wupCityCode: '8505',
            label: translateCityText('city.labels.lowell', 'Lowell, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.6417314473143, -71.3181810964044], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.6417314473143, -71.3181810964044], fallbackDataset: [-71.3181810964044, 42.6417314473143] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ma-massgis-l3-tax-parcels', idPrefix: 'US-MA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lawrence: {
            id: 'lawrence', wupCityCode: '8517',
            label: translateCityText('city.labels.lawrence', 'Lawrence, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.7075937387977, -71.1639769493182], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.7075937387977, -71.1639769493182], fallbackDataset: [-71.1639769493182, 42.7075937387977] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ma-massgis-l3-tax-parcels', idPrefix: 'US-MA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        lynn: {
            id: 'lynn', wupCityCode: '8523',
            label: translateCityText('city.labels.lynn', 'Lynn, United States'),
            currency: { locale: 'en-US', code: 'USD' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [42.4692858620628, -70.9553412983168], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [42.4692858620628, -70.9553412983168], fallbackDataset: [-70.9553412983168, 42.4692858620628] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'us-ma-massgis-l3-tax-parcels', idPrefix: 'US-MA-STATEWIDE-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts. Adapted to WGS84.' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        czestochowa: {
            id: 'czestochowa', wupCityCode: '3002',
            label: translateCityText('city.labels.czestochowa', 'Częstochowa, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [50.8076252950718, 19.1134120802074], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [50.8076252950718, 19.1134120802074], fallbackDataset: [19.1134120802074, 50.8076252950718] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        belchatow: {
            id: 'belchatow', wupCityCode: '3344',
            label: translateCityText('city.labels.belchatow', 'Bełchatów, Poland'),
            currency: { locale: 'pl-PL', code: 'PLN' },
            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [51.3600738693611, 19.3733696862117], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },
            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [51.3600738693611, 19.3733696862117], fallbackDataset: [19.3733696862117, 51.3600738693611] },
            parcels: { strategy: 'grid', gridSize: 0.001, source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', idPrefix: 'PL-EGIB-', requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: 'GUGiK collective EGiB WFS · county cadastral parcels · adapted' },
            buildings: { source: 'osm' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
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
    // The city's default language applies only once the city's stored values are read: before that a
    // language the visitor chose reads as unset, and setting the default then replaced it on every
    // boot (English chosen in Belgrade came back Serbian).
    {
        const applyStoredLanguage = () => applyCityLanguagePreference(getCurrentCityConfig());
        const ready = typeof PersistentStorage !== 'undefined' && PersistentStorage ? PersistentStorage.ready : null;
        if (ready && typeof ready.then === 'function') ready.then(applyStoredLanguage, applyStoredLanguage);
        else applyStoredLanguage();
    }

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
    // `url`: where to go instead of the current address (a route into the next city, such as a
    // proposal to open there). The page being left keeps its own history entry, so Back returns to
    // it; rewriting that entry first made Back land on the new route in the old city instead.
    function navigateToCity(nextId, options = {}) {
        try {
            const url = new URL(options.url || window.location.href, window.location.href);
            url.searchParams.set('city', nextId);
            // `at` opens the next city at a given view (js/map-core.js applies and strips it);
            // `world` (force the globe) must not follow the visitor into the city they just picked.
            url.searchParams.delete('at');
            url.searchParams.delete('world');
            if (options.at && window.WorldEntryModel) url.searchParams.set('at', window.WorldEntryModel.formatAt(options.at));
            if (options.clearRoute) {
                // Every route the boot acts on: left in, a proposal focused before the switch reopened
                // in the next city, and a monitor asked to switch back.
                if (/^\/(proposals|plans|parcel|bets|monitors)\//.test(url.pathname)) url.pathname = '/';
                ['proposalShare', 'shared', 'parcel', 'bets', 'focusProposal', 'arrive', 'activity', 'scene']
                    .forEach(param => url.searchParams.delete(param));
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
            at = null,
            url = null
        } = options;

        if (!nextId || !CITY_CONFIGS[nextId] || nextId === currentCityId) {
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

    // A city id as links, records and the server spell it ('zagreb', the short code 'zg', any case),
    // or null when it names no configured city (an old placeholder such as 'city', a typo).
    function resolveCityId(raw) {
        const value = String(raw ?? '').trim().toLowerCase();
        if (!value) return null;
        const id = CITY_QUERY_MAP[value] || value;
        return CITY_CONFIGS[id] ? id : null;
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
    // Šibenik's Overture; a move from Zagreb to Split in place loaded no buildings there, so a road
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
        getCadastreKey,
        getPlaceDataKey,
        resolveCityId,
        foreignCityFor,
        datasetToLatLng,
        latLngToDataset,
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
