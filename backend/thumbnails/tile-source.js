// Where server-side thumbnails get their basemap tiles: an on-disk cache in front of the tile
// provider, plus a process-wide cap on concurrent network fetches. Every proposal upload renders a
// thumbnail from up to MAX_TILES tiles; without a cache and a cap, a burst of uploads is a burst of
// hundreds of requests at a third-party CDN (Carto), which is how a server gets its IP banned.
//
// Cache layout: <dir>/<style>/<z>/<x>/<y>.png, where <style> is a short hash of the URL TEMPLATE
// (so the a/b/c subdomains share one entry). Entries older than the TTL are refetched; if that
// refetch fails the stale bytes are still served. The directory is bounded: every PRUNE_EVERY
// writes it is walked, expired files are deleted and the oldest go until it is under maxBytes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // 30 days
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;          // 512 MB
const DEFAULT_CONCURRENCY = 4;                        // network fetches in flight, process-wide
const DEFAULT_TIMEOUT_MS = 8000;
const PRUNE_EVERY = 200;                              // writes between size checks

const ts = () => new Date().toISOString();

// A counting semaphore. `run(fn)` waits for a slot, runs fn, frees the slot however fn ends.
export function createLimiter(max) {
    const limit = Math.max(1, Math.floor(max) || 1);
    let active = 0;
    const waiting = [];
    const release = () => {
        active--;
        const next = waiting.shift();
        if (next) next();
    };
    return {
        get active() { return active; },
        get pending() { return waiting.length; },
        async run(fn) {
            if (active >= limit) await new Promise(resolve => waiting.push(resolve));
            active++;
            try {
                return await fn();
            } finally {
                release();
            }
        }
    };
}

export function tileStyleKey(template) {
    return createHash('sha1').update(String(template)).digest('hex').slice(0, 12);
}

async function defaultFetchBytes(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'consensus-builder-thumbnailer' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {Object} [options]
 * @param {string} [options.cacheDir]   - defaults to THUMBNAIL_TILE_CACHE_DIR or <tmp>/ugt-thumbnail-tiles
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.concurrency] - max network fetches in flight
 * @param {Function} [options.fetchBytes] - (url, timeoutMs) => Promise<Buffer>; injectable for tests
 * @param {Function} [options.now]
 */
export function createTileSource(options = {}) {
    const {
        cacheDir = process.env.THUMBNAIL_TILE_CACHE_DIR || path.join(os.tmpdir(), 'ugt-thumbnail-tiles'),
        ttlMs = DEFAULT_TTL_MS,
        maxBytes = DEFAULT_MAX_BYTES,
        concurrency = Number(process.env.THUMBNAIL_TILE_CONCURRENCY) || DEFAULT_CONCURRENCY,
        fetchBytes = defaultFetchBytes,
        now = () => Date.now()
    } = options;

    const limiter = createLimiter(concurrency);
    const inFlight = new Map(); // cache path → Promise<Buffer>, so two renders never fetch one tile twice
    const stats = { hits: 0, misses: 0, stale: 0, fetched: 0, failed: 0 };
    let writesSincePrune = 0;
    let pruning = null;

    const entryPath = (template, z, x, y) =>
        path.join(cacheDir, tileStyleKey(template), String(z), String(x), `${y}.png`);

    async function readEntry(file) {
        try {
            const stat = await fs.stat(file);
            const bytes = await fs.readFile(file);
            return { bytes, fresh: now() - stat.mtimeMs < ttlMs };
        } catch {
            return null;
        }
    }

    async function writeEntry(file, bytes) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        // Write-then-rename: a reader never sees a half-written tile, even across a crash.
        const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, file);
        if (++writesSincePrune >= PRUNE_EVERY) {
            writesSincePrune = 0;
            prune().catch(err => console.warn(`[${ts()}] [tile-cache] prune failed: ${err.message}`));
        }
    }

    async function listFiles(dir, out = []) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await listFiles(full, out);
            else if (entry.isFile()) {
                try {
                    const stat = await fs.stat(full);
                    out.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
                } catch { /* raced with another delete */ }
            }
        }
        return out;
    }

    // Delete expired entries, then the oldest until the cache is under 90% of maxBytes.
    function prune() {
        if (pruning) return pruning;
        pruning = (async () => {
            const files = await listFiles(cacheDir);
            let total = 0;
            const live = [];
            let removed = 0;
            for (const entry of files) {
                if (now() - entry.mtimeMs >= ttlMs || entry.file.endsWith('.tmp')) {
                    await fs.rm(entry.file, { force: true });
                    removed++;
                } else {
                    live.push(entry);
                    total += entry.size;
                }
            }
            if (total > maxBytes) {
                live.sort((a, b) => a.mtimeMs - b.mtimeMs);
                const target = maxBytes * 0.9;
                for (const entry of live) {
                    if (total <= target) break;
                    await fs.rm(entry.file, { force: true });
                    total -= entry.size;
                    removed++;
                }
            }
            if (removed) console.log(`[${ts()}] [tile-cache] pruned ${removed} tile(s); ${(total / 1048576).toFixed(1)} MB kept in ${cacheDir}`);
            return { removed, totalBytes: total };
        })().finally(() => { pruning = null; });
        return pruning;
    }

    /**
     * Tile bytes for (template, z, x, y). `url` is the expanded URL to fetch on a miss.
     */
    async function getTileBytes({ template, z, x, y, url, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        const file = entryPath(template, z, x, y);
        const cached = await readEntry(file);
        if (cached && cached.fresh) {
            stats.hits++;
            return cached.bytes;
        }
        if (inFlight.has(file)) return inFlight.get(file);

        const job = limiter.run(() => fetchBytes(url, timeoutMs))
            .then(async bytes => {
                stats.fetched++;
                try {
                    await writeEntry(file, bytes);
                } catch (err) {
                    console.warn(`[${ts()}] [tile-cache] could not store ${z}/${x}/${y}: ${err.message}`);
                }
                return bytes;
            })
            .catch(err => {
                if (cached) {
                    stats.stale++;
                    return cached.bytes; // an old tile beats a grey square
                }
                stats.failed++;
                throw err;
            })
            .finally(() => inFlight.delete(file));
        stats.misses++;
        inFlight.set(file, job);
        return job;
    }

    return { getTileBytes, prune, limiter, stats, cacheDir, entryPath };
}

let defaultSource = null;
export function defaultTileSource() {
    if (!defaultSource) defaultSource = createTileSource();
    return defaultSource;
}
