// A block breakup becomes road proposals: only each cut's connector is new street, streets that
// meet (end to end or as a T) form one road sharing the junction node, and the corridor import
// turns each road into a road-track record with the chosen cross-section.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const propose = require('../../frontend/js/urban-blocks-propose.js');
const { recordsFromImport } = require('../../frontend/js/corridor-import.js');
const { CORRIDOR_PROFILE_PRESETS, corridorProfileToOsmTags } = require('../../frontend/js/corridor-profile.js');

// Metres east/north of a point near Bogotá, as [lng, lat].
const ORIGIN = [-74.08, 4.61], KY = 111320, KX = KY * Math.cos(ORIGIN[1] * Math.PI / 180);
const at = (x, y) => [ORIGIN[0] + x / KX, ORIGIN[1] + y / KY];
const cut = (path, connectorIndex = 0) => ({ type: 'Feature', properties: { splitPath: path.map(([x, y]) => at(x, y)), connectorIndex } });

const westStreet = cut([[0, 0], [0, 100]]);
const teeIntoWest = cut([[0, 50], [80, 50]]);
const eastStreet = cut([[200, 0], [200, 100]]);
// An alley from the outline at (300, 0) to its tip at (300, 40); only the 40 m beyond the tip is new.
const alleyExtension = cut([[300, 0], [300, 40], [300, 80]], 1);

describe('block breakup to road proposals', () => {
    it('groups streets that meet into one road and splits the host street at the T', () => {
        const networks = propose.streetNetworks([westStreet, teeIntoWest, eastStreet]);
        expect(networks).toHaveLength(2);
        const west = networks.find(ways => ways.length > 1);
        expect(west).toHaveLength(2);
        expect(west[0]).toHaveLength(3);
        expect(west[0][1]).toEqual(at(0, 50));
    });

    it('takes only the connector of a cut that extends an alley', () => {
        const [[way]] = propose.streetNetworks([alleyExtension]);
        expect(way).toEqual([at(300, 40), at(300, 80)]);
    });

    it('shares the junction node between the host street and the T', () => {
        const { form, roads } = propose.importForm([westStreet, teeIntoWest], { tags: { highway: 'residential' } });
        const ways = form.elements.filter(element => element.type === 'way');
        expect(roads).toHaveLength(1);
        expect(roads[0].wayIds).toEqual(ways.map(way => way.id));
        const junction = form.elements.find(element => element.type === 'node' && element.lon === at(0, 50)[0] && element.lat === at(0, 50)[1]);
        expect(ways[0].nodes).toContain(junction.id);
        expect(ways[1].nodes[0]).toBe(junction.id);
    });

    it('makes one road-track record per road with the local-street cross-section', () => {
        const profile = { strips: CORRIDOR_PROFILE_PRESETS[10].map(strip => ({ ...strip })) };
        const parsed = propose.importForm([westStreet, teeIntoWest, eastStreet],
            { tags: { highway: 'residential', ...corridorProfileToOsmTags(profile) } });
        const records = recordsFromImport(parsed, { source: 'block-breakup', fallbackTitle: 'New street' });
        expect(records).toHaveLength(2);
        for (const record of records) {
            expect(record.goal).toBe('road-track');
            expect(record.roadProposal.definition.width).toBeCloseTo(10, 3);
            expect(record.roadProposal.definition.metadata.source).toBe('block-breakup');
        }
        expect(records.map(record => record.roadProposal.definition.segments.length).sort()).toEqual([1, 2]);
    });

    it('refuses a cut without street geometry', () => {
        expect(() => propose.streetNetworks([{ properties: {} }])).toThrow('no street geometry');
    });
});
