// A real generated Block crosses the old one-chunk limit and must pin, index and reload intact.
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

describe('large authored design publication', () => {
    it('pins the generated courtyard with a standard file CID, indexes it and reloads its exact geometry', async () => {
        const { design } = generateLargeBlockFixture();
        const uncompressed = canonicalBytes(design).length;
        const content = DesignRecord.published({ ...design, createdAt: design.authoredAt });
        const bytes = canonicalBytes(content);
        const cid = cidOf(bytes);
        expect(uncompressed).toBeGreaterThan(1024 * 1024);
        expect(bytes.length).toBeGreaterThan(256 * 1024);
        expect(bytes.length).toBeLessThan(uncompressed * 0.6);
        expect(content.geometry.blockMassing).toBeUndefined();
        expect(content.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
        expect(BrowserCid.cidOfObject(content)).toBe(cid);
        expect(BrowserCid.parse(cid).codec).toBe(0x70);
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
