import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupIpfsRoute } from '../routes/ipfs.js';
import { createRouteApp } from './helpers/create-route-app.js';

let app;
const originalApiKey = process.env.PINATA_API_KEY;
const originalApiSecret = process.env.PINATA_API_SECRET;

beforeEach(() => {
    app = createRouteApp(setupIpfsRoute);
    process.env.PINATA_API_KEY = 'test-key';
    process.env.PINATA_API_SECRET = 'test-secret';
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.PINATA_API_KEY = originalApiKey;
    process.env.PINATA_API_SECRET = originalApiSecret;
});

describe('POST /ipfs/upload', () => {
    it('rejects non-object request bodies', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({});
    });

    it('rejects missing imageData', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .send({ metadata: { name: 'No image' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData is required.' });
    });

    it('rejects invalid data urls', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'broken',
                metadata: { name: 'Broken asset' }
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData must be a base64 data URL.' });
    });

    it('rejects missing metadata objects', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .send({ imageData: 'data:image/png;base64,aGVsbG8=' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects non-object metadata payloads', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: []
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal NFT' },
                injected: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('rejects empty decoded image payloads', async () => {
        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,!!!',
                metadata: { name: 'Empty image' }
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Decoded image data is empty.' });
    });

    it('returns 500 when Pinata credentials are missing', async () => {
        delete process.env.PINATA_API_KEY;
        delete process.env.PINATA_API_SECRET;

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal NFT' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to upload assets to IPFS.'
        });
    });

    it('returns 500 when image upload to Pinata fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            text: async () => 'gateway down'
        }));

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal NFT' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to upload assets to IPFS.'
        });
    });

    it('returns 500 when image upload response has no hash', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({})
        }));

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal NFT' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to upload assets to IPFS.'
        });
    });

    it('returns 500 when metadata upload to Pinata fails', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ IpfsHash: 'imageHash' })
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 503,
                text: async () => 'metadata unavailable'
            });
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal NFT' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to upload assets to IPFS.'
        });
    });

    it('returns 500 when metadata upload response has no hash', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ IpfsHash: 'imageHash' })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({})
            });
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal NFT' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: 'Failed to upload assets to IPFS.'
        });
    });

    it('uploads image and metadata to Pinata and returns ipfs urls', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ IpfsHash: 'imageHash' })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ IpfsHash: 'metadataHash' })
            });
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                fileName: 'proposal.png',
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: {
                    name: 'Proposal NFT'
                }
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            imageUri: 'ipfs://imageHash',
            imageGatewayUrl: 'https://gateway.pinata.cloud/ipfs/imageHash',
            metadataUri: 'ipfs://metadataHash',
            metadataGatewayUrl: 'https://gateway.pinata.cloud/ipfs/metadataHash'
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('enriches metadata with image links and preserves an existing external url', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ IpfsHash: 'imageHash' })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ IpfsHash: 'metadataHash' })
            });
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/ipfs/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: {
                    name: 'Proposal NFT',
                    external_url: 'https://example.com/proposals/1'
                }
            });

        expect(res.status).toBe(200);

        const secondCall = fetchMock.mock.calls[1];
        expect(secondCall[0]).toBe('https://api.pinata.cloud/pinning/pinJSONToIPFS');
        const metadataBody = JSON.parse(secondCall[1].body);
        expect(metadataBody.pinataMetadata.name).toBe('Proposal NFT-metadata.json');
        expect(metadataBody.pinataContent).toMatchObject({
            name: 'Proposal NFT',
            image: 'ipfs://imageHash',
            image_url: 'https://gateway.pinata.cloud/ipfs/imageHash',
            external_url: 'https://example.com/proposals/1'
        });
    });
});