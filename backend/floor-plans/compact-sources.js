// Small, hash-bound source evidence survives after successful HTML parsing.
import * as cheerio from 'cheerio';
import { buildingEvidenceFacts, prepareBuildingEvidence, unicodeSafeSlice } from './building-reading.js';
import { pruneDiscardedFiles,readBlob,readBlobRow } from './blob-store.js';
import { withCrawlMutation } from './crawl-locks.js';

export const PROCESSED_SOURCE_REASON = 'processed-source.v1';
export const SOURCE_EVIDENCE_SCHEMA = 'processed-source-evidence.v1';

export function agencyIdentityEvidence(html) {
    const $ = cheerio.load(html);
    return agencyIdentityEvidenceFromDocument($);
}

function agencyIdentityEvidenceFromDocument($) {
    const body = $('body').length ? $('body').clone() : $.root().clone();
    body.find('script,style,noscript').remove();
    body.find('br').replaceWith(' ');
    body.find('p,div,section,li,h1,h2,h3').append(' ');
    const visible = body.text().replace(/\s+/g, ' ').trim();
    const matches = [];
    for (const match of visible.matchAll(/\bOIB\s*[:.]?\s*(?:HR)?\s*(\d{11})\b/gi)) {
        matches.push({ oib: match[1], quote: match[0], context: unicodeSafeSlice(visible, Math.max(0, match.index - 350), match.index + 100) });
    }
    return { matches, text: unicodeSafeSlice(visible, 0, 20000), truncated: visible.length > 20000 };
}

export function prepareSourceEvidence({ url, sha256, html, document = null, facts = {} } = {}) {
    if (typeof html !== 'string') throw new Error('Source evidence needs HTML text.');
    const $ = document || cheerio.load(html);
    return {
        schema: SOURCE_EVIDENCE_SCHEMA,
        source: { url, sha256 },
        building: prepareBuildingEvidence({ url, sha256, html, document: $, facts }),
        agencyIdentity: agencyIdentityEvidenceFromDocument($),
    };
}

export function sourceEvidenceMatches(value, url, sha256, facts) {
    const matches = value?.schema === SOURCE_EVIDENCE_SCHEMA && value.source?.url === url
        && value.source?.sha256 === sha256 && value.building?.source?.url === url
        && value.building?.source?.sha256 === sha256 && typeof value.building.text === 'string'
        && Array.isArray(value.building.links) && Array.isArray(value.agencyIdentity?.matches);
    if (!matches || facts === undefined) return matches;
    try {
        const expected = buildingEvidenceFacts(facts), actual = value.building.facts;
        return Object.keys(expected).every(key => actual?.[key] === expected[key]);
    } catch { return false; }
}

export function buildingEvidenceWithCandidates(sourceEvidence, candidates = []) {
    const packet = sourceEvidence?.building;
    if (!packet || typeof packet.text !== 'string' || !Array.isArray(packet.links))
        throw new Error('Processed source has no building evidence packet.');
    if (!Array.isArray(candidates) || candidates.length > 40) throw new Error('Invalid building candidates.');
    const clean = (value, max = 700) => typeof value === 'string' ? unicodeSafeSlice(value.replace(/\s+/g, ' ').trim(), 0, max) : null;
    return { ...packet, candidates: candidates.map((candidate, index) => {
        const distanceM = candidate.distanceM ?? null;
        if (distanceM !== null && (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > 1e6))
            throw new Error('Invalid candidate distance.');
        return { id: `C${index + 1}`, address: clean(candidate.address, 300) || null,
            name: clean(candidate.name, 300) || null,
            distanceM, evidence: clean(candidate.evidence) };
    }) };
}

const RETENTION_WORK_COUNTERS = ['htmlSources', 'htmlBlobs', 'htmlBytes', 'envelopeSources', 'envelopeBlobs',
    'envelopeBytes', 'sourceReadErrors', 'filesDeleted', 'bytesDeleted'];
const RETENTION_INVENTORY_COUNTERS = ['protectedEnvelopeSources', 'retainedPendingPlans', 'retainedPendingEnvelopes'];

// Run independently committed compaction batches until the bounded selector drains,
// a source fails, or the caller's deadline/abort signal asks us to stop.
export async function drainSourceRetention(db, { compact = compactSources, limit = 1000, deadline = Infinity,
    signal, log = () => {}, now = Date.now } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('Retention limit must be 1..100000.');
    const totals = { apply: true, batches: 0, partial: false, remaining: false, deferred: 0,
        ...Object.fromEntries(RETENTION_WORK_COUNTERS.map(key => [key, 0])),
        ...Object.fromEntries(RETENTION_INVENTORY_COUNTERS.map(key => [key, 0])) };
    const expired = () => Number.isFinite(deadline) && now() >= deadline;
    let stopReason = null;
    while (true) {
        if (signal?.aborted) { stopReason = 'interrupted'; break; }
        if (expired()) { stopReason = 'deadline'; break; }
        const batch = await compact(db, { apply: true, limit, deadline, signal, log });
        totals.batches++;
        for (const key of RETENTION_WORK_COUNTERS) totals[key] += Number(batch?.[key] || 0);
        for (const key of RETENTION_INVENTORY_COUNTERS) totals[key] = Number(batch?.[key] || 0);
        totals.deferred = Number(batch?.deferred || 0);
        log({ phase: 'source-retention-checkpoint', batch: totals.batches,
            ...Object.fromEntries(RETENTION_WORK_COUNTERS.map(key => [key, totals[key]])),
            ...Object.fromEntries(RETENTION_INVENTORY_COUNTERS.map(key => [key, totals[key]])),
            deferred: totals.deferred });
        if (signal?.aborted) { stopReason = 'interrupted'; break; }
        if (expired()) { stopReason = 'deadline'; break; }
        if (Number(batch?.sourceReadErrors || 0) > 0) { stopReason = 'source-errors'; break; }
        // A full selection may be the final batch, so one empty follow-up confirms exhaustion.
        const selectionFull = Number(batch?.htmlBlobs || 0) >= limit
            || Number(batch?.envelopeSources || 0) >= limit || Number(batch?.filesDeleted || 0) >= limit;
        if (totals.deferred <= 0 && !selectionFull) break;
    }
    if (stopReason) {
        totals.status = 'partial'; totals.partial = true; totals.remaining = true; totals.stopReason = stopReason;
    } else totals.status = 'complete';
    return totals;
}

// Prefer the exact URL/hash observation packet. Raw bytes are a fallback only while retained.
export async function readSourceEvidence(db, { url, sha256, facts = {} } = {}) {
    const row = (await db.query(`SELECT evidence->'sourcePacket' AS packet FROM floor_plan.observation
        WHERE url=$1 AND sha256=$2`, [url, sha256])).rows[0];
    if (sourceEvidenceMatches(row?.packet, url, sha256)) return { ...row.packet, from: 'snapshot' };
    const bytes = await readBlob(db, sha256);
    if (!bytes) return null;
    return { ...prepareSourceEvidence({ url, sha256, html: bytes.toString('utf8'), facts }), from: 'bytes' };
}

const RETAINED_ENVELOPE_SQL = `NOT EXISTS(SELECT 1 FROM floor_plan.target plan_alias
    JOIN floor_plan.observation plan_observation ON plan_observation.url=plan_alias.url
      AND plan_observation.sha256=t.current_sha256
    WHERE plan_alias.kind='asset'
      AND EXISTS(SELECT 1 FROM floor_plan.listing l
        CROSS JOIN LATERAL jsonb_array_elements(l.asset_urls) a
        WHERE (a->>'url')=plan_alias.url AND a->'listingOwned'='true'::jsonb AND a->>'kind'='floor-plan'))
  AND NOT EXISTS(SELECT 1 FROM floor_plan.extraction e WHERE e.sha256=t.current_sha256 AND e.model ? 'architecture')
  AND NOT EXISTS(SELECT 1 FROM floor_plan.processed_plan p WHERE p.source_sha256=t.current_sha256)
  AND NOT EXISTS(SELECT 1 FROM floor_plan.plan_task pt WHERE pt.source_sha256=t.current_sha256 AND pt.status<>'complete')
  AND NOT EXISTS(SELECT 1 FROM floor_plan.plan_task pt WHERE pt.source_sha256=t.current_sha256
      AND pt.processor='sheet-context-v1' AND pt.status<>'complete')
  AND EXISTS(SELECT 1 FROM floor_plan.image_task it WHERE it.source_sha256=t.current_sha256
      AND it.status='complete' AND it.result->'reading'->>'envelopeEvidence'='true')
  AND EXISTS(SELECT 1 FROM floor_plan.plan_task pt WHERE pt.source_sha256=t.current_sha256
      AND pt.processor='sheet-context-v1' AND pt.status='complete'
      AND pt.result->'sheet'->>'kind' IN ('photo','render'))`;

function emptyRetentionResult(apply) {
    return { apply, htmlSources: 0, htmlBlobs: 0, htmlBytes: 0, envelopeSources: 0,
        envelopeBlobs: 0, envelopeBytes: 0, protectedEnvelopeSources: 0, sourceReadErrors: 0,
        retainedPendingPlans: 0, retainedPendingEnvelopes: 0, filesDeleted: 0, bytesDeleted: 0, deferred: 0 };
}

// Compact complete content-hash groups only. Shared bytes stay available if any current reference
// is unsupported or cannot be given its own exact-URL evidence packet.
export async function compactSources(db, options = {}) {
    if (options.apply && options.crawlLockHeld)
        return withCrawlMutation(db, () => compactSourcesLocked(db, options));
    return compactSourcesLocked(db, options);
}

async function compactSourcesLocked(db, { apply = false, crawlLockHeld = false, limit = 50000, deadline = Infinity, signal, prune = pruneDiscardedFiles, log = () => {} } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('Retention limit must be 1..100000.');
    const expired = () => Boolean(signal?.aborted) || (Number.isFinite(deadline) && Date.now() >= deadline);
    let locked = false, inTransaction = false;
    const result = emptyRetentionResult(apply), htmlHashes = new Map(), sourcePackets = [];
    try {
        if (apply && !crawlLockHeld) {
            locked = Boolean((await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-crawl')) AS locked`)).rows[0]?.locked);
            if (!locked) throw new Error('Stop the active crawl before applying source retention.');
        }
        const rows = (await db.query(`WITH candidate_hashes AS (
              SELECT b.sha256
              FROM floor_plan.blob b
              WHERE b.bytes_available AND b.media_type ~* '(html|xml)'
                AND EXISTS(SELECT 1 FROM floor_plan.observation o WHERE o.sha256=b.sha256)
                AND NOT EXISTS(SELECT 1 FROM floor_plan.target ct WHERE ct.current_sha256=b.sha256
                  AND NOT EXISTS(SELECT 1 FROM floor_plan.observation co WHERE co.url=ct.url AND co.sha256=b.sha256))
                AND NOT EXISTS(SELECT 1 FROM floor_plan.target at WHERE at.current_sha256=b.sha256 AND at.kind='asset')
                AND NOT EXISTS(SELECT 1 FROM floor_plan.observation ao
                  JOIN floor_plan.target at ON at.url=ao.url WHERE ao.sha256=b.sha256 AND at.kind='asset')
                AND NOT EXISTS(SELECT 1 FROM floor_plan.extraction e WHERE e.sha256=b.sha256)
                AND NOT EXISTS(SELECT 1 FROM floor_plan.processed_plan p WHERE p.source_sha256=b.sha256)
                AND NOT EXISTS(SELECT 1 FROM floor_plan.plan_task pt WHERE pt.source_sha256=b.sha256)
                AND NOT EXISTS(SELECT 1 FROM floor_plan.image_task it WHERE it.source_sha256=b.sha256)
                AND NOT EXISTS(SELECT 1 FROM floor_plan.observation o
                  LEFT JOIN floor_plan.target t ON t.url=o.url
                  WHERE o.sha256=b.sha256 AND (t.url IS NULL OR t.kind NOT IN ('home','sitemap','page')
                    OR t.state IS DISTINCT FROM 'ok'))
              ORDER BY b.sha256 LIMIT $1
            )
            SELECT t.url,t.kind,o.sha256,o.evidence->'sourcePacket' AS packet,
                CASE WHEN t.current_sha256=o.sha256 THEN l.facts ELSE '{}'::jsonb END AS facts,
                b.media_type,b.byte_count,b.storage_path,b.bytes_available
            FROM candidate_hashes c JOIN floor_plan.blob b ON b.sha256=c.sha256
            JOIN floor_plan.observation o ON o.sha256=c.sha256
            JOIN floor_plan.target t ON t.url=o.url
            LEFT JOIN floor_plan.listing l ON l.url=t.url
            WHERE t.kind IN ('home','sitemap','page') AND t.state='ok'
            ORDER BY c.sha256,t.url`, [limit])).rows;
        const eligibleHashes = new Set();
        const rowsByHash = new Map();
        for (const row of rows) {
            const group = rowsByHash.get(row.sha256) || [];
            group.push(row);
            rowsByHash.set(row.sha256, group);
        }
        let processedHashGroups = 0, processedBytes = 0;
        const groups = [...rowsByHash];
        const reportHashProgress = () => {
            processedHashGroups++;
            if (processedHashGroups % 50 === 0) log({ phase: 'source-retention', processed: processedHashGroups,
                total: groups.length, bytes: processedBytes });
        };
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            if (expired()) { result.deferred += groups.length - groupIndex; break; }
            const [hash, group] = groups[groupIndex];
            const row = group[0];
            let bytes;
            try { bytes = await readBlobRow(row); }
            catch (error) {
                result.sourceReadErrors++;
                log({ hash, error: error.message });
                reportHashProgress();
                continue;
            }
            if (!bytes) { result.sourceReadErrors++; reportHashProgress(); continue; }
            const packets = [];
            let validGroup = true;
            let deadlineReached = false;
            let html;
            let document;
            for (const alias of group) {
                if (expired()) { deadlineReached = true; break; }
                if (sourceEvidenceMatches(alias.packet, alias.url, hash, alias.facts || {})) continue;
                try {
                    if (html === undefined) html = bytes.toString('utf8');
                    if (!document) document = cheerio.load(html);
                    packets.push({ url: alias.url, sha256: hash,
                        packet: prepareSourceEvidence({ url: alias.url, sha256: hash, html, document, facts: alias.facts || {} }) });
                } catch (error) {
                    result.sourceReadErrors++;
                    log({ url: alias.url, hash, error: error.message });
                    validGroup = false;
                }
            }
            if (deadlineReached || expired()) { result.deferred += groups.length - groupIndex; break; }
            processedBytes += Number(row.byte_count) || 0;
            reportHashProgress();
            if (!validGroup) continue;
            sourcePackets.push(...packets);
            eligibleHashes.add(hash);
            result.htmlSources += group.length;
            htmlHashes.set(hash, Number(row.byte_count));
        }
        result.htmlBlobs = eligibleHashes.size;
        result.htmlBytes = [...eligibleHashes].reduce((sum, hash) => sum + (htmlHashes.get(hash) || 0), 0);

        const envelopeEligibility = alias => RETAINED_ENVELOPE_SQL.replace(/\bt\./g, `${alias}.`);
        const envelopes = (await db.query(`WITH candidate_rows AS MATERIALIZED (
                SELECT t.url,t.current_sha256 AS sha256,b.media_type,b.byte_count,b.storage_path,b.bytes_available
                FROM floor_plan.target t JOIN floor_plan.blob b ON b.sha256=t.current_sha256
                WHERE t.kind='asset' AND t.image_kind='envelope' AND t.image_classified_sha256=t.current_sha256
                  AND b.bytes_available AND lower(split_part(b.media_type,';',1)) IN ('image/jpeg','image/png','image/webp','image/avif')
            ), candidate_hashes AS MATERIALIZED (
                SELECT DISTINCT sha256 FROM candidate_rows
            ), alias_checks AS MATERIALIZED (
                SELECT c.sha256,BOOL_OR(alias.kind<>'asset' OR alias.image_kind IS DISTINCT FROM 'envelope'
                    OR alias.image_classified_sha256 IS DISTINCT FROM alias.current_sha256
                    OR NOT (${envelopeEligibility('alias')})) AS has_unsafe_alias
                FROM candidate_hashes c JOIN floor_plan.target alias ON alias.current_sha256=c.sha256
                GROUP BY c.sha256
            )
            SELECT DISTINCT c.url,c.sha256,c.media_type,c.byte_count,c.storage_path,c.bytes_available
            FROM candidate_rows c JOIN alias_checks a ON a.sha256=c.sha256 AND a.has_unsafe_alias IS FALSE
            JOIN floor_plan.target t ON t.url=c.url
            WHERE ${RETAINED_ENVELOPE_SQL}
            ORDER BY c.url LIMIT $1`, [limit])).rows;
        const envelopeHashes = new Map();
        let processedEnvelopes = 0, processedEnvelopeBytes = 0;
        for (let envelopeIndex = 0; envelopeIndex < envelopes.length; envelopeIndex++) {
            if (expired()) { result.deferred += envelopes.length - envelopeIndex; break; }
            const row = envelopes[envelopeIndex];
            try {
                const bytes = await readBlobRow(row);
                if (!bytes) result.sourceReadErrors++;
                else {
                    envelopeHashes.set(row.sha256, Number(row.byte_count));
                    result.envelopeSources++;
                }
            } catch (error) { result.sourceReadErrors++; log({ url: row.url, hash: row.sha256, error: error.message }); }
            processedEnvelopes++;
            processedEnvelopeBytes += Number(row.byte_count) || 0;
            if (processedEnvelopes % 50 === 0) log({ phase: 'envelope-retention', processed: processedEnvelopes,
                total: envelopes.length, bytes: processedEnvelopeBytes });
        }
        result.envelopeBlobs = envelopeHashes.size;
        result.envelopeBytes = [...envelopeHashes.values()].reduce((sum, bytes) => sum + bytes, 0);
        result.protectedEnvelopeSources = Number((await db.query(`SELECT count(*)::int AS n FROM floor_plan.target t
            JOIN floor_plan.blob b ON b.sha256=t.current_sha256
            WHERE t.kind='asset' AND t.image_kind='envelope' AND b.bytes_available
              AND NOT (${RETAINED_ENVELOPE_SQL})`)).rows[0]?.n || 0);
        result.retainedPendingPlans = Number((await db.query(`SELECT count(*)::int AS n FROM floor_plan.blob b
            WHERE b.bytes_available AND EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.kind='asset' AND t.current_sha256=b.sha256)
              AND (EXISTS(SELECT 1 FROM floor_plan.extraction e WHERE e.sha256=b.sha256 AND e.status IN ('pending','needs_review','error'))
                OR EXISTS(SELECT 1 FROM floor_plan.processed_plan p WHERE p.source_sha256=b.sha256 AND p.status='needs_review'))`)).rows[0]?.n || 0);
        result.retainedPendingEnvelopes = Number((await db.query(`SELECT count(DISTINCT t.current_sha256)::int AS n FROM floor_plan.target t
            JOIN floor_plan.blob b ON b.sha256=t.current_sha256 WHERE t.kind='asset' AND t.image_kind='envelope'
              AND b.bytes_available AND NOT (${RETAINED_ENVELOPE_SQL})`)).rows[0]?.n || 0);

        if (!apply) return result;
        if (eligibleHashes.size || envelopeHashes.size) {
            await db.query('BEGIN'); inTransaction = true;
            for (const { url, sha256, packet } of sourcePackets) {
                if (!eligibleHashes.has(sha256)) continue;
                await db.query(`UPDATE floor_plan.observation SET evidence=evidence||$3::jsonb,updated_at=now()
                    WHERE url=$1 AND sha256=$2`, [url, sha256, JSON.stringify({ sourcePacket: packet })]);
                const check = (await db.query(`SELECT evidence->'sourcePacket' AS packet FROM floor_plan.observation
                    WHERE url=$1 AND sha256=$2`, [url, sha256])).rows[0]?.packet;
                if (!sourceEvidenceMatches(check, url, sha256)) throw new Error(`Source packet read-back failed: ${url} ${sha256}`);
            }
            if (eligibleHashes.size) await db.query(`UPDATE floor_plan.blob SET bytes_available=false,discarded_at=now(),discard_reason=$2,updated_at=now()
                WHERE sha256=ANY($1::text[]) AND bytes_available`, [[...eligibleHashes], PROCESSED_SOURCE_REASON]);
            if (envelopeHashes.size) {
                const hashes = [...envelopeHashes.keys()];
                await db.query(`UPDATE floor_plan.blob SET bytes_available=false,discarded_at=now(),discard_reason='processed-envelope.v1',updated_at=now()
                    WHERE sha256=ANY($1::text[]) AND bytes_available`, [hashes]);
                await db.query(`UPDATE floor_plan.target SET next_check_at='infinity',updated_at=now()
                    WHERE kind='asset' AND current_sha256=ANY($1::text[])`, [hashes]);
            }
            await db.query('COMMIT'); inTransaction = false;
        }
        const pendingCount = Number((await db.query(`SELECT count(*)::int AS n FROM floor_plan.blob
            WHERE NOT bytes_available AND storage_path IS NOT NULL
              AND discard_reason IN ('processed-source.v1','processed-envelope.v1')`)).rows[0]?.n || 0);
        const pending = (await db.query(`SELECT sha256 FROM floor_plan.blob
            WHERE NOT bytes_available AND storage_path IS NOT NULL
              AND discard_reason IN ('processed-source.v1','processed-envelope.v1')
            ORDER BY sha256 LIMIT $1`, [limit])).rows;
        result.deferred += Math.max(0, pendingCount - pending.length);
        const pruneHashes = [...new Set([...eligibleHashes, ...envelopeHashes.keys(), ...pending.map(row => row.sha256)])];
        if (expired()) result.deferred += pruneHashes.length;
        else if (pruneHashes.length) {
            const pruned = await prune(db, { hashes: pruneHashes });
            result.filesDeleted = Number(pruned?.filesDeleted || 0);
            result.bytesDeleted = Number(pruned?.bytesDeleted || 0);
        }
        return result;
    } catch (error) {
        if (inTransaction) { await db.query('ROLLBACK'); inTransaction = false; }
        throw error;
    } finally {
        if (locked) await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl'))`);
    }
}
