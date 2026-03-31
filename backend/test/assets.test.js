import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupAssetsRoute } from '../routes/assets.js';
import { createRouteApp } from './helpers/create-route-app.js';

let app;
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
                imageData: 'data:image/png;base64,aGVsbG8='
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects non-object metadata payloads', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: []
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .send({
                imageData: 'data:image/png;base64,aGVsbG8=',
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
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Proposal Asset' }
            });

        expect(controlCharRes.status).toBe(400);
        expect(controlCharRes.body).toEqual({ error: 'fileName contains invalid control characters.' });

        const lengthRes = await request(app)
            .post('/assets/upload')
            .send({
                fileName: 'a'.repeat(256),
                imageData: 'data:image/png;base64,aGVsbG8=',
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
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: { name: 'Broken asset' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to store uploaded assets.' });
    });

    it('stores image and metadata and returns upload urls', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .set('host', 'example.test')
            .send({
                fileName: 'proposal-asset',
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: {
                    name: 'Proposal Asset',
                    properties: {
                        kind: 'proposal'
                    }
                }
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            imageUri: 'http://example.test/uploads/images/proposal-asset.png',
            imageUrl: 'http://example.test/uploads/images/proposal-asset.png',
            imageGatewayUrl: 'http://example.test/uploads/images/proposal-asset.png',
            uploadedImageUrl: 'http://example.test/uploads/images/proposal-asset.png',
            metadataUri: 'http://example.test/uploads/metadata/proposal-asset.json',
            metadataUrl: 'http://example.test/uploads/metadata/proposal-asset.json',
            metadataGatewayUrl: 'http://example.test/uploads/metadata/proposal-asset.json'
        });

        expect(writeFileSpy).toHaveBeenCalledTimes(2);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve('uploads/images/proposal-asset.png'));
        expect(writeFileSpy.mock.calls[1][0]).toBe(path.resolve('uploads/metadata/proposal-asset.json'));
        const savedMetadata = JSON.parse(writeFileSpy.mock.calls[1][1]);
        expect(savedMetadata.image).toBe('http://example.test/uploads/images/proposal-asset.png');
        expect(savedMetadata.properties.uploadedImageUrl).toBe('http://example.test/uploads/images/proposal-asset.png');
        expect(savedMetadata.properties.kind).toBe('proposal');
    });

    it('sanitizes uploaded file names before writing files', async () => {
        const res = await request(app)
            .post('/assets/upload')
            .set('host', 'example.test')
            .send({
                fileName: '../../Escape Folder',
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: {
                    name: 'Proposal Asset'
                }
            });

        expect(res.status).toBe(200);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve('uploads/images/escape-folder.png'));
        expect(writeFileSpy.mock.calls[1][0]).toBe(path.resolve('uploads/metadata/escape-folder.json'));
        expect(res.body.imageUrl).toBe('http://example.test/uploads/images/escape-folder.png');
        expect(res.body.metadataUrl).toBe('http://example.test/uploads/metadata/escape-folder.json');
    });

    it('uses fallback names, preserves external_url, and respects forwarded https protocol', async () => {
        app.enable('trust proxy');

        const res = await request(app)
            .post('/assets/upload')
            .set('host', 'example.test')
            .set('X-Forwarded-Proto', 'https')
            .send({
                fileName: '!!!',
                imageData: 'data:image;base64,aGVsbG8=',
                metadata: {
                    name: 'Proposal Asset',
                    external_url: 'https://example.test/original'
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.imageUrl).toMatch(/^https:\/\/example\.test\/uploads\/images\/road-proposal-.*\.png$/);
        expect(res.body.metadataUrl).toMatch(/^https:\/\/example\.test\/uploads\/metadata\/road-proposal-.*\.json$/);

        const savedMetadata = JSON.parse(writeFileSpy.mock.calls[1][1]);
        expect(savedMetadata.image).toMatch(/^https:\/\/example\.test\/uploads\/images\/road-proposal-.*\.png$/);
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
                imageData: 'data:image/png;base64,aGVsbG8=',
                metadata: {
                    name: 'Proposal Asset',
                    properties: []
                }
            });

        expect(res.status).toBe(200);

        const savedMetadata = JSON.parse(writeFileSpy.mock.calls[1][1]);
        expect(savedMetadata.properties).toEqual({
            uploadedImageUrl: 'http://example.test/uploads/images/proposal-asset.png'
        });
    });
});