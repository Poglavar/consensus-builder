// Tests for the GeoJSON adapter in frontend/js/corridor-import.js: LineStrings and MultiLineString
// parts become one road each, feature properties read as OSM tags (width, lanes, highway, railway),
// non-line features are counted and left out, non-WGS84 input is refused, and a JSON file is told
// apart as OSM JSON or GeoJSON by its content.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const imports = require('../../frontend/js/corridor-import.js');
const P = require('../../frontend/js/corridor-profile.js');

const line = (coordinates, properties = {}, extra = {}) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates }, ...extra });
const COLLECTION = {
    type: 'FeatureCollection',
    features: [
        line([[15.970, 45.800], [15.971, 45.800], [15.972, 45.800]], { name: 'Ulica A', highway: 'residential', width: 12, lanes: 2, sidewalk: 'both' }, { id: 'a' }),
        { type: 'Feature', properties: { name: 'Two parts' }, geometry: { type: 'MultiLineString', coordinates: [
            [[15.972, 45.800], [15.972, 45.801]],
            [[15.973, 45.801], [15.974, 45.801]]
        ] } },
        line([[15.975, 45.802], [15.975, 45.803]], { mode: 'rail', name: 'Tram' }),
        line([[15.976, 45.802], [15.977, 45.803]], { highway: 'footway', width: 3 }),
        { type: 'Feature', properties: { name: 'Park' }, geometry: { type: 'Polygon', coordinates: [[[15.97, 45.79], [15.98, 45.79], [15.98, 45.795], [15.97, 45.79]]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [15.97, 45.8] } }
    ]
};

describe('parseGeoJson', () => {
    it('makes one road per LineString and per MultiLineString part, sharing nodes where lines meet', () => {
        const parsed = imports.parseGeoJson(JSON.stringify(COLLECTION));
        expect(parsed.placement).toBe('georeference');
        expect(parsed.skipped).toBe(2);
        expect(parsed.warnings).toEqual(['2 feature(s) that are not lines were left out']);
        expect(parsed.roads.map(road => [road.id, road.name])).toEqual([
            ['a', 'Ulica A'], ['f2.1', 'Two parts'], ['f2.2', 'Two parts'], ['f3', 'Tram'], ['f4', null]
        ]);
        const ways = parsed.form.elements.filter(element => element.type === 'way');
        const nodes = parsed.form.elements.filter(element => element.type === 'node');
        expect(ways).toHaveLength(5);
        // Ulica A's end and the first part's start are the same position, so one node
        expect(ways[1].nodes[0]).toBe(ways[0].nodes[2]);
        expect(nodes).toHaveLength(10);
        expect(nodes.find(node => node.id === ways[0].nodes[0])).toMatchObject({ lat: 45.8, lon: 15.97 });
        expect(ways[0].tags).toMatchObject({ name: 'Ulica A', highway: 'residential', width: '12', lanes: '2', sidewalk: 'both', 'cb:segment': 'g1' });
        expect(ways[1].tags.highway).toBe('road'); // no class: a plain road, as drawn
        expect(ways[3].tags).toMatchObject({ railway: 'rail' });
    });

    it('becomes road and track records whose cross-sections follow the properties', () => {
        const records = imports.recordsFromImport(imports.parseGeoJson(JSON.stringify(COLLECTION)), { author: 'test', source: 'geojson' });
        expect(records.map(record => [record.title, record.primaryType])).toEqual([
            ['Ulica A', 'Road'], ['Two parts', 'Road'], ['Two parts', 'Road'], ['Tram', 'Track'], ['Imported road 5', 'Road']
        ]);
        const street = records[0].roadProposal.definition;
        expect(street.points).toEqual([[{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.971 }, { lat: 45.8, lng: 15.972 }]]);
        expect(street.profile.strips.map(lane => lane.type)).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
        expect(street.metadata).toMatchObject({ highway: 'residential', source: 'geojson', isRoad: true, isTrack: false });
        // the same tags through the OSM path give the same cross-section
        expect(street.profile).toEqual(P.normalizeCorridorProfile(P.corridorProfileFromOsmTags({ highway: 'residential', width: '12', lanes: '2', sidewalk: 'both' })));
        expect(records[1].roadProposal.definition.profile.strips.map(lane => lane.type)).toEqual(['driving', 'driving']);
        expect(records[3].roadProposal.definition.profile.strips.every(lane => lane.type === 'rail')).toBe(true);
        const path = records[4].roadProposal.definition;
        expect(path.profile.strips.map(lane => lane.type)).toEqual(['sidewalk']);
        expect(path.width).toBe(3);
    });

    it('reads a lone Feature and a bare geometry', () => {
        const feature = imports.parseGeoJson(JSON.stringify(line([[16, 45.78], [16.001, 45.78]], { name: 'Solo' })));
        expect(feature.roads).toEqual([{ id: 'f1', name: 'Solo', wayIds: [-1] }]);
        const bare = imports.parseGeoJson(JSON.stringify({ type: 'LineString', coordinates: [[16, 45.78], [16.001, 45.78]] }));
        expect(bare.roads).toHaveLength(1);
        expect(imports.recordsFromImport(bare)).toHaveLength(1);
    });

    it('refuses coordinates that are not WGS84 longitude/latitude, and a declared projected CRS', () => {
        expect(() => imports.parseGeoJson(JSON.stringify(line([[458000, 5070000], [458100, 5070000]])))).toThrow(/outside WGS84/);
        expect(() => imports.parseGeoJson(JSON.stringify(line([['16', 45.78], [16.001, 45.78]])))).toThrow(/not \[longitude, latitude\]/);
        const projected = { ...COLLECTION, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3765' } } };
        expect(() => imports.parseGeoJson(JSON.stringify(projected))).toThrow(/EPSG::3765/);
        const wgs84 = { ...COLLECTION, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } } };
        expect(imports.parseGeoJson(JSON.stringify(wgs84)).roads).toHaveLength(5);
        expect(() => imports.parseGeoJson('{"elements":[]}')).toThrow(/FeatureCollection/);
        expect(() => imports.parseGeoJson('not json')).toThrow(/not valid JSON/);
    });

    it('drops a line with fewer than two distinct positions with a warning', () => {
        const parsed = imports.parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [line([[16, 45.78], [16, 45.78]])] }));
        expect(parsed.roads).toEqual([]);
        expect(parsed.warnings).toEqual(['feature 1 has fewer than two distinct positions and was left out']);
    });
});

describe('format detection', () => {
    const geojson = JSON.stringify(COLLECTION);
    const osmJson = JSON.stringify({ version: 0.6, elements: [] });

    it('tells OSM JSON and GeoJSON apart by content', () => {
        expect(imports.detectJsonFormat(geojson)).toBe('geojson');
        expect(imports.detectJsonFormat(osmJson)).toBe('osm');
        expect(imports.detectJsonFormat('<osm/>')).toBe(null);
        expect(imports.detectJsonFormat('{"foo":1}')).toBe(null);
    });

    it('reads a .json file with the format its content is, whichever JSON format was chosen', () => {
        expect(imports.formatFor('roads.json', undefined, geojson).id).toBe('geojson');
        expect(imports.formatFor('roads.json', 'osm', geojson).id).toBe('geojson');
        expect(imports.formatFor('roads.json', 'geojson', osmJson).id).toBe('osm');
        expect(imports.formatFor('roads.geojson').id).toBe('geojson');
        expect(imports.formatFor('roads.osm', 'osm', '<osm/>').id).toBe('osm');
        expect(imports.formatFor('roads.xodr', undefined, '<OpenDRIVE/>').id).toBe('opendrive');
        expect(imports.formatFor('roads.shp')).toBe(null);
    });
});
