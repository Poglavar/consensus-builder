// Tests for frontend/js/corridor-import.js recordsFromImport: an import's OSM form becomes one
// applied-road record per road, shaped like a drawn road's record, with its stretches and
// cross-sections read from the ways (roads.md §11).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const imports = require('../../frontend/js/corridor-import.js');
const form = require('../../frontend/js/corridor-osm-form.js');
const P = require('../../frontend/js/corridor-profile.js');

const node = (id, lat, lon) => ({ type: 'node', id, lat, lon });
const way = (id, nodes, profile, extra = {}) => ({ type: 'way', id, nodes, tags: { ...form.laneTagsOf(profile), ...extra } });
const wide = { strips: P.CORRIDOR_PROFILE_PRESETS[26] };
const narrow = { strips: P.CORRIDOR_PROFILE_PRESETS[10] };
const track = P.corridorDefaultTrackProfile(1435);

function parsed() {
    return {
        placement: 'georeference',
        warnings: [],
        roads: [
            { id: '1', name: 'Main Street', wayIds: [-1, -2] },
            { id: '3', name: null, wayIds: [-3] },
            { id: '7', name: 'Tram', wayIds: [-4] }
        ],
        form: {
            version: 0.6,
            generator: 'test',
            elements: [
                node(-1, 45.800, 15.970), node(-2, 45.800, 15.971), node(-3, 45.800, 15.972), node(-4, 45.801, 15.971), node(-5, 45.802, 15.975), node(-6, 45.803, 15.975),
                way(-1, [-1, -2], wide, { highway: 'primary', name: 'Main Street', 'cb:road': '1' }),
                way(-2, [-2, -3], narrow, { highway: 'primary', name: 'Main Street', 'cb:road': '1' }),
                way(-3, [-2, -4], narrow, { highway: 'residential', 'cb:road': '3' }),
                way(-4, [-5, -6], track, { 'cb:road': '7' })
            ]
        }
    };
}

describe('recordsFromImport', () => {
    it('makes one record per road, with its stretches, cross-sections and class', () => {
        const records = imports.recordsFromImport(parsed(), { author: 'tester', createdAt: '2026-10-15T12:00:00.000Z', source: 'opendrive' });
        expect(records).toHaveLength(3);
        const [main, branch, tram] = records;
        expect(main).toMatchObject({ author: 'tester', title: 'Main Street', primaryType: 'Road', goal: 'road-track', isCorridor: true, cadastreParcelIds: [], applied: false, createdAt: '2026-10-15T12:00:00.000Z' });
        const definition = main.roadProposal.definition;
        expect(definition.points).toHaveLength(2); // two stretches
        expect(definition.points[0]).toEqual([{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.971 }]);
        expect(definition.width).toBe(26);
        expect(definition.metadata).toMatchObject({ mode: 'import', type: 'road', source: 'opendrive', sourceRoadId: '1', isTrack: false, isRoad: true, isCorridor: true, highway: 'primary' });
        const entries = P.corridorSegmentEntries(definition);
        expect(P.corridorProfileWidth(entries[0].profile)).toBe(26);
        expect(P.corridorProfileWidth(entries[1].profile)).toBe(10);
        expect(definition.tunnels).toEqual([]);

        expect(branch.title).toBe('Imported road 2'); // a road without a name is numbered
        expect(branch.roadProposal.definition.points[0][0]).toEqual({ lat: 45.8, lng: 15.971 }); // shares the node
        expect(tram).toMatchObject({ primaryType: 'Track', title: 'Tram' });
        expect(tram.roadProposal.definition.metadata).toMatchObject({ isTrack: true, isRoad: false });
        expect(tram.roadProposal.definition.metadata.highway).toBeUndefined();
    });

    it('records the city it was made in, so sharing can choose the parcel source', () => {
        const previous = globalThis.CityConfigManager;
        globalThis.CityConfigManager = { getCurrentCityId: () => 'zagreb' };
        try {
            expect(imports.recordsFromImport(parsed()).map(record => record.city)).toEqual(['zagreb', 'zagreb', 'zagreb']);
            expect(imports.recordsFromImport(parsed(), { city: 'split' })[0].city).toBe('split');
        } finally {
            globalThis.CityConfigManager = previous;
        }
        expect(imports.recordsFromImport(parsed())[0].city).toBeNull();
    });

    it('takes every way as one road, named after the first way, when the adapter names none', () => {
        const input = parsed();
        delete input.roads;
        const records = imports.recordsFromImport(input, { fallbackTitle: 'Road' });
        expect(records).toHaveLength(1);
        expect(records[0].title).toBe('Main Street');
        expect(records[0].roadProposal.definition.points).toHaveLength(4);
        delete input.form.elements[6].tags.name;
        expect(imports.recordsFromImport(input, { fallbackTitle: 'Road' })[0].title).toBe('Road 1');
    });

    it('skips a road whose ways are missing, and reads a way with only a class as OSM would (default lanes)', () => {
        const input = parsed();
        input.roads.push({ id: '9', name: 'Ghost', wayIds: [-99] });
        input.form.elements.push({ type: 'way', id: -98, nodes: [-1, -2], tags: { highway: 'road' } });
        input.roads.push({ id: '8', name: 'Only a class', wayIds: [-98] });
        const records = imports.recordsFromImport(input);
        expect(records.map(record => record.title)).toEqual(['Main Street', 'Imported road 2', 'Tram', 'Only a class']);
        const bare = records[3].roadProposal.definition;
        expect(bare.profile.strips.filter(lane => lane.type === 'driving')).toHaveLength(2);
        expect(bare.width).toBeGreaterThan(0);
    });

    it('knows OpenDRIVE by its extension and nothing else', () => {
        expect(imports.extensionOf('plan.XODR')).toBe('xodr');
        // the chooser names six formats; three have an adapter, the rest are greyed and asked for
        expect(imports.FORMATS.map(format => format.id)).toEqual(['osm', 'opendrive', 'landxml', 'streetmix', 'geojson', 'shapefile']);
        expect(imports.FORMATS.filter(format => format.parse).map(format => format.id)).toEqual(['osm', 'opendrive', 'geojson']);
        expect(imports.formatFor('plan.XODR').id).toBe('opendrive');
        expect(imports.formatFor('streets.osm').id).toBe('osm');
        expect(imports.formatFor('overpass.json').id).toBe('osm');
        expect(imports.formatFor('any.json', 'opendrive').id).toBe('opendrive');
        expect(imports.formatFor('roads.xml')).toBeNull();
        expect(imports.formatFor('roads.xml', 'landxml')).toBeNull();
    });
});

describe('createRoadRecords', () => {
    const record = () => ({ roadProposal: { definition: { polygon: { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.98, 45.8], [15.98, 45.81], [15.97, 45.8]]] } } } });
    const install = overrides => {
        const calls = [];
        const fakes = {
            L: { geoJSON: polygon => ({ getBounds: () => ({ polygon }) }) },
            CadastralParcelRepository: { ensureBounds: async bounds => { calls.push(['ensureBounds', !!bounds.polygon]); } },
            rebuildRoadDefinitionFootprint: () => calls.push(['footprint']),
            declareParcelsUnderRoadLand: (item, polygon) => { calls.push(['declare', !!polygon]); item.cadastreParcelIds = ['HR-1']; },
            ProposalManager: { createCorridorProposalAtomically: async item => { calls.push(['create', item.cadastreParcelIds]); return { ok: true, proposalId: 'p-1' }; } },
            ...overrides(calls)
        };
        const saved = Object.fromEntries(Object.keys(fakes).map(name => [name, globalThis[name]]));
        Object.assign(globalThis, fakes);
        return { calls, restore: () => Object.assign(globalThis, saved) };
    };

    it('loads the ground under the land before declaring the parcels it reaches', async () => {
        const { calls, restore } = install(() => ({}));
        try {
            await expect(imports.createRoadRecords([record()])).resolves.toEqual({ created: ['p-1'], failed: [] });
            expect(calls).toEqual([['footprint'], ['ensureBounds', true], ['declare', true], ['create', ['HR-1']]]);
        } finally { restore(); }
    });

    it('fails a record whose ground cannot be loaded rather than declaring too little', async () => {
        const { calls, restore } = install(() => ({
            CadastralParcelRepository: { ensureBounds: async () => { throw new Error('Register unavailable'); } }
        }));
        try {
            await expect(imports.createRoadRecords([record()])).resolves.toEqual({ created: [], failed: ['Register unavailable'] });
            expect(calls.map(call => call[0])).toEqual(['footprint']);
        } finally { restore(); }
    });
});
