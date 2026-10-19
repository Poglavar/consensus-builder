// Tests for frontend/js/corridor-import-osm.js: an .osm XML extract and an OSM-JSON document give
// the same import form, ways group into roads by name, non-road ways and short ways are left out
// with a warning, and the stretches read back with the cross-section their tags describe.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const osm = require('../../frontend/js/corridor-import-osm.js');
const imports = require('../../frontend/js/corridor-import.js');
const form = require('../../frontend/js/corridor-osm-form.js');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="45.8000" lon="15.9700"/>
  <node id="2" lat="45.8000" lon="15.9710"><tag k="highway" v="crossing"/></node>
  <node id="3" lat="45.8000" lon="15.9720"/>
  <node id="4" lat="45.8010" lon="15.9710"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Ulica A"/><tag k="lanes" v="2"/><tag k="sidewalk" v="both"/></way>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Ulica A"/><tag k="lanes" v="2"/><tag k="sidewalk" v="both"/></way>
  <way id="12"><nd ref="2"/><nd ref="4"/><tag k="highway" v="footway"/></way>
  <way id="13"><nd ref="1"/><nd ref="4"/><tag k="building" v="yes"/></way>
  <way id="14"><nd ref="1"/><nd ref="99"/><tag k="highway" v="service"/></way>
  <relation id="5"><member type="way" ref="10" role=""/><tag k="type" v="route"/></relation>
</osm>`;

const JSON_DOC = JSON.stringify({
    version: 0.6, generator: 'overpass',
    elements: [
        { type: 'node', id: 1, lat: 45.8, lon: 15.97 }, { type: 'node', id: 2, lat: 45.8, lon: 15.971, tags: { highway: 'crossing' } },
        { type: 'node', id: 3, lat: 45.8, lon: 15.972 }, { type: 'node', id: 4, lat: 45.801, lon: 15.971 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'Ulica A', lanes: '2', sidewalk: 'both' } },
        { type: 'way', id: 11, nodes: [2, 3], tags: { highway: 'residential', name: 'Ulica A', lanes: '2', sidewalk: 'both' } },
        { type: 'way', id: 12, nodes: [2, 4], tags: { highway: 'footway' } },
        { type: 'way', id: 13, nodes: [1, 4], tags: { building: 'yes' } },
        { type: 'way', id: 14, nodes: [1, 99], tags: { highway: 'service' } },
        { type: 'relation', id: 5, members: [], tags: { type: 'route' } }
    ]
});

describe('parseOsm', () => {
    it('reads XML and JSON to the same form: road ways only, grouped into roads by name', () => {
        const fromXml = osm.parseOsm(XML);
        const fromJson = osm.parseOsm(JSON_DOC);
        expect(fromJson.form).toEqual(fromXml.form);
        expect(fromJson.roads).toEqual(fromXml.roads);
        expect(fromXml.placement).toBe('georeference');
        const ways = fromXml.form.elements.filter(element => element.type === 'way');
        expect(ways.map(way => way.id)).toEqual([10, 11, 12]);
        expect(ways[0].tags['cb:segment']).toBe('w10');
        expect(fromXml.form.elements.filter(element => element.type === 'node').map(node => node.id).sort()).toEqual([1, 2, 3, 4]);
        expect(fromXml.form.elements.find(element => element.id === 2 && element.type === 'node').tags).toEqual({ highway: 'crossing' });
        expect(fromXml.roads).toEqual([{ id: 'Ulica A', name: 'Ulica A', wayIds: [10, 11] }, { id: 'w12', name: null, wayIds: [12] }]);
        expect(fromXml.warnings).toEqual([
            '1 way(s) without a highway or railway tag were left out',
            'way 14 has fewer than two nodes in the file and was left out'
        ]);
    });

    it('becomes road records whose stretches carry the cross-section the tags describe', () => {
        const records = imports.recordsFromImport(osm.parseOsm(XML), { author: 'test', source: 'openstreetmap' });
        expect(records.map(record => record.title)).toEqual(['Ulica A', 'Imported road 2']);
        const street = records[0].roadProposal.definition;
        expect(street.points).toHaveLength(2);
        expect(street.segmentIds).toEqual(['w10', 'w11']);
        expect(street.profile.strips.map(lane => lane.type)).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
        expect(street.metadata).toMatchObject({ highway: 'residential', source: 'openstreetmap', isRoad: true });
        const path = records[1].roadProposal.definition;
        expect(path.profile.strips.map(lane => lane.type)).toEqual(['sidewalk']);
        // and each record stores as the OSM document it came from
        expect(form.toRecord(street).osm.elements.filter(element => element.type === 'way')).toHaveLength(2);
    });

    it('refuses what is not OSM', () => {
        expect(() => osm.parseOsm('<xodr/>')).toThrow(/no <osm> root/);
        expect(() => osm.parseOsm('{"foo":1}')).toThrow(/elements/);
    });
});
