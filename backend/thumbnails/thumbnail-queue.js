// Background queue for server-side proposal thumbnails. POST /proposals answers as soon as the row
// is written and hands the render to this queue, so an upload never waits on (or fails because of)
// a third-party tile CDN. Renders run a few at a time; tiles inside a render are capped and cached
// by thumbnails/tile-source.js.
//
// Restart-safety: the queue is in memory only. A thumbnail that was queued when the process died,
// that failed, or that was shed because the queue was full simply leaves screenshot_url NULL, and
// scripts/backfill-proposal-thumbnails.mjs (idempotent, only touches screenshot_url IS NULL) renders
// it later. The write below also only fills a NULL, so it never overwrites a newer thumbnail.
import { generateAndStoreProposalThumbnail } from './proposal-thumbnail.js';
import { createLimiter } from './tile-source.js';

const DEFAULT_RENDER_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUED = 200;
// A render that has not finished by now is abandoned (its slot is freed; tile fetches it started
// still finish under the global fetch cap and warm the cache).
const DEFAULT_DEADLINE_MS = 60000;

const ts = () => new Date().toISOString();

function withDeadline(promise, ms, label) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createThumbnailQueue(options = {}) {
    const {
        concurrency = DEFAULT_RENDER_CONCURRENCY,
        maxQueued = DEFAULT_MAX_QUEUED,
        deadlineMs = DEFAULT_DEADLINE_MS,
        render = generateAndStoreProposalThumbnail
    } = options;

    const limiter = createLimiter(concurrency);
    const jobs = new Set();
    const idleWaiters = [];

    const settle = (job) => {
        jobs.delete(job);
        if (jobs.size === 0) idleWaiters.splice(0).forEach(resolve => resolve());
    };

    async function runJob({ pool, proposal, city, proposalId, baseUrl }) {
        const started = Date.now();
        try {
            const result = await withDeadline(
                render(pool, proposal, { city, proposalId, baseUrl }),
                deadlineMs,
                `thumbnail render for proposal ${proposalId}`
            );
            if (!result) {
                console.log(`[${ts()}] [thumbnail] proposal ${proposalId}: nothing to draw, no thumbnail`);
                return null;
            }
            const update = await pool.query(
                `UPDATE proposal SET screenshot_url = $1 WHERE id = $2 AND screenshot_url IS NULL`,
                [result.url, proposalId]
            );
            console.log(`[${ts()}] [thumbnail] proposal ${proposalId}: ${result.url} ` +
                `(zoom ${result.frame?.zoom}, ${result.tiles?.loaded}/${result.tiles?.total} tiles, ` +
                `${result.bytes} bytes, ${Date.now() - started} ms${update?.rowCount === 0 ? ', row already had one' : ''})`);
            return result;
        } catch (err) {
            // Never thrown to anyone: the proposal exists either way. The backfill script retries.
            console.error(`[${ts()}] [thumbnail] proposal ${proposalId}: RENDER FAILED after ${Date.now() - started} ms ` +
                `(screenshot_url stays NULL for backfill): ${err.message}`);
            return null;
        }
    }

    /**
     * Queue a render. Returns the job's promise (resolves to the render result or null; never
     * rejects), or null when the queue is full and the job was shed.
     */
    function enqueue(job) {
        if (jobs.size >= maxQueued) {
            console.warn(`[${ts()}] [thumbnail] queue full (${jobs.size}); proposal ${job.proposalId} ` +
                'left for scripts/backfill-proposal-thumbnails.mjs');
            return null;
        }
        const promise = limiter.run(() => runJob(job));
        jobs.add(promise);
        promise.finally(() => settle(promise));
        return promise;
    }

    function onIdle() {
        if (jobs.size === 0) return Promise.resolve();
        return new Promise(resolve => idleWaiters.push(resolve));
    }

    return { enqueue, onIdle, get size() { return jobs.size; }, limiter };
}

let defaultQueue = null;
export function defaultThumbnailQueue() {
    if (!defaultQueue) defaultQueue = createThumbnailQueue();
    return defaultQueue;
}
