import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupAssetsRoute } from '../routes/assets.js';
import { createRouteApp } from './helpers/create-route-app.js';

let app;
// A real PNG signature + IHDR start: uploads are sniffed, so the old 'hello' payload is refused now.
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;
let writeFileSpy;

beforeEach(() => {
    app = createRouteApp(setupAssetsRoute);
    writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('POST /assets/upload', () => {
    it('rejects non-object request bodies', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({});
    });

    it('rejects missing imageData', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({ metadata: { title: 'Missing image' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData is required.' });
    });

    it('rejects invalid data urls', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: 'not-a-data-url',
                metadata: { title: 'Broken asset' }
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData must be a base64 data URL.' });
    });

    it('rejects missing metadata objects', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: PNG_DATA_URL
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects non-object metadata payloads', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: PNG_DATA_URL,
                metadata: []
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: PNG_DATA_URL,
                metadata: { name: 'Proposal Asset' },
                injected: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('rejects invalid file names before writing files', async () => {
        const controlCharRes = await request(app)
            .post('/assets/upload')
            .send({
                fileName: 'bad\u0000name',
                imageData: PNG_DATA_URL,
                metadata: { name: 'Proposal Asset' }
            });

        expect(controlCharRes.status).toBe(400);
        expect(controlCharRes.body).toEqual({ error: 'fileName contains invalid control characters.' });

        const lengthRes = await request(app)
            .post('/assets/upload')
            .send({
                fileName: 'a'.repeat(256),
                imageData: PNG_DATA_URL,
                metadata: { name: 'Proposal Asset' }
            });

        expect(lengthRes.status).toBe(400);
        expect(lengthRes.body).toEqual({ error: 'fileName must be at most 255 characters.' });
    });

    it('rejects empty decoded image payloads', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: 'data:image/png;base64,!!!',
                metadata: { name: 'Broken asset' }
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Decoded image data is empty.' });
    });

    it('returns 500 when asset writes fail', async () => {
        writeFileSpy.mockImplementation(() => {
            throw new Error('disk full');
        });

        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: PNG_DATA_URL,
                metadata: { name: 'Broken asset' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to store uploaded assets.' });
    });

    it('stores image and metadata under one random base and returns upload urls', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                fileName: 'proposal-asset',
                imageData: PNG_DATA_URL,
                metadata: {
                    name: 'Proposal Asset',
                    properties: {
                        kind: 'proposal'
                    }
                }
            });

        expect(res.status).toBe(200);
        const [, base] = res.body.imageUrl.match(/^\/uploads\/images\/(proposal-asset-[0-9a-f]{12})\.png$/) || [];
        expect(base).toBeTruthy();
        expect(res.body).toEqual({
            imageUri: `/uploads/images/${base}.png`,
            imageUrl: `/uploads/images/${base}.png`,
            imageGatewayUrl: `/uploads/images/${base}.png`,
            uploadedImageUrl: `/uploads/images/${base}.png`,
            metadataUri: `/uploads/metadata/${base}.json`,
            metadataUrl: `/uploads/metadata/${base}.json`,
            metadataGatewayUrl: `/uploads/metadata/${base}.json`
        });

        expect(writeFileSpy).toHaveBeenCalledTimes(2);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve(`uploads/images/${base}.png`));
        expect(writeFileSpy.mock.calls[0][2]).toEqual({ flag: 'wx' });
        expect(writeFileSpy.mock.calls[1][0]).toBe(path.resolve(`uploads/metadata/${base}.json`));
        expect(writeFileSpy.mock.calls[1][2]).toEqual({ encoding: 'utf8', flag: 'wx' });
        const savedMetadata = JSON.parse(writeFileSpy.mock.calls[1][1]);
        expect(savedMetadata.image).toBe(`/uploads/images/${base}.png`);
        expect(savedMetadata.properties.uploadedImageUrl).toBe(`/uploads/images/${base}.png`);
        expect(savedMetadata.properties.kind).toBe('proposal');
    });

    it('sanitizes uploaded file names before writing files', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                fileName: '../../Escape Folder',
                imageData: PNG_DATA_URL,
                metadata: {
                    name: 'Proposal Asset'
                }
            });

        expect(res.status).toBe(200);
        expect(writeFileSpy.mock.calls[0][0]).toMatch(new RegExp(`^${path.resolve('uploads/images')}/escape-folder-[0-9a-f]{12}\\.png$`));
        expect(writeFileSpy.mock.calls[1][0]).toMatch(new RegExp(`^${path.resolve('uploads/metadata')}/escape-folder-[0-9a-f]{12}\\.json$`));
    });

    it('uses fallback names, preserves external_url, and ignores Host / forwarded protocol', async () => {
        app.enable('trust proxy');

        const res = await request(app)
            .post('/assets/upload')
            .set('host', 'example.test')
            .set('X-Forwarded-Proto', 'https')
            .send({
                fileName: '!!!',
                imageData: PNG_DATA_URL.replace('image/png', 'image'),
                metadata: {
                    name: 'Proposal Asset',
                    external_url: 'https://example.test/original'
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.imageUrl).toMatch(/^\/uploads\/images\/image-.*\.png$/);
        expect(res.body.metadataUrl).toMatch(/^\/uploads\/metadata\/image-.*\.json$/);

        const savedMetadata = JSON.parse(writeFileSpy.mock.calls[1][1]);
        expect(savedMetadata.image).toBe(res.body.imageUrl);
        expect(savedMetadata.image_url).toBe(savedMetadata.image);
        expect(savedMetadata.external_url).toBe('https://example.test/original');
        expect(savedMetadata.properties.uploadedImageUrl).toBe(savedMetadata.image);
    });

    it('drops non-object metadata.properties payloads when saving metadata', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .set('host', 'example.test')
            .send({
                fileName: 'proposal-asset',
                imageData: PNG_DATA_URL,
                metadata: {
                    name: 'Proposal Asset',
                    properties: []
                }
            });

        expect(res.status).toBe(200);

        const savedMetadata = JSON.parse(writeFileSpy.mock.calls[1][1]);
        expect(savedMetadata.properties).toEqual({
            uploadedImageUrl: res.body.imageUrl
        });
    });
});