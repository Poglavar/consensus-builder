// unapply-tour.js — the pure item model behind the unapply/delete dependents panel: classify raw
// descendant ids into dependent proposals (with claim kind) and parcel slices, ordered fabric
// first, deduped, with display labels.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let tour;

const PROPOSALS = {
    'p-road': { proposalId: 'p-road', title: 'Road 2043', goal: 'road-track' },
    'p-park': { proposalId: 'p-park', title: 'Park 2047', goal: 'park' },
    'p-untitled': { proposalId: 'p-untitled', goal: 'single' }
};

const PARCELS = {
    'HR-1-823/1#p-road-1': { broj: '823/1', isRoad: false, roadName: null },
    'HR-1-823/1#p-road-2': { broj: '823/1', isRoad: true, roadName: 'Nova cesta' }
};

const accessors = {
    getProposal: (id) => PROPOSALS[id] || null,
    getParcelInfo: (id) => PARCELS[id] || null
};

beforeAll(() => {
    tour = require('../../frontend/js/proposals/unapply-tour.js');
});

describe('buildUnapplyItems', () => {
    it('classifies proposals vs parcel slices and orders fabric first', () => {
        const items = tour.buildUnapplyItems(
            ['HR-1-823/1#p-road-1', 'p-park', 'p-road', 'HR-1-823/1#p-road-2'],
            accessors
        );
        expect(items.map(i => `${i.kind}:${i.id}`)).toEqual([
            'proposal:p-road',            // fabric before content
            'proposal:p-park',
            'parcel:HR-1-823/1#p-road-1', // parcels (ground) last
            'parcel:HR-1-823/1#p-road-2'
        ]);
        expect(items[0].claimKind).toBe('fabric');
        expect(items[1].claimKind).toBe('content');
        expect(items[2].claimKind).toBe('ground');
    });

    it('labels items for humans: titles, parcel numbers, road markers', () => {
        const items = tour.buildUnapplyItems(
            ['p-road', 'p-untitled', 'HR-1-823/1#p-road-2', 'HR-9-unknown'],
            accessors
        );
        const byId = Object.fromEntries(items.map(i => [i.id, i]));
        expect(byId['p-road'].label).toBe('Road 2043');
        expect(byId['p-road'].extra).toBe('road-track');
        expect(byId['p-untitled'].label).toBe('p-untitled'); // id fallback when untitled
        expect(byId['HR-1-823/1#p-road-2'].label).toBe('823/1');
        expect(byId['HR-1-823/1#p-road-2'].extra).toBe('Nova cesta');
        expect(byId['HR-9-unknown'].label).toBe('HR-9-unknown'); // no info anywhere → raw id
    });

    it('dedupes and drops empty ids', () => {
        const items = tour.buildUnapplyItems(['p-road', 'p-road', '', null, undefined], accessors);
        expect(items).toHaveLength(1);
    });

    it('an empty descendant list yields an empty model', () => {
        expect(tour.buildUnapplyItems([], accessors)).toEqual([]);
        expect(tour.buildUnapplyItems(null, accessors)).toEqual([]);
    });
});
