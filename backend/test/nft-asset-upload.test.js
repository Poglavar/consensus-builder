// /ipfs/upload and /walrus/upload pin content on OUR paid storage accounts. They used to be open
// relays (origin check only, 15 MB of anything); these lock them to what the mint flows send: a
// sniffed PNG/JPEG/WEBP within a size cap, ERC-721-style metadata, and a per-IP rate limit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupIpfsRoute } from '../routes/ipfs.js';
import { setupWalrusRoute } from '../routes/walrus.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { MAX_UPLOAD_IMAGE_BYTES, UPLOAD_RATE_MAX, validateNftMetadata } from '../utils/nft-asset-upload.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDataUrl = (size = 24) => 'data:image/png;base64,' + Buffer.concat([PNG_HEADER, Buffer.alloc(size - 8)]).toString('base64');
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]).toString('base64');

// What frontend/js/parcels/ui/claim.js actually sends for a parcel mint.
const parcelMetadata = () => ({
    name: 'Parcel HR-339318-7396',
    description: 'Digitized cadastral parcel HR-339318-7396. Minted by 0xabc.',
    image: '',
    attributes: [
        { trait_type: 'Parcel ID', value: 'HR-339318-7396' },
        { trait_type: 'Area (m²)', value: 512.3, display_type: 'number' }
    ],
    parcelId: 'HR-339318-7396',
    areaSquareMeters: 512.3,
    geometry: { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]] }
});

// What frontend/js/proposals/create.js sends for a proposal mint.
const proposalMetadata = () => ({
    name: 'Road proposal', title: 'Road proposal', description: 'x', image: '',
    attributes: [{ trait_type: 'Goal', value: 'road' }, { trait_type: 'Conditional', value: 'No' }],
    properties: { proposalId: 'p1', goal: 'road', cadastreParcelIds: ['HR-1-2'], offer: { amount: 1, currency: 'USDC' } }
});

const ROUTES = [
    ['ipfs', setupIpfsRoute, '/ipfs/upload'],
    ['walrus', setupWalrusRoute, '/walrus/upload']
];

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each(ROUTES)('%s relay guard', (_name, setup, path) => {
    let app;
    let fetchMock;
    beforeEach(() => {
        process.env.PINATA_API_KEY = 'k';
        process.env.PINATA_API_SECRET = 's';
        app = createRouteApp(setup);
        app.set('trust proxy', true); // req.ip from X-Forwarded-For, as behind prod's one trusted hop
        fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ IpfsHash: 'h', newlyCreated: { blobObject: { id: 'o', blobId: 'b', storage: { endEpoch: 1 } }, cost: 1 } }) }));
        vi.stubGlobal('fetch', fetchMock);
    });

    it('refuses bytes that are not an image, whatever the declared mime', async () => {
        const res = await request(app).post(path).send({
            imageData: 'data:image/png;base64,' + Buffer.from('<html>not an image, just content to host</html>').toString('base64'),
            metadata: parcelMetadata()
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/PNG, JPEG or WEBP/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an image over the size cap', async () => {
        const res = await request(app).post(path).send({ imageData: pngDataUrl(MAX_UPLOAD_IMAGE_BYTES + 1), metadata: parcelMetadata() });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/too large/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses metadata that is not NFT metadata', async () => {
        const res = await request(app).post(path).send({ imageData: pngDataUrl(), metadata: { name: 'x', payload: 'arbitrary blob' } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unsupported fields: payload/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts what the mint flows send', async () => {
        for (const metadata of [parcelMetadata(), proposalMetadata()]) {
            const res = await request(app).post(path).send({ imageData: JPEG, metadata, fileName: 'parcel-HR-1.png' });
            expect(res.status).toBe(200);
        }
    });

    it('rate-limits per IP', async () => {
        let last;
        for (let i = 0; i <= UPLOAD_RATE_MAX; i++) {
            last = await request(app).post(path).set('X-Forwarded-For', '203.0.113.50').send({ imageData: 'broken', metadata: parcelMetadata() });
        }
        expect(last.status).toBe(429);
        // a forged CF header does not buy a fresh bucket; a different real address does
        const forged = await request(app).post(path).set('X-Forwarded-For', '203.0.113.50').set('cf-connecting-ip', '198.51.100.7').send({ imageData: 'broken', metadata: parcelMetadata() });
        expect(forged.status).toBe(429);
        const other = await request(app).post(path).set('X-Forwarded-For', '203.0.113.51').send({ imageData: 'broken', metadata: parcelMetadata() });
        expect(other.status).toBe(400);
    });
});

describe('ipfs relay pins the sniffed type, not the declared one', () => {
    it('names and types the pinned file from the bytes', async () => {
        process.env.PINATA_API_KEY = 'k';
        process.env.PINATA_API_SECRET = 's';
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ IpfsHash: 'h' }) }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await request(createRouteApp(setupIpfsRoute)).post('/ipfs/upload')
            .send({ imageData: JPEG.replace('image/jpeg', 'text/html'), metadata: parcelMetadata(), fileName: 'evil.html' });
        expect(res.status).toBe(200);
        const file = fetchMock.mock.calls[0][1].body.get('file');
        expect(file.type).toBe('image/jpeg');
        expect(file.name).toBe('evil.jpg');
    });
});

describe('validateNftMetadata', () => {
    it('requires a name and bounded attributes', () => {
        expect(validateNftMetadata({})).toMatch(/name/);
        expect(validateNftMetadata({ name: 'a', attributes: [{ trait_type: 'x', value: { nested: 1 } }] })).toMatch(/value/);
        expect(validateNftMetadata({ name: 'a', external_url: 'javascript:alert(1)' })).toMatch(/external_url/);
        expect(validateNftMetadata({ name: 'a', description: 'x'.repeat(10001) })).toMatch(/description/);
        expect(validateNftMetadata({ name: 'a', properties: { blob: 'x'.repeat(1024 * 1024) } })).toMatch(/too large/);
        expect(validateNftMetadata(parcelMetadata())).toBeNull();
    });
});
