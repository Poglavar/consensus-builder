// Queues close site-location calls for LLM adjudication and applies the readings, through the
// shared batch worker (batch API, per-item cost, daily budget, one chunk per invocation).
import { readBlob } from './blob-store.js';
import { runBatchStage } from './batch-worker.js';
import { SITE_PROCESSOR, SITE_SCHEMA, applySiteReading, buildSiteRequest, parseSiteReading, prepareSiteEvidence, siteTaskId } from './site-adjudication.js';

export async function enqueueSiteTasks(db, { limit = 20, urls = null, statuses = ['ambiguous', 'probable'] } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Site adjudication queue limit must be 1..1000.');
    const rows = (await db.query(`SELECT l.url, l.facts, l.location, t.current_sha256
        FROM floor_plan.listing l JOIN floor_plan.target t ON t.url = l.url
        JOIN floor_plan.blob b ON b.sha256 = t.current_sha256 AND b.bytes_available
        WHERE l.location_status = ANY($1::text[]) AND l.location->>'sourceSha256' = t.current_sha256
          AND jsonb_array_length(COALESCE(l.location->'candidates', '[]'::jsonb)) > 0
          AND ($2::text[] IS NULL OR l.url = ANY($2::text[]))
          AND NOT EXISTS (SELECT 1 FROM floor_plan.building_task bt WHERE bt.listing_url = l.url
                AND bt.processor = $3 AND bt.source_sha256 = t.current_sha256 AND bt.status <> 'error')
        ORDER BY l.location_checked_at, l.url LIMIT $4`, [statuses, urls, SITE_PROCESSOR, limit])).rows;
    let enqueued = 0;
    for (const row of rows) {
        const bytes = await readBlob(db, row.current_sha256);
        if (!bytes) continue;
        const packet = prepareSiteEvidence({ url: row.url, sha256: row.current_sha256, html: bytes.toString('utf8'), facts: row.facts || {}, location: row.location });
        const saved = await db.query(`INSERT INTO floor_plan.building_task(id, source_sha256, listing_url, processor, context, candidate_map)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [siteTaskId(packet), row.current_sha256, row.url, SITE_PROCESSOR, JSON.stringify(packet), JSON.stringify(packet.candidateMap)]);
        enqueued += saved.rowCount || 0;
    }
    return { selected: rows.length, enqueued };
}

async function currentLocation(db, task) {
    const row = (await db.query(`SELECT l.location, t.current_sha256 FROM floor_plan.listing l JOIN floor_plan.target t ON t.url = l.url
        WHERE l.url = $1`, [task.listing_url])).rows[0];
    return row && row.current_sha256 === task.source_sha256 && row.location?.sourceSha256 === task.source_sha256 ? row.location : null;
}

export async function adjudicateSites(db, options = {}) {
    return runBatchStage(db, {
        stage: 'buildings', processor: SITE_PROCESSOR, schema: SITE_SCHEMA,
        counters: { located: 0, probable: 0, ambiguous: 0, unresolved: 0, stale: 0 },
        async prepare(db, task, llm, limits) {
            if (task.processor !== SITE_PROCESSOR) throw new Error('Historical site task needs its original reader.');
            if (!await currentLocation(db, task)) throw new Error('Listing source or location changed before adjudication.');
            return { request: buildSiteRequest(llm, task, limits), evidence: {} };
        },
        async apply(db, task, item) {
            const reading = parseSiteReading(item.data ?? item.text, task, { model: item.model });
            const status = !reading.isListing ? 'not_listing' : reading.candidateId ? 'candidate' : 'unresolved';
            await db.query(`UPDATE floor_plan.building_task SET status=$2, result=result||$3::jsonb, error=NULL, updated_at=now() WHERE id=$1`,
                [task.id, status, JSON.stringify({ reading })]);
            const location = await currentLocation(db, task);
            if (!location) return { stale: 1 };
            const next = applySiteReading(location, reading);
            await db.query(`UPDATE floor_plan.listing SET location=$2, location_status=$3, updated_at=now() WHERE url=$1`,
                [task.listing_url, JSON.stringify(next), next.status]);
            return { [next.status]: 1 };
        },
    }, options);
}
