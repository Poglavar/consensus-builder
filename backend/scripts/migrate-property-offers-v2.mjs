#!/usr/bin/env node
// Property offers v2 (docs/property-market-plan.md step 6): replaces the v1 offer index
// (consensus.property_offer with parcel_keys/price_lamports, consensus.property_offer_acceptance and
// consensus.property_offer_transfer) by the v2 tables of backend/db/property-offer-ddl.sql. The deploy
// re-applies that DDL on every run, so the drop lives here and not in the DDL. v1 offers are
// experimental records of a retired program; they are dropped, not converted.
//
// Without --apply it only reports: each old table's rows and anything outside the set that depends on
// it. --apply drops the old tables (never CASCADE) and applies the v2 DDL in ONE transaction, and
// refuses when an unexpected dependent exists. A database already on v2 is left untouched.
//
//   node scripts/migrate-property-offers-v2.mjs            # report only
//   node scripts/migrate-property-offers-v2.mjs --apply
// The connection is DATABASE_URL (from backend/.env, or --env-file); it is never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DDL_FILE = path.join(BACKEND_DIR, 'db', 'property-offer-ddl.sql');
// Children first: the acceptance and transfer tables reference the offer table.
export const OLD_TABLES = ['consensus.property_offer_transfer', 'consensus.property_offer_acceptance', 'consensus.property_offer'];

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

function usage(code) {
    console.log([
        'Replace the v1 property-offer tables by the v2 index (backend/db/property-offer-ddl.sql).',
        '',
        '  (no option)        Report the old tables, their rows and dependents; write nothing',
        '  --apply            Drop the old tables and apply the v2 DDL in one transaction',
        '  --env-file FILE    Where DATABASE_URL is read from (default backend/.env)',
        '  --help             This text'
    ].join('\n'));
    process.exit(code);
}

/** The v1 tables present, with rows, and the objects outside the set that depend on them. */
export async function discover(client) {
    const { rows: present } = await client.query(`SELECT t AS name, to_regclass(t)::oid::int8 AS oid FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NOT NULL`, [OLD_TABLES]);
    const offer = present.find(row => row.name === 'consensus.property_offer');
    if (offer) {
        const { rows } = await client.query(`SELECT 1 FROM pg_attribute WHERE attrelid = $1::oid AND attname = 'asset_hash' AND NOT attisdropped`, [offer.oid]);
        // Already v2 (and the v1 children gone): nothing to migrate.
        if (rows.length && present.length === 1) return { v2: true, tables: [], dependents: [] };
    }
    const tables = [];
    for (const row of present) tables.push({ ...row, rows: Number((await client.query(`SELECT count(*)::int8 AS n FROM ${row.name}`)).rows[0].n) });
    const oids = tables.map(table => table.oid);
    const { rows: dependents } = oids.length ? await client.query(`
        SELECT DISTINCT 'view or rule' AS kind, r.ev_class::regclass::text AS object
          FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
         WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
           AND d.refobjid = ANY($1::oid[]) AND NOT (r.ev_class = ANY($1::oid[]))
        UNION
        SELECT 'foreign key', c.conname || ' on ' || c.conrelid::regclass::text
          FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = ANY($1::oid[]) AND NOT (c.conrelid = ANY($1::oid[]))
        ORDER BY 1, 2`, [oids]) : { rows: [] };
    return { v2: false, tables, dependents };
}

export function report(found) {
    if (found.v2) return log('consensus.property_offer is already v2; nothing to migrate');
    if (!found.tables.length) log('no v1 property-offer table exists; --apply only creates the v2 tables');
    for (const table of found.tables) log(`   ${table.name}: ${table.rows} row(s) to drop`);
    if (found.dependents.length) {
        log(`REFUSED: ${found.dependents.length} object(s) outside the set depend on these tables (no CASCADE):`);
        for (const item of found.dependents) log(`   ${item.kind} ${item.object}`);
    } else if (found.tables.length) log('nothing outside the set depends on these tables');
}

/** Drop the v1 tables and apply the v2 DDL, in one transaction. → 'already-v2' | 'migrated' */
export async function migrate(client, { ddl = fs.readFileSync(DDL_FILE, 'utf8') } = {}) {
    await client.query('BEGIN');
    try {
        // Checked again inside the transaction that drops.
        const found = await discover(client);
        if (found.v2) { await client.query('ROLLBACK'); return 'already-v2'; }
        if (found.dependents.length) throw new Error(`refused: ${found.dependents.map(item => `${item.kind} ${item.object}`).join(', ')} depend(s) on the v1 tables`);
        for (const table of found.tables) {
            await client.query(`DROP TABLE ${table.name}`);
            log(`dropped ${table.name} (${table.rows} row(s))`);
        }
        await client.query(ddl);
        await client.query('COMMIT');
        log('applied db/property-offer-ddl.sql');
        return 'migrated';
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function main(argv) {
    let options;
    try {
        options = parseArgs({ args: argv, options: { apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
            'env-file': { type: 'string', default: path.join(BACKEND_DIR, '.env') } } }).values;
    } catch (error) { console.error(error.message); usage(2); }
    if (options.help) usage(0);
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: options['env-file'], quiet: true });
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (backend/.env or --env-file)');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        const found = await discover(client);
        report(found);
        if (!options.apply) return log('report only; rerun with --apply to migrate');
        if (found.dependents.length) process.exitCode = 1;
        else log(`result: ${await migrate(client)}`);
    } finally { await client.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch(error => { console.error(`[${new Date().toISOString()}] failed: ${error.message}`); process.exit(1); });
}
