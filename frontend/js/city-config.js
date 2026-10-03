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
                requiresBackend: true
            },
            buildings: {
                // Overture-Maps footprints + heights (shared overture_building_footprint table,
                // extruded server-side like Belgrade). 3D buildings load automatically in 3D mode.
                source: 'overture'
            },
            sidebar: {
                // Zagreb-only datasets (city blocks, GUP roads, area monitor,
                // 2D buildings WFS layer) stay off until ingested for Split.
                disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor']
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
                requiresBackend: true
            },
            buildings: {
                // Overture-Maps footprints + heights, extruded server-side. Reads the shared
                // overture_building_footprint rows already ingested for the whole
                // Zadar–Šibenik–Knin area (see backend/buildings/overture-cities.js).
                source: 'overture'
            },
            sidebar: {
                // Zagreb-only datasets (city blocks, GUP roads, area monitor, 2D buildings
                // WFS layer) stay off until ingested for Šibenik.
                disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor']
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
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
            buildings: { source: 'none' },
            sidebar: { disabledSections: ['parcelBlocks', 'buildings', 'roads', 'areaMonitor'] },
            parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }
        },
        // Not a city: the generic place-without-parcels view (see EXPLORE_CITY_ID above). Left out
        // of getAvailableCities/findNearestCity, the search box city list, the stored-city pointer and
        // scripts/build-world-coverage.mjs (which skips `explore: true`).
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
                // The backend resolves buildings by city id and has no provider for 'explore'.
                source: 'none'
            },
            sidebar: {
                // Everything that needs parcels; Measure, Activity and Settings stay. Proposals and
                // stations need none (PARCEL-OPTIONAL.md): a site drawn here has an empty binding
                // and can only execute through an authority's verdict.
                disabledSections: ['parcels', 'parcelBlocks', 'buildings', 'roads', 'areaMonitor', 'game']
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

    function getCurrentCityConfig() {
        return CITY_CONFIGS[currentCityId] || CITY_CONFIGS[DEFAULT_CITY_ID];
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

        // Apply feature visibility after sidebar configuration
        applyFeatureVisibility();
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
                document.removeEventListener('keydown', onKeydown, true);
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                resolve(result);
            }

            // Escape cancels, like showStyledChoice. Without it the key went to the page behind:
            // it closed the sheet the confirm was opened from and left the confirm up.
            function onKeydown(event) {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                cleanup(false);
            }
            document.addEventListener('keydown', onKeydown, true);

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
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cleanup(null);
                    return;
                }
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
                if (event.key === 'Escape') {
                    event.preventDefault();
                    cleanup();
                } else if (event.key === 'Tab') {
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
        getAvailableCities: () => Object.values(CITY_CONFIGS).filter(config => !config.explore),
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
        getCityConfig: id => CITY_CONFIGS[id] || null,
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
        applyFeatureVisibility
    };
})();
