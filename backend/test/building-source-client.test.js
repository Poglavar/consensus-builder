// Every building source goes through the backend; OSM fallback preserves completeness signals.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const client = require('../../frontend/js/building-source-client.js');
const geometry = { type: 'Point', coordinates: [-74.08, 4.61] };
function page(buildings, answers, configAt = null) {
    const calls = [];
    const global = { getBackendBase: () => 'http://backend.test',
        CityConfigManager: { getCurrentCityConfig: () => ({ buildings }),
            ...(configAt ? { getCityConfigAt: configAt } : {}) },
        fetch: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
            const answer = answers.shift();
            if (answer instanceof Error) throw answer;
            return { ok: true, json: async () => answer };
        } };
    return { global, calls };
}
describe('building source client', () => {
    it.each(['/buildings/near', '/buildings/footprints', '/buildings/under'])('reads %s through the backend without browser tile APIs', async path => {
        const answer = { source: 'osm-footprints', truncated: false, regions: { take: [] } };
        const { global, calls } = page({ source: 'osm' }, [answer]);
        expect(await client.request(path, { geometry, city: 'wrong', source: 'stale-source' }, { global })).toEqual(answer);
        expect(calls[0]).toMatchObject({ url: 'http://backend.test'+path, body: { geometry } });
        expect(calls[0].body).not.toHaveProperty('city');
        expect(calls[0].body.source).toBe('osm');
    });
    it('uses the request location to select a dedicated source', async () => {
        const { global, calls } = page({ source: 'osm' }, [{ count: 1 }], (lat, lon) => {
            expect([lat, lon]).toEqual([4.61, -74.08]);
            return { buildings: { source: 'cadastre', sourceId: 'building.there' } };
        });
        await client.request('/buildings/near', { geometry }, { global });
        expect(calls[0].body.source).toBe('building.there');
    });
    it('reads geometry requests from the city own source only, whatever stand-ins it declares', async () => {
        for (const [path, answer] of [['/buildings/near', { buildings: [] , unavailable: true }],
            ['/buildings/footprints', { footprints: [], truncated: true }],
            ['/buildings/under', { supported: true, regions: { take: [] }, truncated: false }]]) {
            const { global, calls } = page({ sourceId: 'building.city', fallbacks: ['osm'] }, [answer]);
            expect(await client.request(path, { geometry }, { global })).toEqual(answer);
            expect(calls.map(call => call.body.source)).toEqual(['building.city']);
        }
    });
    it('lists the city sources in order, its own first, and asks one cell of one named source', async () => {
        const { global, calls } = page({ sourceId: 'building.city', fallbacks: ['osm'] }, [{ supported: true, items: [], complete: true }]);
        expect(client.sourcesFor(global, { geometry })).toEqual(['building.city', 'osm']);
        expect(client.sourcesFor(page({ source: 'osm' }, []).global, { geometry })).toEqual(['osm']);
        await client.requestCell({ kind: 'footprints', source: 'osm', bbox: [-74.11, 4.61, -74.10, 4.62] }, { global });
        expect(calls[0]).toMatchObject({ url: 'http://backend.test/buildings/cell', body: { kind: 'footprints', source: 'osm', bbox: [-74.11, 4.61, -74.10, 4.62] } });
    });
    it('keeps aborts and failures visible when no fallback is configured', async () => {
        const abort = Object.assign(new Error('aborted'), { name:'AbortError' });
        const a = page({ sourceId:'building.city', fallbacks:['osm'] }, [abort]);
        await expect(client.request('/buildings/near', { geometry }, { global:a.global })).rejects.toThrow('aborted');
        expect(a.calls).toHaveLength(1);
        const b = page({ sourceId:'building.mine' }, [new Error('offline')]);
        await expect(client.request('/buildings/near', { geometry }, { global:b.global })).rejects.toThrow('offline');
        expect(b.calls).toHaveLength(1);
    });
});

it('sends an explicit evidence namespace only when frontend settings select it', async () => {
    const { global, calls } = page({ source: 'osm' }, [{ buildings: [] }], () => ({
        buildings: { source: 'gdi', sourceId: 'gdi-3d' }, floorModels: { namespace: 'evidence-collection' }
    }));
    await client.request('/buildings/near', { geometry, city: 'ignored', floorModelNamespace: 'stale' }, { global });
    expect(calls[0].body).toEqual({geometry, source:'gdi-3d', floorModelNamespace:'evidence-collection'});
});
