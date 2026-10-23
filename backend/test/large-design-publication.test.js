// The reported Block stays compact; a synthetic collection independently exercises chunked publication.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { generateLargeBlockFixture } from './helpers/large-block-fixture.js';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import { scriptedCadastre } from './helpers/content-fixtures.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { PINATA_FILE_ENDPOINT } from '../storage/pinning.js';
const require = createRequire(import.meta.url);
const DesignRecord = require('../../frontend/js/design-record.js');
const BrowserCid = require('../../frontend/js/cid.js');

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('generated building design publication', () => {
    it.each([1, 16])('pins and reloads %i generated courtyards with their exact geometry', async count => {
        const { design, ring } = generateLargeBlockFixture();
        if (count > 1) {
            // Explicit synthetic transport fixture: a grid of separate buildings. A single building
            // must not need thousands of redundant vertices just to exercise multi-chunk pinning.
            const template = design.geometry.buildings[0];
            design.geometry = { buildings: Array.from({ length: count }, (_, index) => ({
                ...structuredClone(template),
                geometry: { type: 'Polygon', coordinates: template.geometry.coordinates.map(outline => outline.map(([x, y]) =>
                    [x + (index % 4) * 0.004, y + Math.floor(index / 4) * 0.004])) }
            })) };
        }
        const uncompressed = canonicalBytes(design).length;
        const content = DesignRecord.published({ ...design, createdAt: design.authoredAt });
        const bytes = canonicalBytes(content);
        const cid = cidOf(bytes);
        expect(ring.widthAchieved).toBe(15);
        if (count === 1) {
            expect(content.geometry.buildings[0].geometry.coordinates.flat().length).toBeLessThan(1000);
            expect(bytes.length).toBeLessThan(64 * 1024);
            expect(bytes.length).toBeLessThan(uncompressed * 0.6);
        } else {
            expect(bytes.length).toBeGreaterThan(256 * 1024);
        }
        expect(content.geometry.buildings).toHaveLength(count);
        expect(content.geometry.blockMassing).toBeUndefined();
        expect(content.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
        expect(BrowserCid.cidOfObject(content)).toBe(cid);
        expect(BrowserCid.parse(cid).codec).toBe(count === 1 ? 0x55 : 0x70);
        expect(DesignRecord.validate(content).valid).toBe(true);

        vi.stubEnv('PINATA_API_KEY', 'test-key');
        vi.stubEnv('PINATA_API_SECRET', 'test-secret');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        // Independently model the provider's IPFS importer rather than returning our expected CID.
        const upstream = vi.fn(async (url, init) => {
            expect(url).toBe(PINATA_FILE_ENDPOINT);
            const uploaded = new Uint8Array(await init.body.get('file').arrayBuffer());
            expect(Buffer.compare(Buffer.from(uploaded), bytes)).toBe(0);
            let root;
            for await (const entry of importer([{ path: 'design.json', content: uploaded }], { put: async () => {} }, {
                cidVersion: 1, rawLeaves: true, reduceSingleLeafToSelf: true, wrapWithDirectory: false,
                chunker: fixedSize({ chunkSize: 256 * 1024 }), layout: balanced()
            })) root = entry;
            return Response.json({ IpfsHash: root.cid.toString(), Timestamp: '2026-10-23T00:00:00.000Z' });
        });
        vi.stubGlobal('fetch', upstream);
        const pool = createMockPool();
        pool.bindingAnswer = scriptedCadastre();
        let saved = null;
        pool.answer(/FROM consensus\.design WHERE cid = \$1/, () => ({ rows: saved ? [saved] : [] }));
        pool.answer(/INSERT INTO consensus\.design/, (_sql, params) => {
            saved = { cid: params[0], city: params[1], goal: params[2], title: params[3], author: params[4],
                binding: JSON.parse(params[7]), content: JSON.parse(params[8]), origin_cid: params[9],
                created_at: new Date('2026-10-23T00:00:00.000Z') };
            return { rows: [saved] };
        });
        const app = createContentApp(pool, { thumbnailQueue: { enqueue: vi.fn() }, baseUrl: 'https://api.example' });
        const pinned = await request(app).post('/pins').send({ kind: 'design', cid, bytes: bytes.toString('base64') });
        expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
        expect(pinned.body.cid).toBe(cid);
        expect(upstream).toHaveBeenCalledTimes(1);
        const indexed = await request(app).post('/designs').send({ cid, content });
        expect(indexed.status, JSON.stringify(indexed.body)).toBe(201);
        const reopened = await request(app).get(`/designs/${cid}`);
        expect(reopened.status).toBe(200);
        expect(reopened.body.content).toEqual(content);
        expect(cidOf(canonicalBytes(reopened.body.content))).toBe(cid);
    }, 30000);
});
