// Machine-readable source wrapper and operation contracts shared by the browser and server.
// Adapter config remains provider-owned; these schemas describe the stable boundary around it.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SourceContracts = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const clone = value => JSON.parse(JSON.stringify(value));
    const obj = (properties, required = Object.keys(properties), extra = false) => ({
        type: 'object', properties, required, additionalProperties: extra
    });
    const string = (description, format) => ({ type: 'string', ...(format ? { format } : {}), description });
    const number = (description, minimum) => ({ type: 'number', ...(minimum === undefined ? {} : { minimum }), description });
    const array = (items, description) => ({ type: 'array', items, description });
    const bbox = { type: 'array', prefixItems: [number('West longitude.'), number('South latitude.'), number('East longitude.'), number('North latitude.')],
        minItems: 4, maxItems: 4, items: false, description: 'west,south,east,north in EPSG:4326' };
    const geometry = obj({ type: string('GeoJSON geometry type'), coordinates: { description: 'GeoJSON coordinates in the operation-declared CRS.' },
        geometries: array({ type: 'object' }, 'GeoJSON GeometryCollection members.') }, ['type']);
    const feature = obj({ type: { const: 'Feature' }, id: { description: 'Source-stable feature identifier.' },
        geometry: { oneOf: [geometry, { type: 'null' }] }, properties: obj({}, [], true) }, ['type', 'geometry', 'properties'], false);
    const featureCollection = obj({ type: { const: 'FeatureCollection' }, features: array(feature), source: string('Resolved source id.'),
        partial: { type: 'boolean', description: 'True when the provider reports incomplete coverage/results.' },
        truncated: { type: 'boolean', description: 'True when a documented result cap omitted records.' } }, ['type', 'features'], true);
    const operation = (input, output, semantics, argumentList, runtimeType = 'JSON') => ({ input, output, semantics,
        argumentList, runtimeType, ...(runtimeType !== 'JSON' ? { outputSchema: null } : {}) });
    const featureResult = obj({ features: array(feature), complete: { type: 'boolean' }, sourceId: string('Resolved source id.'),
        returnsWGS84: { type: 'boolean' }, truncated: { type: 'boolean' }, partial: { type: 'boolean' } }, ['features'], true);
    const pointPosition = { type: 'array', items: number('WGS84 longitude or latitude.'), minItems: 2, maxItems: 2 };
    const projectedBbox = { type: 'array', items: number('EPSG:3765 coordinate.'), minItems: 4, maxItems: 4,
        description: 'minX,minY,maxX,maxY in EPSG:3765 metres.' };
    const fc = obj({ type: { const: 'FeatureCollection' }, features: array(feature), source: string('Source identifier.'),
        truncated: { type: 'boolean' }, partial: { type: 'boolean' } }, ['type', 'features'], true);
    const operations = {
        parcels: {
            queryBounds: operation(obj({ bbox }), featureResult,
                'Returns the provider reader result, commonly {features,complete,sourceId,returnsWGS84}; not every adapter sets every metadata field. bbox is EPSG:4326; missing geometry is not synthesized.', ['bbox']),
            queryIds: operation(obj({ ids: array(string('Source parcel ids.')) }), featureResult,
                'Unknown ids may be absent or reported in adapter metadata; result completeness is provider-defined.', ['ids']),
            queryGeometry: operation(obj({ geometry }), featureResult,
                'Geometry and normalized geometry use EPSG:4326. Returns provider reader result, not a guaranteed GeoJSON FeatureCollection wrapper.', ['geometry']),
            queryPoint: operation(obj({ coordinates: pointPosition }), featureResult,
                'Point coordinates are [longitude, latitude]; unsupported adapters reject this operation.', ['coordinates'])
        },
        buildings: {
            near: operation(obj({ geometry, bufferMeters: number('Search buffer in metres.', 0) }),
                obj({ buildings: array({ type: 'object' }), count: number('Returned building count.', 0), source: string('Provider id.'), partial: { type: 'boolean' }, heights: { oneOf: [{ type: 'object' }, { type: 'null' }] } }, ['buildings', 'count', 'source'], true),
                'Returns {buildings,count,source} with provider-specific optional partial/height/cache metadata; missing height and storey data stays absent/null.', ['geometry', 'bufferMeters']),
            footprints: operation(obj({ geometry }), obj({ footprints: array({ type: 'object' }), count: number('Returned footprint count.', 0), source: string('Provider id.'), truncated: { type: 'boolean' } }, ['footprints', 'count', 'source'], true),
                'Input is the query geometry (normally a bbox Polygon), not a bbox tuple. Output retains source-specific completeness/truncation.', ['geometry']),
            footprintsUnder: operation(obj({ regions: array({ type: 'object' }, 'Requested regions keyed by consumer identity.') }), null,
                'Returns {regions: Map<regionKey, regionResult>,source,truncated}; this is an in-process Map, not a JSON object projection.', ['regions'], 'Map')
        },
        planning: {
            query: operation(obj({}, [], true), obj({ items: array(obj({}, [], true)), nextAfter: { oneOf: [string('Opaque provider cursor.'), { type: 'null' }] }, omitted: number('Omitted invalid/unsupported records.', 0), summary: { type: 'object' } }, ['items', 'omitted'], true),
                'Provider method query(pool, query) returns {items,nextAfter,omitted,summary?}; HTTP aggregation/pagination is a separate layer. planning-representations.v1 semantics remain on items.', ['pool [runtime context]', 'query']),
            parcel: operation(obj({}, [], true), array(obj({}, [], true)),
                'Provider method parcel(pool, query) returns planning items; the route adds schemaVersion/city/source envelope.', ['pool [runtime context]', 'query']),
            record: operation(obj({}, [], true), array(obj({}, [], true)),
                'Provider method record(pool, query) returns planning items; the route adds its response envelope.', ['pool [runtime context]', 'query'])
        },
        economics: {
            rates: operation(obj({ city: obj({}, [], true), ukLandRates: { type: 'object' } }),
                array(obj({ metric: { enum: ['land', 'roadLand', 'sale', 'construction'] }, unit: { enum: ['m2-land', 'm2-floor'] },
                    amount: number('Non-negative amount per declared unit.', 0), currency: string('ISO 4217 currency code.'),
                    basis: { enum: ['assumption', 'policy-appraisal', 'market', 'construction-cost'] }, asOf: { oneOf: [string('YYYY-MM-DD observation date.', 'date'), { type: 'null' }] },
                    sourceId: string('Source id.'), sourceName: string('Human-readable source label.'), sourceUrl: { oneOf: [string('Evidence URL.', 'uri'), { type: 'null' }] },
                    scope: { oneOf: [string('Authority/geographic scope.'), { type: 'null' }] } }, ['metric', 'unit', 'amount', 'currency', 'basis', 'asOf', 'sourceId', 'sourceName', 'sourceUrl', 'scope'])),
                'rates(context) returns normalized rate rows. Rates retain unit, currency, evidence basis, observation date and source. No conversion or assessed-total-to-rate inference.', ['context'])
        },
        imagery: {
            tileUrl: operation(obj({ base: string('Gateway base URL.', 'uri'), coords: obj({ z: number('Web Mercator zoom.', 0), x: number('Tile column.', 0), y: number('Tile row.', 0) }) }), string('Protected imagery gateway URL.', 'uri'),
                'tileUrl(base,coords) returns a URL, not image bytes; selected source config is bound by the adapter.' , ['base', 'coords']),
            basemap: operation(obj({}), obj({ url: string('Basemap template URL.', 'uri'), options: obj({}, [], true) }, ['url', 'options']),
                'Returns the basemap URL and Leaflet options; imagery tile fetching is a separate gateway reader.', [])
        },
        geocoding: {
            search: operation(obj({ params: obj({ q: string('Place query.'), limit: number('Requested result cap.', 1), bbox }, ['q']),
                options: obj({ fetchImpl: {}, signal: {} }, [], true) }, ['params']),
                obj({ type: { const: 'FeatureCollection' }, features: array(feature) }, ['type', 'features'], true),
                'search(params,{fetchImpl,signal}) returns raw Photon GeoJSON. SearchModel.parsePhoton is a separate map-search normalization step; no-match is not proof of absence.', ['params', 'options?'])
        },
        'transit-alignments': {
            load: operation(obj({ options: obj({ fetchImpl: {} }, [], true) }), featureCollection,
                'Single-source load({fetchImpl}) returns that source FeatureCollection; metadata from the source descriptor stays separate. Coordinates are EPSG:4326 lines; proposal corridors are separate.', ['options'])
        },
        'terrain-profile': {
            profile: operation(obj({ profile: obj({ coordinates: array(pointPosition), stepM: number('Sample spacing in metres.', 0) }, ['coordinates', 'stepM']),
                options: obj({ fetchImpl: {}, signal: {} }, [], true) }, ['profile']),
                obj({ source: string('Resolved provider id.'), datum: string('Vertical reference datum.'), resolutionM: number('Nominal raster resolution in metres.', 0), points: array(obj({}, [], true)) }, ['source', 'datum', 'points'], true),
                'profile({coordinates,stepM},{fetchImpl,signal}) returns the validated raw provider profile. Samples use dM (geodesic chainage metres) and nullable elevation fields such as elevAslM/elevationM/elevation; preserve response fields. NoData is null, never zero.', ['profile', 'options?'])
        },
        'road-network': {
            readNetwork: operation(obj({ boxes: array(bbox), railways: { type: 'boolean' } }), array(feature), 'Returns a feature array from indexed source rows; route wraps it as FeatureCollection.', ['boxes', 'railways']),
            readLiveNetwork: operation(obj({ bbox, railways: { type: 'boolean' } }), featureCollection, 'Returns provider FeatureCollection from Overpass fallback.', ['bbox', 'railways'])
        },
        'frontage-streets': { near: operation(obj({ bbox }), featureCollection, 'EPSG:4326 frontage-eligible street centrelines only; this is not the complete road network.', ['bbox']) },
        'block-barriers': { readBarriers: operation(obj({ bbox }), featureCollection, 'EPSG:4326 barriers used by block creation; preserves highway/source tags.', ['bbox']) },
        'street-register': { readStreets: operation(obj({ bbox: projectedBbox }), featureCollection, 'Input bbox is EPSG:3765; output line geometries are transformed to EPSG:4326.', ['bboxParts']) },
        'planned-roads': { readReservations: operation(obj({ bbox: projectedBbox }), array(obj({ props: obj({}, [], true), geometry }, ['props', 'geometry'])), 'Reader returns raw rows whose reservation geometry remains in EPSG:3765; route applies display properties and wraps the output separately.', ['client [runtime context]', 'bboxParts']) },
        'road-classification': { readIds: operation(obj({ bbox }), array(obj({ parcel_id: string('Stable parcel id classified as road.') }, ['parcel_id'])), 'Returns rows with parcel_id only; classification does not create parcel geometry.', ['bbox']) },
        trees: {
            near: operation(obj({ geometry, bufferMeters: number('Search buffer in metres.', 0) }),
                obj({ trees: array(array(number('WGS84 longitude, latitude'))), count: number('Number of returned tree points.', 0), source: string('Resolved provider id.') }, ['trees', 'count', 'source']),
                'Tree locations are [longitude, latitude]; count matches returned trees. Unavailable coverage is not an empty observation unless provider says so.', ['geometry', 'bufferMeters']),
            layers: operation(obj({ bbox, kinds: array(string('Decor kind.')) }), array(string('Available kind.')),
                'Reader returns the available kind ids as string[]; HTTP route wraps them in {layers}.', ['bbox', 'kinds'])
        },
        water: { near: operation(obj({ geometry, bufferMeters: number('Search buffer in metres.', 0) }),
            obj({ areas: array(obj({ geometry, kind: string('Water feature class.') })), count: number('Number of returned areas.', 0), source: string('Resolved provider id.') }, ['areas', 'count', 'source']),
            'Water geometries are GeoJSON EPSG:4326; preserve Polygon/MultiPolygon type and source classification.', ['geometry', 'bufferMeters']) },
        ownership: { lookup: operation(obj({ parcelId: string('Stable parcel id.') }), { oneOf: [obj({}, [], true), { type: 'null' }] },
            'Bound reader method lookup(parcelId); null means no answer for registered source/parcel. Non-null answers are normalized by the ownership contract and retain source, attribution and licence.', ['parcelId']) },
        'building-details': { fetchFloorModels: operation(obj({ identities: array(obj({}, [], true)) }), null,
            'Returns an in-process Map keyed by canonical identity JSON to raw database rows. No JSON projection is defined; generated/suggested layouts are not registry records.', ['identities'], 'Map') }
    };

    operations['reality-mesh'] = { authentication: operation(obj({ accessToken: string('Private runtime access token; never persisted in source metadata.') }),
        obj({ apiToken: string('Runtime authentication token.'), assetId: number('Provider asset id.') }),
        'authentication({accessToken}) produces the native Cesium credentials at runtime; catalogue config contains only assetId.', ['options']) };
    operations['terrain-profile'].url = operation(obj({}, [], true), string('Resolved profile endpoint.', 'uri'),
        'url(global) resolves configured endpoint or runtime API base; global is injected runtime context.', ['global? [runtime context]']);

    const sourceSchema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://urbangametheory.xyz/schemas/source-wrapper.v1.json',
        title: 'Canonical source wrapper', type: 'object', additionalProperties: false,
        required: ['id', 'abstraction', 'adapter', 'kind', 'label', 'config'],
        properties: {
            id: { type: 'string', minLength: 1, maxLength: 10000, description: 'Stable identifier within the abstraction.' },
            abstraction: { type: 'string', enum: Object.keys(operations), description: 'Domain operation family.' },
            adapter: { type: 'string', minLength: 1, description: 'Allowlisted transport/reader implementation id.' },
            kind: { enum: ['default', 'custom'], description: 'Configured source or user-supplied source.' },
            label: { type: 'string', minLength: 1, description: 'Human-readable label; defaults to id.' },
            config: { type: 'object', description: 'Adapter-owned public configuration; never credentials or runtime dependencies.', additionalProperties: true }
        }
    };
    // These are schemas for operation VALUES, not a schema that accidentally validates
    // the descriptive metadata as if it were an invocation.
    function operationSchemas() {
        const $defs = {};
        for (const [family, methods] of Object.entries(operations)) {
            for (const [name, contract] of Object.entries(methods)) {
                const key = family.replace(/-/g, '_') + '_' + name;
                $defs[key + '_input'] = contract.input;
                if (contract.output !== null) $defs[key + '_output'] = contract.output;
            }
        }
        for (const [variant, methods] of Object.entries(nativeOperations)) for (const [name, contract] of Object.entries(methods)) {
            const key = variant.replace(/[-/]/g, '_') + '_' + name;
            $defs[key + '_input'] = contract.input;
            if (contract.output !== null) $defs[key + '_output'] = contract.output;
        }
        return { $schema: 'https://json-schema.org/draft/2020-12/schema',
            $id: 'https://urbangametheory.xyz/schemas/source-operations.v1.json',
            title: 'Source operation input and output schemas', $defs };
    }

    const adapterIds = {
        parcels: ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', 'gml-snapshot', 'shapefile-snapshot', 'shapefile-zip', 'hmlr-browser', 'catastro-wfs', 'dlrs-sheet', 'kerala-entebhoomi', 'nairobi-outlines', 'kazakhstan-pkk', 'msda-point', 'tkgm-point', 'pl-uldk-point', 'bev-tiles', 'vector-tiles', 'hamburg-alkis-wfs', 'frankfurt-wfs', 'gml-wfs', 'pulse-public', 'bf-dgi-geojson', 'divo-ecommunes-xml', 'dda-public-plots', 'shenzhen-land-certain', 'arcgis-hub', 'arcgis-webmap', 'asig-wms-kml', 'be-cadgis', 'changhua-urbangis', 'cheongju-mapmoa', 'corrientes-wms', 'diyarbakir-eimar', 'ecommunes-xml', 'flatgeobuf-range', 'geogeo-emap', 'geojson-range', 'geopixel', 'gwangju-jijuk', 'huaibei-cadastre', 'huainan-mapshine', 'interpi-sigef', 'kartverket-eiendom', 'kg-gisar-wms', 'kml-kmz', 'mersin-eimar', 'moj-mapxml', 'netgis-runxml', 'pk-glis', 'reestr54-bounded', 'ru-cadastral-report', 'sakarya-sbb-bounded', 'saltillo-visor', 'santos-lotes', 'shapefile-range', 'sisgran-wms', 'sofia-isofmap', 'supermap-map', 'taichung-gismap', 'tatarstan-cadastre-bounded', 'toscana-catasto', 'ua-kadastr-landuse', 'ugnlis-parcel-search', 'uy-dnc-snig', 'dgu-wfs', 'oss-wfs', 'parcel-ba', 'parcel-bg', 'parcel-lj', 'parcel-nyc', 'dgu-live'],
        buildings: ['gdi-3d', 'nyc-arcgis', 'nyc-socrata', 'osm', 'arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', 'overpass', 'gdi-map', 'dgu-map', 'osm-reference', 'overture-pmtiles'],
        planning: ['gup', 'nyc-pilot', 'atlas-url', 'bogota-pot'], economics: ['rate-table', 'uk-mhclg-2023', 'scenario-assumptions'],
        imagery: ['xyz', 'wms', 'xyz-basemap', 'maptiler-basemap'], geocoding: ['photon'], 'transit-alignments': ['static-geojson'],
        'terrain-profile': ['dgu-dtm-20m'], 'road-network': ['osm-road-network'], 'frontage-streets': ['osm-street-frontage'],
        'block-barriers': ['overpass-block-roads'], 'street-register': ['postgis-street-register'],
        'planned-roads': ['postgis-road-reservations'], 'road-classification': ['postgis-road-classification'],
        trees: ['osm-decor-trees'], water: ['openfreemap-water'], ownership: ['http', 'hr-oss', 'ar-caba', 'rs-bg', 'us-nyc', 'si-gurs', 'hr-oss-public-fallback'],
        'building-details': ['floor-model-storage'], 'reality-mesh': ['cesium-ion-3dtiles']
    };
    const nativeOnly = new Set(['cesium-ion-3dtiles','oss-wfs', 'parcel-ba', 'parcel-bg', 'parcel-lj', 'parcel-nyc', 'dgu-live', 'gdi-map', 'dgu-map', 'osm-reference', 'hr-oss-public-fallback','gdi-3d', 'nyc-arcgis', 'nyc-socrata', 'osm', 'gup', 'nyc-pilot', 'bogota-pot', 'uk-mhclg-2023', 'scenario-assumptions',
        'osm-road-network', 'osm-street-frontage', 'postgis-street-register', 'postgis-road-reservations', 'postgis-road-classification', 'osm-decor-trees',
        'floor-model-storage', 'hr-oss', 'ar-caba', 'rs-bg', 'us-nyc', 'si-gurs']);
    const requiredMethods = {
        parcels: ['queryBounds', 'queryIds', 'queryGeometry'], buildings: ['near', 'footprints', 'footprintsUnder'],
        planning: ['query', 'record'], economics: ['rates'], imagery: ['tileUrl', 'basemap'], geocoding: ['search'],
        'transit-alignments': ['load'], 'terrain-profile': ['profile', 'url'], 'road-network': ['readNetwork', 'readLiveNetwork'], 'frontage-streets': ['near'],
        'block-barriers': ['readBarriers'], 'street-register': ['readStreets'], 'planned-roads': ['readReservations'],
        'road-classification': ['readIds'], trees: ['near', 'layers'], water: ['near'], ownership: ['lookup'], 'building-details': ['fetchFloorModels'], 'reality-mesh': ['authentication']
    };

    const standardOperations = clone(operations);
    const nativeOperations = {};
    const request = obj({ query: obj({}, [], true), body: obj({}, [], true), params: obj({}, [], true) }, []);
    const nativeLookup = operation(obj({ input: request }), fc,
        'lookup({query,body,params}) preserves the named dataset route query, provider properties and native FeatureCollection metadata. No conversion to queryBounds reader results.', ['input?']);
    const ossMethods = {
        lookup: nativeLookup,
        under: operation(obj({ input: request }), fc, 'input.body is {geometry,srid?}; Polygon/MultiPolygon, default SRID 4326. Returns the candidate parcels that meet it (edge-touching included) as a FeatureCollection with count/queryMs; the shared rule decides what is taken. Over 5,000 parcels: 413.', ['input?']),
        parcelIds: operation(obj({ input: request }), fc, 'input.query.ids is a comma-separated HR cadastral id list; preserves native feature properties.', ['input?']),
        neighbours: operation(obj({ input: request }), fc, 'input.params[0] is the numeric cestica_id or HR-<municipality>-<parcel-number> selection; output retains ownership and cadastral properties.', ['input?']),
        queryGeometry: operation(obj({ geometry }), featureResult,
            'Binding candidates for a WGS84 site: current parcels within 5 cm (properties parcelId HR-<municipality>-<number>, sourceId hr-cadastre; twin current ids unioned), and `regions` [{id, geometry}], the cadastral municipalities the site meets cut to its box. 9-decimal WGS84. Over 5,000 parcels: truncated, no features. site-binding.js decides.', ['geometry']),
        queryIds: operation(obj({ ids: array(string('HR cadastral parcel identity.')) }), featureResult,
            'Current parcels by HR-<municipality>-<number> id; ids that are not HR ids or not current are listed in absentIds.', ['ids'])
    };
    for (const id of ['oss-wfs', 'parcel-ba', 'parcel-bg', 'parcel-lj', 'parcel-nyc']) nativeOperations['parcels/' + id] = id === 'oss-wfs' ? ossMethods : {
        lookup: nativeLookup,
        ...(id === 'parcel-nyc' ? { queryIds: standardOperations.parcels.queryIds, queryGeometry: standardOperations.parcels.queryGeometry, envelope: operation(obj({ input: request }), obj({ parcelId: string('Canonical US-NY parcel id.'), bbl: {}, address: {}, envelope: obj({}, [], true) }),
            'input.params.parcelId selects the PLUTO record; returns native zoning envelope and screening evidence.', ['input?']) } : {})
    };
    nativeOperations['parcels/dgu-live'] = {
        fetchBbox: operation(obj({ bbox: projectedBbox }), array(feature), 'EPSG:3765 bbox; returns WGS84 feature array.', ['bbox']),
        fetchIds: operation(obj({ ids: array(string('HR cadastral parcel identity.')) }), array(feature), 'Returns shaped WGS84 features from batched WFS reads.', ['ids']),
        fetchUnder: operation(obj({ geometry }, ['geometry']),
            obj({ features: array(feature) }, ['features']),
            'WGS84 geometry; returns the candidate parcels that meet it (edge-touching included), as /parcels/under.', ['geometry'])
    };
    for (const id of ['gdi-map', 'dgu-map']) nativeOperations['buildings/' + id] = { lookup: operation(obj({ query: obj({ bbox: string('minX,minY,maxX,maxY in EPSG:3765.'), cestica_id: string('Numeric parcel id.') }, []) }), fc,
        'lookup(query) returns native FeatureCollection geometry in EPSG:3765, not WGS84. Bbox mode has source/truncated; cestica_id mode reads GDI parcel buildings with count and containment/area properties.', ['query']) };
    nativeOperations['buildings/osm-reference'] = { fetchBbox: operation(obj({ bbox }), fc, 'WGS84 bbox; returns native staged/Overpass FeatureCollection with partial/truncated flags.', ['bbox']) };
    nativeOperations['buildings/overture-pmtiles'] = { featuresIn: operation(obj({ bbox }), fc, 'WGS84 bbox; returns {type,features,truncated,partial:false}; tile cap is reported by truncated. Source identity remains on feature properties.', ['bbox']) };
    nativeOperations['ownership/hr-oss-public-fallback'] = { lookup: operation(obj({ parcelId: string('HR cadastral parcel identity.') }), { oneOf: [array(obj({}, [], true)), { type: 'null' }] },
        'Public browser fallback returns parsed owner rows or null; this is distinct from the backend normalized ownership record.', ['parcelId']) };
    const imageSpec = obj({ url: publicUrlPlaceholder(), bbox, width: number('Requested width pixels.', 1), height: number('Requested height pixels.', 1), warp: { type: 'boolean' } }, ['url']);
    function publicUrlPlaceholder() { return string('Guarded public imagery request URL.', 'uri'); }
    const imageOperation = operation(obj({ spec: imageSpec }), null,
        'image(spec) downloads and optionally warps imagery. Returns {bytes:Buffer,contentType,width,height,decoded?}; decoded is a native decoded image. No JSON projection is defined.', ['spec'], 'Binary');
    const tileRequestOperation = operation(obj({ z: number('Zoom.', 0), x: number('Column.', 0), y: number('Row.', 0) }), imageSpec,
        'tileRequest(z,x,y) returns a request specification, not image bytes. XYZ returns {url}; WMS additionally returns {bbox,width:256,height:256,warp} with WGS84 bbox and warp when CRS differs from EPSG:3857.', ['z', 'x', 'y']);
    nativeOperations['imagery/xyz'] = { tileUrl: standardOperations.imagery.tileUrl, image: imageOperation, tileRequest: tileRequestOperation };
    nativeOperations['imagery/wms'] = { tileUrl: standardOperations.imagery.tileUrl, image: imageOperation, tileRequest: tileRequestOperation,
        mapRequest: operation(obj({ bbox, width: number('Width pixels.', 1), height: number('Height pixels.', 1) }), imageSpec,
            'mapRequest(bbox,width,height) returns {url,width,height}; bbox is WGS84. No warp is added for this map request.', ['bbox', 'width', 'height']) };
    nativeOperations['imagery/xyz-basemap'] = { basemap: standardOperations.imagery.basemap };
    nativeOperations['imagery/maptiler-basemap'] = { basemap: operation(obj({ options: obj({}, [], true) }, []), standardOperations.imagery.basemap.output,
        'basemap({apiKey}) receives the key in private runtime input; it is never source config or catalogue metadata.', ['options?']) };
    // Publish native method schemas too; adapters expose only their actual subset below.
    for (const [key, methods] of Object.entries(nativeOperations)) for (const [name, contract] of Object.entries(methods)) if (!operations[key.split('/')[0]][name]) operations[key.split('/')[0]][name] = contract;

    const configs = {};
    const config = (family, id, configSchema, example, preparation) => { configs[family + '/' + id] = { configSchema, example, preparation }; };
    const publicUrl = string('Public HTTPS URL; no credentials or secret query parameters.', 'uri');
    const field = { type: 'string', pattern: '^:?[A-Za-z_][A-Za-z0-9_:.-]{0,79}$' };
    for (const family of ['parcels', 'buildings']) for (const id of ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', ...(family === 'buildings' ? ['overpass'] : [])]) {
        const building = family === 'buildings';
        const properties = { adapter: { const: id }, endpoint: publicUrl, cityIds: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' }, minItems: 1, maxItems: 1 },
            ...(building ? { kind: { const: 'building' } } : {}) };
        if (id !== 'overpass') Object.assign(properties, {
            metricSrid: { type: 'integer', minimum: 2000, maximum: 99999 }, outFields: { type: 'array', items: field, minItems: 1, maxItems: 40 },
            idField: field, objectIdField: field, parcelNumberField: field, versionField: field, geometryField: field,
            idFields: { type: 'array', items: field, minItems: 1, maxItems: 8 }, idType: { enum: ['integer', 'string'] },
            typeName: string('WFS type name.'), featureType: string('Feature type.'), collection: string('OGC collection id.'),
            version: { enum: ['1.1.0', '2.0.0'] }, boundsQueryMode: { enum: ['offset', 'object-ids'] }, bbox,
            expectedSnapshotFeatures: { type: 'integer', minimum: 0, maximum: 5000 }, expectedEtag: string('Quoted HTTP ETag.'),
            ...(building ? { heightField: field, levelsField: field, heightUnit: { enum: ['m', 'ft'] } } : {})
        });
        const example = { adapter: id, endpoint: 'https://data.example.org/' + (id === 'arcgis' ? 'FeatureServer/0' : id === 'geojson-snapshot' ? 'footprints.geojson' : id), cityIds: ['sample_city'],
            ...(building ? { kind: 'building' } : {}), ...(id === 'overpass' ? {} : { metricSrid: 32630, outFields: ['record_id'], idField: 'record_id' }),
            ...(id === 'wfs' ? { typeName: 'cadastre:footprints', version: '2.0.0' } : {}), ...(id === 'ogc-api' ? { collection: 'footprints' } : {}),
            ...(id === 'socrata' ? { geometryField: 'the_geom' } : {}) };
        config(family, id, obj(properties, ['adapter', 'endpoint', ...(building ? ['kind'] : []), ...(id === 'overpass' ? [] : ['metricSrid', 'outFields'])]), example,
            ['Validate with encodeCustomSource; building input includes kind:building. Decoding generates id/idPrefix and reader limits; those resolved fields are not portable input.',
                'List every mapped id/height/levels field in outFields. Confirm adapter-required layer/collection/geometry fields using discovery and a bounded real read.',
                'Supply stable feature ids and valid WGS84 polygon geometry; declare metric CRS, height units, pagination and coverage. GeoJSON snapshots are capped at 5000 features and 8 MiB.']);
    }
    for (const id of ['xyz', 'wms']) config('imagery', id, obj({ kind: { const: 'imagery' }, adapter: { const: id }, endpoint: publicUrl,
        cityIds: { type: 'array', items: string('App city id.'), minItems: 1, maxItems: 1 }, name: string('Readable name.'), attribution: string('Attribution.'), bounds: bbox,
        ...(id === 'xyz' ? { minZoom: { type: 'integer', minimum: 0, maximum: 22 }, maxZoom: { type: 'integer', minimum: 0, maximum: 22 } } : {
            layers: { type: 'array', items: string('WMS layer name.'), minItems: 1, maxItems: 8 }, version: { enum: ['1.1.1', '1.3.0'] }, crs: { enum: ['EPSG:3857', 'EPSG:4326', 'CRS:84'] }, format: { enum: ['image/png', 'image/jpeg'] } }) },
        ['kind', 'adapter', 'endpoint', 'name', ...(id === 'wms' ? ['layers', 'version', 'crs', 'format'] : [])]),
        { kind: 'imagery', adapter: id, endpoint: id === 'xyz' ? 'https://tiles.example.org/{z}/{x}/{y}.png' : 'https://maps.example.org/wms', cityIds: ['sample_city'], name: 'Sample public imagery',
            ...(id === 'wms' ? { layers: ['orthophoto'], version: '1.3.0', crs: 'EPSG:3857', format: 'image/png' } : { minZoom: 0, maxZoom: 19 }) },
        ['Validate with encodeImagerySource. Generated idPrefix belongs to the resolved descriptor.', 'XYZ needs exactly one {z}, {x}, {y}; WMS 1.1.1 excludes CRS:84. Discover and probe coverage; preserve attribution.']);
    config('planning', 'atlas-url', obj({ id: string('Unique source id.'), city: string('App city scope.'), bbox, label: string('Readable label.'), edition: string('Immutable edition.'), url: publicUrl, default: { type: 'boolean' }, parcelSourceId: string('Explicit parcel source for envelopes.'), product: { enum: ['slices', 'districts'] },
        archive: obj({ geometry: string('Exact GeoJSON ZIP member.'), rules: string('Exact CSV or XLSX rules ZIP member.'),
            sheets: { type: 'array', minItems: 1, maxItems: 10, items: string('Exact XLSX worksheet name.') },
            columnNames: { type: 'object', maxProperties: 10, patternProperties: { '^(0|[1-9][0-9]{0,2})$': string('Explicit heading for this zero-based table column.') }, additionalProperties: false },
            repeatedHeaderTail: { type: 'boolean', description: 'Remove only an exact repeated header appended to a data row.' },
            jurisdiction: obj({ field: string('Jurisdiction property in source geography.'), values: { type: 'array', minItems: 1, maxItems: 100, items: string('Exact jurisdiction value to retain.') } }, ['field', 'values']),
            join: { type: 'array', minItems: 1, maxItems: 3, items: obj({ geometry: string('Geometry property.'), rule: string('Rule table column.'), stripPrefix: string('Remove only this rule column’s own code prefix before joining.') }, ['geometry', 'rule']) } }, ['geometry']) }, ['id', 'label', 'edition', 'url']),
        { id: 'sample-plan', city: 'sample_city', label: 'Sample plan', edition: '2026', url: 'https://data.example.org/plan-slices.json' },
        ['Validate a list with parseAtlasSources; city or bbox is required and source ids must be unique.', 'URL serves Atlas Slices GeoJSON by default, or public district GeoJSON/ZIP with product:districts. ZIP rules require an explicit exact-column join. Preserve original fields, literal/expression distinctions and unresolved overlays.', 'Pin parcelSourceId for envelopes. City planning.sourceIds selects the source; cities may share an edition URL and archive configuration.']);
    config('economics', 'rate-table', obj({ version: { const: 1 }, adapter: { const: 'rate-table' }, id: string('Stable source id.'), name: string('Readable name.'), url: publicUrl,
        rates: { type: 'array', minItems: 1, maxItems: 4, items: obj({ metric: { enum: ['land', 'roadLand', 'sale', 'construction'] }, unit: { enum: ['m2-land', 'm2-floor'] }, amount: number('Rate.', 0), currency: { type: 'string', pattern: '^[A-Z]{3}$' }, basis: { enum: ['assumption', 'policy-appraisal', 'market', 'construction-cost'] }, asOf: { type: ['string', 'null'], format: 'date' }, scope: { type: ['string', 'null'] } }, ['metric', 'unit', 'amount', 'currency', 'basis']) } }, ['version', 'adapter', 'id', 'name', 'rates']),
        { version: 1, adapter: 'rate-table', id: 'sample-rates', name: 'Sample scenario rates', rates: [{ metric: 'land', unit: 'm2-land', amount: 100, currency: 'EUR', basis: 'assumption' }] },
        ['Validate with EconomicSources.rateTable. Metrics are unique; land/roadLand use m2-land, sale/construction m2-floor.', 'Non-assumption evidence requires asOf; sale permits market, construction permits construction-cost; currency is fiat and never implicitly converted.']);
    config('geocoding', 'photon', obj({ id: string('Source id.'), endpoint: publicUrl }), { id: 'sample-geocoder', endpoint: 'https://photon.komoot.io/api/' },
        ['HTTPS Photon-compatible endpoint; probe search GeoJSON and browser CORS. SearchModel normalization is separate.']);
    config('transit-alignments', 'static-geojson', obj({ id: string('Source id.'), url: string('Static GeoJSON URL, relative URLs supported.'), mode: string('Transit mode.'), elevationM: number('Reference elevation metres.') }, ['id', 'url'], true),
        { id: 'sample-alignment', url: '/data/sample-alignment.geojson', mode: 'rail' }, ['Prepare WGS84 line FeatureCollection and browser-accessible URL. Source descriptor render/mode metadata stays separate from load output.']);
    config('terrain-profile', 'dgu-dtm-20m', obj({ id: string('Source id.'), endpoint: string('Explicit profile endpoint.'), path: string('Runtime API path.'), source: string('Expected provider source.'), datum: string('Expected vertical datum.'), resolutionM: number('Nominal resolution metres.', 0) }, ['id', 'source', 'datum'], false),
        { id: 'dgu-dtm-20m', path: '/terrain/profile', source: 'dgu-dtm-20m', datum: 'EVRF2000', resolutionM: 20 }, ['Custom endpoints must implement the same profile format; runtime endpoint resolution remains in browser-source-readers.js.', 'POST coordinates/stepM; response must match source/datum and have at least two points. Preserve null elevation and geodesic chainage.']);

    function abstraction(id) {
        const methods = operations[id];
        return methods ? { id, schemaVersion: 'source-abstraction/v1', adapters: (adapterIds[id] || []).map(adapterId => adapter(id, adapterId)),
            operations: Object.fromEntries(Object.entries(methods).map(([name, contract]) => [name, clone(contract)])) } : null;
    }
    function adapter(family, id) {
        if (!operations[family] || typeof id !== 'string' || !id) return null;
        // Planning source ids are data-owned and expand as jurisdictions add regional feeds. Keep
        // their public operation shape stable while describing each unknown registered provider
        // honestly as provider-specific rather than inventing its upstream config schema.
        if (family === 'planning' && !adapterIds.planning.includes(id)) return {
            id, abstraction: family, custom: false, providerSpecific: true,
            required: [...requiredMethods.planning], methods: [...Object.keys(operations.planning)],
            configuration: 'Provider-specific regional planning adapter. Reuse planning-representations.v1; inspect its registered source descriptor for supported fields and capabilities.'
        };
        if (!adapterIds[family]?.includes(id)) return null;
        const native = nativeOnly.has(id) || family === 'parcels' && !['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot'].includes(id);
        const selectedOperations = nativeOperations[family + '/' + id];
        const required = selectedOperations ? Object.keys(selectedOperations) : [...(requiredMethods[family] || [])];
        if (family === 'planning' && ['gup', 'nyc-pilot'].includes(id)) required.push('parcel');
        return { id, abstraction: family, custom: !native, required, methods: selectedOperations ? Object.keys(selectedOperations) : [...(requiredMethods[family] || [])],
            ...(['msda-point', 'tkgm-point', 'pl-uldk-point'].includes(id) ? { optional: ['queryPoint'] } : {}),
            ...(family === 'imagery' && id === 'wms' ? { optional: ['mapRequest'] } : {}),
            operations: clone(selectedOperations || Object.fromEntries((requiredMethods[family] || []).map(name => [name, standardOperations[family][name]]))),
            ...(configs[family + '/' + id] ? clone(configs[family + '/' + id]) : { configSchema: null, example: null, preparation: ['Provider-owned configuration; inspect the registered source and native reader. No universal public config schema is claimed.'] }),
            configuration: family === 'parcels' || family === 'buildings' ? 'See backend/parcels/custom-source-config.js; this adapter id alone does not promise every native option.' :
                family === 'economics' ? 'See frontend/js/economic-sources.js; rate-table v1 is portable and validates explicit units, currency, basis and date.' :
                    family === 'imagery' ? 'See frontend/js/imagery-source.js; XYZ and WMS configs are validated and proxied by the imagery gateway.' :
                        family === 'building-details' ? 'Repository-owned versioned evidence store; custom registrations are disabled.' :
                            native ? 'Provider-specific configured source; custom registration is disabled unless the runtime explicitly registers it.' :
                                'Adapter-native public configuration; validate endpoint, coverage and output contract before registration.' };
    }
    function all() { return Object.keys(operations).map(id => abstraction(id)); }
    function schemas() { return { source: clone(sourceSchema), operations: clone(operationSchemas()) }; }
    return Object.freeze({ abstraction, adapter, all, schemas });
});
