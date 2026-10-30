// A design's extra downloads read back through the matching import: a road's OSM document through
// Road → Import (OSM JSON) as the same stretches and cross-sections, a parcel layout's plots as the
// polygon features the layout editor's Upload GeoJSON takes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Exports = require('../../frontend/js/design-file-exports.js');
const imports = require('../../frontend/js/corridor-import.js');
const form = require('../../frontend/js/corridor-osm-form.js');
const P = require('../../frontend/js/corridor-profile.js');

const strips = key => ({ strips: P.CORRIDOR_PROFILE_PRESETS[key].map(lane => ({ ...lane })) });
const A = { lat: 45.8001, lng: 15.9701 }, B = { lat: 45.8004, lng: 15.9712 }, C = { lat: 45.8011, lng: 15.9716 };
const roadRecord = () => ({ proposalId: 'r1', title: 'Main Street', goal: 'road-track', roadProposal: { definition: {
    points: [[A, B], [B, C]], segments: [[A, B], [B, C]], segmentIds: ['a', 'b'], profile: strips(10), segmentProfiles: { b: strips(26) },
    metadata: { isRoad: true, isCorridor: true } } } });

describe('a road downloads as the OSM document Road → Import reads back', () => {
    it('imports as one road with the same stretches and cross-sections', () => {
        const record = roadRecord();
        const [file] = Exports.downloadsFor(record);
        expect(file).toMatchObject({ id: 'road-osm', suffix: '.osm.json', type: 'application/json' });
        const format = imports.formatFor('main-street.osm.json', null, file.text);
        expect(format.id).toBe('osm');
        const records = imports.recordsFromImport(format.parse(file.text));
        expect(records).toHaveLength(1);
        const [imported] = records;
        expect(imported.title).toBe('Main Street');
        const back = imported.roadProposal.definition;
        expect(back.segments).toEqual(record.roadProposal.definition.segments);
        expect(back.profile.strips.map(lane => [lane.type, lane.width])).toEqual(strips(10).strips.map(lane => [lane.type, lane.width]));
        const second = back.segmentProfiles[back.segmentIds[1]];
        expect(second.strips.map(lane => [lane.type, lane.width])).toEqual(strips(26).strips.map(lane => [lane.type, lane.width]));
    });
    it('brings back what the ways cannot say: tunnels, a road-in-parcel bound, metadata, stretch ids', () => {
        const record = roadRecord();
        const site = { type: 'Polygon', coordinates: [[[15.97, 45.80], [15.972, 45.80], [15.972, 45.802], [15.97, 45.802], [15.97, 45.80]]] };
        const tunnel = { id: 'building-tunnel:x', kind: 'building', edgeKey: 'x', from: A, to: B, segmentId: 'a', buildingIds: ['7'] };
        Object.assign(record.roadProposal.definition, { tunnels: [tunnel], gradeSeparations: [{ id: 'g1', level: 1 }], bound: { site },
            edgeFill: { limit: 'parcel' }, metadata: { mode: 'bounded', isRoad: true, isCorridor: true }, connections: [{ peer: 'other-road' }] });
        const [file] = Exports.downloadsFor(record);
        const doc = JSON.parse(file.text);
        expect(Object.keys(doc['cb:definition']).sort()).toEqual(['bound', 'edgeFill', 'gradeSeparations', 'metadata', 'tunnels']);
        const back = imports.recordsFromImport(imports.formatFor('x.osm.json', null, file.text).parse(file.text))[0].roadProposal.definition;
        expect(back.tunnels).toEqual([tunnel]);
        expect(back.segmentIds).toEqual(['a', 'b']);
        expect(back.gradeSeparations).toEqual([{ id: 'g1', level: 1 }]);
        expect(back.bound).toEqual({ site });
        expect(back.edgeFill).toEqual({ limit: 'parcel' });
        expect(back.metadata.mode).toBe('bounded');
        expect(back.connections).toBeUndefined();
    });
    it('keeps an ordinary OSM file\'s import as it was: no extension, ids from the ways', () => {
        const text = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 45.8, lon: 15.97 }, { type: 'node', id: 2, lat: 45.801, lon: 15.971 },
            { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'residential' } }] });
        const parsed = imports.formatFor('x.json', null, text).parse(text);
        expect(parsed.extension).toBeUndefined();
        const back = imports.recordsFromImport(parsed)[0].roadProposal.definition;
        expect(back.tunnels).toEqual([]); expect(back.metadata.mode).toBe('import');
    });
    it('reads a stored record as well as a running view', () => {
        const record = roadRecord();
        const stored = { ...record, roadProposal: { definition: form.toRecord(record.roadProposal.definition) } };
        expect(Exports.roadOsmDocument(stored)).toEqual(Exports.roadOsmDocument(record));
    });
    it('offers nothing extra for a design that is neither a road nor a layout', () => {
        expect(Exports.downloadsFor({ goal: 'park', structureProposal: { kind: 'park' } })).toEqual([]);
        expect(Exports.downloadsFor({ goal: 'road-track', roadProposal: { definition: { polygon: { type: 'Polygon', coordinates: [] } } } })).toEqual([]);
    });
});

describe('a road downloads as OSM XML for JOSM and netconvert', () => {
    it('writes the same ways, which Road → Import reads back as the same road', () => {
        const record = roadRecord();
        record.title = 'Main & "Market" <Street>';
        const files = Exports.downloadsFor(record);
        expect(files.map(file => file.id)).toEqual(['road-osm', 'road-osm-xml']);
        const xml = files[1];
        expect(xml).toMatchObject({ suffix: '.osm', type: 'application/vnd.openstreetmap.data+xml' });
        expect(xml.text).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<osm version="0.6" generator="consensus-builder" upload="never">/);
        expect(xml.text).toContain('<tag k="name" v="Main &amp; &quot;Market&quot; &lt;Street&gt;"/>');
        const json = JSON.parse(files[0].text);
        // Every node and way, with its id, position, references and tags, as in the OSM JSON.
        expect(require('../../frontend/js/corridor-import-osm.js').elementsFromXml(xml.text)).toEqual(json.elements);
        const format = imports.formatFor('main-street.osm', null, xml.text);
        expect(format.id).toBe('osm');
        const [imported] = imports.recordsFromImport(format.parse(xml.text));
        expect(imported.title).toBe('Main & "Market" <Street>');
        expect(imported.roadProposal.definition.segments).toEqual(record.roadProposal.definition.segments);
        expect(imported.roadProposal.definition.profile.strips.map(lane => [lane.type, lane.width])).toEqual(strips(10).strips.map(lane => [lane.type, lane.width]));
    });
});

describe('a parcel layout downloads its plots as GeoJSON polygons', () => {
    it('numbers each plot and keeps its geometry', () => {
        const square = x => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] });
        const [file] = Exports.downloadsFor({ goal: 'parcel-layout', parcelLayout: { plots: [{ geometry: square(0) }, { geometry: square(1) }] } });
        expect(file).toMatchObject({ id: 'layout-plots', suffix: '-plots.geojson', type: 'application/geo+json' });
        const collection = JSON.parse(file.text);
        expect(collection.type).toBe('FeatureCollection');
        expect(collection.features.map(feature => [feature.properties.plot, feature.geometry])).toEqual([[1, square(0)], [2, square(1)]]);
    });
});
