// Recreate the explicitly reviewed public records under cleaned canonical CIDs, then replace the
// index atomically. A backup, exact change manifest and empty decision/market dependencies are required.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, values) => value.startsWith('--')
    ? [value.slice(2), values[index + 1]?.startsWith('--') || !values[index + 1] ? true : values[index + 1]] : null).filter(Boolean));
if (!args.snapshot || !args.changes || !args['backend-dir']) {
    console.log('Usage: node clean-concept-labels.mjs --backend-dir <backend> --snapshot <backup.json> --changes <changes.json> [--apply --base-url <api> --pin-journal <receipts.json>]');
    process.exit(0);
}
const backend = path.resolve(args['backend-dir']), require = createRequire(path.join(backend, 'package.json'));
require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const ecosystem = require(path.join(backend, 'ecosystem.config.cjs')).apps.find(app => app.name === 'consensus-builder-api');
for (const [key, value] of Object.entries(ecosystem?.env || {})) if (process.env[key] === undefined) process.env[key] = String(value);
globalThis.proj4 = require('proj4');
const Cid = require(path.join(backend, '../frontend/js/cid.js'));
globalThis.Cid = Cid;
const Cleaner = require(args.cleaner ? path.resolve(args.cleaner) : path.join(backend, '../frontend/js/publication-label-cleanup.js'));
const Design = require(path.join(backend, '../frontend/js/design-record.js'));
const Plan = require(path.join(backend, '../frontend/js/plan-record.js'));
const snapshot = JSON.parse(await fs.readFile(args.snapshot, 'utf8'));
const changes = JSON.parse(await fs.readFile(args.changes, 'utf8'));
if (JSON.stringify(Cleaner.buildRevisions(snapshot)) !== JSON.stringify(changes)) throw new Error('Manifest differs from the exact metadata-only cleanup.');
const entries = [...changes.designs, ...changes.plans, ...changes.agreements];
const counts = Object.fromEntries(['designs', 'plans', 'agreements'].map(kind => [kind, changes[kind].length]));

for (const change of entries) {
    if (Cid.cidOfObject(change.content) !== change.to) throw new Error('Change manifest has an incorrect CID.');
    if (change.kind === 'design') {
        const validation = Design.validate(change.content);
        if (!validation.valid) throw new Error(`Invalid cleaned design: ${JSON.stringify(validation.errors)}`);
    }
    if (change.kind === 'plan' && Plan.validate(change.content)) throw new Error('Invalid cleaned plan.');
}
console.log(JSON.stringify({ operation: 'clean-concept-labels', ...counts,
    bytes: entries.reduce((sum, entry) => sum + Cid.canonicalBytes(entry.content).length, 0), apply: args.apply === true }));
if (!args.apply) process.exit(0);
if (!args['base-url'] || !args['pin-journal']) throw new Error('--apply requires an explicit --base-url and --pin-journal.');
const base = new URL(args['base-url']);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid API origin.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { Pool } = require('pg'), pool = new Pool({ connectionString: process.env.DATABASE_URL });
const agreementIds = changes.agreements.map(row => row.from), planIds = changes.plans.map(row => row.from);

async function guard(db) {
    for (const kind of ['design', 'plan', 'agreement']) {
        const current = (await db.query(`SELECT cid,content FROM consensus.${kind} WHERE cid=ANY($1::text[])`,
            [changes[kind + 's'].map(row => row.from)])).rows;
        if (current.length !== changes[kind + 's'].length) throw new Error(`Stale ${kind} source set.`);
        for (const row of current) if (Cid.cidOfObject(row.content) !== row.cid) throw new Error('Source content changed or is invalid.');
    }
    const dependent = (await db.query("SELECT cid,onchain FROM consensus.agreement WHERE content->>'planCid'=ANY($1::text[])", [planIds])).rows;
    if (dependent.some(row => row.onchain || !agreementIds.includes(row.cid)) || dependent.length !== agreementIds.length)
        throw new Error('A plan has an unreviewed or minted dependent agreement.');
    for (const table of ['agreement_decision', 'community_report', 'bet_event', 'points_market']) {
        const exists = (await db.query('SELECT to_regclass($1) name', [`consensus.${table}`])).rows[0].name;
        if (!exists) continue;
        const count = (await db.query(`SELECT count(*)::int count FROM consensus.${table} WHERE agreement_cid=ANY($1::text[])`, [agreementIds])).rows[0].count;
        if (count) throw new Error(`Protected ${table} references prevent replacement.`);
    }
}

try {
    await guard(pool);
    // The original publication data is retained in the snapshot; a second backup pins the reviewed
    // change manifest to this run before a provider call or an index mutation.
    await fs.writeFile(args.changes + '.reviewed-backup', JSON.stringify({ snapshot, changes }), { mode: 0o600 });
    let receipts = {};
    try { receipts = JSON.parse(await fs.readFile(args['pin-journal'], 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { pinFile } = await import(pathToFileURL(path.join(backend, 'storage/pinning.js')));
    const unique = [...new Map(entries.map(entry => [entry.to, entry])).values()];
    let completed = 0;
    for (const entry of unique) {
        if (!receipts[entry.to]) {
            const pinned = await pinFile({ bytes: Cid.canonicalBytes(entry.content), fileName: `${entry.to}.json`, cid: entry.to });
            if (pinned.cid !== entry.to) throw new Error('Pin receipt did not match the reviewed content.');
            receipts[entry.to] = pinned;
            await fs.writeFile(args['pin-journal'], JSON.stringify(receipts), { mode: 0o600 });
        }
        if (++completed % 10 === 0 || completed === unique.length) console.log(JSON.stringify({ pinned: completed, total: unique.length }));
    }
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query("SET LOCAL lock_timeout='5s'");
        await db.query('LOCK TABLE consensus.design, consensus.plan, consensus.agreement IN SHARE ROW EXCLUSIVE MODE');
        await guard(db);
        for (const entry of changes.designs) await db.query(`INSERT INTO consensus.design
            (cid,city,goal,title,author,site,bounds,binding,content,origin_cid,screenshot_url,screenshot_before_url,screenshot_pair_url,created_at,updated_at)
            SELECT $2,city,goal,$3,$4,site,bounds,binding,$5::jsonb,$6,screenshot_url,screenshot_before_url,screenshot_pair_url,created_at,now()
            FROM consensus.design WHERE cid=$1 ON CONFLICT(cid) DO NOTHING`,
        [entry.from, entry.to, entry.content.title, entry.content.author, JSON.stringify(entry.content), entry.content.origin?.cid || null]);
        for (const entry of changes.plans) await db.query(`INSERT INTO consensus.plan (cid,content,created_at)
            SELECT $2,$3::jsonb,created_at FROM consensus.plan WHERE cid=$1 ON CONFLICT(cid) DO NOTHING`,
        [entry.from, entry.to, JSON.stringify(entry.content)]);
        for (const entry of changes.agreements) {
            const content = changes.plans.find(plan => plan.to === entry.content.planCid)?.content;
            if (!content) throw new Error('A dependent agreement has no reviewed plan.');
            await db.query(`INSERT INTO consensus.agreement
                (cid,city,title,author,design_cids,input_parcel_ids,parcel_source_id,deadline,content,onchain,screenshot_url,screenshot_before_url,screenshot_pair_url,created_at,updated_at)
                SELECT $2,city,title,author,$3::text[],input_parcel_ids,parcel_source_id,deadline,$4::jsonb,onchain,screenshot_url,screenshot_before_url,screenshot_pair_url,created_at,now()
                FROM consensus.agreement WHERE cid=$1 ON CONFLICT(cid) DO NOTHING`,
            [entry.from, entry.to, content.designCids, JSON.stringify(entry.content)]);
        }
        for (const kind of ['agreement', 'plan', 'design']) {
            const list = changes[kind + 's'];
            await db.query(`DELETE FROM consensus.${kind} WHERE cid=ANY($1::text[]) AND NOT(cid=ANY($2::text[]))`,
                [list.map(row => row.from), list.map(row => row.to)]);
        }
        for (const kind of ['design', 'plan', 'agreement']) {
            const list = changes[kind + 's'];
            const rows = (await db.query(`SELECT cid,content FROM consensus.${kind} WHERE cid=ANY($1::text[])`, [list.map(row => row.to)])).rows;
            if (rows.length !== new Set(list.map(row => row.to)).size || rows.some(row => Cid.cidOfObject(row.content) !== row.cid))
                throw new Error(`Read-back verification failed for ${kind}.`);
        }
        await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
    console.log(JSON.stringify({ complete: true, ...counts, apiOrigin: base.origin,
        planLinks: changes.plans.map(row => ({ title: row.content.title, path: `/plans/${row.to}` })) }));
} finally { await pool.end(); }
