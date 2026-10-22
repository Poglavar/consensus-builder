#!/usr/bin/env node
// End of M3 (plan-design-agreement.md): drops the proposal-era database objects once designs and
// agreements carry everything: the proposal table (wherever it lives: public locally, consensus on the
// server) with its indexes, constraints, triggers and owned sequences, the named-plan table ens_plan,
// consensus.proposal_prepared and consensus.proposal_owner_decision, the proposal_*backup* tables the
// proposal-row migrations left behind, and the immutability trigger functions of
// backend/db/publication-immutability.sql (the named-plan one too: M2 removed it from that file, but a
// database that applied the earlier file still holds it). Markets on proposal accounts are proposal_market program
// accounts on chain: the database holds no market rows (routes/markets.js reads the agreement index and
// the chain), so there is nothing of theirs to drop here.
//
// --dry-run lists every object, its rows and size, what is dropped with it, and anything
// outside the set that depends on it (which makes --apply refuse: nothing is ever dropped with CASCADE).
// --backup DIR writes a pg_dump (custom format) of every table, the function definitions and a manifest,
// and verifies each dump with pg_restore --list. --apply backs up first and refuses unless that backup
// completed in the same run; it then drops everything in ONE transaction, after checking under lock that
// no table changed since its dump. A second --apply finds nothing and changes nothing. The DDL list of
// backend/deploy-backend.sh is not edited here: the lines to remove are printed.
//
//   node scripts/drop-proposal-era.mjs --dry-run                # list only
//   node scripts/drop-proposal-era.mjs --backup ~/backups/m3    # dumps only
//   node scripts/drop-proposal-era.mjs --backup ~/backups/m3 --apply
// The connection is DATABASE_URL from backend/.env (or --env-file); it is never printed. The steps are
// exported (dropProposalEra runs them on a connected client) so they can be tested without a database.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = ['public', 'consensus'];
// The proposal-era tables by name; a name is looked up in both schemas.
const TABLES = ['proposal', 'ens_plan', 'proposal_prepared', 'proposal_owner_decision'];
// Backups the proposal-row migrations wrote (proposal_site_backup_v1, proposal_borovje_flat_backup, …).
const BACKUP_TABLE_PATTERN = 'proposal\\_%backup%';
// backend/db/publication-immutability.sql: the triggers go with the proposal and ens_plan tables, the
// functions do not. enforce_named_plan_publication left that file in M2 but stays in databases that applied it.
const FUNCTIONS = ['enforce_proposal_publication', 'enforce_named_plan_publication'];
// The DDL files whose entries leave backend/deploy-backend.sh's DDL_FILES (and its comment about them).
const DEPLOY_DDL_PATTERN = /proposals-ddl\.sql|proposal-site-ddl\.sql|proposal-thumbnail-ddl\.sql|proposal-owner-decision-ddl\.sql|proposal-prepared-ddl\.sql|publication-immutability\.sql/;

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const ident = name => `"${String(name).replace(/"/g, '""')}"`;
const qualified = ({ schema, name }) => `${ident(schema)}.${ident(name)}`;
const label = ({ schema, name }) => `${schema}.${name}`;
const mb = bytes => `${(Number(bytes) / 1048576).toFixed(2)} MB`;

function usage(code) {
    console.log([
        'Drop the proposal-era database objects (end of M3). Nothing runs without a parameter.',
        '',
        '  --dry-run              List what would be dropped, with rows, sizes and dependents; write nothing',
        '  --backup DIR           pg_dump every table (custom format), the function definitions and a manifest',
        '                         into DIR, each dump verified with pg_restore --list',
        '  --apply                Back up (needs --backup DIR), then drop everything in one transaction',
        '  --role NAME            Role for the drop (default geo_user, the owner of geodata objects)',
        '  --no-role              Drop as the connecting user',
        '  --env-file FILE        Where DATABASE_URL is read from (default backend/.env)',
        '  --pg-dump PATH         pg_dump binary (default pg_dump); --pg-restore PATH likewise',
        '  --deploy-script FILE   The deploy script whose DDL lines are printed (default backend/deploy-backend.sh)',
        '  --help                 This text'
    ].join('\n'));
    process.exit(code);
}

function parseCli(argv) {
    if (!argv.length) usage(0);
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                'dry-run': { type: 'boolean', default: false },
                backup: { type: 'string' },
                apply: { type: 'boolean', default: false },
                role: { type: 'string', default: 'geo_user' },
                'no-role': { type: 'boolean', default: false },
                'env-file': { type: 'string', default: path.join(BACKEND_DIR, '.env') },
                'pg-dump': { type: 'string', default: 'pg_dump' },
                'pg-restore': { type: 'string', default: 'pg_restore' },
                'deploy-script': { type: 'string', default: path.join(BACKEND_DIR, 'deploy-backend.sh') },
                help: { type: 'boolean', default: false }
            }
        }).values;
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (parsed.help) usage(0);
    // Checked first: otherwise --apply alone fell into the generic "choose a mode" refusal below.
    if (parsed.apply && !parsed.backup) {
        console.error('--apply needs --backup DIR: nothing is dropped without a backup made in the same run');
        usage(2);
    }
    if (!parsed['dry-run'] && !parsed.backup) {
        console.error('choose --dry-run, --backup DIR, or --backup DIR --apply');
        usage(2);
    }
    if (parsed.apply && parsed['dry-run']) {
        console.error('--apply and --dry-run exclude each other');
        usage(2);
    }
    if (parsed.role !== undefined && !/^[a-z_][a-z0-9_]*$/.test(parsed.role)) {
        console.error(`--role must be a plain role name, got ${JSON.stringify(parsed.role)}`);
        usage(2);
    }
    return parsed;
}

// ---- discovery (read-only) ---------------------------------------------------------------------------

export async function discover(client) {
    const { rows: tables } = await client.query(`
        SELECT c.oid::int8 AS oid, c.reltype::int8 AS reltype, n.nspname AS schema, c.relname AS name,
               pg_get_userbyid(c.relowner) AS owner, pg_total_relation_size(c.oid)::int8 AS bytes,
               (c.relname LIKE $3 ESCAPE '\\') AS backup
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[])
           AND (c.relname = ANY($2::text[]) OR c.relname LIKE $3 ESCAPE '\\')
         ORDER BY n.nspname, c.relname`, [SCHEMAS, TABLES, BACKUP_TABLE_PATTERN]);
    for (const table of tables) {
        table.rows = Number((await client.query(`SELECT count(*)::int8 AS n FROM ${qualified(table)}`)).rows[0].n);
        const owned = await client.query(`
            SELECT 'index' AS kind, i.indexrelid::regclass::text AS name FROM pg_index i WHERE i.indrelid = $1
            UNION ALL
            SELECT 'trigger', t.tgname || ' (' || p.proname || ')' FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE t.tgrelid = $1 AND NOT t.tgisinternal
            UNION ALL
            SELECT 'sequence', s.oid::regclass::text FROM pg_depend d JOIN pg_class s ON s.oid = d.objid
             WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = $1
               AND s.relkind = 'S' AND d.deptype IN ('a', 'i')
            UNION ALL
            SELECT 'constraint', c.conname FROM pg_constraint c WHERE c.conrelid = $1
            ORDER BY 1, 2`, [table.oid]);
        table.owned = owned.rows;
    }
    const { rows: functions } = await client.query(`
        SELECT p.oid::int8 AS oid, n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = ANY($1::text[]) AND p.proname = ANY($2::text[])
         ORDER BY n.nspname, p.proname`, [SCHEMAS, FUNCTIONS]);
    // Everything outside the set that would break: views and rules over the tables, foreign keys into
    // them, functions taking or returning their row types, triggers elsewhere that call the functions.
    const tableOids = tables.map(table => table.oid);
    const typeOids = tables.map(table => table.reltype);
    const { rows: dependents } = await client.query(`
        SELECT DISTINCT 'view or rule' AS kind, r.ev_class::regclass::text AS object
          FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
         WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
           AND d.refobjid = ANY($1::oid[]) AND NOT (r.ev_class = ANY($1::oid[]))
        UNION
        SELECT 'foreign key', c.conname || ' on ' || c.conrelid::regclass::text
          FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = ANY($1::oid[]) AND NOT (c.conrelid = ANY($1::oid[]))
        UNION
        SELECT 'function', p.oid::regprocedure::text
          FROM pg_proc p WHERE p.prorettype = ANY($2::oid[]) OR p.proargtypes::oid[] && $2::oid[]
        UNION
        SELECT 'trigger', t.tgname || ' on ' || t.tgrelid::regclass::text
          FROM pg_trigger t WHERE t.tgfoid = ANY($3::oid[]) AND NOT (t.tgrelid = ANY($1::oid[]))
        ORDER BY 1, 2`, [tableOids, typeOids, functions.map(fn => fn.oid)]);
    return { tables, functions, dependents };
}

export function report(found) {
    const { tables, functions, dependents } = found;
    if (!tables.length && !functions.length) {
        log('nothing proposal-era is left in this database');
        return;
    }
    log(`${tables.length} table(s) and ${functions.length} function(s) to drop:`);
    for (const table of tables) {
        log(`   table ${label(table)}${table.backup ? ' (migration backup)' : ''}: ${table.rows} row(s), ${mb(table.bytes)}, owner ${table.owner}`);
        for (const item of table.owned) log(`      with it: ${item.kind} ${item.name}`);
    }
    for (const fn of functions) log(`   function ${fn.schema}.${fn.name}(${fn.args})`);
    if (dependents.length) {
        log(`REFUSED: ${dependents.length} object(s) outside the set depend on it; drop or re-point them first (no CASCADE):`);
        for (const item of dependents) log(`   ${item.kind} ${item.object}`);
    } else {
        log('nothing outside the set depends on these objects');
    }
}

export function printDeployLines(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
        log(`cannot read ${file} (${error.code}); remove the proposal-era DDL entries from its DDL_FILES by hand`);
        return;
    }
    const lines = text.split('\n').map((line, index) => ({ number: index + 1, line })).filter(item => DEPLOY_DDL_PATTERN.test(item.line));
    if (!lines.length) {
        log(`${path.basename(file)} lists no proposal-era DDL any more`);
        return;
    }
    log(`remove these ${lines.length} line(s) from ${path.basename(file)} (DDL_FILES and the comment that names them) in the same change as the drop:`);
    for (const item of lines) console.log(`   ${String(item.number).padStart(4)}: ${item.line}`);
}

// ---- backup ------------------------------------------------------------------------------------------

function sha256File(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(binary, args) {
    const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (result.error) throw new Error(`${path.basename(binary)} could not start: ${result.error.message}`);
    // stderr of pg_dump names objects and errors, never the connection string we pass as an argument.
    if (result.status !== 0) throw new Error(`${path.basename(binary)} exited ${result.status}: ${String(result.stderr).trim().slice(0, 500)}`);
    return result.stdout;
}

export function backup(found, { dir, databaseUrl, database, pgDump, pgRestore }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const files = [];
    found.tables.forEach((table, index) => {
        const file = path.join(dir, `${stamp}-${table.schema}.${table.name}.dump`);
        log(`backup ${index + 1}/${found.tables.length}: ${label(table)} (${table.rows} rows) → ${path.basename(file)}`);
        run(pgDump, ['--format=custom', `--table=${qualified(table)}`, `--file=${file}`, `--dbname=${databaseUrl}`]);
        const listing = run(pgRestore, ['--list', file]);
        if (!new RegExp(`TABLE DATA ${table.schema} ${table.name} `).test(listing)) {
            throw new Error(`the dump of ${label(table)} holds no TABLE DATA entry; nothing is dropped`);
        }
        const bytes = fs.statSync(file).size;
        files.push({ object: label(table), rows: table.rows, file: path.basename(file), bytes, sha256: sha256File(file) });
    });
    if (found.functions.length) {
        const file = path.join(dir, `${stamp}-functions.sql`);
        fs.writeFileSync(file, `${found.functions.map(fn => `-- ${fn.schema}.${fn.name}(${fn.args})\n${fn.definition};\n`).join('\n')}`, { mode: 0o600 });
        files.push({ object: 'functions', file: path.basename(file), bytes: fs.statSync(file).size, sha256: sha256File(file) });
        log(`backup: ${found.functions.length} function definition(s) → ${path.basename(file)}`);
    }
    const manifest = {
        comment: 'drop-proposal-era.mjs backup: restore a table with pg_restore --dbname=<url> <file>; functions with psql -f.',
        createdAt: new Date().toISOString(),
        database,
        files
    };
    const manifestFile = path.join(dir, `${stamp}-manifest.json`);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    log(`backup complete: ${files.length} file(s), manifest ${manifestFile}`);
    return manifest;
}

// ---- drop (one transaction) ------------------------------------------------------------------------

export async function drop(client, found, { role }) {
    await client.query('BEGIN');
    try {
        if (role) await client.query(`SET LOCAL ROLE ${ident(role)}`);
        await client.query(`SET LOCAL lock_timeout = '30s'`);
        if (found.tables.length) await client.query(`LOCK TABLE ${found.tables.map(qualified).join(', ')} IN ACCESS EXCLUSIVE MODE`);
        // Nothing may have changed since the dump: the drop would lose it.
        for (const table of found.tables) {
            const now = Number((await client.query(`SELECT count(*)::int8 AS n FROM ${qualified(table)}`)).rows[0].n);
            if (now !== table.rows) throw new Error(`${label(table)} has ${now} rows now, ${table.rows} when it was dumped; run again`);
        }
        if (found.tables.length) await client.query(`DROP TABLE ${found.tables.map(qualified).join(', ')}`);
        for (const fn of found.functions) await client.query(`DROP FUNCTION ${ident(fn.schema)}.${ident(fn.name)}(${fn.args})`);
        const left = await discover(client);
        if (left.tables.length || left.functions.length) throw new Error('objects remained after the drop; rolled back');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
}

/**
 * One run on a connected client, as the CLI's options say (parseCli's values): list; with `backup`, dump
 * (refused while anything outside the set depends on it); with `apply` as well, drop after that dump.
 * @param {{ databaseUrl: () => string, database: object }} connection  the URL pg_dump connects with
 *   (read only when dumping) and the described database the manifest names
 * @returns {Promise<{ found, manifest: object|null, dropped: boolean }>}
 */
export async function dropProposalEra(client, args, { databaseUrl, database }) {
    const found = await discover(client);
    report(found);
    printDeployLines(args['deploy-script']);
    if (!args.backup) {
        log('dry run: nothing written (--backup DIR to dump, --backup DIR --apply to drop)');
        return { found, manifest: null, dropped: false };
    }
    if (found.dependents.length) throw new Error('objects outside the set depend on these tables or functions; nothing was backed up or dropped');
    if (!found.tables.length && !found.functions.length) return { found, manifest: null, dropped: false };
    const dir = path.resolve(args.backup.replace(/^~(?=$|\/)/, os.homedir()));
    const manifest = backup(found, { dir, databaseUrl: databaseUrl(), database, pgDump: args['pg-dump'], pgRestore: args['pg-restore'] });
    if (!args.apply) {
        log('backup only: nothing dropped (add --apply to drop after a fresh backup)');
        return { found, manifest, dropped: false };
    }
    await drop(client, found, { role: args['no-role'] ? null : args.role });
    log(`dropped ${found.tables.length} table(s) and ${found.functions.length} function(s) in one transaction; a rerun finds nothing`);
    return { found, manifest, dropped: true };
}

async function main() {
    const args = parseCli(process.argv.slice(2));
    dotenv.config({ path: args['env-file'], quiet: true });
    const require = (await import('node:module')).createRequire(import.meta.url);
    const { createClient, databaseUrl, describeDatabase } = require('../db/connection.cjs');
    const database = describeDatabase();
    const mode = args.apply ? 'APPLY' : args.backup ? 'backup only' : 'dry run';
    log(`${mode} · database ${database.database} on ${database.host}:${database.port} as ${database.user}`);
    const client = createClient();
    await client.connect();
    try {
        await dropProposalEra(client, args, { databaseUrl, database });
    } finally {
        await client.end();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] drop-proposal-era failed: ${error.message}`);
        process.exit(1);
    });
}
