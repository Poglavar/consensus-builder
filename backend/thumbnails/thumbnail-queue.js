// Background queue for server-side thumbnails of proposals, designs and agreements. The publish routes
// (POST /designs and POST /agreements, plan-design-agreement.md M2) answer as soon as the row is
// written and hand the render to this queue, so a publish never waits on (or fails because of) a
// third-party tile CDN. Renders run a few at a time; tiles inside a render are capped and cached by
// thumbnails/tile-source.js. A job names its subject: { proposal, proposalId, city } for a proposal
// row (kept until M3 removes the table), { design } or { agreement } for an indexed one, keyed by CID.
//
// Restart-safety: the queue is in memory only. A thumbnail that was queued when the process died,
// that failed, or that was shed because the queue was full simply leaves screenshot_url NULL. For a
// proposal, scripts/backfill-proposal-thumbnails.mjs (idempotent, only touches screenshot_url IS
// NULL) renders it later; designs and agreements have no backfill yet, so theirs stays missing. The
// write below also only fills a NULL, so it never overwrites a newer thumbnail.
import { generateAndStoreContentThumbnail, generateAndStoreProposalThumbnail } from './proposal-thumbnail.js';
import { createLimiter } from './tile-source.js';

const DEFAULT_RENDER_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUED = 200;
// A render that has not finished by now is abandoned (its slot is freed; tile fetches it started
// still finish under the global fetch cap and warm the cache).
const DEFAULT_DEADLINE_MS = 60000;

const ts = () => new Date().toISOString();

// The table an indexed subject's thumbnail is written to, by kind (backend/db/design-ddl.sql, agreement-ddl.sql).
const CONTENT_TABLES = Object.freeze({ design: 'consensus.design', agreement: 'consensus.agreement' });

// A design or agreement job's subject for generateAndStoreContentThumbnail, or null for a proposal job.
function contentSubject(job) {
    if (job.design) return { kind: 'design', ...job.design };
    if (job.agreement) return { kind: 'agreement', ...job.agreement };
    return null;
}

const labelOf = job => {
    const subject = contentSubject(job);
    return subject ? `${subject.kind} ${subject.cid}` : `proposal ${job.proposalId}`;
};

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
        render = generateAndStoreProposalThumbnail,
        // Read when a design or agreement job runs (generateAndStoreContentThumbnail by default).
        renderContent = null
    } = options;

    const limiter = createLimiter(concurrency);
    const jobs = new Set();
    const idleWaiters = [];

    const settle = (job) => {
        jobs.delete(job);
        if (jobs.size === 0) idleWaiters.splice(0).forEach(resolve => resolve());
    };

    async function runJob(job) {
        const { pool, proposal, city, proposalId, baseUrl } = job;
        const subject = contentSubject(job);
        const label = labelOf(job);
        const started = Date.now();
        try {
            const result = await withDeadline(
                subject
                    ? (renderContent || generateAndStoreContentThumbnail)(pool, subject, { baseUrl })
                    : render(pool, proposal, { city, proposalId, baseUrl }),
                deadlineMs,
                `thumbnail render for ${label}`
            );
            if (!result) {
                console.log(`[${ts()}] [thumbnail] ${label}: nothing to draw, no thumbnail`);
                return null;
            }
            const urls = [result.url, result.beforeUrl || null, result.pairUrl || null];
            const update = subject
                ? await pool.query(
                    `UPDATE ${CONTENT_TABLES[subject.kind]}
                        SET screenshot_url = $1, screenshot_before_url = $2, screenshot_pair_url = $3, updated_at = now()
                      WHERE cid = $4 AND screenshot_url IS NULL`,
                    [...urls, subject.cid])
                : await pool.query(
                    `UPDATE proposal SET screenshot_url = $1, screenshot_before_url = $2, screenshot_pair_url = $3
                      WHERE id = $4 AND screenshot_url IS NULL`,
                    [...urls, proposalId]);
            console.log(`[${ts()}] [thumbnail] ${label}: ${result.url} ` +
                `(zoom ${result.frame?.zoom}, ${result.tiles?.loaded}/${result.tiles?.total} tiles, ` +
                `${result.bytes} bytes, ${Date.now() - started} ms${update?.rowCount === 0 ? ', row already had one' : ''})`);
            return result;
        } catch (err) {
            // Never thrown to anyone: the record exists either way. For a proposal the backfill script retries.
            console.error(`[${ts()}] [thumbnail] ${label}: RENDER FAILED after ${Date.now() - started} ms ` +
                `(screenshot_url stays NULL${subject ? '' : ' for backfill'}): ${err.message}`);
            return null;
        }
    }

    /**
     * Queue a render. Returns the job's promise (resolves to the render result or null; never
     * rejects), or null when the queue is full and the job was shed.
     */
    function enqueue(job) {
        if (jobs.size >= maxQueued) {
            console.warn(`[${ts()}] [thumbnail] queue full (${jobs.size}); ${labelOf(job)} ` +
                (contentSubject(job) ? 'stays without a thumbnail' : 'left for scripts/backfill-proposal-thumbnails.mjs'));
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
