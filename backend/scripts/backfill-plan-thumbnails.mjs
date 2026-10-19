#!/usr/bin/env node
// Restartable backfill for whole-plan image pairs. Dry run by default; writes require an explicit
// public origin so stored image URLs cannot accidentally point at localhost or a guessed host.
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { createPool, isLocalDatabase } from '../db/connection.cjs';
import { generateAndStorePlanThumbnail } from '../thumbnails/plan-thumbnail.js';

const USAGE = `
Backfill whole-plan before/after thumbnails for named plans.

Usage:
  node scripts/backfill-plan-thumbnails.mjs [options]

Options:
  --apply                 Render and write images and database URLs. Default is dry run.
  --base-url <url>        Required with --apply; public API origin, e.g. https://api.example.org.
  --slug <slug[,slug...]> Restrict to named plan slug(s).
  --limit <n>             Process at most n plans.
  --help                  Print this help.

Environment: DATABASE_URL (read from backend/.env unless already set).
Only plans with a complete, unchanged member-hash snapshot and no before image are candidates.
`;

function parseArgs(argv) {
    const args = { apply: false, help: false, baseUrl: null, slugs: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--help': case '-h': args.help = true; break;
            case '--apply': args.apply = true; break;
            case '--dry-run': args.apply = false; break;
            case '--base-url': args.baseUrl = next(); if (!args.baseUrl) throw new Error('--base-url requires a value'); break;
            case '--slug':
                args.slugs = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
                if (!args.slugs.length) throw new Error('--slug requires at least one slug');
                break;
            case '--limit':
                args.limit = Number(next());
                if (!Number.isSafeInteger(args.limit) || args.limit <= 0) throw new Error('--limit must be a positive integer');
                break;
            default: throw new Error(`Unknown option: ${arg}`);
        }
    }
    return args;
}

const log = (...parts) => console.log(`[${new Date().toISOString()}]`, ...parts);
const logError = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

export async function runBackfill(pool, args) {
    const clauses = ['thumbnail_before_url IS NULL', 'thumbnail_pair_url IS NULL', 'member_hashes IS NOT NULL', 'plan_hash IS NOT NULL'];
    const params = [];
    if (args.slugs?.length) {
        params.push(args.slugs);
        clauses.push(`slug = ANY($${params.length}::text[])`);
    }
    const limitSql = args.limit ? `LIMIT ${args.limit}` : '';
    const { rows } = await pool.query(`SELECT slug FROM ens_plan WHERE ${clauses.join(' AND ')} ORDER BY slug ${limitSql}`, params);
    log(`${args.apply ? 'Applying' : 'Dry run:'} ${rows.length} plan thumbnail(s).`);
    const stats = { total: rows.length, rendered: 0, skipped: 0, failed: 0 };
    for (let i = 0; i < rows.length; i++) {
        const slug = rows[i].slug;
        const started = Date.now();
        try {
            const result = await generateAndStorePlanThumbnail(pool, slug, { baseUrl: args.baseUrl || '', dryRun: !args.apply });
            if (!result) {
                stats.skipped++;
                log(`[${i + 1}/${rows.length}] ${slug}: SKIP — no complete geometry or member snapshot changed`);
                continue;
            }
            stats.rendered++;
            log(`[${i + 1}/${rows.length}] ${slug}: ${args.apply ? 'SAVED' : 'WOULD SAVE'} ` +
                `(${result.tiles.loaded}/${result.tiles.total} tiles, ${Date.now() - started} ms)`);
        } catch (error) {
            stats.failed++;
            logError(`[${i + 1}/${rows.length}] ${slug}: FAILED after ${Date.now() - started} ms`, error);
        }
    }
    log(`Done: ${stats.rendered} rendered, ${stats.skipped} skipped, ${stats.failed} failed.`);
    if (stats.failed) process.exitCode = 1;
    return stats;
}

async function main() {
    let args;
    try { args = parseArgs(process.argv.slice(2)); }
    catch (error) { logError(error.message); console.error(USAGE); process.exitCode = 2; return; }
    if (args.help || process.argv.length <= 2) { console.log(USAGE); return; }
    if (args.apply) {
        if (!args.baseUrl) args.baseUrl = process.env.PUBLIC_API_BASE_URL || null;
        let parsed;
        try { parsed = args.baseUrl ? new URL(args.baseUrl) : null; } catch (_) { parsed = null; }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            logError('--apply requires --base-url <origin> or PUBLIC_API_BASE_URL, with no path, query, or fragment.');
            console.error(USAGE);
            process.exitCode = 2;
            return;
        }
        args.baseUrl = parsed.origin;
    }
    const pool = createPool();
    try {
        if (!args.apply && !isLocalDatabase()) log('Connected to a remote database; DRY RUN only.');
        await runBackfill(pool, args);
    } catch (error) {
        logError('Plan thumbnail backfill failed:', error);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
