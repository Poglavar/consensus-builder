// An over-cap /parcels/under used to cost the FULL query before refusing.
//
// The route built every parcel's GeoJSON, its ownership join and the coverage aggregate, and only
// then compared the row count with the cap — measured at 17.2 s to answer 413 for a 59,311-parcel
// box. A client that splits and retries on that refusal (the replay's batched ground load does)
// therefore paid 17 s per attempt down the whole halving cascade: a 6 s reload became 49 s.
//
// The count is the same index scan without any of that, so the refusal now costs ~0.3 s.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const route = readFileSync(fileURLToPath(new URL('../routes/parcels.js', import.meta.url)), 'utf8');

describe('POST /parcels/under refuses cheaply', () => {
    const handler = route.slice(
        route.indexOf("app.post('/parcels/under'"),
        route.indexOf("console.error('Error in POST /parcels/under:'")
    );

    it('counts before it builds', () => {
        expect(handler).toContain('const countSql = `');
        expect(handler.indexOf('const counted =')).toBeLessThan(handler.indexOf('await pool.query(sql,'));
        expect(handler.indexOf('res.status(413)')).toBeLessThan(handler.indexOf('await pool.query(sql,'));
    });

    it('counts the same parcels the full query would return', () => {
        // Same subdivision, same index predicate, same current filter — a count that disagreed with
        // the query would refuse requests it could serve, or serve ones it should refuse.
        const countSql = handler.slice(handler.indexOf('const countSql = `'), handler.indexOf('const counted ='));
        expect(countSql).toContain('ST_Subdivide(g, ${FOOTPRINT_SUBDIVIDE_VERTICES})');
        expect(countSql).toContain('p.current = true');
        expect(countSql).toContain('p.geom && parts.part');
        expect(countSql).toContain('ST_Intersects(p.geom, parts.part)');
        expect(countSql).toContain('SELECT DISTINCT p.cestica_id');
    });

    it('still reports how many it found, so the caller can decide how to split', () => {
        expect(handler).toContain('over the ${MAX_PARCELS_UNDER} limit.`');
        expect(handler).toContain('count: counted');
    });
});
