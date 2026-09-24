// Route tests for what the free POST /proposals refuses to store as-is: a thumbnail that is not an
// image in our own upload store, an author that impersonates a wallet or agent persona. Plus the
// thumbnail being rendered OFF the request path, and the proposal_id lock guard on the insert.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { validProposalBody, insertResult, updateResult } from './helpers/fixtures.js';
import { isOwnStoreImageUrl, isReservedAuthorIdentity } from '../routes/proposals.js';
import { generateAndStoreProposalThumbnail } from '../thumbnails/proposal-thumbnail.js';
import { defaultThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { saveImageBuffer } from '../utils/image-store.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

let pool;
let app;
let ownImage; // a real file in uploads/images, as /assets/upload would have written it
let savedBase;
let warn;

beforeEach(() => {
    pool = createMockPool();
    app = createTestApp(pool);
    savedBase = process.env.PUBLIC_API_BASE_URL;
    process.env.PUBLIC_API_BASE_URL = 'https://api.example.test';
    ownImage = saveImageBuffer(PNG, 'write-hardening-test');
    vi.mocked(generateAndStoreProposalThumbnail).mockReset();
    vi.mocked(generateAndStoreProposalThumbnail).mockResolvedValue(null);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
    await defaultThumbnailQueue().onIdle();
    fs.rmSync(ownImage.absolutePath, { force: true });
    if (savedBase === undefined) delete process.env.PUBLIC_API_BASE_URL;
    else process.env.PUBLIC_API_BASE_URL = savedBase;
    warn.mockRestore();
});

const insertCall = () => pool.getCalls().find(call => call.sql.includes('INSERT INTO proposal'));
const storedData = () => JSON.parse(insertCall().params[32]);

function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

describe('isOwnStoreImageUrl', () => {
    it('accepts an existing image under our store, as a path or under the pinned origin', () => {
        expect(isOwnStoreImageUrl(ownImage.imagePath)).toBe(true);
        expect(isOwnStoreImageUrl(`/images/${ownImage.fileName}`)).toBe(true);
        expect(isOwnStoreImageUrl(`https://api.example.test${ownImage.imagePath}`)).toBe(true);
    });

    it.each([
        ['another host', () => `https://evil.example${ownImage.imagePath}`],
        ['protocol-relative', () => `//evil.example${ownImage.imagePath}`],
        ['a gateway', () => 'https://gateway.pinata.cloud/ipfs/abc'],
        ['a missing file', () => '/uploads/images/does-not-exist.png'],
        ['traversal', () => '/uploads/images/../metadata/x.json'],
        ['metadata json', () => '/metadata/x.json'],
        ['a model', () => '/uploads/models/x.glb'],
        ['a query string', () => `https://api.example.test${ownImage.imagePath}?x=1`],
        ['javascript:', () => 'javascript:alert(1)'],
        ['a data url', () => 'data:image/png;base64,AAAA']
    ])('refuses %s', (_label, url) => {
        expect(isOwnStoreImageUrl(url())).toBe(false);
    });
});

describe('POST /proposals — client thumbnails', () => {
    it('drops a foreign screenshotUrl and queues the server render instead', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals')
            .send(validProposalBody({ screenshotUrl: 'https://tracker.example/pixel.png' }));

        expect(res.status).toBe(201);
        expect(res.body.screenshotUrl).toBeNull();
        expect(insertCall().params[31]).toBeNull(); // screenshot_url column
        expect(storedData().screenshotUrl).toBeUndefined();
        await defaultThumbnailQueue().onIdle();
        expect(generateAndStoreProposalThumbnail).toHaveBeenCalledTimes(1);
    });

    it('keeps an own-store screenshotUrl and does not render', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals')
            .send(validProposalBody({ screenshotUrl: ownImage.imagePath }));

        expect(res.status).toBe(201);
        expect(res.body.screenshotUrl).toBe(ownImage.imagePath);
        expect(insertCall().params[31]).toBe(ownImage.imagePath);
        await defaultThumbnailQueue().onIdle();
        expect(generateAndStoreProposalThumbnail).not.toHaveBeenCalled();
    });

    it('drops a foreign onchain.imageUrl (the lists fall back to it) but keeps the rest of onchain', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals').send(validProposalBody({
            onchain: { transactionHash: '0xabc', imageUrl: 'https://tracker.example/pixel.png' }
        }));

        expect(res.status).toBe(201);
        const onchainColumn = JSON.parse(insertCall().params[30]);
        expect(onchainColumn).toEqual({ transactionHash: '0xabc' });
        expect(storedData().onchain.imageUrl).toBeUndefined();
    });
});

describe('POST /proposals — authors', () => {
    it.each([
        ['an EVM address', '0x52908400098527886E0F7030069857D2E4169EE7'],
        ['a Solana address', 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg'],
        ['an agent persona name', 'densifier-01'],
        ['a persona name in another case', 'Densifier-01']
    ])('does not store %s as the author on the free route', async (_label, author) => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals').send(validProposalBody({ author }));

        expect(res.status).toBe(201);
        expect(insertCall().params[5]).toBeNull();          // author column
        expect(storedData().author).toBeUndefined();        // and not in proposal_data (the fallback)
        expect(warn.mock.calls.some(args => String(args[0]).includes('author'))).toBe(true);
    });

    it.each(['Guest 3780', 'Pontifex Maximus', 'zagreb.lol – lokalna analiza', '0xABCDEF1234567890'])(
        'keeps the display name %s',
        async (author) => {
            pool.setResults([insertResult(), updateResult()]);
            const res = await request(app).post('/proposals').send(validProposalBody({ author }));
            expect(res.status).toBe(201);
            expect(insertCall().params[5]).toBe(author);
            expect(storedData().author).toBe(author);
        }
    );

    it('classifies identities without false positives on ordinary names', () => {
        expect(isReservedAuthorIdentity('FoPmPhKE6bykLoumQSvygZCSJYLkxBfsqjE3ybMvSjYs')).toBe(true);
        expect(isReservedAuthorIdentity('supporter-01')).toBe(true);
        expect(isReservedAuthorIdentity('Guest 5064')).toBe(false);
        expect(isReservedAuthorIdentity('')).toBe(false);
        expect(isReservedAuthorIdentity(null)).toBe(false);
    });
});

describe('POST /proposals — thumbnail off the request path', () => {
    it('answers 201 before the thumbnail render finishes, then stores it', async () => {
        const render = deferred();
        vi.mocked(generateAndStoreProposalThumbnail).mockImplementation(() => render.promise);
        pool.setResults([insertResult(), updateResult(), updateResult()]);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        const res = await request(app).post('/proposals').send(validProposalBody());

        expect(res.status).toBe(201);
        expect(res.body.screenshotUrl).toBeNull();
        expect(pool.getCalls().some(call => call.sql.includes('SET screenshot_url'))).toBe(false);

        render.resolve({ url: '/uploads/images/proposal-thumb-1.png', frame: { zoom: 19 }, tiles: { loaded: 4, total: 4 }, bytes: 10 });
        await defaultThumbnailQueue().onIdle();
        log.mockRestore();

        const update = pool.getCalls().find(call => call.sql.includes('SET screenshot_url'));
        expect(update.params).toEqual(['/uploads/images/proposal-thumb-1.png', 1]);
    });
});

describe('POST /proposals — proposal_id lock guard', () => {
    it('inserts only under the shared proposal_id lock, and answers 409 when a paid request holds it', async () => {
        pool.setResults([{ rows: [], rowCount: 0 }]); // the guarded INSERT … SELECT … WHERE inserted nothing

        const res = await request(app).post('/proposals').send(validProposalBody());

        expect(insertCall().sql).toMatch(/WHERE pg_try_advisory_xact_lock_shared\(\d+, hashtext\(\$1::varchar\)\)/);
        expect(res.status).toBe(409);
        expect(res.body.proposalId).toBe('test-proposal-001');
        expect(pool.getCalls()).toHaveLength(1); // no follow-up UPDATE, no thumbnail
    });
});
