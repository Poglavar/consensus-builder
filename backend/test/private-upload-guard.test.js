import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { privateUploadGuard } from '../utils/private-upload-guard.js';

describe('private uploads are never public static files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'private-upload-test-'));
    mkdirSync(join(directory, 'mcp-drafts', 'shared-plans'), { recursive: true });
    writeFileSync(join(directory, 'mcp-drafts', 'shared-plans', 'session.json'), '{"ownerToken":"private-test-value"}');
    writeFileSync(join(directory, 'public-model.glb'), 'public-model');
    const app = express(); app.use('/uploads', privateUploadGuard, express.static(directory));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    it.each(['/uploads/MCP-DRAFTS/shared-plans/session.json', '/uploads/mcp-drafts/shared-plans/session.json', '/uploads/%6dcp-drafts/shared-plans/session.json', '/uploads/mcp-drafts%2fshared-plans%2fsession.json', '/uploads/a/%2e%2e/mcp-drafts/shared-plans/session.json'])('blocks %s', async url => {
        const result = await request(app).get(url);
        expect(result.status).toBe(404); expect(result.text).not.toContain('private-test-value');
    });
    it('continues serving ordinary uploads', async () => {
        expect((await request(app).get('/uploads/public-model.glb')).status).toBe(200);
    });
});
