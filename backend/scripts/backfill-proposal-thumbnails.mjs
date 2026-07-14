#!/usr/bin/env node
// Backfill proposal thumbnails: give every proposal a hosted thumbnail image and a screenshot_url.
//
// Two kinds of work, decided per proposal:
//   MIGRATE — proposal_data already carries a base64 `screenshotDataUrl` (what a wallet-less upload
//             produced). Decode it and store it as a real file; do NOT re-render, the picture exists.
//   RENDER  — no image at all. Render one server-side from the proposal's geometry.
//
// Idempotent and restartable: it only ever touches rows where screenshot_url IS NULL, so a rerun
// picks up exactly what an interrupted run left behind. DRY RUN IS THE DEFAULT — pass --apply to write.
//
// The destructive part (dropping the now-redundant base64 blob out of proposal_data) is a SEPARATE
// pass (--strip-data-urls), and it only strips rows whose hosted file is confirmed present, so the
// image can never be deleted before its replacement is real.
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import pkg from 'pg';
import fs from 'fs';
import path from 'path';
import {
    generateAndStoreProposalThumbnail,
    shouldSkipProposalThumbnail,
    resolveProposalGoalKey
} from '../thumbnails/proposal-thumbnail.js';
import { saveImageBuffer, decodeImageDataUrl, imageFileExists } from '../utils/image-store.js';

const { Pool } = pkg;

const USAGE = `
Backfill thumbnails for proposals that have none.

Usage:
  node scripts/backfill-proposal-thumbnails.mjs [options]

Options:
  --apply                 Actually write (DB + image files). Without it the script is a DRY RUN.
  --base-url <url>        Origin the stored images are served from.
                          (default: $PUBLIC_API_BASE_URL or http://localhost:3000)
  --city <id>             Only proposals of this city (e.g. zagreb, new_york).
  --id <n[,n...]>         Only these proposal table ids.
  --limit <n>             Process at most n proposals.
  --out-dir <dir>         Also write each rendered PNG here (handy for eyeballing a dry run).
  --strip-data-urls       SEPARATE PASS: remove the redundant base64 screenshotDataUrl from
                          proposal_data for rows that already have a working hosted file.
                          Still honours --apply / dry run.
  --help                  Print this help and exit without doing anything.

Environment: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE (read from backend/.env unless already set).
`;

function parseArgs(argv) {
    const args = { apply: false, help: false, stripDataUrls: false, limit: null, city: null, ids: null, outDir: null, baseUrl: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--help': case '-h': args.help = true; break;
            case '--apply': args.apply = true; break;
            case '--dry-run': args.apply = false; break;
            case '--strip-data-urls': args.stripDataUrls = true; break;
            case '--limit': args.limit = Number(next()); break;
            case '--city': args.city = next(); break;
            case '--id': args.ids = String(next()).split(',').map(v => Number(v.trim())).filter(Number.isFinite); break;
            case '--out-dir': args.outDir = next(); break;
            case '--base-url': args.baseUrl = next(); break;
            default:
                console.error(`Unknown option: ${arg}`);
                args.help = true;
        }
    }
    return args;
}

const log = (...parts) => console.log(`[${new Date().toISOString()}]`, ...parts);
const logError = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

function buildWhere(args, extraClauses = []) {
    const clauses = [...extraClauses];
    const params = [];
    if (args.city) {
        params.push(args.city);
        clauses.push(`city = $${params.length}`);
    }
    if (args.ids && args.ids.length) {
        params.push(args.ids);
        clauses.push(`id = ANY($${params.length}::int[])`);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function runBackfill(pool, args) {
    const { where, params } = buildWhere(args, ['screenshot_url IS NULL']);
    const limitSql = Number.isFinite(args.limit) && args.limit > 0 ? `LIMIT ${args.limit}` : '';
    const { rows } = await pool.query(
        `SELECT id, proposal_id, city, type, proposal_data
         FROM proposal
         ${where}
         ORDER BY id ASC
         ${limitSql}`,
        params
    );

    log(`Found ${rows.length} proposal(s) without screenshot_url.`);

    const stats = { total: rows.length, migrated: 0, rendered: 0, skipped: 0, failed: 0 };
    const failures = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const proposal = row.proposal_data || {};
        const label = `#${row.id} (${row.proposal_id} · ${row.type || '?'} · ${row.city || '?'})`;
        const progress = `[${i + 1}/${rows.length}]`;
        const startedAt = Date.now();

        try {
            if (shouldSkipProposalThumbnail(proposal)) {
                log(`${progress} ${label} SKIP — goal '${resolveProposalGoalKey(proposal)}' has no map geometry`);
                stats.skipped++;
                continue;
            }

            const existingDataUrl = typeof proposal.screenshotDataUrl === 'string' ? proposal.screenshotDataUrl : null;

            // MIGRATE: the image already exists as base64; move it to a file, never re-render it.
            if (existingDataUrl) {
                const decoded = decodeImageDataUrl(existingDataUrl);
                if (!decoded || !decoded.buffer.length) {
                    throw new Error('screenshotDataUrl is not a decodable, non-empty base64 data URL');
                }
                const fileNameBase = `proposal-thumb-${row.id}-${Date.now()}`;
                if (!args.apply) {
                    log(`${progress} ${label} MIGRATE (dry run) — ${decoded.buffer.length} bytes of ${decoded.contentType} would become ${args.baseUrl}/uploads/images/${fileNameBase}.${decoded.extension}`);
                    if (args.outDir) {
                        fs.writeFileSync(path.join(args.outDir, `proposal-${row.id}-migrated.${decoded.extension}`), decoded.buffer);
                    }
                    stats.migrated++;
                    continue;
                }
                const { imagePath } = saveImageBuffer(decoded.buffer, fileNameBase, decoded.extension);
                const url = `${args.baseUrl.replace(/\/$/, '')}${imagePath}`;
                await pool.query(
                    `UPDATE proposal SET screenshot_url = $1, updated_at = NOW() WHERE id = $2 AND screenshot_url IS NULL`,
                    [url, row.id]
                );
                log(`${progress} ${label} MIGRATED — ${decoded.buffer.length} bytes → ${url} (${Date.now() - startedAt}ms)`);
                stats.migrated++;
                continue;
            }

            // RENDER: no image anywhere — draw one from the proposal's geometry.
            const result = await generateAndStoreProposalThumbnail(pool, proposal, {
                city: row.city,
                proposalId: row.id,
                baseUrl: args.baseUrl,
                dryRun: !args.apply
            });

            if (!result) {
                log(`${progress} ${label} SKIP — no usable geometry`);
                stats.skipped++;
                continue;
            }

            if (args.outDir) {
                fs.writeFileSync(path.join(args.outDir, `proposal-${row.id}-${row.type || 'x'}.png`), result.buffer);
            }

            if (!args.apply) {
                log(`${progress} ${label} RENDER (dry run) — zoom ${result.frame.zoom}, ${result.frame.tilesX}x${result.frame.tilesY} tiles (${result.tiles.loaded} ok/${result.tiles.failed} failed), ${result.bytes} bytes (${Date.now() - startedAt}ms)`);
                stats.rendered++;
                continue;
            }

            await pool.query(
                `UPDATE proposal SET screenshot_url = $1, updated_at = NOW() WHERE id = $2 AND screenshot_url IS NULL`,
                [result.url, row.id]
            );
            log(`${progress} ${label} RENDERED — ${result.url} (zoom ${result.frame.zoom}, ${result.tiles.loaded}/${result.tiles.total} tiles, ${result.bytes} bytes, ${Date.now() - startedAt}ms)`);
            stats.rendered++;
        } catch (err) {
            stats.failed++;
            failures.push(`${label}: ${err.message}`);
            logError(`${progress} ${label} FAILED — ${err.message}`);
        }
    }

    log('─'.repeat(70));
    log(`${args.apply ? 'APPLIED' : 'DRY RUN'} summary: ${stats.total} candidate(s) — ` +
        `${stats.migrated} migrated (base64 → file), ${stats.rendered} rendered, ` +
        `${stats.skipped} skipped (no geometry), ${stats.failed} failed`);
    if (failures.length) {
        logError(`${failures.length} failure(s):`);
        failures.forEach(f => logError(`  - ${f}`));
    }
    return stats.failed === 0;
}

// Separate destructive pass: drop the base64 blob from proposal_data once a hosted file exists.
async function runStripDataUrls(pool, args) {
    const { where, params } = buildWhere(args, [
        `screenshot_url IS NOT NULL`,
        `proposal_data ? 'screenshotDataUrl'`
    ]);
    const limitSql = Number.isFinite(args.limit) && args.limit > 0 ? `LIMIT ${args.limit}` : '';
    const { rows } = await pool.query(
        `SELECT id, proposal_id, city, screenshot_url,
                length(proposal_data->>'screenshotDataUrl') AS blob_chars
         FROM proposal
         ${where}
         ORDER BY id ASC
         ${limitSql}`,
        params
    );

    log(`Found ${rows.length} proposal(s) with BOTH a hosted screenshot_url and a redundant base64 blob.`);

    const stats = { total: rows.length, stripped: 0, unverified: 0, failed: 0 };

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const progress = `[${i + 1}/${rows.length}]`;
        const label = `#${row.id} (${row.proposal_id})`;
        try {
            // Only strip when the replacement is real. Locally-hosted files are checked on disk;
            // anything else (IPFS gateway, other origin) is checked over HTTP.
            const isLocalUpload = /\/uploads\/images\/[^/]+$/.test(row.screenshot_url);
            let reachable = false;
            if (isLocalUpload) {
                reachable = imageFileExists(row.screenshot_url.split('/').pop());
            } else {
                const response = await fetch(row.screenshot_url, { method: 'HEAD' });
                reachable = response.ok;
            }

            if (!reachable) {
                log(`${progress} ${label} KEEP — hosted image not reachable (${row.screenshot_url}); refusing to strip`);
                stats.unverified++;
                continue;
            }

            if (!args.apply) {
                log(`${progress} ${label} STRIP (dry run) — would free ${row.blob_chars} chars of base64 from proposal_data`);
                stats.stripped++;
                continue;
            }

            await pool.query(
                `UPDATE proposal
                 SET proposal_data = proposal_data - 'screenshotDataUrl', updated_at = NOW()
                 WHERE id = $1`,
                [row.id]
            );
            log(`${progress} ${label} STRIPPED — freed ${row.blob_chars} chars (image lives at ${row.screenshot_url})`);
            stats.stripped++;
        } catch (err) {
            stats.failed++;
            logError(`${progress} ${label} FAILED — ${err.message}`);
        }
    }

    log('─'.repeat(70));
    log(`${args.apply ? 'APPLIED' : 'DRY RUN'} strip summary: ${stats.total} candidate(s) — ` +
        `${stats.stripped} stripped, ${stats.unverified} kept (image unverified), ${stats.failed} failed`);
    return stats.failed === 0;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        process.exit(0);
    }

    args.baseUrl = args.baseUrl || process.env.PUBLIC_API_BASE_URL || 'http://localhost:3000';
    if (args.outDir) {
        fs.mkdirSync(args.outDir, { recursive: true });
    }

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });

    log(`Mode: ${args.apply ? 'APPLY (writes DB + files)' : 'DRY RUN (no writes)'}${args.stripDataUrls ? ' · strip-data-urls pass' : ''}`);
    log(`Database: ${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`);
    log(`Image base URL: ${args.baseUrl}`);
    if (args.city) log(`City filter: ${args.city}`);
    if (args.ids) log(`Id filter: ${args.ids.join(', ')}`);
    if (args.outDir) log(`Writing PNG copies to: ${args.outDir}`);

    let ok = false;
    try {
        ok = args.stripDataUrls ? await runStripDataUrls(pool, args) : await runBackfill(pool, args);
    } finally {
        await pool.end();
    }
    process.exit(ok ? 0 : 1);
}

main().catch(err => {
    logError('Fatal:', err);
    process.exit(1);
});
