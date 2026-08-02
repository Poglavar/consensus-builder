// Which evidence set a lane's width is the difference between "actual" and "idealised" — and it is
// the RECORD that makes the difference, not the algorithm. These lock the two ways the record could
// lie: claiming authorship for evidence that decided nothing, and counting a constrained width as a
// measured one.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const Provenance = require('../../frontend/js/lane-width-provenance.js');
const LaneParcelFit = require('../../frontend/js/lane-parcel-fit.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const { WIDTH_SOURCES, resolveWidthSource, moreTrusted, summarise, rankOf } = Provenance;

describe('the evidence order', () => {
    it('ranks measured over parcel over tag over default', () => {
        expect(WIDTH_SOURCES).toEqual(['measured', 'road_parcel', 'osm_tag', 'default']);
        expect(rankOf('measured')).toBeLessThan(rankOf('road_parcel'));
        expect(rankOf('road_parcel')).toBeLessThan(rankOf('osm_tag'));
        expect(rankOf('osm_tag')).toBeLessThan(rankOf('default'));
    });

    it('treats an unknown source as least trusted rather than most', () => {
        expect(moreTrusted('nonsense', 'default')).toBe('default');
        expect(moreTrusted('measured', 'nonsense')).toBe('measured');
    });

    it('lets the strongest available evidence win', () => {
        expect(resolveWidthSource({ measured: true, parcelNarrowed: true, taggedWidthM: 9 }))
            .toBe('measured');
        expect(resolveWidthSource({ parcelNarrowed: true, taggedWidthM: 9 })).toBe('road_parcel');
        expect(resolveWidthSource({ taggedWidthM: 9 })).toBe('osm_tag');
        expect(resolveWidthSource({})).toBe('default');
    });

    it('does not credit a parcel that changed nothing', () => {
        // The parcel is a bound. One wider than the cross-section decided nothing, and claiming it
        // did would overstate how much of the map rests on evidence.
        expect(resolveWidthSource({ parcelNarrowed: false, taggedWidthM: 9 })).toBe('osm_tag');
        expect(resolveWidthSource({ parcelNarrowed: false })).toBe('default');
    });

    it('does not credit a width tag that is absent or unusable', () => {
        expect(resolveWidthSource({ taggedWidthM: 0 })).toBe('default');
        expect(resolveWidthSource({ taggedWidthM: null })).toBe('default');
        expect(resolveWidthSource({ taggedWidthM: NaN })).toBe('default');
        expect(resolveWidthSource({ taggedWidthM: -3 })).toBe('default');
    });
});

describe('summarise', () => {
    const lanes = [
        { widthSource: 'measured' }, { widthSource: 'road_parcel' },
        { widthSource: 'default' }, { widthSource: 'default' }
    ];

    it('counts every source and the share resting on a guess', () => {
        const summary = summarise(lanes);
        expect(summary.counts).toEqual({ measured: 1, road_parcel: 1, osm_tag: 0, default: 2 });
        expect(summary.total).toBe(4);
        expect(summary.defaultShare).toBe(0.5);
    });

    it('counts only the top of the hierarchy as measured', () => {
        // A road narrowed by its parcel is CONSTRAINED, not measured. Folding the two together
        // would make an unsurveyed map look surveyed.
        expect(summarise(lanes).measuredShare).toBe(0.25);
    });

    it('reports zeroes rather than dividing by nothing', () => {
        expect(summarise([])).toEqual({
            counts: { measured: 0, road_parcel: 0, osm_tag: 0, default: 0 },
            total: 0, measuredShare: 0, defaultShare: 0
        });
        expect(summarise(null).total).toBe(0);
        expect(summarise([{}, { widthSource: null }]).total).toBe(0);
    });
});

describe('recorded by the graph builder', () => {
    const line = [[15.9600, 45.8000], [15.9608, 45.8000]];
    function evidence(tags) {
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: line },
                properties: { osm_id: 101, highway_type: 'residential', osm_node_ids: [1, 2], tags }
            }]
        };
    }
    const MX = 111320 * Math.cos(45.8 * Math.PI / 180);
    const project = ([lng, lat]) => [(lng - 15.9604) * MX, (lat - 45.8) * 110540];
    const narrowParcel = [{
        score: 70,
        rings: [[[15.9598, 45.79998], [15.9610, 45.79998], [15.9610, 45.80002], [15.9598, 45.80002]]]
    }];

    function build(tags, parcelFit) {
        return LaneTopologyGraph.build(evidence(tags), {
            profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
            orientProfile: OsmProfile.orientForRightHandTraffic,
            ...(parcelFit ? { parcelFit } : {})
        });
    }

    it('marks a standard width as the guess it is', () => {
        const graph = build({ highway: 'residential', lanes: '2' });
        expect(graph.sections[0].widthSource).toBe('default');
        expect(graph.lanes.every(lane => lane.widthSource === 'default')).toBe(true);
    });

    it('credits a surveyor who stated width=', () => {
        const graph = build({ highway: 'residential', lanes: '2', width: '7.5' });
        expect(graph.sections[0].widthSource).toBe('osm_tag');
    });

    it('reads a comma decimal, as OSM sometimes carries it', () => {
        expect(build({ highway: 'residential', lanes: '2', width: '7,5' }).sections[0].widthSource)
            .toBe('osm_tag');
    });

    it('credits the parcel when the land is what set the width', () => {
        const graph = build({ highway: 'residential', lanes: '2', width: '7.5' },
            { parcels: narrowParcel, turf, fit: LaneParcelFit, project });
        // The tag said 7.5 m; the parcel gives less, so the land decided and outranks the tag.
        expect(graph.sections[0].widthSource).toBe('road_parcel');
        expect(graph.lanes.every(lane => lane.widthSource === 'road_parcel')).toBe(true);
    });

    it('leaves the tag in charge where the parcel is roomy', () => {
        const roomy = [{
            score: 70,
            rings: [[[15.9598, 45.7996], [15.9610, 45.7996], [15.9610, 45.8004], [15.9598, 45.8004]]]
        }];
        const graph = build({ highway: 'residential', lanes: '2', width: '7.5' },
            { parcels: roomy, turf, fit: LaneParcelFit, project });
        expect(graph.sections[0].widthSource).toBe('osm_tag');
    });
});
