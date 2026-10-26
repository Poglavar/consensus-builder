#!/usr/bin/env node
// Uses the existing backend DB access. No public dashboard and no new credentials.
import { createPool } from '../db/connection.cjs';
import { readPlanningUsage } from '../operations/planning-usage.js';
import { createDiagnosticStore } from '../operations/planning-diagnostics.js';
const args = process.argv.slice(2);
const allowed = new Set(['--days', '--diagnostics', '--prune-diagnostics']);
let days = 30;
for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error('Usage: planning-usage.mjs [--days 1..365] [--diagnostics] [--prune-diagnostics]');
    if (args[i] === '--days') days = Number(args[++i]);
}
if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
let pool;
try {
    pool = createPool({ connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'ugt-private-planning-report' });
    if (args.includes('--prune-diagnostics')) {
        const result = await createDiagnosticStore(pool).insert([]);
        if (result.unavailable || result.busy) throw new Error('Diagnostic cleanup unavailable');
    }
    console.log(JSON.stringify(await readPlanningUsage(pool, { days, diagnostics: args.includes('--diagnostics') }), null, 2));
} catch {
    console.error('Planning report unavailable. Check existing DB access, publication tables and optional diagnostic schema. No connection details are printed.');
    process.exitCode = 1;
} finally { await pool?.end(); }
