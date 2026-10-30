// North Rhine-Westphalia's LoD2 tiles (buildings/nrw-lod2.js): a box maps onto the state's 1 km tile
// names, a real tile excerpt (central Cologne) reads into roofed 3D records standing at their height
// above sea level, an unpublished tile is empty, and only a few parsed tiles are kept.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { NRW_LOD2, createNrwLod2Provider } from '../buildings/nrw-lod2.js';

const excerpt = readFileSync(new URL('./fixtures/nrw-lod2-356-5645-excerpt.gml', import.meta.url), 'utf8');
const toUtm = proj4('EPSG:4326', NRW_LOD2.crs);
const quiet = { log() {} };
const serve = sheets => vi.fn(async url => {
    const name = url.match(/LoD2_32_(\d+_\d+)_1_NW\.gml$/)?.[1];
    return sheets[name] ? new Response(sheets[name], { status: 200 }) : new Response('', { status: 404 });
});

describe('nrw-lod2', () => {
    it('names the 1 km tiles under a box', () => {
        const [x, y] = toUtm.forward([6.9583, 50.9413]); // Cologne Cathedral
        expect(NRW_LOD2.sheetsFor([x, y, x, y])).toEqual(['356_5645']);
        expect(NRW_LOD2.sheetsFor([355999, 5645000, 356001, 5646001])).toEqual(['355_5645', '355_5646', '356_5645', '356_5646']);
        expect(NRW_LOD2.sheetUrl('356_5645')).toBe('https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/LoD2_32_356_5645_1_NW.gml');
    });

    it('reads a tile into roofed buildings above sea level, and an unpublished tile as empty', async () => {
        const fetchImpl = serve({ '356_5645': excerpt });
        const provider = createNrwLod2Provider({ fetchImpl, log: quiet });
        const area = { type: 'Polygon', coordinates: [[[6.950, 50.938], [6.965, 50.938], [6.965, 50.949], [6.950, 50.949], [6.950, 50.938]]] };
        const near = await provider.near(area);
        expect(near.count).toBe(2);
        for (const record of near.buildings) {
            expect(record.object_id).toMatch(/^nrw-lod2:/);
            // Cologne's old town stands about 50–60 m above sea level (DHHN2016, no offset).
            expect(record.z_min).toBeGreaterThan(35); expect(record.z_min).toBeLessThan(80);
            expect(record.z_max).toBeGreaterThan(record.z_min);
            expect(record.faces.some(face => face.kind === 'roof')).toBe(true);
        }
        const footprints = await provider.footprints(area);
        expect(footprints.footprints).toHaveLength(2);
        expect(footprints.footprints.every(item => item.height_m > 0)).toBe(true);
        const outside = await createNrwLod2Provider({ fetchImpl, log: quiet }).near({ type: 'Point', coordinates: [6.9, 50.9] }, 50);
        expect(outside).toMatchObject({ count: 0 });
    });

    it('keeps only a few parsed tiles', async () => {
        const sheets = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${350 + i}_5645`, excerpt]));
        const fetchImpl = serve(sheets);
        const provider = createNrwLod2Provider({ fetchImpl, log: quiet });
        const at = i => { const [lng, lat] = proj4(NRW_LOD2.crs, 'EPSG:4326').forward([(350 + i) * 1000 + 500, 5645500]); return { type: 'Point', coordinates: [lng, lat] }; };
        for (let i = 0; i < 7; i++) await provider.near(at(i), 10);
        await provider.near(at(6), 10);
        expect(fetchImpl).toHaveBeenCalledTimes(7);
        await provider.near(at(0), 10);
        expect(fetchImpl).toHaveBeenCalledTimes(8);
        expect(NRW_LOD2.sheetCache).toBe(6);
    });
});
