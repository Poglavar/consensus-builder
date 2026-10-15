// Export and merge topology history by content, preserving local records and remapping every foreign key.
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { TOPOLOGY_TABLES, contentIdentity, remapReferences, mutableConflict } from './lib/topology-sync.js';

const { values: args } = parseArgs({ options: {
    export: { type: 'string' }, import: { type: 'string' }, apply: { type: 'boolean' },
    receipt: { type: 'string' }, source: { type: 'string' }, help: { type: 'boolean' }
} });
const log = message => console.error(`[${new Date().toISOString()}] ${message}`);
if (args.help || (!args.export && !args.import)) {
    console.log('Usage: node --env-file=.env scripts/sync-topology-state.mjs --export FILE --source LABEL\n'
        + '       node --env-file=.env scripts/sync-topology-state.mjs --import FILE [--apply] [--receipt FILE]');
    process.exit(0);
}
if (args.export && args.import) throw new Error('Choose export or import');
const pool = new pg.Pool({
    host: process.env.PGHOST === 'db' ? 'localhost' : process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432, user: process.env.PGUSER,
    password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
    connectionTimeoutMillis: 10_000, statement_timeout: 120_000
});
const client = await pool.connect();

function selection(table) {
    const geom = TOPOLOGY_TABLES[table].geometry;
    return geom
        ? `to_jsonb(t) - '${geom}' || jsonb_build_object('${geom}',encode(ST_AsEWKB(t.${geom}),'hex')) AS record`
        : 'to_jsonb(t) AS record';
}

async function* tableRows(table) {
    let after = '0';
    for (;;) {
        const { rows } = await client.query(`SELECT ${selection(table)} FROM public.${table} t WHERE id > $1 ORDER BY id LIMIT 50`, [after]);
        if (!rows.length) break;
        for (const row of rows) yield row.record;
        after = String(rows.at(-1).record.id);
    }
}

async function exportState() {
    const fd = fs.openSync(args.export, 'wx', 0o600);
    const counts = {};
    const identities = {};
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        fs.writeSync(fd, JSON.stringify({ format: 'topology-state-v1', source: args.source || 'unspecified', exported_at: new Date().toISOString() }) + '\n');
        for (const table of Object.keys(TOPOLOGY_TABLES)) {
            identities[table] = new Map();
            counts[table] = 0;
            for await (const record of tableRows(table)) {
                const fingerprint = contentIdentity(table, record, identities);
                identities[table].set(String(record.id), fingerprint);
                fs.writeSync(fd, JSON.stringify({ table, fingerprint, record }) + '\n');
                counts[table]++;
            }
            log(`exported ${table}: ${counts[table]}`);
        }
        fs.writeSync(fd, JSON.stringify({ end: true, counts }) + '\n');
        await client.query('COMMIT');
        console.log(JSON.stringify({ exported: args.export, counts }));
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { fs.closeSync(fd); }
}

async function importState() {
    const identities = {}, existing = {}, mappings = {}, columns = {}, changes = {}, deferred = [];
    const report = { source: null, applied: !!args.apply, counts: {}, started_at: new Date().toISOString() };
    await client.query('BEGIN');
    try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('topology-state-merge'))");
        // Writers cannot allocate IDs while the merge reserves and checks references.
        if (args.apply) await client.query('LOCK TABLE ' + Object.keys(TOPOLOGY_TABLES).map(t => `public.${t}`).join(',') + ' IN SHARE ROW EXCLUSIVE MODE');
        for (const table of Object.keys(TOPOLOGY_TABLES)) {
            identities[table] = new Map(); existing[table] = new Map(); mappings[table] = new Map();
            changes[table] = { inserted: 0, updated: 0, matched: 0 };
            const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows;
            columns[table] = cols.map(r => r.column_name);
            for await (const row of tableRows(table)) {
                const fingerprint = contentIdentity(table, row, identities);
                identities[table].set(String(row.id), fingerprint);
                existing[table].set(fingerprint, row);
            }
        }
        const seen = {}, totals = {};
        const lines = createInterface({ input: fs.createReadStream(args.import), crlfDelay: Infinity });
        let ended = false;
        for await (const line of lines) {
            const item = JSON.parse(line);
            if (item.format) { if (item.format !== 'topology-state-v1') throw new Error('Unknown export format'); report.source = item.source; continue; }
            if (item.end) {
                ended = true;
                for (const [t, n] of Object.entries(item.counts)) if ((totals[t] || 0) !== n) throw new Error(`Incomplete ${t}: ${totals[t] || 0}/${n}`);
                continue;
            }
            if (ended) throw new Error('Rows after end marker');
            const { table, fingerprint, record } = item;
            if (!TOPOLOGY_TABLES[table]) throw new Error(`Unknown table ${table}`);
            seen[table] ??= new Map();
            const calculated = contentIdentity(table, record, seen);
            if (calculated !== fingerprint) throw new Error(`Corrupt identity ${table}/${record.id}`);
            seen[table].set(String(record.id), fingerprint);
            totals[table] = (totals[table] || 0) + 1;
            for (const key of Object.keys(record)) if (!columns[table].includes(key)) throw new Error(`Target lacks ${table}.${key}`);
            const matched = existing[table].get(fingerprint);
            let targetId;
            if (matched) {
                targetId = String(matched.id);
                if (mutableConflict(record, matched)) {
                    changes[table].updated++;
                    deferred.push({ table, record, targetId, update: true });
                } else changes[table].matched++;
            } else {
                changes[table].inserted++;
                targetId = args.apply
                    ? String((await client.query("SELECT nextval(pg_get_serial_sequence($1,'id')) AS id", [`public.${table}`])).rows[0].id)
                    : `new:${table}:${record.id}`;
                deferred.push({ table, record, targetId, update: false });
                existing[table].set(fingerprint, { ...record, id: targetId });
            }
            mappings[table].set(String(record.id), targetId);
        }
        if (!ended) throw new Error('Export has no end marker; refusing partial input');
        // Allocate identities first, then insert with self-references temporarily null. This handles
        // parent chains and supersession links even when the referenced ID occurs later in the dump.
        for (const item of deferred) {
            const row = { ...remapReferences(item.table, item.record, mappings), id: item.targetId };
            if (!args.apply) continue;
            const spec = TOPOLOGY_TABLES[item.table];
            for (const [key, target] of Object.entries(spec.refs)) if (target === item.table && row[key] != null) row[key] = null;
            const cols = columns[item.table].filter(c => c in row);
            if (item.update) {
                const mutable = cols.filter(c => c !== 'id');
                await client.query(`UPDATE public.${item.table} t SET (${mutable.join(',')}) = (SELECT ${mutable.join(',')} FROM jsonb_populate_record(NULL::public.${item.table},$1::jsonb)) WHERE id=$2`, [JSON.stringify(row), item.targetId]);
            } else {
                await client.query(`INSERT INTO public.${item.table} (${cols.join(',')}) SELECT ${cols.join(',')} FROM jsonb_populate_record(NULL::public.${item.table},$1::jsonb)`, [JSON.stringify(row)]);
            }
        }
        for (const item of deferred) {
            const row = remapReferences(item.table, item.record, mappings);
            if (!args.apply) continue;
            for (const [key, target] of Object.entries(TOPOLOGY_TABLES[item.table].refs)) {
                if (target === item.table && row[key] != null) await client.query(`UPDATE public.${item.table} SET ${key}=$1 WHERE id=$2`, [row[key], item.targetId]);
            }
        }
        report.counts = changes;
        report.finished_at = new Date().toISOString();
        await client.query(args.apply ? 'COMMIT' : 'ROLLBACK');
        if (args.receipt) fs.writeFileSync(args.receipt, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify(report));
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

try { if (args.export) await exportState(); else await importState(); }
finally { client.release(); await pool.end(); }
