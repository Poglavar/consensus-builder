// city → region → country → planet.
//
// The shared spatial tables label every row with the ingest it came from, and a provider used to
// name exactly one label. A city whose data had been pulled under a BROADER name than its config
// expected then read an empty table and reported, perfectly calmly, that the ground had no buildings
// on it — which is how Šibenik lost its entire building stock while 2.9M Croatian footprints sat in
// the table under 'croatia'.
//
// The label never made the answer correct; the geometry filter did. So widening is not a compromise,
// and dropping the label entirely is the last honest question rather than a bug.

import { describe, it, expect, vi } from 'vitest';
import { scopeLadder, queryDownScopeLadder, createScopeMemo } from '../data-scope.js';
import { OVERTURE_CITIES } from '../buildings/overture-cities.js';

describe('the ladder', () => {
    it('runs narrowest first and always ends on the planet', () => {
        expect(scopeLadder({ city: 'sibenik', region: 'sjeverna-dalmacija', country: 'croatia' }))
            .toEqual(['sibenik', 'sjeverna-dalmacija', 'croatia', null]);
    });

    it('collapses a duplicate rung — Split\'s region ingest IS called split', () => {
        expect(scopeLadder({ city: 'split', region: 'split', country: 'croatia' }))
            .toEqual(['split', 'croatia', null]);
    });

    it('skips rungs that were never named', () => {
        expect(scopeLadder({ region: 'belgrade' })).toEqual(['belgrade', null]);
        expect(scopeLadder({})).toEqual([null]);
        expect(scopeLadder(null)).toEqual([null]);
        expect(scopeLadder({ city: '   ', region: null })).toEqual([null]);
    });

    it('gives Šibenik the ladder the city actually needs', () => {
        // sibenik → sjeverna dalmacija → croatia, then the bare geometry.
        expect(scopeLadder({
            city: OVERTURE_CITIES.sibenik.city,
            region: OVERTURE_CITIES.sibenik.region,
            country: OVERTURE_CITIES.sibenik.country
        })).toEqual(['sibenik', 'sjeverna-dalmacija', 'croatia', null]);
    });
});

describe('running down it', () => {
    // A table holding rows under exactly one label — the shape of every real ingest.
    const tableWith = (label, rows = [{ id: 1 }]) => vi.fn(async scope => (scope === label ? rows : []));

    it('takes the narrowest rung that answers', async () => {
        const run = tableWith('sibenik');
        const out = await queryDownScopeLadder(['sibenik', 'sjeverna-dalmacija', 'croatia', null], run);
        expect(out.scope).toBe('sibenik');
        expect(out.tried).toEqual(['sibenik']);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('widens until it finds the ingest that actually holds the ground', async () => {
        // Šibenik as it really is on this machine: nothing city- or region-specific, 2.9M rows
        // under 'croatia'.
        const run = tableWith('croatia');
        const out = await queryDownScopeLadder(['sibenik', 'sjeverna-dalmacija', 'croatia', null], run);
        expect(out.scope).toBe('croatia');
        expect(out.tried).toEqual(['sibenik', 'sjeverna-dalmacija', 'croatia']);
    });

    it('falls through to the planet — a labelless read is still a read', async () => {
        const run = vi.fn(async scope => (scope === null ? [{ id: 9 }] : []));
        const out = await queryDownScopeLadder(['sibenik', 'croatia', null], run);
        expect(out.scope).toBeNull();
        expect(out.rows).toHaveLength(1);
    });

    it('reports an empty area as empty, not as a failure', async () => {
        const run = vi.fn(async () => []);
        const out = await queryDownScopeLadder(['sibenik', 'croatia', null], run);
        expect(out.rows).toEqual([]);
        expect(out.scope).toBeNull();
        expect(run).toHaveBeenCalledTimes(3);
    });

    it('never asks with no ladder at all', async () => {
        const run = vi.fn(async () => [{ id: 1 }]);
        await queryDownScopeLadder([], run);
        expect(run).toHaveBeenCalledWith(null);
    });
});

describe('remembering which rung answered', () => {
    it('starts where it succeeded last time', async () => {
        const memo = createScopeMemo();
        const ladder = ['sibenik', 'sjeverna-dalmacija', 'croatia', null];
        const run = vi.fn(async scope => (scope === 'croatia' ? [{ id: 1 }] : []));

        const first = await queryDownScopeLadder(ladder, run, memo, 'buildings:sibenik');
        expect(first.tried).toEqual(['sibenik', 'sjeverna-dalmacija', 'croatia']);

        run.mockClear();
        const second = await queryDownScopeLadder(ladder, run, memo, 'buildings:sibenik');
        expect(second.tried).toEqual(['croatia']);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('still widens when the remembered rung is empty HERE', async () => {
        // The city ingest covers the old town; this query is out at Vodice, which only the
        // countrywide pull reaches. A memo that short-circuited would answer "no buildings".
        const memo = createScopeMemo();
        memo.set('buildings:sibenik', 'sibenik');
        const run = vi.fn(async scope => (scope === 'croatia' ? [{ id: 1 }] : []));
        const out = await queryDownScopeLadder(['sibenik', 'sjeverna-dalmacija', 'croatia', null], run, memo, 'buildings:sibenik');
        expect(out.scope).toBe('croatia');
        expect(out.rows).toHaveLength(1);
    });

    it('keeps one winner per dataset, not one for the whole server', async () => {
        const memo = createScopeMemo();
        await queryDownScopeLadder(['a', null], async s => (s === 'a' ? [{}] : []), memo, 'buildings:x');
        await queryDownScopeLadder(['b', null], async s => (s === 'b' ? [{}] : []), memo, 'trees:x');
        expect(memo.get('buildings:x')).toBe('a');
        expect(memo.get('trees:x')).toBe('b');
        expect(memo.size()).toBe(2);
    });
});
