#!/usr/bin/env node
// Strip a dead local origin off stored proposal thumbnail URLs so the rows hold the served PATH
// (`/uploads/images/<file>`), which any backend serves and the client resolves against the backend
// it is talking to. Rows pointed at localhost:4583, :3000 and :4927 long after those dev backends
// were gone, so every share dialog and proposal card asked a port nobody listened on.
//
// DRY RUN IS THE DEFAULT; --apply writes, after saving the touched rows' old values to a JSON file.
// Idempotent and restartable: a row already holding a path, or one whose origin is not local, is
// never touched, so a rerun finds nothing to do. --all-origins also strips remote origins (for a
// database whose API is served from one pinned public base and whose clients resolve paths).
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import pkg from 'pg';

const { Pool } = pkg;

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/)/i;
const ANY_ORIGIN = /^https?:\/\/[^/]+(?=\/)/i;

// The path a stored URL should become, or null when the row must stay as it is: not a URL, not a
// local origin (unless allOrigins), or not one of the paths this API serves.
export function relativizeStoredUrl(value, { allOrigins = false } = {}) {
    if (typeof value !== 'string') return null;
    const pattern = allOrigins ? ANY_ORIGIN : LOCAL_ORIGIN;
    if (!pattern.test(value)) return null;
    const served = value.replace(pattern, '');
    return /^\/(?:uploads|images)\//.test(served) ? served : null;
}

const USAGE = `
Turn stored proposal thumbnail URLs with a dead local origin into served paths.

Usage:
  node scripts/relativize-screenshot-urls.mjs [options]

Options:
  --apply          Write the changes. Without it the script is a DRY RUN that prints what it would do.
  --all-origins    Also strip remote origins (https://api.example/...), not only localhost ones.
  --limit <n>      Touch at most n rows.
  --help           Print this help and exit without doing anything.

Environment: DATABASE_URL or PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE (read from backend/.env).
`;

function parseArgs(argv) {
    const args = { apply: false, allOrigins: false, limit: null, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--help': case '-h': args.help = true; break;
            case '--apply': args.apply = true; break;
            case '--all-origins': args.allOrigins = true; break;
            case '--limit': args.limit = Number(argv[++i]); break;
            default:
                console.error(`Unknown argument: ${arg}`);
                args.help = true;
        }
    }
    return args;
}

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(USAGE); return 0; }

    const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
    try {
        const { rows } = await pool.query(
            `SELECT id, proposal_id, screenshot_url FROM proposal WHERE screenshot_url ~ '^https?://' ORDER BY id`
        );
        const changes = [];
        const untouchedByOrigin = new Map();
        rows.forEach(row => {
            const next = relativizeStoredUrl(row.screenshot_url, { allOrigins: args.allOrigins });
            if (next) changes.push({ id: row.id, proposalId: row.proposal_id, from: row.screenshot_url, to: next });
            else {
                const origin = (row.screenshot_url.match(ANY_ORIGIN) || ['?'])[0];
                untouchedByOrigin.set(origin, (untouchedByOrigin.get(origin) || 0) + 1);
            }
        });
        const selected = Number.isFinite(args.limit) && args.limit > 0 ? changes.slice(0, args.limit) : changes;

        log(`${rows.length} row(s) hold an absolute screenshot_url; ${changes.length} would become paths`
            + (selected.length !== changes.length ? ` (limited to ${selected.length})` : '') + '.');
        untouchedByOrigin.forEach((count, origin) => log(`  left as is: ${count} row(s) at ${origin}`));
        selected.slice(0, 5).forEach(change => log(`  ${change.proposalId}: ${change.from} -> ${change.to}`));
        if (!selected.length) { log('Nothing to do.'); return 0; }
        if (!args.apply) { log('DRY RUN — pass --apply to write.'); return 0; }

        const backupDir = path.resolve('uploads/backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupFile = path.join(backupDir, `screenshot-urls-${Date.now()}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(selected, null, 2));
        log(`Saved the ${selected.length} old value(s) to ${backupFile}.`);

        const BATCH = 200;
        let done = 0;
        for (let start = 0; start < selected.length; start += BATCH) {
            const batch = selected.slice(start, start + BATCH);
            // Each row is guarded by its old value, so a concurrent change is never overwritten.
            await pool.query(
                `UPDATE proposal AS p SET screenshot_url = v.next, updated_at = NOW()
                 FROM UNNEST($1::int[], $2::text[], $3::text[]) AS v(id, prev, next)
                 WHERE p.id = v.id AND p.screenshot_url = v.prev`,
                [batch.map(c => c.id), batch.map(c => c.from), batch.map(c => c.to)]
            );
            done += batch.length;
            log(`${done}/${selected.length} row(s) updated.`);
        }
        const { rows: remaining } = await pool.query(
            `SELECT count(*)::int AS n FROM proposal WHERE screenshot_url ~ '^https?://(localhost|127\\.0\\.0\\.1)'`
        );
        log(`Done. ${remaining[0].n} row(s) still carry a localhost origin.`);
        return 0;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });
}
