// Tests for the thumbnail tile source (on-disk cache + global fetch cap) and the background render
// queue. Offline: the network fetch is injected, the cache lives in a temp dir.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTileSource, createLimiter } from '../thumbnails/tile-source.js';
import { createThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { computeStitchFrame, MAX_TILES } from '../thumbnails/tile-stitch.js';

const TEMPLATE = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

let cacheDir;
beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-cache-test-'));
});
afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
});

const tile = (z, x, y) => ({ template: TEMPLATE, z, x, y, url: `https://a.example/${z}/${x}/${y}.png` });

describe('tile cache', () => {
    it('serves a cached tile without touching the network', async () => {
        const fetchBytes = vi.fn(async () => PNG);
        const source = createTileSource({ cacheDir, fetchBytes });
        const file = source.entryPath(TEMPLATE, 19, 1, 2);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, PNG);

        const bytes = await source.getTileBytes(tile(19, 1, 2));

        expect(bytes.equals(PNG)).toBe(true);
        expect(fetchBytes).not.toHaveBeenCalled();
        expect(source.stats.hits).toBe(1);
    });

    it('fetches a miss once, stores it, and serves the next request from disk', async () => {
        const fetchBytes = vi.fn(async () => PNG);
        const source = createTileSource({ cacheDir, fetchBytes });

        await source.getTileBytes(tile(19, 5, 6));
        await source.getTileBytes(tile(19, 5, 6));

        expect(fetchBytes).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(source.entryPath(TEMPLATE, 19, 5, 6))).toBe(true);
    });

    it('shares one entry across subdomains (keyed by template, not expanded url)', async () => {
        const fetchBytes = vi.fn(async () => PNG);
        const source = createTileSource({ cacheDir, fetchBytes });
        await source.getTileBytes({ ...tile(19, 5, 6), url: 'https://a.x/19/5/6.png' });
        await source.getTileBytes({ ...tile(19, 5, 6), url: 'https://b.x/19/5/6.png' });
        expect(fetchBytes).toHaveBeenCalledTimes(1);
    });

    it('refetches after the TTL, and serves the stale tile when the refetch fails', async () => {
        let clock = Date.now();
        const fetchBytes = vi.fn(async () => PNG);
        const source = createTileSource({ cacheDir, fetchBytes, ttlMs: 1000, now: () => clock });
        await source.getTileBytes(tile(19, 7, 8));
        clock += 5000;
        fetchBytes.mockRejectedValueOnce(new Error('HTTP 503'));

        const bytes = await source.getTileBytes(tile(19, 7, 8));

        expect(fetchBytes).toHaveBeenCalledTimes(2);
        expect(bytes.equals(PNG)).toBe(true);
        expect(source.stats.stale).toBe(1);
    });

    it('prunes the cache down under its byte budget, oldest first', async () => {
        const fetchBytes = vi.fn(async () => Buffer.alloc(1000, 1));
        const source = createTileSource({ cacheDir, fetchBytes, maxBytes: 3000 });
        for (let i = 0; i < 6; i++) await source.getTileBytes(tile(19, i, 0));
        const oldest = source.entryPath(TEMPLATE, 19, 0, 0);
        const newest = source.entryPath(TEMPLATE, 19, 5, 0);
        fs.utimesSync(oldest, new Date(Date.now() - 60000), new Date(Date.now() - 60000));

        const { totalBytes } = await source.prune();

        expect(totalBytes).toBeLessThanOrEqual(3000);
        expect(fs.existsSync(oldest)).toBe(false);
        expect(fs.existsSync(newest)).toBe(true);
    });
});

describe('tile fetch concurrency cap', () => {
    it('never has more network fetches in flight than the cap, however many tiles are asked for', async () => {
        let inFlight = 0;
        let peak = 0;
        const gates = [];
        const fetchBytes = vi.fn(() => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            const gate = deferred();
            gates.push(gate);
            return gate.promise.finally(() => { inFlight--; });
        });
        const source = createTileSource({ cacheDir, fetchBytes, concurrency: 3 });

        const all = Promise.all(Array.from({ length: 12 }, (_, i) => source.getTileBytes(tile(19, i, 1))));
        // Release fetches one at a time; each release lets exactly one queued fetch start.
        for (let served = 0; served < 12; served++) {
            await vi.waitFor(() => expect(gates.length).toBeGreaterThan(served));
            expect(inFlight).toBeLessThanOrEqual(3);
            gates[served].resolve(PNG);
        }
        await all;

        expect(fetchBytes).toHaveBeenCalledTimes(12);
        expect(peak).toBe(3);
    });

    it('limiter frees its slot when the task throws', async () => {
        const limiter = createLimiter(1);
        await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
        expect(limiter.active).toBe(0);
    });
});

describe('per-thumbnail tile cap', () => {
    it('lowers the zoom for a district-sized proposal instead of fetching more than MAX_TILES', () => {
        const wide = [[[15.90, 45.75], [16.05, 45.75], [16.05, 45.85], [15.90, 45.85], [15.90, 45.75]]];
        const frame = computeStitchFrame({ polygon: wide, polygonOrder: 'lnglat', padding: 0.05, zoom: 19 });
        expect(MAX_TILES).toBe(36);
        expect(frame.tilesX * frame.tilesY).toBeLessThanOrEqual(MAX_TILES);
        expect(frame.zoom).toBeLessThan(14);
    });
});

describe('thumbnail queue', () => {
    it('runs at most `concurrency` renders at once and writes each result into a NULL screenshot_url', async () => {
        const gates = [];
        let running = 0;
        let peak = 0;
        const render = vi.fn(() => {
            running++;
            peak = Math.max(peak, running);
            const gate = deferred();
            gates.push(gate);
            return gate.promise.finally(() => { running--; });
        });
        const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const queue = createThumbnailQueue({ concurrency: 2, render });

        for (let id = 1; id <= 5; id++) queue.enqueue({ pool, proposal: {}, city: 'zagreb', proposalId: id, baseUrl: '' });
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
        expect(running).toBe(2);
        for (let done = 0; done < 5; done++) {
            await vi.waitFor(() => expect(gates.length).toBeGreaterThan(done));
            expect(running).toBeLessThanOrEqual(2);
            gates[done].resolve({ url: `/uploads/images/t-${done}.png`, frame: {}, tiles: {}, bytes: 1 });
        }
        await queue.onIdle();
        log.mockRestore();

        expect(peak).toBe(2);
        expect(pool.query).toHaveBeenCalledTimes(5);
        expect(pool.query.mock.calls[0][0]).toMatch(/SET screenshot_url = \$1 WHERE id = \$2 AND screenshot_url IS NULL/);
    });

    it('sheds jobs beyond maxQueued (the backfill picks them up) and never throws a render failure', async () => {
        const render = vi.fn(async () => { throw new Error('all tiles failed'); });
        const pool = { query: vi.fn() };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const queue = createThumbnailQueue({ concurrency: 1, maxQueued: 2, render });

        const a = queue.enqueue({ pool, proposal: {}, proposalId: 1 });
        const b = queue.enqueue({ pool, proposal: {}, proposalId: 2 });
        const c = queue.enqueue({ pool, proposal: {}, proposalId: 3 });

        expect(c).toBeNull();
        await expect(a).resolves.toBeNull();
        await expect(b).resolves.toBeNull();
        expect(pool.query).not.toHaveBeenCalled();
        error.mockRestore();
        warn.mockRestore();
    });
});
