// Security regression tests for user uploads (audit 2026-09): the stored type/extension comes from
// the real bytes (no .html/.svg/.js on our origin), names are unguessable and never overwritten,
// persisted URLs ignore a spoofed Host, and uploads are served with nosniff / as downloads.
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { setupFileStorageRoutes } from '../routes/file-storage.js';
import { uploadStaticHeaders } from '../utils/upload-static-headers.js';
import { createRouteApp } from './helpers/create-route-app.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const b64 = (text) => Buffer.from(text).toString('base64');
const HOSTILE = [
    ['html', `data:text/html;base64,${b64('<html><script>alert(document.cookie)</script></html>')}`],
    ['svg', `data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`],
    ['js', `data:application/javascript;base64,${b64('fetch("/x?c="+document.cookie);//padding')}`],
    // Lying about the type does not help either: the bytes are HTML.
    ['html declared as png', `data:image/png;base64,${b64('<!doctype html><script>alert(1)</script>')}`]
];

// Real files written by the non-mocked collision tests, removed afterwards.
const created = [];
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
    for (const file of created) fs.rmSync(file, { force: true });
});

describe('POST /images refuses anything that is not a real image', () => {
    const app = createRouteApp(setupFileStorageRoutes);

    for (const [label, dataUrl] of HOSTILE) {
        it(`refuses ${label}`, async () => {
            const write = vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
            const res = await request(app).post('/images').send({ fileName: 'x', imageData: dataUrl });
            expect(res.status).toBe(400);
            expect(write).not.toHaveBeenCalled();
        });
    }

    it('accepts a png and chooses the extension server-side', async () => {
        const write = vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
        const res = await request(app)
            .post('/images')
            .send({ fileName: 'evil.html', imageData: PNG_DATA_URL.replace('image/png', 'text/html') });
        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^evil-html-[0-9a-f]{12}\.png$/);
        expect(res.body.contentType).toBe('image/png');
        expect(write.mock.calls[0][0]).toMatch(/\.png$/);
    });
});

describe('POST /models refuses anything that is not glTF', () => {
    const app = createRouteApp(setupFileStorageRoutes);

    for (const [label, dataUrl] of HOSTILE) {
        it(`refuses ${label}`, async () => {
            const write = vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
            const res = await request(app)
                .post('/models')
                .send({ fileName: 'house.glb', modelData: dataUrl.replace(/^data:[^;]+/, 'data:model/gltf-binary') });
            expect(res.status).toBe(400);
            expect(write).not.toHaveBeenCalled();
        });
    }

    it('echoes the sniffed content type, not the declared one', async () => {
        vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
        const glb = Buffer.from('676c54460200000014000000', 'hex').toString('base64');
        const res = await request(app)
            .post('/models')
            .send({ fileName: 'house.gltf', modelData: `data:text/html;base64,${glb}` });
        expect(res.status).toBe(200);
        expect(res.body.contentType).toBe('model/gltf-binary');
        expect(res.body.fileName).toMatch(/\.glb$/);
    });
});

describe('client-supplied names never overwrite an existing file', () => {
    // Real disk writes: the point is what ends up on disk, not which call was made.
    const storageApp = createRouteApp(setupFileStorageRoutes);
    const track = (servedUrl, dir) => {
        const file = path.resolve('uploads', dir, path.basename(servedUrl));
        created.push(file);
        return file;
    };

    it('POST /images with the same fileName twice keeps both files', async () => {
        const second = Buffer.concat([PNG_BYTES, Buffer.from('second')]);
        const a = await request(storageApp).post('/images').send({ fileName: 'proposal-thumb-7-1', imageData: PNG_DATA_URL });
        const b = await request(storageApp)
            .post('/images')
            .send({ fileName: 'proposal-thumb-7-1', imageData: `data:image/png;base64,${second.toString('base64')}` });
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(b.body.fileName).not.toBe(a.body.fileName);
        expect(fs.readFileSync(track(a.body.imageUrl, 'images'))).toEqual(PNG_BYTES);
        expect(fs.readFileSync(track(b.body.imageUrl, 'images'))).toEqual(second);
    });
});

describe('persisted asset URLs ignore a spoofed Host', () => {
    it('uses the pinned public base, never the request Host', async () => {
        const write = vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
        const previous = process.env.PUBLIC_API_BASE_URL;
        process.env.PUBLIC_API_BASE_URL = 'https://api.example.test';
        try {
            const app = createRouteApp(setupFileStorageRoutes);
            const res = await request(app)
                .post('/images')
                .set('host', 'attacker.test')
                .send({ fileName: 'road', imageData: PNG_DATA_URL });
            expect(res.status).toBe(200);
            expect(res.body.imageUrl).toMatch(/^https:\/\/api\.example\.test\//);
            expect(res.body.imageUrl).not.toContain('attacker.test');
            expect(write).toHaveBeenCalled();
        } finally {
            if (previous === undefined) delete process.env.PUBLIC_API_BASE_URL;
            else process.env.PUBLIC_API_BASE_URL = previous;
        }
    });
});

describe('serving uploads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-uploads-'));
    fs.writeFileSync(path.join(dir, 'legacy.png'), PNG_BYTES);
    fs.writeFileSync(path.join(dir, 'meta.json'), '{"a":1}');
    fs.writeFileSync(path.join(dir, 'evil.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(dir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(dir, 'evil.js'), 'alert(1)');
    const app = express();
    app.use('/images', uploadStaticHeaders, express.static(dir));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('serves existing images and metadata inline with nosniff', async () => {
        const png = await request(app).get('/images/legacy.png');
        expect(png.status).toBe(200);
        expect(png.headers['content-type']).toBe('image/png');
        expect(png.headers['x-content-type-options']).toBe('nosniff');
        expect(png.headers['content-disposition']).toBeUndefined();

        const json = await request(app).get('/images/meta.json');
        expect(json.headers['content-type']).toMatch(/^application\/json/);
        expect(json.headers['content-disposition']).toBeUndefined();
    });

    for (const name of ['evil.html', 'evil.svg', 'evil.js']) {
        it(`serves ${name} only as an opaque download`, async () => {
            const res = await request(app).get(`/images/${name}`);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('application/octet-stream');
            expect(res.headers['content-disposition']).toBe('attachment');
            expect(res.headers['x-content-type-options']).toBe('nosniff');
        });
    }
});
