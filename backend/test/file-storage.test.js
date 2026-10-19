import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupFileStorageRoutes } from '../routes/file-storage.js';
import { createRouteApp } from './helpers/create-route-app.js';

let app;
// A real PNG signature + IHDR start: uploads are sniffed, so the old 'hello' payload is refused now.
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;
let writeFileSpy;

beforeEach(() => {
    app = createRouteApp(setupFileStorageRoutes);
    writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('POST /images', () => {
    it('rejects non-object request bodies', async () => {
        const res = await request(app)
            .post('/images')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({});
    });

    it('rejects missing imageData', async () => {
        const res = await request(app).post('/images').send({ fileName: 'test-image' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData (base64 data URL) is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/images')
            .send({
                imageData: PNG_DATA_URL,
                injected: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('rejects filenames with control characters', async () => {
        const res = await request(app)
            .post('/images')
            .send({
                fileName: 'bad\u0000name',
                imageData: PNG_DATA_URL
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'fileName contains invalid control characters.' });
    });

    it('rejects invalid data urls', async () => {
        const res = await request(app)
            .post('/images')
            .send({
                imageData: 'not-a-data-url'
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'imageData must be a base64-encoded data URL.' });
    });

    it('rejects empty decoded image payloads', async () => {
        const res = await request(app)
            .post('/images')
            .send({
                imageData: 'data:image/png;base64,===='
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Decoded image data is empty.' });
    });

    it('returns 500 when image storage fails', async () => {
        writeFileSpy.mockImplementation(() => {
            throw new Error('permission denied');
        });

        const res = await request(app)
            .post('/images')
            .send({
                fileName: 'test-image',
                imageData: PNG_DATA_URL
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to store image.' });
    });

    it('stores a base64 data URL and returns the public image url', async () => {
        const res = await request(app)
            .post('/images')
            .set('host', 'example.test')
            .send({
                fileName: 'Test Image',
                imageData: PNG_DATA_URL
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^test-image-[0-9a-f]{12}\.png$/);
        // No public base is pinned in tests: the served path alone, never the request's Host.
        expect(res.body.imageUrl).toBe(`/images/${res.body.fileName}`);
        expect(res.body.contentType).toBe('image/png');

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve(`uploads/images/${res.body.fileName}`));
        expect(writeFileSpy.mock.calls[0][2]).toEqual({ flag: 'wx' });
    });

    it('uses a fallback name and ignores the declared mime and the request origin entirely', async () => {
        app.enable('trust proxy');

        const res = await request(app)
            .post('/images')
            .set('host', 'example.test')
            .set('X-Forwarded-Proto', 'https')
            .send({
                fileName: '!!!',
                // Declared as gif; the bytes are PNG, and the bytes decide.
                imageData: PNG_DATA_URL.replace('image/png', 'image/gif')
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^image-.*\.png$/);
        expect(res.body.contentType).toBe('image/png');
        // Host and forwarded protocol are client-controlled and were once baked into stored rows.
        expect(res.body.imageUrl).toBe(`/images/${res.body.fileName}`);
    });

    it('bakes in the pinned public base when one is configured', async () => {
        const previous = process.env.PUBLIC_API_BASE_URL;
        process.env.PUBLIC_API_BASE_URL = 'https://api.example.test/';
        try {
            const res = await request(app)
                .post('/images')
                .set('host', 'attacker.test')
                .send({ fileName: 'Pinned', imageData: PNG_DATA_URL });
            expect(res.status).toBe(200);
            expect(res.body.imageUrl).toMatch(/^https:\/\/api\.example\.test\/images\/pinned-[0-9a-f]{12}\.png$/);
        } finally {
            if (previous === undefined) delete process.env.PUBLIC_API_BASE_URL;
            else process.env.PUBLIC_API_BASE_URL = previous;
        }
    });
});

describe('POST /metadata', () => {
    it('rejects non-object request bodies', async () => {
        const res = await request(app)
            .post('/metadata')
            .set('Content-Type', 'application/json')
            .send('"invalid"');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({});
    });

    it('rejects missing metadata object', async () => {
        const res = await request(app).post('/metadata').send({ fileName: 'road-meta' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/metadata')
            .send({
                metadata: { title: 'Road Proposal' },
                injected: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('rejects filenames that exceed the configured limit', async () => {
        const res = await request(app)
            .post('/metadata')
            .send({
                fileName: 'a'.repeat(256),
                metadata: { title: 'Road Proposal' }
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'fileName must be at most 255 characters.' });
    });

    it('rejects invalid metadata json strings', async () => {
        const res = await request(app)
            .post('/metadata')
            .send({
                fileName: 'road-meta',
                metadata: '{bad json'
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata must be valid JSON when sent as a string.' });
    });

    it('rejects non-object metadata payloads', async () => {
        const res = await request(app)
            .post('/metadata')
            .send({
                fileName: 'road-meta',
                metadata: []
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'metadata object is required.' });
    });

    it('accepts metadata json strings when they decode to plain objects', async () => {
        const res = await request(app)
            .post('/metadata')
            .set('host', 'example.test')
            .send({
                fileName: 'road-meta',
                metadata: '{"title":"Road Proposal"}'
            });

        expect(res.status).toBe(200);
        expect(res.body.metadataUrl).toMatch(/^\/metadata\/road-meta-[0-9a-f]{12}\.json$/);
        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0][1]).toContain('"title": "Road Proposal"');
    });

    it('preserves json suffixes and returns 500 when metadata storage fails', async () => {
        writeFileSpy.mockImplementation(() => {
            throw new Error('disk full');
        });

        const res = await request(app)
            .post('/metadata')
            .send({
                fileName: 'road-meta.json',
                metadata: { title: 'Road Proposal' }
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to store metadata.' });
    });

    it('stores metadata and returns the public metadata url', async () => {
        const res = await request(app)
            .post('/metadata')
            .set('host', 'example.test')
            .send({
                fileName: 'Road Meta',
                metadata: { title: 'Road Proposal' }
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^road-meta-[0-9a-f]{12}\.json$/);
        expect(res.body.metadataUrl).toBe(`/metadata/${res.body.fileName}`);

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve(`uploads/metadata/${res.body.fileName}`));
        expect(writeFileSpy.mock.calls[0][2]).toEqual({ encoding: 'utf8', flag: 'wx' });
    });

    it('generates a fallback metadata filename when the provided name sanitizes to empty', async () => {
        const res = await request(app)
            .post('/metadata')
            .set('host', 'example.test')
            .send({
                fileName: '!!!',
                metadata: { title: 'Road Proposal' }
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^metadata-.*\.json$/);
        expect(res.body.metadataUrl).toMatch(/^\/metadata\/metadata-.*\.json$/);
        expect(writeFileSpy).toHaveBeenCalledTimes(1);
    });
});

describe('POST /models', () => {
    // "glTF" magic + version 2 + length: models are sniffed, so arbitrary bytes are refused now.
    const GLB_DATA_URL = `data:model/gltf-binary;base64,${Buffer.from('676c54460200000014000000', 'hex').toString('base64')}`;

    it('rejects missing modelData', async () => {
        const res = await request(app).post('/models').send({ fileName: 'building' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'modelData (base64 data URL) is required.' });
    });

    it('rejects unsupported fields', async () => {
        const res = await request(app)
            .post('/models')
            .send({ modelData: GLB_DATA_URL, injected: true });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
    });

    it('rejects invalid data urls', async () => {
        const res = await request(app).post('/models').send({ modelData: 'not-a-data-url' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'modelData must be a base64-encoded data URL.' });
    });

    it('rejects empty decoded model payloads', async () => {
        const res = await request(app)
            .post('/models')
            .send({ modelData: 'data:model/gltf-binary;base64,====' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Decoded model data is empty.' });
    });

    it('returns 500 when model storage fails', async () => {
        writeFileSpy.mockImplementation(() => {
            throw new Error('permission denied');
        });

        const res = await request(app)
            .post('/models')
            .send({ fileName: 'building.glb', modelData: GLB_DATA_URL });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to store model.' });
    });

    it('stores a glb data URL and returns the public model url under /uploads/models', async () => {
        const res = await request(app)
            .post('/models')
            .set('host', 'example.test')
            .send({ fileName: 'Test Building.glb', modelData: GLB_DATA_URL });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^test-building-glb-[0-9a-f]{12}\.glb$/);
        expect(res.body.modelUrl).toBe(`/uploads/models/${res.body.fileName}`);
        expect(res.body.contentType).toBe('model/gltf-binary');

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0][0]).toMatch(
            new RegExp(`${path.resolve('uploads/models')}/test-building-glb-[0-9a-f]{12}\\.glb$`)
        );
    });

    it('writes a .gltf file when the upload name ends in .gltf', async () => {
        const res = await request(app)
            .post('/models')
            .set('host', 'example.test')
            .send({
                fileName: 'house.gltf',
                modelData: `data:model/gltf+json;base64,${Buffer.from('{"asset":{"version":"2.0"}}').toString('base64')}`
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^house-gltf-[0-9a-f]{12}\.gltf$/);
        expect(res.body.contentType).toBe('model/gltf+json');
    });
});