#!/usr/bin/env node
// Private maintainer access; no public GET endpoint exposes reports.
import pg from 'pg';
const args = process.argv.slice(2);
if (!args.includes('--list') && !args.includes('--id')) {
    console.log('Usage: node --env-file=.env scripts/feedback-inbox.mjs --list [--limit 20] | --id <receipt-UUID>');
} else {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
        if (args.includes('--id')) {
            const id = args[args.indexOf('--id') + 1];
            if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw new Error('Supply a receipt UUID');
            const { rows } = await pool.query('SELECT id, kind, message, page_url, source, created_at FROM consensus.feedback WHERE id = $1::uuid', [id]);
            console.log(JSON.stringify(rows, null, 2));
        } else {
            const value = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 20;
            if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('limit must be 1–100');
            const { rows } = await pool.query('SELECT id, kind, left(message, 160) AS summary, page_url, source, created_at FROM consensus.feedback ORDER BY created_at DESC LIMIT $1', [value]);
            console.log(JSON.stringify(rows, null, 2));
        }
    } finally { await pool.end(); }
}
