// Which applied subdivision/readjustment plots a road or track edge would cut, and which houses
// standing on such plots it would run through (PARCEL-OPTIONAL.md phase 7b). A later corridor takes
// its ribbon out of the plots it crosses (apply/road.js _groundAfterLaterCorridors), so the road tool
// asks "Build through?" naming them; a corridor through a standing building is refused at apply
// (`building-over-road`), so those are said up front and Build through is not offered. Pure: the
// browser glue (corridor-structures.js) passes live pieces, proposal buildings and records.
// UMD: `window.__plotCrossings`, `require` in backend tests.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__plotCrossings = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // Crossings below this are kerf along shared edges, not ground the corridor takes (the same
    // 1 m² budget corridor-structures.js uses for parks/squares/lakes).
    const MIN_CROSSING_M2 = 1;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (global && global.turf) return global.turf;
        return typeof require === 'function' ? require('@turf/turf') : null;
    }

    const asFeature = value => {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry ? value : null;
        if (value.geometry && value.geometry.type) return { type: 'Feature', properties: {}, geometry: value.geometry };
        if (value.type === 'Polygon' || value.type === 'MultiPolygon') return { type: 'Feature', properties: {}, geometry: value };
        return null;
    };

    function overlapM2(t, a, b) {
        try {
            const hit = t.intersect(a, b);
            return hit ? (Number(t.area(hit)) || 0) : 0;
        } catch (error) {
            console.warn('[plot-crossings] intersection failed', error);
            return 0;
        }
    }

    function isPlotRecord(record) {
        return !!(record && record.reparcellization && typeof record.reparcellization === 'object');
    }

    function plotKind(record) {
        return record && record.reparcellization && record.reparcellization.poolSource === 'site' ? 'subdivision' : 'readjustment';
    }

    function titleOf(record, fallback) {
        const value = record && (record.title || record.name || record.proposalName);
        return value ? String(value) : String(fallback || '');
    }

    function idOf(record) {
        const value = record && (record.proposalId ?? record.id);
        return value === undefined || value === null ? '' : String(value);
    }

    // The ground a plot record subdivides: its site, else its plots.
    function plotGroundParts(record) {
        const site = asFeature(record && record.site);
        if (site) return [site];
        const polygons = record && record.reparcellization && Array.isArray(record.reparcellization.polygons)
            ? record.reparcellization.polygons : [];
        return polygons.map(asFeature).filter(Boolean);
    }

    /**
     * @param corridor GeoJSON Feature/geometry of the edge being added (surface ribbon).
     * @param {{ pieces: object[], buildings: object[], lookupProposal: (id) => object|null,
     *   plotRecords: object[], approvedIds?: Iterable<string>, minAreaM2?: number, turf?: object }} options
     *   pieces: live fabric pieces near the edge (properties.producedByProposalId);
     *   buildings: applied proposal building footprints (properties.proposalId);
     *   plotRecords: applied subdivision/readjustment records (for "is this house on a plot").
     * @returns {{ plots: {proposalId, title, kind, count, areaM2}[], blocked: {proposalId, title, plotProposalId, plotTitle, areaM2}[] }}
     */
    function detectPlotCrossings(corridor, options) {
        const opts = options || {};
        const t = T(opts);
        const edge = asFeature(corridor);
        const out = { plots: [], blocked: [] };
        if (!t || !edge) return out;
        const min = typeof opts.minAreaM2 === 'number' && Number.isFinite(opts.minAreaM2) ? opts.minAreaM2 : MIN_CROSSING_M2;
        const approved = new Set(Array.from(opts.approvedIds || [], String));
        const lookup = typeof opts.lookupProposal === 'function' ? opts.lookupProposal : () => null;

        const byPlotRecord = new Map();
        (Array.isArray(opts.pieces) ? opts.pieces : []).forEach(piece => {
            const producer = piece && piece.properties ? piece.properties.producedByProposalId : null;
            if (producer === undefined || producer === null || producer === '') return;
            const key = String(producer);
            if (approved.has(key)) return;
            const record = lookup(key);
            if (!isPlotRecord(record)) return;
            const feature = asFeature(piece);
            const area = feature ? overlapM2(t, edge, feature) : 0;
            if (area < min) return;
            const entry = byPlotRecord.get(key) || { proposalId: key, title: titleOf(record, key), kind: plotKind(record), count: 0, areaM2: 0 };
            entry.count += 1;
            entry.areaM2 += area;
            byPlotRecord.set(key, entry);
        });
        out.plots = Array.from(byPlotRecord.values())
            .map(entry => ({ ...entry, areaM2: Math.round(entry.areaM2) }))
            .sort((a, b) => b.areaM2 - a.areaM2 || a.proposalId.localeCompare(b.proposalId));

        const plotGrounds = (Array.isArray(opts.plotRecords) ? opts.plotRecords : [])
            .filter(isPlotRecord)
            .map(record => ({ record, parts: plotGroundParts(record) }));
        const byHouse = new Map();
        (Array.isArray(opts.buildings) ? opts.buildings : []).forEach(building => {
            const feature = asFeature(building);
            const owner = feature && feature.properties ? feature.properties.proposalId : null;
            if (!feature || owner === undefined || owner === null || owner === '') return;
            const area = overlapM2(t, edge, feature);
            if (area < min) return;
            const ground = plotGrounds.find(entry => entry.parts.some(part => overlapM2(t, part, feature) >= min));
            if (!ground) return; // a building not on a plot keeps the building prompt (corridor-tunnel.js)
            const key = String(owner);
            const entry = byHouse.get(key) || {
                proposalId: key,
                title: titleOf(lookup(key), key),
                plotProposalId: idOf(ground.record),
                plotTitle: titleOf(ground.record, idOf(ground.record)),
                areaM2: 0
            };
            entry.areaM2 += area;
            byHouse.set(key, entry);
        });
        out.blocked = Array.from(byHouse.values())
            .map(entry => ({ ...entry, areaM2: Math.round(entry.areaM2) }))
            .sort((a, b) => a.proposalId.localeCompare(b.proposalId));
        return out;
    }

    function defaultT(key, fallback, params) {
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (params && name in params ? params[name] : match));
    }

    function defaultFormatArea(m2) {
        return `${Math.round(m2).toLocaleString('en-US')} m²`;
    }

    /**
     * The prompt for a detection result, or null when there is nothing to ask.
     * @param {{ t?: (key, fallback, params) => string, corridorKind?: 'road'|'track', formatArea?: (m2) => string }} options
     * @returns {null | { message, choices: {value, label, primary?}[], blocked: boolean }}
     *   choices: Build through + Choose another route; only the latter when a house is in the way.
     */
    function plotCrossingPrompt(result, options) {
        const opts = options || {};
        const t = typeof opts.t === 'function' ? opts.t : defaultT;
        const formatArea = typeof opts.formatArea === 'function' ? opts.formatArea : defaultFormatArea;
        const plots = result && Array.isArray(result.plots) ? result.plots : [];
        const blocked = result && Array.isArray(result.blocked) ? result.blocked : [];
        if (!plots.length && !blocked.length) return null;
        const kind = opts.corridorKind === 'track'
            ? t('modal.corridorTunnel.track', 'track', {})
            : t('modal.corridorTunnel.road', 'road', {});
        const parts = [];
        if (plots.length) {
            const lines = plots.map(entry => `• ${t('modal.corridorPlots.line', '“{{name}}”: {{plots}}, {{area}}', {
                name: entry.title,
                plots: entry.count === 1
                    ? t('modal.corridorPlots.plotOne', '1 plot', { count: 1 })
                    : t('modal.corridorPlots.plotMany', '{{count}} plots', { count: entry.count }),
                area: formatArea(entry.areaM2)
            })}`);
            parts.push(`${t('modal.corridorPlots.offer', 'This {{kind}} would cut through plots of:', { kind })}\n${lines.join('\n')}`);
            if (!blocked.length) {
                parts.push(t('modal.corridorPlots.note',
                    'The {{kind}} takes its ground out of the plots it crosses; the rest of each plot stays. Unapplying the {{kind}} gives them back. Build through?',
                    { kind }));
            }
        }
        if (blocked.length) {
            const lines = blocked.map(entry => `• ${t('modal.corridorPlots.blockedLine', '“{{name}}” on “{{plot}}”', { name: entry.title, plot: entry.plotTitle })}`);
            parts.push(`${t('modal.corridorPlots.blocked', 'It would run through a house standing on a plot:', { kind })}\n${lines.join('\n')}`);
            parts.push(t('modal.corridorPlots.blockedNote',
                'A {{kind}} is never built through a standing building, so it would be refused. Choose another route, or unapply the house first.',
                { kind }));
        }
        const cancel = { value: 'cancel', label: t('modal.corridorTunnel.cancel', 'Choose another route', {}) };
        const choices = blocked.length
            ? [{ ...cancel, primary: true }]
            : [{ value: 'build', label: t('modal.corridorStructure.buildThrough', 'Build through', {}), primary: true }, cancel];
        return { message: parts.join('\n\n'), choices, blocked: blocked.length > 0 };
    }

    return {
        MIN_CROSSING_M2,
        isPlotRecord,
        plotKind,
        detectPlotCrossings,
        plotCrossingPrompt
    };
});
