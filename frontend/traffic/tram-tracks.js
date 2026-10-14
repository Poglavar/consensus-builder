// Clip canonical OSM tram ways to the preview and derive metre-gauge rails on their actual centerlines.
(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./geometry.js') : root.TrafficGeometry);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficTramTracks = api;
})(typeof window !== 'undefined' ? window : null, function (G) {
    'use strict';
    // Match Station3D's street-tram cross-section: narrow rails, a paved shoulder, and no heavy-rail sleepers.
    const RAIL_WIDTH_M = .1, BED_SHOULDER_M = .5, TRACK_SPACING_M = 2.8;

    function clip(points, bbox) {
        const parts = [];
        let current = [];
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1];
            const bounds = [[-dx, a[0] - bbox[0]], [dx, bbox[2] - a[0]], [-dy, a[1] - bbox[1]], [dy, bbox[3] - a[1]]];
            let start = 0, end = 1;
            for (const [p, q] of bounds) {
                if (Math.abs(p) < 1e-12) { if (q < 0) { start = 2; break; } }
                else if (p < 0) start = Math.max(start, q / p);
                else end = Math.min(end, q / p);
            }
            if (start >= end) { if (current.length > 1) parts.push(current); current = []; continue; }
            const first = [a[0] + dx * start, a[1] + dy * start], last = [a[0] + dx * end, a[1] + dy * end];
            if (!current.length || Math.hypot(current.at(-1)[0] - first[0], current.at(-1)[1] - first[1]) > 1e-9) {
                if (current.length > 1) parts.push(current);
                current = [first];
            }
            current.push(last);
        }
        if (current.length > 1) parts.push(current);
        return parts;
    }

    function fromGeoJSON(source, bbox) {
        if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features) || source.metadata?.truncated) {
            throw new Error('The mapped rail source is missing or truncated.');
        }
        const records = [], seen = new Set();
        for (const feature of source.features) {
            const props = feature.properties || {};
            if (props.railway !== 'tram' || seen.has(String(props.osm_id))) continue;
            if (props.osm_id == null || feature.geometry?.type !== 'LineString'
                || !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 2
                || !feature.geometry.coordinates.every(p =>
                Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
                throw new Error(`Invalid mapped tram geometry: ${props.osm_id}`);
            }
            const gauge = Number.parseFloat(props.gauge), count = props.tracks == null ? 1 : Number(props.tracks);
            if (!Number.isFinite(gauge) || gauge <= 0 || !Number.isInteger(count) || count < 1 || count > 8) {
                throw new Error(`Invalid mapped tram cross-section: ${props.osm_id}`);
            }
            seen.add(String(props.osm_id));
            for (const [part, points] of clip(feature.geometry.coordinates, bbox).entries()) {
                records.push({ id: `tram:${props.osm_id}:${part}`, sourceWayId: String(props.osm_id),
                    name: props.name || '', gaugeM: gauge / 1000, trackCount: count, points });
            }
        }
        return records;
    }

    function build(records, project, offsetPolyline) {
        const tracks = [];
        for (const record of records) {
            const points = record.points.map(project);
            for (let track = 0; track < record.trackCount; track++) {
                const centerOffset = (track - (record.trackCount - 1) / 2) * TRACK_SPACING_M;
                const center = centerOffset ? offsetPolyline(points, centerOffset) : points;
                tracks.push({ id: `${record.id}:track:${track}`, sourceWayId: record.sourceWayId, gaugeM: record.gaugeM,
                    path: G.path(center), bedWidth: record.gaugeM + RAIL_WIDTH_M + 2 * BED_SHOULDER_M,
                    railWidth: RAIL_WIDTH_M,
                    rails: [-1, 1].map(side => G.path(offsetPolyline(points, centerOffset + side * record.gaugeM / 2))) });
            }
        }
        return tracks;
    }
    return { fromGeoJSON, build };
});
