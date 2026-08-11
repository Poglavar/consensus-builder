// What is actually on the map, and what it costs to pan it — `mapLoad()` from the console.
//
// "Panning is choppy with 600 proposals" has several possible causes that feel identical, and the
// difference decides the fix: too many DOM nodes (the SVG renderer draws one <path> per polygon, and
// the browser re-renders the whole SVG on every frame of a drag), too many interactive layers (every
// one is hit-tested on mousemove), work bound to map movement, or the same object added twice.
//
// So this counts them instead of guessing. Nothing here mutates the map.
(function attachMapLoadDebug(global) {
    'use strict';

    function paneCounts() {
        const out = {};
        try {
            const panes = global.map.getPanes();
            Object.keys(panes).forEach(name => {
                const el = panes[name];
                if (!el) return;
                const paths = el.querySelectorAll ? el.querySelectorAll('path').length : 0;
                const markers = el.querySelectorAll ? el.querySelectorAll('.leaflet-marker-icon').length : 0;
                const canvases = el.querySelectorAll ? el.querySelectorAll('canvas').length : 0;
                if (paths || markers || canvases) out[name] = { paths, markers, canvases };
            });
        } catch (_) { }
        return out;
    }

    // Where a layer lives, which is what tells a duplicate apart from a coincidence: two copies in
    // parcelLayer is one bug (indexed twice), one in parcelLayer and one added straight to the map
    // is a different one (something bypassed the group), and two in different panes is a third.
    function homeOf(layer) {
        const parts = [];
        try { if (global.parcelLayer && global.parcelLayer.hasLayer(layer)) parts.push('parcelLayer'); } catch (_) { }
        try { if (global.proposedBuildingLayer && global.proposedBuildingLayer.hasLayer(layer)) parts.push('proposedBuildingLayer'); } catch (_) { }
        try {
            const indexed = (global.parcelLayerById instanceof Map) ? global.parcelLayerById.get(String(
                (layer.feature && layer.feature.properties && (layer.feature.properties.parcelId ?? layer.feature.properties.id)) || '')) : null;
            if (indexed) parts.push(indexed === layer ? 'indexed(this one)' : 'indexed(the OTHER one)');
        } catch (_) { }
        try { if (layer.options && layer.options.pane) parts.push('pane:' + layer.options.pane); } catch (_) { }
        try { parts.push(layer.options && layer.options.renderer ? 'canvas' : 'svg'); } catch (_) { }
        if (!parts.length) parts.push('map only');
        return parts.join(' + ');
    }

    // A handful of telling fields rather than the whole property bag.
    function describeOrphan(layer) {
        if (!layer) return null;
        const props = (layer.feature && layer.feature.properties) || {};
        const picked = {};
        ['isRoad', 'isTrack', 'isCorridor', 'isProposed', 'proposalId', 'kind', 'source', 'roadName']
            .forEach(key => { if (props[key] !== undefined) picked[key] = props[key]; });
        if (Array.isArray(props.formedByProposalIds)) picked.formedByProposalIds = props.formedByProposalIds.slice(0, 3);
        picked.interactive = !!(layer.options && layer.options.interactive);
        picked.pane = (layer.options && layer.options.pane) || 'overlayPane';
        return picked;
    }

    function describeOrphanText(layer) {
        const picked = describeOrphan(layer);
        if (!picked) return 'no orphan — both copies are in parcelLayer';
        return Object.entries(picked).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
    }

    function layerCensus() {
        const census = { total: 0, byType: {}, interactive: 0, withFeature: 0, interactiveByType: {} };
        const ids = new Map();
        const homes = new Map();
        // The copy that is NOT the indexed one: the one nothing can find, update or remove.
        const orphans = new Map();
        try {
            global.map.eachLayer(layer => {
                census.total += 1;
                const type = (layer instanceof L.TileLayer) ? 'TileLayer'
                    : (layer instanceof L.Marker) ? 'Marker'
                        : (layer instanceof L.Polygon) ? 'Polygon'
                            : (layer instanceof L.Polyline) ? 'Polyline'
                                : (layer instanceof L.FeatureGroup) ? 'FeatureGroup'
                                    : 'other';
                census.byType[type] = (census.byType[type] || 0) + 1;
                if (layer.options && layer.options.interactive) {
                    census.interactive += 1;
                    census.interactiveByType[type] = (census.interactiveByType[type] || 0) + 1;
                }
                const props = layer.feature && layer.feature.properties;
                if (props) {
                    census.withFeature += 1;
                    const id = props.parcelId ?? props.id ?? null;
                    // A massing polygon is the PROPOSED BUILDING drawn over a parcel, and it carries
                    // that parcel's id so it can be found again. It is a different thing standing on
                    // the same ground, not a second copy of the parcel — counting it as a duplicate
                    // reported 739 "extra layers rendered for nothing" that were in fact the entire
                    // visible product of the plan. Anything that is not ground is not a duplicate of
                    // ground.
                    const isGround = !props.kind || props.kind === 'remainder' || props.kind === 'piece';
                    if (id !== null && id !== undefined && isGround) {
                        const key = String(id);
                        ids.set(key, (ids.get(key) || 0) + 1);
                        if (!homes.has(key)) homes.set(key, []);
                        homes.get(key).push(homeOf(layer));
                        const inGroup = !!(global.parcelLayer && global.parcelLayer.hasLayer(layer));
                        const indexed = (global.parcelLayerById instanceof Map)
                            && global.parcelLayerById.get(key) === layer;
                        if (!inGroup && !indexed) orphans.set(key, layer);
                    }
                }
            });
        } catch (_) { }
        // The same id drawn twice is two sets of geometry to render and two hit-test targets, for one
        // thing on the ground. COUNT them all before showing a sample — reporting the length of a
        // list already sliced to 20 says "20" whether there are 20 or two thousand, which is exactly
        // the kind of number that stops an investigation at the wrong place.
        const duplicated = Array.from(ids.entries())
            .filter(([, count]) => count > 1)
            .sort((a, b) => b[1] - a[1]);
        census.duplicateIdCount = duplicated.length;
        census.duplicateLayerCount = duplicated.reduce((sum, [, count]) => sum + (count - 1), 0);
        census.duplicateIds = duplicated.slice(0, 20).map(([id, count]) => ({
            id,
            drawnTimes: count,
            where: (homes.get(id) || []).join('  |  '),
            // What the ORPHAN is, in its own words — the properties name the code that made it far
            // faster than reading every L.geoJSON call in the app does.
            // A STRING: console.table prints an object as {…}, which has cost three rounds of
            // "expand it and paste it back". The point of the column is to be read at a glance.
            orphanProps: describeOrphanText(orphans.get(id))
        }));
        census.orphanSample = Array.from(orphans.values()).slice(0, 50);
        return census;
    }

    // Leaflet keeps its listeners on _events. Work bound to `move` or `drag` runs on EVERY FRAME of a
    // pan; work bound to `moveend` runs once, after. The first is the one that makes a drag stutter.
    function movementHandlers() {
        const out = {};
        try {
            const events = global.map._events || {};
            ['move', 'movestart', 'moveend', 'drag', 'dragstart', 'dragend', 'zoom', 'zoomend', 'mousemove', 'viewreset']
                .forEach(name => {
                    const list = events[name];
                    if (list && list.length) out[name] = list.length;
                });
        } catch (_) { }
        return out;
    }

    function mapLoad() {
        if (typeof global.map === 'undefined' || !global.map) {
            console.error('[mapLoad] no map on this page');
            return null;
        }
        const census = layerCensus();
        const panes = paneCounts();
        const handlers = movementHandlers();
        // mapPane is the ANCESTOR of every other pane, so a querySelectorAll on it already counts
        // everything the children hold. Summing all panes therefore double-counted the total — it
        // reported 25,236 paths where the real figure was 12,618, and an overstated total is exactly
        // the kind of number that sends someone optimising a layer that was never the problem.
        const own = Object.entries(panes).filter(([name]) => name !== 'mapPane');
        const svgPaths = own.reduce((sum, [, pane]) => sum + pane.paths, 0);
        const markers = own.reduce((sum, [, pane]) => sum + pane.markers, 0);
        const canvases = own.reduce((sum, [, pane]) => sum + pane.canvases, 0);

        const report = {
            renderer: global.map.options.preferCanvas ? 'canvas (preferCanvas)' : 'SVG (Leaflet default)',
            svgPaths,
            markers,
            canvasSurfaces: canvases,
            layers: census.total,
            interactiveLayers: census.interactive,
            byType: census.byType,
            interactiveByType: census.interactiveByType,
            perFramePanHandlers: (handlers.move || 0) + (handlers.drag || 0),
            handlers,
            panes,
            duplicateIdCount: census.duplicateIdCount,
            duplicateLayerCount: census.duplicateLayerCount,
            duplicateIds: census.duplicateIds,
            orphanSample: census.orphanSample
        };

        // Rough, and stated as rough: an SVG overlay stays comfortable into the low thousands of
        // paths and stops being comfortable somewhere after that, because a pan transforms and
        // re-rasterises the whole thing every frame.
        const notes = [];
        if (!global.map.options.preferCanvas && svgPaths > 2000) {
            notes.push(`${svgPaths} SVG paths on the default renderer — the whole overlay is re-rendered `
                + 'each frame of a drag. This is the usual cause of a choppy pan.');
        }
        if (report.perFramePanHandlers > 0) {
            notes.push(`${report.perFramePanHandlers} handler(s) on move/drag run on EVERY FRAME of a pan.`);
        }
        if (census.duplicateIdCount) {
            notes.push(`${census.duplicateIdCount} PARCEL id(s) drawn more than once = ${census.duplicateLayerCount} `
                + 'extra layer(s) rendered and hit-tested for nothing (proposed buildings are not counted: '
                + 'they carry a parcel id but are not a copy of it). duplicateIds shows the worst 20, '
                + 'with orphanProps naming what made the copy nothing can find.');
        }
        if (census.interactive > 3000) {
            notes.push(`${census.interactive} interactive layers are hit-tested on every mousemove.`);
        }
        report.notes = notes;

        console.log(`[mapLoad] ${report.renderer} · ${svgPaths} paths · ${markers} markers · `
            + `${census.total} layers (${census.interactive} interactive)`, report);
        // Which pane holds the paths decides what to move next; a total says only that something must.
        console.log('[mapLoad] paths by pane:', own
            .map(([name, pane]) => `${name}: ${pane.paths} paths, ${pane.canvases} canvas`).join(' · '));
        notes.forEach(note => console.warn('[mapLoad] ' + note));
        if (census.duplicateIds.length) console.table(census.duplicateIds);
        return report;
    }

    global.mapLoad = mapLoad;
})(typeof window !== 'undefined' ? window : globalThis);
