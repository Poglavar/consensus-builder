// Importing roads from a file (roads.md §11): every road format is an adapter into the OSM form,
// and this is the one path from that form to applied road records — one record per road, built
// and junctioned exactly as a drawn road is (ProposalManager.createCorridorProposalAtomically).
// `recordsFromImport` is pure and node-tested; the browser half offers the formats in a chooser
// (OpenStreetMap and OpenDRIVE live, four more named and greyed until asked for), picks the file,
// places one that has no georeference at the map centre, and reports.
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
    // Every format the chooser offers, in its order. The two with a `parse` are supported; the rest
    // are named so the choice is visible and asked for, and get an adapter when someone needs one.
    const FORMATS = [
        { id: 'osm', label: 'OpenStreetMap', extensions: ['osm', 'json'], icon: 'fa-map', key: 'importOsm',
            parse: text => adapter('__corridorImportOsm', './corridor-import-osm.js').parseOsm(text) },
        { id: 'opendrive', label: 'OpenDRIVE', extensions: ['xodr'], icon: 'fa-road', key: 'importOpenDrive',
            parse: (text, options) => adapter('__corridorImportOpenDrive', './corridor-import-opendrive.js').parseOpenDrive(text, options) },
        { id: 'landxml', label: 'LandXML', extensions: ['xml'], icon: 'fa-drafting-compass', key: 'importLandXml' },
        { id: 'streetmix', label: 'Streetmix', extensions: ['json'], icon: 'fa-street-view', key: 'importStreetmix' },
        { id: 'geojson', label: 'GeoJSON', extensions: ['geojson', 'json'], icon: 'fa-code', key: 'importGeoJson' },
        { id: 'shapefile', label: 'Shapefile', extensions: ['zip', 'shp'], icon: 'fa-file-archive', key: 'importShapefile' }
    ];
    const extensionOf = name => String(name || '').toLowerCase().split('.').pop();
    const formatById = id => FORMATS.find(format => format.id === id) || null;
    // The format a file is read with: the one chosen in the dialog, else the first supported format
    // that takes the file's extension.
    function formatFor(fileName, chosenId) {
        const chosen = chosenId ? formatById(chosenId) : null;
        if (chosen) return chosen.parse ? chosen : null;
        const extension = extensionOf(fileName);
        return FORMATS.find(format => format.parse && format.extensions.includes(extension)) || null;
    }
    const supportedAccept = () => FORMATS.filter(format => format.parse).flatMap(format => format.extensions).map(ext => `.${ext}`).join(',');

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
        const chosen = formatFor(file.name, formatId);
        if (!chosen) {
            status(t('panel.road.importUnsupported', 'Unsupported file type: {{ext}}. Supported: OpenStreetMap (.osm, .json) and OpenDRIVE (.xodr).', { ext: extension || '?' }), { transient: true });
            return null;
        }
        const map = global.map;
        const centre = map && typeof map.getCenter === 'function' ? map.getCenter() : null;
        let parsed;
        try {
            parsed = chosen.parse(await file.text(), { anchor: centre ? { lat: centre.lat, lng: centre.lng, headingDeg: 0 } : undefined });
        } catch (error) {
            status(t('panel.road.importFailed', 'Could not import {{file}}: {{reason}}', { file: file.name, reason: String(error && error.message || error) }));
            return null;
        }
        const author = (typeof global.getProposalAuthorValue === 'function' && global.getProposalAuthorValue()) || 'import';
        const records = recordsFromImport(parsed, { author, source: chosen.label.toLowerCase(), fallbackTitle: t('panel.road.importedRoad', 'Imported road') });
        if (!records.length) {
            status(t('panel.road.importNone', '{{file}} holds no road this app can draw.', { file: file.name }));
            return null;
        }
        const manager = global.ProposalManager;
        const created = [];
        const failed = [];
        for (const record of records) {
            const definition = record.roadProposal.definition;
            // The same steps Finish takes: the land from the lanes, the parcels it reaches, then the
            // one transaction that junctions it with the roads already applied.
            if (typeof global.rebuildRoadDefinitionFootprint === 'function') global.rebuildRoadDefinitionFootprint(definition);
            if (typeof global.declareParcelsUnderRoadLand === 'function') global.declareParcelsUnderRoadLand(record, definition.polygon);
            try {
                const result = await manager.createCorridorProposalAtomically(record);
                if (result && result.ok) created.push(result.proposalId); else failed.push(result && result.reason);
            } catch (error) {
                failed.push(String(error && error.message || error));
            }
        }
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
        status(summary + placed + problems);
        if (parsed.warnings && parsed.warnings.length) console.warn('[corridor-import]', file.name, parsed.warnings);
        return { created, failed, placement: parsed.placement, warnings: parsed.warnings || [] };
    }

    function bindCorridorImportInput() {
        const input = global.document && global.document.getElementById('corridorImportInput');
        if (!input || input.dataset.bound) return;
        input.dataset.bound = '1';
        input.addEventListener('change', () => { const file = input.files && input.files[0]; if (file) importCorridorFile(file, input.dataset.format || undefined); });
    }
    if (global && global.document) {
        if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', bindCorridorImportInput);
        else bindCorridorImportInput();
        global.openCorridorImportPicker = openCorridorImportPicker;
        global.openCorridorImportChooser = openCorridorImportChooser;
    }

    return { recordsFromImport, importCorridorFile, openCorridorImportPicker, openCorridorImportChooser, FORMATS, formatFor, extensionOf };
});
