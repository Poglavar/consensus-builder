#!/usr/bin/env node
// Materialize newly supported property facts from retained pages without downloading or using AI.
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { extractPageEvidence } from '../floor-plans/page-evidence.js';
import { readBlobRow } from '../floor-plans/blob-store.js';
if (!process.argv.includes('--apply')) { console.log('Usage: node backend/scripts/floor-plan-property-backfill.mjs --apply'); process.exit(0); }
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ...(process.env.PGHOST ? { host: process.env.PGHOST } : {}) });
await db.connect();
const locked = (await db.query("SELECT pg_try_advisory_lock(hashtext('floor-plan-crawl')) AS locked")).rows[0].locked;
if (!locked) { await db.end(); throw new Error('Stop the active crawl before materializing property facts.'); }
try {
    const rows = (await db.query(`SELECT l.url,l.facts,t.source_kind,b.* FROM floor_plan.listing l
        JOIN floor_plan.target t ON t.url=l.url JOIN floor_plan.blob b ON b.sha256=t.current_sha256
        WHERE b.bytes_available AND b.media_type ILIKE '%html%' AND t.exclusion_reason IS NULL ORDER BY l.url`)).rows;
    let changed = 0, done = 0;
    for (const row of rows) {
        const bytes = await readBlobRow(row);
        const evidence = extractPageEvidence(bytes.toString('utf8'), row.url, { sourceKind: row.source_kind, discovery: false });
        if (evidence.listing?.propertyDetails) {
            const details = evidence.listing.propertyDetails;
            const result = await db.query(`UPDATE floor_plan.listing SET facts=jsonb_set(facts,'{propertyDetails}',$2::jsonb),updated_at=now()
                WHERE url=$1 AND facts->'propertyDetails' IS DISTINCT FROM $2::jsonb`, [row.url, JSON.stringify(details)]);
            changed += result.rowCount;
        }
        if (++done % 100 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), stage: 'property-facts', done, total: rows.length, changed }));
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), stage: 'property-facts', done, total: rows.length, changed }));
} finally { await db.query("SELECT pg_advisory_unlock(hashtext('floor-plan-crawl'))"); await db.end(); }
