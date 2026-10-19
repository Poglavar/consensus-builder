#!/usr/bin/env node
// Manual, bounded subscription processing. No daemon, schedule, or paid batch submission.
import dotenv from 'dotenv';
import { createClient } from '../db/connection.cjs';
import { runCliStage } from '../floor-plans/cli-worker.js';
import { siteStageAdapter } from '../floor-plans/adjudicate-sites.js';
import { imageStageAdapter } from '../floor-plans/classify-images.js';
import { planStageAdapter } from '../floor-plans/interpret-plans.js';
import { sheetStageAdapter } from '../floor-plans/sheet-context.js';
import { IMAGE_MAX_OUTPUT_TOKENS } from '../floor-plans/image-reading.js';
dotenv.config({ path: new URL('../.env', import.meta.url), quiet: true });
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
    console.log('Usage: node backend/scripts/floor-plan-cli.mjs --stage buildings|images|plans|sheets [--limit 1..20] [--engine codex|claude] [--model MODEL] [--effort medium|high]\nUses DATABASE_URL and FLOOR_PLAN_ARCHIVE_DIR. Codex defaults to gpt-6.1-sol, high effort. Runs one chunk and exits.');
} else {
    for (let i = 0; i < args.length; i += 2) {
        if (!['--stage', '--limit', '--engine', '--model', '--effort'].includes(args[i]) || !args[i + 1]) throw new Error('Unknown or missing CLI option.');
    }
    const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
    const stage = option('--stage'), engine = option('--engine', 'codex'), limit = Number(option('--limit', '1'));
    // Explicit user choice for this manual workflow, including image triage (2026-10-19).
    const model = option('--model', engine === 'codex' ? 'gpt-6.1-sol' : null);
    const effort = option('--effort', engine === 'codex' ? 'high' : undefined);
    const adapters = { buildings: siteStageAdapter, images: imageStageAdapter, plans: planStageAdapter, sheets: sheetStageAdapter };
    if (!adapters[stage]) throw new Error('Choose buildings, images, plans, or sheets.');
    const db = createClient(); await db.connect();
    try {
        const result = await runCliStage(db, adapters[stage](), { engine, model, effort, limit,
            ...(stage === 'images' ? { maxOutputTokens: IMAGE_MAX_OUTPUT_TOKENS } : {}) });
        console.log(JSON.stringify(result)); if (result.status !== 'complete') process.exitCode = 2;
    } finally { await db.end(); }
}
