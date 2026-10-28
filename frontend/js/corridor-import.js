// Importing roads from a file (roads.md §11): every road format is an adapter into the OSM form,
// and this is the one path from that form to applied road records — one record per road, built
// and junctioned exactly as a drawn road is (ProposalManager.createCorridorProposalAtomically).
// `recordsFromImport` is pure and node-tested; the browser half offers the formats in a chooser
// (OpenStreetMap, OpenDRIVE and GeoJSON live, three more named and greyed until asked for), picks
// the file, places one that has no georeference at the map centre, and reports.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorImport = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const osmForm = () => {
        if (global && global.__corridorOsmForm) return global.__corridorOsmForm;
        if (typeof require === 'function') return require('./corridor-osm-form.js');
        throw new Error('corridor-osm-form is not available');
    };

    // Adapters by file extension. Each takes the file's text and `{ anchor }`, and answers
    // `{ form, roads, placement, warnings }` (see corridor-import-opendrive.js).
    function adapter(globalName, moduleId) {
        if (global && global[globalName]) return global[globalName];
        if (typeof require === 'function') return require(moduleId);
        throw new Error(`${moduleId} is not available`);
    }
    // ---- GeoJSON ---------------------------------------------------------------------------------
    // Road centrelines as GeoJSON become the same OSM form the other adapters make. Each LineString,
    // and each part of a MultiLineString, is one road; the feature's scalar properties are the way's
    // tags, so `width`, `lanes`, `highway`, `railway`, `sidewalk`, `oneway`… read exactly as in an
    // OSM import. `mode: 'rail'` means `railway=rail`; a line with neither class tag is
    // `highway=road`, as a drawn road is. Points and polygons are not roads: they are counted and
    // left out. Coordinates must be WGS84 longitude/latitude (RFC 7946).
    const GEOJSON_GEOMETRIES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
    const WGS84_CRS_NAME = /(CRS84|EPSG:+4326)$/i; // the legacy `crs` member, when a file still carries one
    const GEOJSON_MAX_LINES = 500;
    const COORD_DECIMALS = 7; // ~1 cm: two line ends this close are one node

    // Which JSON road format a document is, by its content: OSM JSON has an `elements` list, GeoJSON
    // a `type` that is a FeatureCollection, a Feature or a geometry. Null for anything else.
    function jsonFormatOf(doc) {
        if (!doc || typeof doc !== 'object') return null;
        if (Array.isArray(doc.elements)) return 'osm';
        if (doc.type === 'FeatureCollection' || doc.type === 'Feature' || GEOJSON_GEOMETRIES.has(doc.type)) return 'geojson';
        return null;
    }
    function detectJsonFormat(text) {
        const source = String(text || '').replace(/^\uFEFF/, '').trimStart();
        if (!source.startsWith('{')) return null;
        try { return jsonFormatOf(JSON.parse(source)); } catch (_) { return null; }
    }

    // parseGeoJson(text) -> { form, roads, placement, warnings, skipped }, `skipped` being the number
    // of features that are not lines.
    function parseGeoJson(text) {
        let doc;
        try { doc = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch (error) { throw new Error(`GeoJSON: not valid JSON (${error.message})`); }
        if (jsonFormatOf(doc) !== 'geojson') throw new Error('GeoJSON: expected a FeatureCollection, a Feature or a geometry');
        if (doc.crs) {
            const crsName = doc.crs.properties && doc.crs.properties.name;
            if (!(typeof crsName === 'string' && WGS84_CRS_NAME.test(crsName))) {
                throw new Error(`GeoJSON: the file declares the coordinate system ${crsName || 'of another kind'}; only WGS84 longitude/latitude (EPSG:4326) is read. Reproject it first.`);
            }
        }
        const features = doc.type === 'FeatureCollection' ? (Array.isArray(doc.features) ? doc.features : [])
            : doc.type === 'Feature' ? [doc] : [{ type: 'Feature', geometry: doc, properties: {} }];
        const warnings = [];
        const nodeIds = new Map();
        const formNodes = [];
        const formWays = [];
        const roads = [];
        let skipped = 0;
        let lines = 0;
        const nodeOf = (position, featureNumber) => {
            const [lon, lat] = Array.isArray(position) ? position : [];
            if (!(typeof lon === 'number' && Number.isFinite(lon) && typeof lat === 'number' && Number.isFinite(lat))) {
                throw new Error(`GeoJSON: feature ${featureNumber} has a position that is not [longitude, latitude]`);
            }
            if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
                throw new Error(`GeoJSON: feature ${featureNumber} has the position [${lon}, ${lat}], outside WGS84 longitude/latitude; the file is probably in a projected coordinate system. Reproject it to EPSG:4326 first.`);
            }
            const key = `${lon.toFixed(COORD_DECIMALS)},${lat.toFixed(COORD_DECIMALS)}`;
            if (!nodeIds.has(key)) {
                const id = -(formNodes.length + 1);
                nodeIds.set(key, id);
                formNodes.push({ type: 'node', id, lat, lon });
            }
            return nodeIds.get(key);
        };
        features.forEach((feature, index) => {
            const featureNumber = index + 1;
            const geometry = feature && feature.geometry;
            const type = geometry && geometry.type;
            const parts = type === 'LineString' ? [geometry.coordinates] : (type === 'MultiLineString' ? geometry.coordinates : null);
            if (!parts) { skipped += 1; return; }
            if (!Array.isArray(parts) || parts.some(part => !Array.isArray(part))) throw new Error(`GeoJSON: feature ${featureNumber} has malformed coordinates`);
            const properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
            const tags = {};
            Object.entries(properties).forEach(([key, value]) => {
                if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) tags[key] = String(value);
            });
            if (properties.mode === 'rail' && !tags.railway) tags.railway = 'rail';
            if (!tags.highway && !tags.railway) tags.highway = 'road';
            const name = tags.name ? tags.name.trim() : '';
            const featureId = (feature.id !== undefined && feature.id !== null) ? String(feature.id) : `f${featureNumber}`;
            parts.forEach((part, partIndex) => {
                const nodes = part.map(position => nodeOf(position, featureNumber)).filter((id, i, all) => i === 0 || id !== all[i - 1]);
                const label = parts.length > 1 ? `${featureId}.${partIndex + 1}` : featureId;
                if (nodes.length < 2) {
                    warnings.push(`feature ${featureNumber}${parts.length > 1 ? ` part ${partIndex + 1}` : ''} has fewer than two distinct positions and was left out`);
                    return;
                }
                lines += 1;
                if (lines > GEOJSON_MAX_LINES) return;
                const id = -(formWays.length + 1);
                formWays.push({ type: 'way', id, nodes, tags: { ...tags, 'cb:segment': `g${-id}` } });
                roads.push({ id: label, name: name || null, wayIds: [id] });
            });
        });
        if (lines > GEOJSON_MAX_LINES) warnings.push(`${lines} lines in the file; only the first ${GEOJSON_MAX_LINES} were imported`);
        if (skipped) warnings.push(`${skipped} feature(s) that are not lines were left out`);
        const used = new Set(formWays.flatMap(way => way.nodes));
        return {
            form: { version: 0.6, generator: 'consensus-builder', elements: [...formNodes.filter(node => used.has(node.id)), ...formWays] },
            roads,
            placement: 'georeference',
            warnings,
            skipped
        };
    }

    // Every format the chooser offers, in its order. The three with a `parse` are supported; the rest
    // are named so the choice is visible and asked for, and get an adapter when someone needs one.
    const FORMATS = [
        { id: 'osm', label: 'OpenStreetMap', extensions: ['osm', 'json'], icon: 'fa-map', key: 'importOsm',
            parse: text => adapter('__corridorImportOsm', './corridor-import-osm.js').parseOsm(text) },
        { id: 'opendrive', label: 'OpenDRIVE', extensions: ['xodr'], icon: 'fa-road', key: 'importOpenDrive',
            parse: (text, options) => adapter('__corridorImportOpenDrive', './corridor-import-opendrive.js').parseOpenDrive(text, options) },
        { id: 'landxml', label: 'LandXML', extensions: ['xml'], icon: 'fa-drafting-compass', key: 'importLandXml' },
        { id: 'streetmix', label: 'Streetmix', extensions: ['json'], icon: 'fa-street-view', key: 'importStreetmix' },
        { id: 'geojson', label: 'GeoJSON', extensions: ['geojson', 'json'], icon: 'fa-code', key: 'importGeoJson',
            parse: text => parseGeoJson(text) },
        { id: 'shapefile', label: 'Shapefile', extensions: ['zip', 'shp'], icon: 'fa-file-archive', key: 'importShapefile' }
    ];
    const extensionOf = name => String(name || '').toLowerCase().split('.').pop();
    const formatById = id => FORMATS.find(format => format.id === id) || null;
    // The format a file is read with: the one chosen in the dialog, else the first supported format
    // that takes the file's extension. A JSON file is OSM JSON or GeoJSON by its content (`text`,
    // when given), whichever of the two was chosen or the extension suggests.
    function formatFor(fileName, chosenId, text) {
        const chosen = chosenId ? formatById(chosenId) : null;
        const extension = extensionOf(fileName);
        const candidate = chosen || FORMATS.find(format => format.parse && format.extensions.includes(extension)) || null;
        if (!candidate || !candidate.parse) return null;
        const detected = (text !== undefined && (candidate.id === 'osm' || candidate.id === 'geojson')) ? detectJsonFormat(text) : null;
        return detected ? formatById(detected) : candidate;
    }
    const supportedAccept = () => [...new Set(FORMATS.filter(format => format.parse).flatMap(format => format.extensions))].map(ext => `.${ext}`).join(',');

    // The proposal records an import's OSM form makes: one per road (the ways tagged `cb:road`),
    // each a definition read back from that road's ways, shaped like a drawn road's record so the
    // same authoring path junctions and lands it. `author` and `createdAt` come from the caller.
    function recordsFromImport(parsed, options = {}) {
        const form = parsed && parsed.form;
        const elements = (form && Array.isArray(form.elements)) ? form.elements : [];
        const nodes = elements.filter(element => element && element.type === 'node');
        const ways = elements.filter(element => element && element.type === 'way');
        const roads = Array.isArray(parsed && parsed.roads) && parsed.roads.length
            ? parsed.roads
            : [{ id: 'all', name: null, wayIds: ways.map(way => way.id) }];
        const api = osmForm();
        const records = [];
        roads.forEach((road, index) => {
            const roadWays = ways.filter(way => road.wayIds.includes(way.id));
            if (!roadWays.length) return;
            const definition = api.definitionFromOsmForm({ elements: [...nodes, ...roadWays] });
            if (!definition) return;
            const isTrack = definition.profile.strips.every(lane => lane.type === 'rail');
            const highway = roadWays[0].tags && roadWays[0].tags.highway;
            const name = road.name || (roadWays[0].tags && roadWays[0].tags.name) || null;
            definition.tunnels = [];
            definition.gradeSeparations = [];
            definition.metadata = {
                mode: 'import',
                type: isTrack ? 'track' : 'road',
                source: options.source || 'import',
                sourceRoadId: String(road.id),
                isTrack,
                isRoad: !isTrack,
                isCorridor: true,
                ...(highway ? { highway } : {})
            };
            const title = name || `${options.fallbackTitle || 'Imported road'} ${index + 1}`;
            records.push({
                author: options.author || 'import',
                title,
                name: title,
                proposalName: title,
                description: options.description || title,
                primaryType: isTrack ? 'Track' : 'Road',
                goal: 'road-track',
                isCorridor: true,
                cadastreParcelIds: [],
                applied: false,
                createdAt: options.createdAt || new Date().toISOString(),
                roadProposal: { definition, mode: 'import', isCorridor: true }
            });
        });
        return records;
    }

    // ---- browser ---------------------------------------------------------------------------------

    async function loadGroundUnder(definition) {
        const repository = global.CadastralParcelRepository;
        if (!definition.polygon || !repository || typeof repository.ensureBounds !== 'function' || !global.L) return;
        await repository.ensureBounds(global.L.geoJSON(definition.polygon).getBounds());
    }

    // Applied road proposals from records made by recordsFromImport, through the steps a drawn
    // road's Finish takes: the land from the lanes, the parcels it reaches, then the one transaction
    // that junctions it with the roads already applied. Used by the file import, the block
    // playground and the Schelling plan. Answers the new ids and the reasons of the others.
    async function createRoadRecords(records) {
        const manager = global.ProposalManager;
        const created = [];
        const failed = [];
        for (const record of records) {
            const definition = record.roadProposal.definition;
            if (typeof global.rebuildRoadDefinitionFootprint === 'function') global.rebuildRoadDefinitionFootprint(definition);
            try {
                // The parcels a road reaches are read from the ground loaded in this browser, so the
                // ground under its land is loaded first: a road made away from the view, or below
                // the parcel zoom, would otherwise declare none of the parcels it takes. A failed
                // load fails the record rather than declaring too little.
                await loadGroundUnder(definition);
                if (typeof global.declareParcelsUnderRoadLand === 'function') global.declareParcelsUnderRoadLand(record, definition.polygon);
                const result = await manager.createCorridorProposalAtomically(record);
                if (result && result.ok) created.push(result.proposalId); else failed.push(result && result.reason);
            } catch (error) {
                failed.push(String(error && error.message || error));
            }
        }
        return { created, failed };
    }

    function t(key, fallback, params = {}) {
        const api = global && global.i18n;
        if (api && typeof api.t === 'function') {
            try { const translated = api.t(key, params); if (translated !== key) return translated; } catch (_) { /* fall through */ }
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }
    const status = (message, options) => { if (typeof global.updateStatus === 'function') global.updateStatus(message, options); };

    function openCorridorImportPicker(formatId) {
        const input = global.document && global.document.getElementById('corridorImportInput');
        if (!input) return;
        const format = formatId ? formatById(formatId) : null;
        input.accept = format ? format.extensions.map(ext => `.${ext}`).join(',') : supportedAccept();
        input.dataset.format = format ? format.id : '';
        input.value = '';
        input.click();
    }

    // The format chooser: one tile per format, the unsupported ones greyed with the same hover
    // explanation, so the choice is seen and can be asked for.
    function openCorridorImportChooser() {
        const doc = global.document;
        const dialogs = global.CbDialog;
        if (!doc || !dialogs || typeof dialogs.open !== 'function') { openCorridorImportPicker(); return null; }
        const intro = doc.createElement('p');
        intro.className = 'corridor-import-intro';
        intro.textContent = t('panel.road.importChooseIntro', 'Choose the file format. Greyed formats are recognised but not supported yet; ask for one and its adapter is added.');
        const tiles = doc.createElement('div');
        tiles.className = 'cb-tiles corridor-import-formats';
        let dialogApi = null;
        FORMATS.forEach(format => {
            const tile = doc.createElement('button');
            tile.type = 'button';
            tile.className = 'cb-tile';
            tile.setAttribute('data-format', format.id);
            const hint = t(`panel.road.${format.key}Hint`, format.label);
            tile.title = format.parse ? hint : `${hint} ${t('panel.road.importNotYet', 'Not supported yet. Ask for it and the adapter will be added.')}`;
            if (!format.parse) tile.setAttribute('aria-disabled', 'true');
            const icon = doc.createElement('i');
            icon.className = `cb-tile__icon fas ${format.icon}`;
            icon.setAttribute('aria-hidden', 'true');
            const label = doc.createElement('span');
            label.className = 'cb-tile__label';
            label.textContent = `${t(`panel.road.${format.key}`, format.label)} (${format.extensions.map(ext => `.${ext}`).join(', ')})`;
            tile.appendChild(icon);
            tile.appendChild(label);
            tile.addEventListener('click', () => {
                if (!format.parse) {
                    status(t('panel.road.importNotYetStatus', '{{format}} import is not supported yet. Ask for it and the adapter will be added.', { format: format.label }), { transient: true });
                    return;
                }
                if (dialogApi) dialogApi.close(format.id);
                openCorridorImportPicker(format.id);
            });
            tiles.appendChild(tile);
        });
        dialogApi = dialogs.open({
            title: t('panel.road.importChooseTitle', 'Import roads'),
            size: 'sm',
            className: 'corridor-import-dialog',
            body: [intro, tiles],
            actions: [{ id: 'cancel', value: null, label: t('modal.common.cancel', 'Cancel'), role: 'secondary' }]
        });
        return dialogApi;
    }

    async function importCorridorFile(file, formatId) {
        if (!file) return null;
        const extension = extensionOf(file.name);
        const text = await file.text();
        const chosen = formatFor(file.name, formatId, text);
        if (!chosen) {
            status(t('panel.road.importUnsupported', 'Unsupported file type: {{ext}}. Supported: OpenStreetMap (.osm, .json), GeoJSON (.geojson) and OpenDRIVE (.xodr).', { ext: extension || '?' }), { transient: true });
            return null;
        }
        const map = global.map;
        const centre = map && typeof map.getCenter === 'function' ? map.getCenter() : null;
        let parsed;
        try {
            parsed = chosen.parse(text, { anchor: centre ? { lat: centre.lat, lng: centre.lng, headingDeg: 0 } : undefined });
        } catch (error) {
            status(t('panel.road.importFailed', 'Could not import {{file}}: {{reason}}', { file: file.name, reason: String(error && error.message || error) }));
            return null;
        }
        const author = (typeof global.getProposalAuthorValue === 'function' && global.getProposalAuthorValue()) || 'import';
        const records = recordsFromImport(parsed, { author, source: chosen.label.toLowerCase(), fallbackTitle: t('panel.road.importedRoad', 'Imported road') });
        const skippedNote = parsed.skipped ? ' ' + t('panel.road.importSkippedFeatures', '{{count}} feature(s) that are not lines (points, polygons) were left out.', { count: parsed.skipped }) : '';
        if (!records.length) {
            status(t('panel.road.importNone', '{{file}} holds no road this app can draw.', { file: file.name }) + skippedNote);
            return null;
        }
        const { created, failed } = await createRoadRecords(records);
        // The picker lives in the drawing panel; an import is the whole road work, so the pen is put down.
        if (created.length && global.roadDrawingMode && typeof global.exitRoadDrawingMode === 'function') {
            try { global.exitRoadDrawingMode(); } catch (error) { console.warn('[corridor-import] could not leave drawing mode', error); }
        }
        if (map && typeof map.fitBounds === 'function' && created.length) {
            const lats = parsed.form.elements.filter(e => e.type === 'node').map(e => e.lat);
            const lons = parsed.form.elements.filter(e => e.type === 'node').map(e => e.lon);
            if (lats.length) map.fitBounds([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]], { padding: [40, 40] });
        }
        const summary = t('panel.road.importStatus', 'Imported {{count}} of {{total}} roads from {{file}} ({{format}}).', { count: created.length, total: records.length, file: file.name, format: chosen.label });
        const placed = parsed.placement === 'anchor' ? ' ' + t('panel.road.importPlacedAtCentre', 'The file has no georeference, so the roads were placed at the map centre.') : '';
        const problems = failed.length ? ' ' + failed.filter(Boolean).join(' ') : '';
        status(summary + placed + skippedNote + problems);
        if (parsed.warnings && parsed.warnings.length) console.warn('[corridor-import]', file.name, parsed.warnings);
        return { created, failed, placement: parsed.placement, warnings: parsed.warnings || [] };
    }

    function bindCorridorImportInput() {
        const input = global.document && global.document.getElementById('corridorImportInput');
        if (!input || input.dataset.bound) return;
        input.dataset.bound = '1';
        // The chooser has closed by now, so Import… in the road panel spins while the file lands.
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const button = global.document.getElementById('importRoadsButton');
            global.BusyControl.track(button, () => importCorridorFile(file, input.dataset.format || undefined));
        });
    }
    if (global && global.document) {
        if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', bindCorridorImportInput);
        else bindCorridorImportInput();
        global.openCorridorImportPicker = openCorridorImportPicker;
        global.openCorridorImportChooser = openCorridorImportChooser;
    }

    return { recordsFromImport, createRoadRecords, importCorridorFile, openCorridorImportPicker, openCorridorImportChooser, FORMATS, formatFor, extensionOf, parseGeoJson, detectJsonFormat };
});
