// Unit tests for frontend/js/proposals/site-hash.js: the canonical site encoding whose sha256 is
// proposal_nft v3's `site_hash`, and the (site_hash, open_ground) mint arguments derived from a site
// and its binding. The encoding is pinned byte for byte, so a change to it fails here before it can
// make the browser and the agents hash the same site differently.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const siteHashApi = require('../../frontend/js/proposals/site-hash.js');
const { canonicalSiteJson, siteHash, siteHashHex, siteHashFromChain, isZeroSiteHash, chainSiteArgs, ZERO_SITE_HASH } = siteHashApi;

// A 10 m-ish square with a hole, counter-clockwise exterior, starting at its smallest vertex.
const SQUARE = [[15.97, 45.8], [15.9701, 45.8], [15.9701, 45.8001], [15.97, 45.8001], [15.97, 45.8]];
const HOLE = [[15.97004, 45.80004], [15.97004, 45.80006], [15.97006, 45.80006], [15.97006, 45.80004], [15.97004, 45.80004]];
const OTHER = [[16.0, 45.9], [16.0001, 45.9], [16.0001, 45.9001], [16.0, 45.9]];

const sha256Hex = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('canonical site encoding (version 1)', () => {
    it('pins the exact bytes: integer 1e-7 degree coordinates, closed CCW ring, sorted keys', () => {
        expect(canonicalSiteJson({ type: 'Polygon', coordinates: [SQUARE] })).toBe(
            '{"coordinates":[[[[159700000,458000000],[159701000,458000000],[159701000,458001000],[159700000,458001000],[159700000,458000000]]]],"type":"MultiPolygon"}'
        );
        expect(siteHashApi.SITE_HASH_VERSION).toBe(1);
    });

    it('ignores start vertex, orientation, a missing closing vertex, duplicate vertices, z values and sub-1e-7 noise', async () => {
        const reference = await siteHashHex({ type: 'Polygon', coordinates: [SQUARE] });
        const rotatedClockwise = [[15.9701, 45.8001], [15.9701, 45.8], [15.97, 45.8], [15.97, 45.8001]];
        const noisy = SQUARE.map(([x, y], i) => [x + (i % 2 ? 2e-9 : -3e-9), y + 1e-9, 120.5]);
        const duplicated = [SQUARE[0], SQUARE[0], ...SQUARE.slice(1)];
        for (const ring of [rotatedClockwise, noisy, duplicated]) {
            expect(await siteHashHex({ type: 'Polygon', coordinates: [ring] })).toBe(reference);
        }
        expect(await siteHashHex({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[SQUARE]] } })).toBe(reference);
    });

    it('orients holes clockwise and sorts holes and polygons, so part order never matters', async () => {
        const a = { type: 'MultiPolygon', coordinates: [[SQUARE, HOLE], [OTHER]] };
        const b = { type: 'MultiPolygon', coordinates: [[OTHER], [SQUARE, [...HOLE].reverse()]] };
        expect(await siteHashHex(a)).toBe(await siteHashHex(b));
        const coordinates = siteHashApi.canonicalSiteCoordinates(a);
        const signedArea = ring => ring.slice(0, -1).reduce((sum, [x1, y1], i, open) => {
            const [x2, y2] = open[(i + 1) % open.length];
            return sum + x1 * y2 - x2 * y1;
        }, 0);
        expect(signedArea(coordinates[0][0])).toBeGreaterThan(0); // exterior CCW
        expect(signedArea(coordinates[0][1])).toBeLessThan(0); // hole CW
    });

    it('changes when the site moves by one unit of resolution, and is the sha256 of the canonical JSON', async () => {
        const site = { type: 'Polygon', coordinates: [SQUARE] };
        const moved = { type: 'Polygon', coordinates: [SQUARE.map(([x, y]) => [x + 1e-7, y])] };
        expect(await siteHashHex(moved)).not.toBe(await siteHashHex(site));
        expect(await siteHashHex(site)).toBe(sha256Hex(canonicalSiteJson(site)));
        const bytes = await siteHash(site);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes).toHaveLength(32);
        expect(isZeroSiteHash(bytes)).toBe(false);
    });

    it('refuses what is not a site with area', () => {
        expect(() => canonicalSiteJson({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toThrow(/Polygon/);
        expect(() => canonicalSiteJson({ type: 'Polygon', coordinates: [[[0, 0], [1e-8, 0], [0, 1e-8], [0, 0]]] })).toThrow(/no polygon with area/);
        expect(() => canonicalSiteJson({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] })).toThrow(/no polygon with area/);
        expect(() => canonicalSiteJson({ type: 'Polygon', coordinates: [[[0, 0], [1, NaN], [1, 1]]] })).toThrow(/finite/);
        expect(() => canonicalSiteJson(null)).toThrow();
    });
});

describe('chain decoding of site_hash', () => {
    it('reads the zero hash as no site and any other as lowercase hex', () => {
        expect(siteHashFromChain(Uint8Array.from(ZERO_SITE_HASH))).toBeNull();
        expect(siteHashFromChain(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe(Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''));
        expect(() => isZeroSiteHash(new Uint8Array(31))).toThrow(/32 bytes/);
    });
});

describe('chainSiteArgs: the v3 mint arguments', () => {
    const site = { type: 'Polygon', coordinates: [SQUARE] };

    it('an empty binding is all open ground and needs a site', async () => {
        const args = await chainSiteArgs({ site, binding: { coverage: 'none' }, parcelIds: [] });
        expect(args.openGround).toBe(true);
        expect(Array.from(args.siteHash)).toEqual(Array.from(await siteHash(site)));
        await expect(chainSiteArgs({ parcelIds: [] })).rejects.toThrow(/needs a site/);
        // Even a binding that (wrongly) claims complete coverage cannot make an empty list closed ground.
        expect((await chainSiteArgs({ site, binding: { coverage: 'complete' }, parcelIds: [] })).openGround).toBe(true);
    });

    it('with parcels: open ground unless the binding covers the whole site', async () => {
        expect((await chainSiteArgs({ site, binding: { coverage: 'complete' }, parcelIds: ['HR-1'] })).openGround).toBe(false);
        for (const coverage of ['partial', 'none', 'unknown']) {
            expect((await chainSiteArgs({ site, binding: { coverage }, parcelIds: ['HR-1'] })).openGround, coverage).toBe(true);
        }
    });

    it('without a site (every pre-v3 style proposal) the hash is zero and the ground closed', async () => {
        const args = await chainSiteArgs({ parcelIds: ['HR-1'] });
        expect(args.openGround).toBe(false);
        expect(isZeroSiteHash(args.siteHash)).toBe(true);
    });
});
