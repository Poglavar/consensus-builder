// Trees everywhere: the osm_decor cache where it holds the area, OpenStreetMap live through our
// Overpass chain where it does not or cannot be read, both planted by one query.
import { describe, expect, it, vi } from 'vitest';
import { createOvertureTreesProvider } from '../decor/overture-trees.js';
import { buildTreesQuery, overpassTreesToFeatures, greeneryType, TREE_BEARING_GREENERY } from '../decor/osm-trees-overpass.js';

const AUSTIN = { type: 'Point', coordinates: [-97.745, 30.266] };
const ring = (x, y, d = 0.001) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]].map(([lon, lat]) => ({ lon, lat }));

// A pool that answers by statement: the cache's planting query, its coverage check, the live one.
function pool({ cacheRows = [], covered = false, cacheFails = false, liveRows = [{ lng: -97.745, lat: 30.266 }] } = {}) {
    const calls = [];
    return { calls, async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes('given_trees')) return { rows: liveRows };
        if (sql.includes('AS covered')) return { rows: [{ covered }] };
        if (cacheFails) throw new Error('relation "osm_decor" does not exist');
        return { rows: cacheRows };
    } };
}

describe('tree provider: cache first, OSM live otherwise', () => {
    const live = () => vi.fn(async () => ({ features: [
        { type: 'Feature', id: 'n1', geometry: { type: 'Point', coordinates: [-97.7451, 30.2661] }, properties: { kind: 'trees' } },
        { type: 'Feature', id: 'w2', geometry: { type: 'Polygon', coordinates: [[[-97.746, 30.265], [-97.744, 30.265], [-97.744, 30.267], [-97.746, 30.265]]] }, properties: { kind: 'greenery', t: 'park' } }
    ] }));

    it('answers from the cache where it has trees, without asking OSM', async () => {
        const fetchTrees = live();
        const db = pool({ cacheRows: [{ lng: 15.97, lat: 45.81 }] });
        const result = await createOvertureTreesProvider(db, { fetchTrees }).near({ type: 'Point', coordinates: [15.97, 45.81] }, 300);
        expect(result).toMatchObject({ source: 'overture-trees', count: 1 });
        expect(fetchTrees).not.toHaveBeenCalled();
    });

    it('keeps an empty answer where the cache covers the area (no trees there is true)', async () => {
        const fetchTrees = live();
        const result = await createOvertureTreesProvider(pool({ covered: true }), { fetchTrees }).near({ type: 'Point', coordinates: [15.97, 45.81] }, 300);
        expect(result).toMatchObject({ source: 'overture-trees', count: 0 });
        expect(fetchTrees).not.toHaveBeenCalled();
    });

    it('reads OSM live where the cache holds nothing, and plants it with the same query', async () => {
        const fetchTrees = live();
        const db = pool();
        const result = await createOvertureTreesProvider(db, { fetchTrees }).near(AUSTIN, 300);
        expect(result).toMatchObject({ source: 'overpass', count: 1, trees: [[-97.745, 30.266]] });
        // The asked box: the point and 300 m around it.
        const [[w, s, e, n]] = fetchTrees.mock.calls[0];
        expect(w).toBeLessThan(-97.745); expect(e).toBeGreaterThan(-97.745);
        expect(n - s).toBeCloseTo(600 / 110570, 4);
        const { sql, params } = db.calls.at(-1);
        expect(sql).toContain('json_array_elements($7::json)');
        expect(JSON.parse(params[6])).toEqual([[-97.7451, 30.2661]]);
        expect(JSON.parse(params[7])).toHaveLength(1);
        // One lattice for both sources: the same polygon gets the same trees.
        const cacheSql = db.calls[0].sql;
        const tail = text => text.slice(text.indexOf('stepped AS'));
        expect(tail(sql)).toBe(tail(cacheSql));
    });

    it('reads OSM live when the cache cannot be read at all', async () => {
        const fetchTrees = live();
        const result = await createOvertureTreesProvider(pool({ cacheFails: true }), { fetchTrees }).near(AUSTIN, 300);
        expect(result.source).toBe('overpass');
        expect(fetchTrees).toHaveBeenCalledTimes(1);
    });

    it('plants the cache only through tree-bearing greenery, never water, car parks or paving', async () => {
        const db = pool({ cacheRows: [{ lng: 1, lat: 1 }] });
        await createOvertureTreesProvider(db, { fetchTrees: live() }).near(AUSTIN, 300);
        expect(db.calls[0].sql).toContain("d.payload->>'t' = ANY($7::text[])");
        expect(db.calls[0].params[6]).toEqual(TREE_BEARING_GREENERY);
        for (const bare of ['water', 'parking', 'paving', 'pitch', 'sand']) expect(TREE_BEARING_GREENERY).not.toContain(bare);
    });
});

describe('OSM trees and green areas from Overpass', () => {
    it('asks for mapped trees and the tree-bearing areas, ways and multipolygons', () => {
        const query = buildTreesQuery([4.37, 52.01, 4.38, 52.02]);
        expect(query).toContain('node["natural"="tree"](52.01,4.37,52.02,4.38)');
        expect(query).toContain('way["leisure"~"^(park|garden)$"]');
        expect(query).toContain('relation["type"="multipolygon"]["landuse"~');
        expect(query).toContain('out geom');
    });

    it('classifies areas as the greenery bake does, and only the tree-bearing ones', () => {
        expect(greeneryType({ leisure: 'park' })).toBe('park');
        expect(greeneryType({ natural: 'wood' })).toBe('forest');
        expect(greeneryType({ landuse: 'cemetery' })).toBe('cemetery');
        expect(greeneryType({ natural: 'water' })).toBeNull();
        expect(greeneryType({ amenity: 'parking' })).toBeNull();
    });

    it('converts tree nodes to points and closed areas to polygons, skipping the rest', () => {
        const { features, truncated } = overpassTreesToFeatures([
            { type: 'node', id: 1, lon: 4.371, lat: 52.011, tags: { natural: 'tree' } },
            { type: 'node', id: 2, lon: 4.372, lat: 52.012, tags: { amenity: 'bench' } },
            { type: 'way', id: 3, tags: { leisure: 'park' }, geometry: ring(4.37, 52.01) },
            { type: 'way', id: 4, tags: { leisure: 'park' }, geometry: ring(4.37, 52.01).slice(0, 4) },
            { type: 'way', id: 5, tags: { natural: 'water' }, geometry: ring(4.37, 52.01) },
            { type: 'relation', id: 6, tags: { landuse: 'forest', type: 'multipolygon' }, members: [
                { type: 'way', role: 'outer', geometry: ring(4.375, 52.015) },
                { type: 'way', role: 'inner', geometry: ring(4.3752, 52.0152, 0.0002) }] }
        ]);
        expect(truncated).toBe(false);
        expect(features.map(f => f.id)).toEqual(['n1', 'w3', 'r6-0']);
        expect(features[0].geometry).toEqual({ type: 'Point', coordinates: [4.371, 52.011] });
        expect(features[1].properties).toEqual({ kind: 'greenery', t: 'park' });
        expect(features[2].properties.t).toBe('forest');
    });
});
