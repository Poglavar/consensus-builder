// Uploads stored on the API host's disk are rate limited per IP and per route, and refused once the disk is near full.
import fs from 'fs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFileStorageRoutes } from '../routes/file-storage.js';
import { setupAssetsRoute } from '../routes/assets.js';
import { createUploadRateLimiter, requireUploadDiskHeadroom } from '../utils/nft-asset-upload.js';
import { createRouteApp } from './helpers/create-route-app.js';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;
const metadata = { name: 'Parcel 1', description: 'd' };
const roomy = () => ({ bavail: 1e9, bsize: 4096 });
const full = () => ({ bavail: 10, bsize: 4096 });

afterEach(() => vi.restoreAllMocks());

const routes = [
    ['/models', setupFileStorageRoutes, { fileName: 'a.glb', modelData: 'data:model/gltf-binary;base64,Z2xURgIAAAA=' }],
    ['/images', setupFileStorageRoutes, { fileName: 'a', imageData: PNG_DATA_URL }],
    ['/metadata', setupFileStorageRoutes, { fileName: 'a', metadata }],
    ['/assets/upload', setupAssetsRoute, { fileName: 'a', imageData: PNG_DATA_URL, metadata }]
];

describe('upload budget per route', () => {
    for (const [route, setup, body] of routes) {
        it(`${route} refuses the request after the per-IP limit`, async () => {
            vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
            const app = createRouteApp(app => setup(app, {
                uploadRateLimiter: createUploadRateLimiter({ limit: 1 }),
                diskHeadroom: requireUploadDiskHeadroom('/', { statfs: roomy })
            }));
            const first = await request(app).post(route).send(body);
            expect(first.status).not.toBe(429);
            const second = await request(app).post(route).send(body);
            expect(second.status).toBe(429);
            expect(second.body.code).toBe('upload-rate-limited');
        });

        it(`${route} refuses with 507 and writes nothing when the disk is below the floor`, async () => {
            const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const app = createRouteApp(app => setup(app, {
                diskHeadroom: requireUploadDiskHeadroom('/', { statfs: full, minFreeBytes: 1024 ** 3 })
            }));
            const res = await request(app).post(route).send(body);
            expect(res.status).toBe(507);
            expect(res.body.code).toBe('upload-disk-full');
            expect(write).not.toHaveBeenCalled();
        });
    }
});
