import { normalizeSiteHost } from './crawl-queue.js';

// Site crawls share the maintenance gate, but each domain has one owner.
// Unscoped crawls and existing maintenance commands still exclude every site crawl.
export async function acquireCrawlLock(db, site = null) {
    site = normalizeSiteHost(site);
    const suffix = site ? '_shared' : '';
    const locked = (await db.query(`SELECT pg_try_advisory_lock${suffix}(hashtext('floor-plan-crawl')) AS locked`)).rows[0]?.locked;
    if (!locked) throw new Error('Another floor-plan crawl or maintenance operation is already running.');
    let siteLocked = false;
    try {
        if (site) {
            siteLocked = Boolean((await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-crawl-site'),hashtext($1)) AS locked`, [site])).rows[0]?.locked);
            if (!siteLocked) throw new Error(`Another floor-plan crawl is already running for ${site}.`);
        }
    } catch (error) {
        await db.query(`SELECT pg_advisory_unlock${suffix}(hashtext('floor-plan-crawl'))`);
        throw error;
    }
    return async () => {
        try {
            if (siteLocked) await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl-site'),hashtext($1))`, [site]);
        } finally { await db.query(`SELECT pg_advisory_unlock${suffix}(hashtext('floor-plan-crawl'))`); }
    };
}

// Metadata writes and retention run serially; network requests can overlap.
export async function withCrawlMutation(db, work) {
    await db.query(`SELECT pg_advisory_lock(hashtext('floor-plan-crawl-write'))`);
    try { return await work(); }
    finally { await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl-write'))`); }
}

// A CDN asset may be linked by more than one site. Recheck the queue after waiting.
export async function acquireTargetLock(db, url) {
    await db.query(`SELECT pg_advisory_lock(hashtext('floor-plan-crawl-target'),hashtext($1))`, [url]);
    return () => db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl-target'),hashtext($1))`, [url]);
}
