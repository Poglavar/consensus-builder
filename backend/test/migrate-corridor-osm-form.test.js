// Tests for backend/scripts/migrate-corridor-osm-form.mjs migrateRow: a stored row's definition
// becomes the record (the OSM document, no stretch fields) that reads back as the same road; a row
// already in record shape is skipped; a designation is reported, not changed; and the plan member
// hash is the same before and after.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { migrateRow } from '../scripts/migrate-corridor-osm-form.mjs';
import { memberHash } from '../plans/plan-hash.js';

const require = createRequire(import.meta.url);
const osmForm = require('../../frontend/js/corridor-osm-form.js');
const P = require('../../frontend/js/corridor-profile.js');

const A = { lat: 45.8001, lng: 15.9701 };
const B = { lat: 45.8004, lng: 15.9712, level: -1 };
const C = { lat: 45.8011, lng: 15.9716 };
const profile = { strips: P.CORRIDOR_PROFILE_PRESETS[10].map(lane => ({ ...lane })) };
const row = definition => ({ id: 7, type: 'road', goal: 'road-track', city: 'zagreb', cadastre_parcel_ids: ['HR-1-1'], road_proposal: { definition, mode: 'draw' }, proposal_data: { roadProposal: { definition } } });

describe('migrateRow', () => {
    it('turns a view row into a record that reads back as the same road, with the same member hash', () => {
        const before = row({ points: [[A, B], [B, C]], segments: [[A, B], [B, C]], segmentIds: ['s1', 's2'], profile, segmentProfiles: {}, width: 10, polygon: { type: 'Polygon', coordinates: [] }, tunnels: [] });
        const result = migrateRow(before);
        expect(result.status).toBe('canonicalised'); // `segmentProfiles: {}` is spelled as no overrides
        osmForm.VIEW_FIELDS.forEach(field => expect(result.record[field], field).toBeUndefined());
        expect(result.record.osm.elements.filter(element => element.type === 'way')).toHaveLength(2);
        expect(result.record).toMatchObject({ polygon: { type: 'Polygon' }, tunnels: [] });
        expect(osmForm.toView(result.record).points).toEqual([[A, B], [B, C]]);
        expect(result.hashChanged).toBe(false);
        expect(memberHash({ ...before, road_proposal: { definition: result.record } })).toBe(memberHash(before));
    });

    it('reports a row that already is a record as done, and a designation as unencodable', () => {
        const recorded = row(osmForm.toRecord({ points: [[A, B]], segments: [[A, B]], profile }));
        expect(migrateRow(recorded)).toEqual({ status: 'done' });
        expect(migrateRow(row({ polygon: { type: 'Polygon', coordinates: [] }, width: 12 }))).toMatchObject({ status: 'unencodable' });
        expect(migrateRow({ id: 1, road_proposal: null })).toEqual({ status: 'not-a-road' });
    });

    it('calls a row exact when its stored spelling already is the canonical one', () => {
        const canonical = osmForm.toView(osmForm.toRecord({ points: [[A, B]], segments: [[A, B]], segmentIds: ['s1'], profile, width: 10 }));
        expect(migrateRow(row(canonical)).status).toBe('exact');
    });
});
