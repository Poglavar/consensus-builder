import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupWalrusRoute } from '../routes/walrus.js';
import { createRouteApp } from './helpers/create-route-app.js';

let app;

beforeEach(() => {
    app = createRouteApp(setupWalrusRoute);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.WALRUS_PUBLISHER_URL;
    delete process.env.WALRUS_AGGREGATOR_URL;
    delete process.env.WALRUS_EPOCHS;
    delete process.env.WALRUS_PERMANENT;
    delete process.env.WALRUS_SEND_OBJECT_TO;
});

const newlyCreatedResponse = (blobId, objectId = '0xobj', endEpoch = 100, cost = 1000) => ({
    ok: true,
    json: async () => ({
        newlyCreated: {
            blobObject: { id: objectId, blobId, storage: { endEpoch } },
            cost
        }
    })
});

const alreadyCertifiedResponse = (blobId, endEpoch = 200) => ({
    ok: true,
    json: async () => ({
        alreadyCertified: { blobId, endEpoch, event: { txDigest: '0xtx' } }
    })
});

describe('POST /walrus/upload', () => {
    it('rejects non-object request bodies', async () => {
        const res = await request(app)
            .post('/walrus/upload')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({});
    });

    it('rejects missing imageData', async () => {
        const res = await request(app)
            .post('/walrus/upload')
            .send({ metadata: { name: 'No image' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData is required.' });
    });

    it('rejects invalid data urls', async () => {
        const res = await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'broken', metadata: { name: 'Broken asset' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData must be a base64 data URL.' });
    });

    it('rejects missing metadata objects', async () => {
        const res = await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'data:image/png;base64,aGVsbG8=' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/walrus/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Parcel NFT' },
                injected: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('rejects empty decoded image payloads', async () => {
        const res = await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'data:image/png;base64,!!!', metadata: { name: 'Empty image' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Decoded image data is empty.' });
    });

    it('returns 500 when the publisher rejects the upload', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            text: async () => 'publisher unavailable'
        }));

        const res = await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'data:image/png;base64,aGVsbG8=', metadata: { name: 'Parcel NFT' } });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to upload assets to Walrus.' });
    });

    it('returns 500 when the publisher response has no blobId', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

        const res = await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'data:image/png;base64,aGVsbG8=', metadata: { name: 'Parcel NFT' } });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to upload assets to Walrus.' });
    });

    it('uploads image and metadata and returns walrus urls (newlyCreated)', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(newlyCreatedResponse('imageBlob', '0ximg', 50, 10))
            .mockResolvedValueOnce(newlyCreatedResponse('metaBlob', '0xmeta', 50, 20));
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/walrus/upload')
            .send({
                fileName: 'parcel.png',
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Parcel NFT' }
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            imageUri: 'walrus://imageBlob',
            imageGatewayUrl: 'https://aggregator.walrus-testnet.walrus.space/v1/blobs/imageBlob',
            metadataUri: 'walrus://metaBlob',
            metadataGatewayUrl: 'https://aggregator.walrus-testnet.walrus.space/v1/blobs/metaBlob',
            storage: 'walrus',
            suiObjectId: '0xmeta',
            endEpoch: 50,
            cost: 20
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // First call stores the image bytes via PUT to the publisher with an epochs param.
        const [imageUrl, imageOptions] = fetchMock.mock.calls[0];
        expect(imageUrl).toBe('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=5');
        expect(imageOptions.method).toBe('PUT');
    });

    it('handles alreadyCertified responses (content dedup)', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(alreadyCertifiedResponse('imageBlob'))
            .mockResolvedValueOnce(alreadyCertifiedResponse('metaBlob', 200));
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'data:image/png;base64,aGVsbG8=', metadata: { name: 'Parcel NFT' } });

        expect(res.status).toBe(200);
        expect(res.body.metadataUri).toBe('walrus://metaBlob');
        expect(res.body.suiObjectId).toBeNull();
        expect(res.body.endEpoch).toBe(200);
        expect(res.body.cost).toBeNull();
    });

    it('enriches metadata with image links and preserves an existing external url', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(newlyCreatedResponse('imageBlob'))
            .mockResolvedValueOnce(newlyCreatedResponse('metaBlob'));
        vi.stubGlobal('fetch', fetchMock);

        await request(app)
            .post('/walrus/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Parcel NFT', external_url: 'https://example.com/parcels/1' }
            });

        const metadataBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(metadataBody).toMatchObject({
            name: 'Parcel NFT',
            image: 'walrus://imageBlob',
            image_url: 'https://aggregator.walrus-testnet.walrus.space/v1/blobs/imageBlob',
            external_url: 'https://example.com/parcels/1'
        });
    });

    it('honors WALRUS_PERMANENT and send_object_to config', async () => {
        process.env.WALRUS_PERMANENT = 'true';
        process.env.WALRUS_SEND_OBJECT_TO = '0xowner';
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(newlyCreatedResponse('imageBlob'))
            .mockResolvedValueOnce(newlyCreatedResponse('metaBlob'));
        vi.stubGlobal('fetch', fetchMock);

        await request(app)
            .post('/walrus/upload')
            .send({ imageData: 'data:image/png;base64,aGVsbG8=', metadata: { name: 'Parcel NFT' } });

        const [imageUrl] = fetchMock.mock.calls[0];
        expect(imageUrl).toContain('permanent=true');
        expect(imageUrl).toContain('send_object_to=0xowner');
        expect(imageUrl).not.toContain('epochs=');
    });
});
