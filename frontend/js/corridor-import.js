// Importing roads from a file (roads.md §11): every road format is an adapter into the OSM form,
// and this is the one path from that form to applied road records — one record per road, built
// and junctioned exactly as a drawn road is (ProposalManager.createCorridorProposalAtomically).
// `recordsFromImport` is pure and node-tested; the browser half picks the file, chooses the adapter
// by extension, places a file that has no georeference at the map centre, and reports.
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
    const ADAPTERS = {
        xodr: { label: 'OpenDRIVE', parse: (text, options) => adapter('__corridorImportOpenDrive', './corridor-import-opendrive.js').parseOpenDrive(text, options) }
    };
    function adapter(globalName, moduleId) {
        if (global && global[globalName]) return global[globalName];
        if (typeof require === 'function') return require(moduleId);
        throw new Error(`${moduleId} is not available`);
    }
    const extensionOf = name => String(name || '').toLowerCase().split('.').pop();

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

    function openCorridorImportPicker() {
        const input = global.document && global.document.getElementById('corridorImportInput');
        if (!input) return;
        input.value = '';
        input.click();
    }

    async function importCorridorFile(file) {
        if (!file) return null;
        const extension = extensionOf(file.name);
        const chosen = ADAPTERS[extension];
        if (!chosen) {
            status(t('panel.road.importUnsupported', 'Unsupported file type: {{ext}}. Supported: OpenDRIVE (.xodr).', { ext: extension || '?' }), { transient: true });
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
        input.addEventListener('change', () => { const file = input.files && input.files[0]; if (file) importCorridorFile(file); });
    }
    if (global && global.document) {
        if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', bindCorridorImportInput);
        else bindCorridorImportInput();
        global.openCorridorImportPicker = openCorridorImportPicker;
    }

    return { recordsFromImport, importCorridorFile, openCorridorImportPicker, ADAPTERS, extensionOf };
});
