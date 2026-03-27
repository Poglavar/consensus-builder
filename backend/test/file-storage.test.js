import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupFileStorageRoutes } from '../routes/file-storage.js';
import { createRouteApp } from './helpers/create-route-app.js';

let app;
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
                imageData: 'data:image/png;base64,aGVsbG8=',
                injected: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Request body contains unsupported fields.' });
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
                imageData: 'data:image/png;base64,aGVsbG8='
            });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'permission denied' });
    });

    it('stores a base64 data URL and returns the public image url', async () => {
        const res = await request(app)
            .post('/images')
            .set('host', 'example.test')
            .send({
                fileName: 'Test Image',
                imageData: 'data:image/png;base64,aGVsbG8='
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toBe('test-image.png');
        expect(res.body.imageUrl).toBe('http://example.test/images/test-image.png');
        expect(res.body.contentType).toBe('image/png');

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve('uploads/images/test-image.png'));
    });

    it('sanitizes invalid filenames and derives extensions from content subtypes', async () => {
        const res = await request(app)
            .post('/images')
            .set('host', 'example.test')
            .send({
                fileName: '!!!',
                imageData: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
            });

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^image-.*\.svg$/);
        expect(res.body.contentType).toBe('image/svg+xml');
        expect(res.body.imageUrl).toMatch(/^http:\/\/example\.test\/images\/image-.*\.svg$/);
        expect(writeFileSpy).toHaveBeenCalledTimes(1);
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
        expect(res.body.metadataUrl).toBe('http://example.test/metadata/road-meta.json');
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
        expect(res.body).toEqual({ error: 'disk full' });
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
        expect(res.body).toEqual({
            fileName: 'road-meta.json',
            metadataUrl: 'http://example.test/metadata/road-meta.json'
        });

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0][0]).toBe(path.resolve('uploads/metadata/road-meta.json'));
        expect(writeFileSpy.mock.calls[0][2]).toBe('utf8');
    });
});