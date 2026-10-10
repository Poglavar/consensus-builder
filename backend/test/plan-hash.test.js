// A named plan commits to what its members build (plans.md). The hash must move when the built
// content moves, and must NOT move for prose, thumbnails or lifecycle state.

import { describe, it, expect } from 'vitest';
import { memberHash, planHash, nextVersionSlug, stableStringify, changedMembers } from '../plans/plan-hash.js';

const building = {
    id: 7, type: 'building', goal: 'buildings', title: 'Blok M1-9', description: 'Prvi opis',
    site: { type: 'MultiPolygon', coordinates: [[[[16, 45], [16.001, 45], [16.001, 45.001], [16, 45]]]] },
    cadastre_parcel_ids: ['HR-335550-1791/69'],
    building_proposal: { parameters: { floors: 5, height: 17.5 } },
    geometry: { buildings: [{ type: 'Feature', properties: { height: 17.5 }, geometry: { type: 'Polygon', coordinates: [] } }] },
    screenshot_url: 'https://example.invalid/a.png', lifecycle_status: 'Active'
};

describe('memberHash', () => {
    it('ignores prose, thumbnails and lifecycle state', () => {
        const restated = { ...building, title: 'Novi naslov', description: 'Drugi opis', screenshot_url: null, lifecycle_status: 'Expired' };
        expect(memberHash(restated)).toBe(memberHash(building));
    });

    it('moves when what is built moves', () => {
        expect(memberHash({ ...building, building_proposal: { parameters: { floors: 6, height: 21 } } })).not.toBe(memberHash(building));
        expect(memberHash({ ...building, cadastre_parcel_ids: ['HR-335550-1791/70'] })).not.toBe(memberHash(building));
        const road = { id: 8, type: 'road', road_proposal: { definition: { segments: [[{ lat: 1, lng: 2 }, { lat: 1, lng: 3 }]], width: 19 } } };
        const moved = { ...road, road_proposal: { definition: { segments: [[{ lat: 1, lng: 2 }, { lat: 1.0001, lng: 3 }]], width: 19 } } };
        expect(memberHash(moved)).not.toBe(memberHash(road));
    });

    it('does not depend on key order or parcel order', () => {
        const shuffled = { ...building, cadastre_parcel_ids: ['HR-335550-1791/69'], building_proposal: { parameters: { height: 17.5, floors: 5 } } };
        expect(memberHash(shuffled)).toBe(memberHash(building));
        expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    });
});

describe('planHash', () => {
    it('depends on member order', () => {
        const a = { proposalId: '1', hash: 'aa' };
        const b = { proposalId: '2', hash: 'bb' };
        expect(planHash([a, b])).not.toBe(planHash([b, a]));
    });
});

describe('changedMembers', () => {
    it('reports repaired and vanished members', () => {
        const hashes = { 7: memberHash(building), 9: 'gone' };
        expect(changedMembers(hashes, [building])).toEqual(['9']);
        expect(changedMembers(hashes, [{ ...building, building_proposal: { parameters: { floors: 9 } } }])).toEqual(['7', '9']);
    });
});

describe('nextVersionSlug', () => {
    it('counts up from the base name, skipping taken versions', () => {
        expect(nextVersionSlug('borovje', new Set(['borovje']))).toBe('borovje-v2');
        expect(nextVersionSlug('borovje-v2', new Set(['borovje', 'borovje-v2', 'borovje-v3']))).toBe('borovje-v4');
    });
});
