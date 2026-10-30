// The German states' LoD2 sources (berlin-lod2, hamburg-lod2, bw-lod2, sachsen-lod2) and the range
// reader Hamburg's one big zip needs (remote-zip.js): each state's sheet grid and file names, a file
// read out of a zip by range, a Baden-Württemberg zip read once for its four tiles, and Saxony's share
// id taken from its download portal's config.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { zipSync, strToU8 } from 'fflate';
import { kmSheets } from '../buildings/citygml-source.js';
import { openRemoteZip } from '../buildings/remote-zip.js';
import { BERLIN_LOD2, createBerlinLod2Provider } from '../buildings/berlin-lod2.js';
import { HAMBURG_LOD2, HAMBURG_LOD2_ZIP, createHamburgLod2Provider } from '../buildings/hamburg-lod2.js';
import { BW_LOD2, bwZipOf, createBwLod2Provider } from '../buildings/bw-lod2.js';
import { SACHSEN_LOD2, SACHSEN_PORTAL_CONFIG, sachsenShareId, createSachsenLod2Provider } from '../buildings/sachsen-lod2.js';

// A real excerpt of a UTM 32 tile (central Cologne, two buildings) stands in for Hamburg's and
// Baden-Württemberg's tiles, which share its grid and CRS.
const excerpt = readFileSync(new URL('./fixtures/nrw-lod2-356-5645-excerpt.gml', import.meta.url), 'utf8');
const cologne = { type: 'Polygon', coordinates: [[[6.950, 50.938], [6.965, 50.938], [6.965, 50.949], [6.950, 50.949], [6.950, 50.938]]] };
const quiet = { log() {} };
const utm = (crs, lng, lat) => proj4('EPSG:4326', crs).forward([lng, lat]);

// A server for one archive that answers byte ranges (suffix ranges too) with 206, as a static host does.
function rangeServer(bytes) {
    return vi.fn(async (_url, { headers } = {}) => {
        const [, from, to] = headers?.Range?.match(/^bytes=(\d*)-(\d*)$/) || [];
        if (from === undefined) return new Response(bytes, { status: 200 });
        const start = from === '' ? bytes.length - Number(to) : Number(from);
        const end = from === '' || to === '' ? bytes.length - 1 : Math.min(Number(to), bytes.length - 1);
        return new Response(bytes.slice(Math.max(0, start), end + 1), { status: 206 });
    });
}

describe('state sheet grids', () => {
    it('names each state\'s tiles under a box', () => {
        const [bx, by] = utm(BERLIN_LOD2.crs, 13.4132, 52.5219); // Alexanderplatz
        expect(BERLIN_LOD2.sheetsFor([bx, by, bx, by])).toEqual(['392_5820']);
        expect(BERLIN_LOD2.sheetUrl('392_5820')).toBe('https://gdi.berlin.de/data/a_lod2/atom/LoD2_392_5820.zip');
        const [hx, hy] = utm(HAMBURG_LOD2.crs, 9.9937, 53.5511); // Rathausmarkt
        expect(HAMBURG_LOD2.sheetsFor([hx, hy, hx, hy])).toEqual(['565_5934']);
        const [sx, sy] = utm(SACHSEN_LOD2.crs, 13.7417, 51.0518); // Dresden, Neumarkt
        expect(SACHSEN_LOD2.sheetsFor([sx, sy, sx, sy])).toEqual(['410_5656']);
        expect(kmSheets([409500, 5655500, 412100, 5656100], 2)).toEqual(['408_5654', '408_5656', '410_5654', '410_5656', '412_5654', '412_5656']);
    });

    it("finds Baden-Württemberg's 2 km zip of a 1 km tile (odd east, even north)", () => {
        const [x, y] = utm(BW_LOD2.crs, 9.1770, 48.7784); // Stuttgart, Schlossplatz
        expect(BW_LOD2.sheetsFor([x, y, x, y])).toEqual(['513_5402']);
        expect(['513_5402', '514_5402', '513_5403', '514_5403'].map(bwZipOf)).toEqual(['513_5402', '513_5402', '513_5402', '513_5402']);
        expect(bwZipOf('512_5401')).toBe('511_5400');
        expect(BW_LOD2.zipUrl('513_5402')).toBe('https://opengeodata.lgl-bw.de/data/lod2/LoD2_32_513_5402_2_bw.zip');
    });
});

describe('remote zip', () => {
    const archive = zipSync({ 'tiles/a.gml': strToU8('first '.repeat(500)), 'b.txt': [strToU8('stored'), { level: 0 }] });

    it('lists the files and reads one by range, deflated or stored', async () => {
        const fetchImpl = rangeServer(archive);
        const zip = openRemoteZip('https://example.test/all.zip', { fetchImpl });
        const entries = await zip.entries();
        expect(entries.map(entry => [entry.name, entry.method])).toEqual([['tiles/a.gml', 8], ['b.txt', 0]]);
        expect(new TextDecoder().decode(await zip.read(entries[0]))).toBe('first '.repeat(500));
        expect(new TextDecoder().decode(await zip.read(entries[1]))).toBe('stored');
        await zip.entries();
        expect(fetchImpl).toHaveBeenCalledTimes(4); // tail, directory, two files
        for (const [, init] of fetchImpl.mock.calls) expect(init.headers.Range).toMatch(/^bytes=/);
    });

    it('refuses a server that ignores ranges instead of downloading the whole archive', async () => {
        const zip = openRemoteZip('https://example.test/all.zip', { fetchImpl: async () => new Response(archive, { status: 200 }) });
        await expect(zip.entries()).rejects.toThrow('HTTP 200 to a range request');
    });
});

describe('hamburg-lod2', () => {
    it('reads a tile out of the yearly zip, and a tile the zip lacks as empty', async () => {
        const fetchImpl = rangeServer(zipSync({ 'LoD2_32_356_5645_1_HH.gml': strToU8(excerpt), 'LoD2_32_565_5934_1_HH.gml': strToU8('<x/>') }));
        const provider = createHamburgLod2Provider({ fetchImpl, log: quiet });
        const near = await provider.near(cologne);
        expect(near).toMatchObject({ count: 2, source: 'hamburg-lod2' });
        expect(near.buildings.every(record => record.object_id.startsWith('hamburg-lod2:'))).toBe(true);
        expect(fetchImpl.mock.calls.every(([url]) => url === HAMBURG_LOD2_ZIP)).toBe(true);
        expect(await provider.near({ type: 'Point', coordinates: [6.9, 50.9] }, 50)).toMatchObject({ count: 0 });
    });
});

describe('bw-lod2', () => {
    it('reads each 2 km zip once for its tiles', async () => {
        const zip = zipSync({ 'LoD2_32_355_5644_2_bw/LoD2_32_356_5645_1_BW.gml': strToU8(excerpt),
            'LoD2_32_355_5644_2_bw/INFO_OpenData_LoD2_2026.txt': strToU8('info') });
        const fetchImpl = vi.fn(async url => url === BW_LOD2.zipUrl('355_5644') ? new Response(zip, { status: 200 }) : new Response('', { status: 404 }));
        const provider = createBwLod2Provider({ fetchImpl, log: quiet });
        const near = await provider.near(cologne);
        expect(near).toMatchObject({ count: 2, source: 'bw-lod2' });
        const neighbour = proj4(BW_LOD2.crs, 'EPSG:4326').forward([355500, 5645500]); // another tile of the same zip, absent from it
        expect(await provider.near({ type: 'Point', coordinates: neighbour }, 5)).toMatchObject({ count: 0 });
        // The box spans several zips; the one holding both tiles is read once.
        expect(fetchImpl.mock.calls.filter(([url]) => url === BW_LOD2.zipUrl('355_5644'))).toHaveLength(1);
        expect(new Set(fetchImpl.mock.calls.map(([url]) => url)).size).toBe(fetchImpl.mock.calls.length);
    });
});

describe('sachsen-lod2', () => {
    const appConfig = { bundles: { 'geobak-4x-productdownload': { ProductdownloadController: { productsConfig: [
        { name: 'DOP', formats: [{ name: 'TIFF', cloudId: 'other' }] },
        { name: 'LOD2', formats: [{ name: 'Shape', cloudId: 'shape' }, { name: 'CityGML', cloudId: 'Share123' }] }] } } } };

    it("takes the share id from the portal's config, once, and reads the 2 km tile from it", async () => {
        expect(sachsenShareId(appConfig)).toBe('Share123');
        expect(() => sachsenShareId({})).toThrow('no longer names a LoD2 CityGML share');
        const fetchImpl = vi.fn(async url => url === SACHSEN_PORTAL_CONFIG ? Response.json(appConfig) : new Response('', { status: 404 }));
        const provider = createSachsenLod2Provider({ fetchImpl, log: quiet });
        const [lng, lat] = proj4(SACHSEN_LOD2.crs, 'EPSG:4326').forward([411000, 5657000]);
        expect(await provider.near({ type: 'Point', coordinates: [lng, lat] }, 5)).toMatchObject({ count: 0 });
        expect(await provider.near({ type: 'Point', coordinates: [lng + 0.0001, lat] }, 5)).toMatchObject({ count: 0 });
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([SACHSEN_PORTAL_CONFIG,
            'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/Share123/lod2_33410_5656_2_sn_citygml.zip']);
    });
});

describe('berlin-lod2', () => {
    it('reads the zip of a 1 km tile, and a tile outside the city as empty', async () => {
        const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
        const provider = createBerlinLod2Provider({ fetchImpl, log: quiet });
        expect(await provider.near({ type: 'Point', coordinates: [13.4132, 52.5219] }, 5)).toMatchObject({ count: 0, source: 'berlin-lod2' });
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://gdi.berlin.de/data/a_lod2/atom/LoD2_392_5820.zip']);
        fetchImpl.mockImplementation(async () => new Response('', { status: 500 }));
        await expect(provider.near({ type: 'Point', coordinates: [13.38, 52.52] }, 5)).rejects.toThrow('berlin-lod2 sheet 390_5820: HTTP 500');
    });
});
