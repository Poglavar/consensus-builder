// The staged OSM reference layer: Overture rows out of shared geodata, shaped so the frontend
// cannot tell them from the live Overpass path. Only the pure row→Feature mapping is covered here;
// the query itself is exercised against the real table.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stagedRowToFeature } = require('../buildings/osm-staged.js');

const row = (extra = {}) => ({
    osm_id: 'w195184497',
    names: null,
    height: null,
    num_floors: null,
    geometry: { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.8]]] },
    ...extra
});

describe('stagedRowToFeature', () => {
    it('keeps the OSM element id as the feature id, so the two paths dedupe against each other', () => {
        const feature = stagedRowToFeature(row());
        expect(feature.id).toBe('w195184497');
        expect(feature.properties.osm_id).toBe('w195184497');
        expect(feature.geometry.type).toBe('Polygon');
    });

    it('prefers a measured height, falls back to storeys at ~3 m, else admits it has none', () => {
        expect(stagedRowToFeature(row({ height: 14.2 })).properties.height_m).toBe(14.2);
        expect(stagedRowToFeature(row({ num_floors: 4 })).properties.height_m).toBe(12);
        expect(stagedRowToFeature(row({ height: 14.2, num_floors: 4 })).properties.height_m).toBe(14.2);
        expect(stagedRowToFeature(row()).properties.height_m).toBeNull();
    });

    it('ignores a nonsense height rather than passing it through', () => {
        expect(stagedRowToFeature(row({ height: 0 })).properties.height_m).toBeNull();
        expect(stagedRowToFeature(row({ height: -3, num_floors: 2 })).properties.height_m).toBe(6);
    });

    it('reads the primary name out of the Overture names blob', () => {
        expect(stagedRowToFeature(row({ names: { primary: 'Zagrepčanka' } })).properties.name).toBe('Zagrepčanka');
        expect(stagedRowToFeature(row({ names: {} })).properties.name).toBeNull();
        expect(stagedRowToFeature(row()).properties.name).toBeNull();
    });
});
