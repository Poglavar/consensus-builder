// Files a design downloads as besides its plan file, each in the shape the matching import reads
// back: a road or track as its own OSM document (Road → Import, OSM JSON), the same ways as OSM XML
// for tools that read only XML, and a parcel layout's plots as GeoJSON polygons (the layout editor's
// Upload GeoJSON). Pure; PlanFileUI offers them.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DesignFileExports = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const osmForm = () => (root && root.__corridorOsmForm) || require('./corridor-osm-form.js');
    const corridorImport = () => (root && root.__corridorImport) || require('./corridor-import.js');

    // The road's stored OSM document (corridor-osm-form toRecord), or null for a design that is not
    // a drawn road or track. Every way carries the design's title as its `name`: the OSM import makes
    // one road per name, so the road comes back as one road with its title. What the ways cannot say
    // (tunnels, grade separations, a road-in-parcel bound…) rides along as `cb:definition`, an
    // extension OSM readers ignore and Road → Import reads back.
    function roadOsmDocument(record) {
        const definition = record && record.roadProposal && record.roadProposal.definition;
        if (!definition) return null;
        const stored = osmForm().toRecord(definition);
        if (!stored || !stored.osm) return null;
        const name = String(record.title || '').trim() || 'Road';
        const carried = Object.fromEntries(corridorImport().CARRIED_FIELDS.filter(field => stored[field] !== undefined).map(field => [field, stored[field]]));
        return { ...stored.osm, elements: stored.osm.elements.map(element => (element.type === 'way' ? { ...element, tags: { ...element.tags, name } } : element)),
            ...(Object.keys(carried).length ? { 'cb:definition': carried } : {}) };
    }

    const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

    // An OSM document as OSM XML (.osm), for JOSM and SUMO's netconvert (which turns it into
    // OpenDRIVE). Ids stay negative, OSM's mark for objects not yet in the map, and `upload="never"`
    // keeps editors from sending a design to OpenStreetMap. `cb:definition` has no place in OSM XML,
    // so Road → Import reads this file back without it.
    function osmXml(doc) {
        const tags = tagged => Object.entries(tagged || {}).map(([k, v]) => `\n    <tag k="${escapeXml(k)}" v="${escapeXml(v)}"/>`).join('');
        const lines = doc.elements.map(element => (element.type === 'node'
            ? `  <node id="${element.id}" lat="${element.lat}" lon="${element.lon}"${element.tags ? `>${tags(element.tags)}\n  </node>` : '/>'}`
            : `  <way id="${element.id}">${element.nodes.map(ref => `\n    <nd ref="${ref}"/>`).join('')}${tags(element.tags)}\n  </way>`));
        return `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="${escapeXml(doc.version || '0.6')}" generator="${escapeXml(doc.generator || 'consensus-builder')}" upload="never">\n`
            + `${lines.join('\n')}\n</osm>\n`;
    }

    // Plot polygons as a FeatureCollection, numbered in their order.
    function plotsGeoJson(geometries) {
        return { type: 'FeatureCollection', features: geometries.map((geometry, index) => ({ type: 'Feature', properties: { plot: index + 1 }, geometry })) };
    }

    function layoutPlotsGeoJson(record) {
        const plots = record && record.parcelLayout && record.parcelLayout.plots;
        return Array.isArray(plots) && plots.length ? plotsGeoJson(plots.map(plot => plot.geometry)) : null;
    }

    // The extra downloads of one design: [{ id, suffix, type, text }], empty when it has none.
    function downloadsFor(record) {
        const files = [];
        const osm = roadOsmDocument(record);
        if (osm) {
            files.push({ id: 'road-osm', suffix: '.osm.json', type: 'application/json', text: JSON.stringify(osm, null, 2) + '\n' });
            files.push({ id: 'road-osm-xml', suffix: '.osm', type: 'application/vnd.openstreetmap.data+xml', text: osmXml(osm) });
        }
        const plots = layoutPlotsGeoJson(record);
        if (plots) files.push({ id: 'layout-plots', suffix: '-plots.geojson', type: 'application/geo+json', text: JSON.stringify(plots, null, 2) + '\n' });
        return files;
    }

    return { roadOsmDocument, osmXml, plotsGeoJson, layoutPlotsGeoJson, downloadsFor };
});
