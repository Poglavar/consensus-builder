// Tests for frontend/js/corridor-import-opendrive.js: an OpenDRIVE (.xodr) network imported into the
// OSM form — roads to ways per lane section, lanes to standard lane tags, connecting roads skipped,
// junction arms extended to one shared node, georeference or anchor placement.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const proj4 = require('proj4');
const { parseOpenDrive, OPENDRIVE_LANE_TYPES, OPENDRIVE_ROAD_TYPES } = require('../../frontend/js/corridor-import-opendrive.js');
const { profileFromLaneTags } = require('../../frontend/js/corridor-osm-form.js');
const { frameAt } = require('../../frontend/js/metric-frame.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(here, 'fixtures/opendrive/t-junction.xodr'), 'utf8');
const FIXTURE_PROJ = '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';

const waysOf = result => result.form.elements.filter(element => element.type === 'way');
const nodeMap = result => new Map(result.form.elements.filter(element => element.type === 'node').map(node => [node.id, node]));
const wayById = (result, id) => waysOf(result).find(way => way.id === id);
const roadWays = (result, roadId) => result.roads.find(road => road.id === roadId).wayIds.map(id => wayById(result, id));
const lanesOf = way => profileFromLaneTags(way.tags).strips.map(({ type, width, direction }) => (direction ? { type, width, direction } : { type, width }));

// A minimal one-road document; `extra` goes into the header, `lanes` replaces the lane section body.
function inlineDoc({ header = '', rule = 'RHT', roadType = 'town', left, right } = {}) {
    const lane = (id, type, width) => `<lane id="${id}" type="${type}"><width sOffset="0" a="${width}" b="0" c="0" d="0"/></lane>`;
    return `<?xml version="1.0"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="6">${header}</header>
  <road name="Test &amp; Road" length="100" id="7" junction="-1" rule="${rule}">
    <type s="0" type="${roadType}"/>
    <planView><geometry s="0" x="0" y="0" hdg="0" length="100"><line/></geometry></planView>
    <lanes><laneSection s="0">
      <left>${left || lane(1, 'driving', 3.5)}</left>
      <center><lane id="0" type="none"/></center>
      <right>${right || lane(-1, 'driving', 3.5)}</right>
    </laneSection></lanes>
  </road>
</OpenDRIVE>`;
}

describe('parseOpenDrive on the T-junction fixture', () => {
    const result = parseOpenDrive(FIXTURE);

    it('imports three roads as four ways and skips the connecting road', () => {
        expect(result.placement).toBe('georeference');
        expect(result.roads.map(road => road.id)).toEqual(['1', '2', '3']);
        expect(result.roads.map(road => road.wayIds.length)).toEqual([1, 2, 1]);
        expect(waysOf(result)).toHaveLength(4);
        expect(waysOf(result).some(way => way.tags['cb:road'] === '10')).toBe(false);
        expect(result.roads.map(road => road.name)).toEqual(['Main Street', 'Main Street', 'Branch Street']);
        // Negative, unique ids per element type.
        const ids = type => result.form.elements.filter(element => element.type === type).map(element => element.id);
        ['node', 'way'].forEach(type => {
            expect(ids(type).every(id => id < 0)).toBe(true);
            expect(new Set(ids(type)).size).toBe(ids(type).length);
        });
        // Consecutive sections of road 2 share their boundary node.
        const [first, second] = roadWays(result, '2');
        expect(second.nodes[0]).toBe(first.nodes[first.nodes.length - 1]);
    });

    it('meets all three roads at one junction node on road 1\'s extended centreline', () => {
        const nodes = nodeMap(result);
        const road1 = roadWays(result, '1')[0];
        const road2 = roadWays(result, '2')[0];
        const road3 = roadWays(result, '3')[0];
        const junction = road1.nodes[road1.nodes.length - 1];
        expect(road2.nodes[0]).toBe(junction);
        expect(road3.nodes[0]).toBe(junction);

        const frame = frameAt([15.96, 45.8]);
        const metric = id => { const node = nodes.get(id); return frame.latLngToMetric(node.lat, node.lon); };
        // The line through road 1's last two sampled points (before the appended junction node).
        const [ax, ay] = metric(road1.nodes[road1.nodes.length - 3]);
        const [bx, by] = metric(road1.nodes[road1.nodes.length - 2]);
        const [nx, ny] = metric(junction);
        const distance = Math.abs((bx - ax) * (ny - ay) - (by - ay) * (nx - ax)) / Math.hypot(bx - ax, by - ay);
        expect(distance).toBeLessThan(0.05);
        // The node is beyond road 1's end (6 m east); in the file's own grid it is the junction centre
        // (458000, 5074000), and road 3's first sample is 9 m grid-north of it (grid north, not true
        // north: the projection's meridian convergence here is about 0.4°).
        expect(Math.hypot(nx - bx, ny - by)).toBeGreaterThan(5.9);
        const grid = id => { const node = nodes.get(id); return proj4('WGS84', FIXTURE_PROJ).forward([node.lon, node.lat]); };
        const [gx, gy] = grid(junction);
        expect(Math.hypot(gx - 458000, gy - 5074000)).toBeLessThan(0.05);
        const [r3x, r3y] = grid(road3.nodes[1]);
        expect(Math.hypot(r3x - 458000, r3y - 5074009)).toBeLessThan(0.05);
    });

    it('reads each lane section\'s cross-section left to right, with directions and the taper warning', () => {
        expect(lanesOf(roadWays(result, '1')[0])).toEqual([
            { type: 'sidewalk', width: 2 },
            { type: 'parking', width: 2.5 },
            { type: 'driving', width: 3.5, direction: 'backward' },
            { type: 'driving', width: 3.5, direction: 'forward' },
            { type: 'parking', width: 2.5 },
            { type: 'sidewalk', width: 2 }
        ]);
        const second = lanesOf(roadWays(result, '2')[1]);
        const forwardDriving = second.findIndex(lane => lane.type === 'driving' && lane.direction === 'forward');
        expect(second[forwardDriving + 1]).toEqual({ type: 'cycleway', width: 1.5, direction: 'forward' });
        expect(second).toHaveLength(7);
        expect(roadWays(result, '1')[0].tags.highway).toBe('residential');
        expect(roadWays(result, '3')[0].tags.name).toBe('Branch Street');
        expect(result.warnings.some(warning => /road 2\b/.test(warning) && /taper|widths change/.test(warning))).toBe(true);
        expect(result.warnings.some(warning => /road 1\b/.test(warning))).toBe(false);
    });

    it('places the network with the file\'s geoReference', () => {
        const nodes = nodeMap(result);
        const start = nodes.get(roadWays(result, '1')[0].nodes[0]);
        expect(start.lat).toBeGreaterThan(45.7);
        expect(start.lat).toBeLessThan(45.9);
        expect(start.lon).toBeGreaterThan(15.9);
        expect(start.lon).toBeLessThan(16.0);
        // Road 1 is symmetric (8 m each side, no laneOffset): its centre is the reference line.
        const lateralShift = (8 - 8) / 2;
        const [x, y] = proj4('WGS84', FIXTURE_PROJ).forward([start.lon, start.lat]);
        expect(Math.hypot(x - 457894, y - (5074000 + lateralShift))).toBeLessThan(0.05);
        // Road 2's second section is shifted 0.75 m right of its reference line (8 m left, 9.5 m right).
        const second = roadWays(result, '2')[1];
        const end = nodes.get(second.nodes[second.nodes.length - 1]);
        const [ex, ey] = proj4('WGS84', FIXTURE_PROJ).forward([end.lon, end.lat]);
        const k = 0.005;
        const refX = 458046 + Math.sin(k * 60) / k;
        const refY = 5074000 + (1 - Math.cos(k * 60)) / k;
        const hdg = k * 60;
        expect(Math.hypot(ex - (refX + Math.sin(hdg) * 0.75), ey - (refY - Math.cos(hdg) * 0.75))).toBeLessThan(0.05);
    });
});

describe('parseOpenDrive placement and rules on inline documents', () => {
    it('places a file without a georeference at the anchor, rotated by its heading', () => {
        const result = parseOpenDrive(inlineDoc(), { anchor: { lat: 45.8, lng: 15.97, headingDeg: 90 } });
        expect(result.placement).toBe('anchor');
        const way = waysOf(result)[0];
        const nodes = nodeMap(result);
        const frame = frameAt([15.97, 45.8]);
        const first = nodes.get(way.nodes[0]);
        const last = nodes.get(way.nodes[way.nodes.length - 1]);
        const [fx, fy] = frame.latLngToMetric(first.lat, first.lon);
        const [lx, ly] = frame.latLngToMetric(last.lat, last.lon);
        expect(Math.hypot(fx, fy)).toBeLessThan(0.1);
        expect(Math.hypot(lx - 0, ly - 100)).toBeLessThan(0.1);
        expect(way.tags.name).toBe('Test & Road');
    });

    it('refuses a file without a georeference when no anchor is given', () => {
        expect(() => parseOpenDrive(inlineDoc())).toThrow(/no georeference/);
    });

    it('flips driving directions under left-hand traffic', () => {
        const rht = lanesOf(waysOf(parseOpenDrive(inlineDoc(), { anchor: { lat: 45.8, lng: 15.97 } }))[0]);
        const lht = lanesOf(waysOf(parseOpenDrive(inlineDoc({ rule: 'LHT' }), { anchor: { lat: 45.8, lng: 15.97 } }))[0]);
        expect(rht.map(lane => lane.direction)).toEqual(['backward', 'forward']);
        expect(lht.map(lane => lane.direction)).toEqual(['forward', 'backward']);
    });

    it('maps road types to highway classes and drops none lanes, narrow borders and sub-0.3 m lanes', () => {
        const anchor = { lat: 45.8, lng: 15.97 };
        const lane = (id, type, width) => `<lane id="${id}" type="${type}"><width sOffset="0" a="${width}" b="0" c="0" d="0"/></lane>`;
        const arterial = waysOf(parseOpenDrive(inlineDoc({ roadType: 'townArterial' }), { anchor }))[0];
        expect(arterial.tags.highway).toBe('primary');
        const pedestrian = waysOf(parseOpenDrive(inlineDoc({ roadType: 'pedestrian' }), { anchor }))[0];
        expect(pedestrian.tags.highway).toBe('pedestrian');
        expect(OPENDRIVE_ROAD_TYPES.townArterial).toBe('primary');
        expect(OPENDRIVE_LANE_TYPES.biking).toBe('cycleway');

        const result = parseOpenDrive(inlineDoc({
            left: lane(3, 'border', 1) + lane(2, 'none', 2) + lane(1, 'driving', 3.5),
            right: lane(-1, 'driving', 3.5) + lane(-2, 'border', 0.3) + lane(-3, 'sidewalk', 0.2)
        }), { anchor });
        expect(lanesOf(waysOf(result)[0])).toEqual([
            { type: 'verge', width: 1 },
            { type: 'driving', width: 3.5, direction: 'backward' },
            { type: 'driving', width: 3.5, direction: 'forward' }
        ]);
        // The way is the middle of what was kept: 4.5 m left, 3.5 m right → 0.5 m left of the reference line.
        const frame = frameAt([15.97, 45.8]);
        const node = nodeMap(result).get(waysOf(result)[0].nodes[0]);
        const [, y] = frame.latLngToMetric(node.lat, node.lon);
        expect(y).toBeCloseTo(0.5, 2);
    });

    it('throws on malformed XML and on a document that is not OpenDRIVE', () => {
        expect(() => parseOpenDrive('<OpenDRIVE><header>', { anchor: { lat: 45.8, lng: 15.97 } })).toThrow(/malformed XML/);
        expect(() => parseOpenDrive('<OpenDRIVE><road></OpenDRIVE>', { anchor: { lat: 45.8, lng: 15.97 } })).toThrow(/malformed XML/);
        expect(() => parseOpenDrive('<osm version="0.6"/>', { anchor: { lat: 45.8, lng: 15.97 } })).toThrow(/not <OpenDRIVE>/);
    });
});
