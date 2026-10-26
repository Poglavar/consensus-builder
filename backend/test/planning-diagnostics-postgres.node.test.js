// Runs only against an explicitly supplied, disposable test DB. No production defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createDiagnosticStore, validateDiagnosticReport, MAX_ROWS } from '../operations/planning-diagnostics.js';
import { readPlanningUsage } from '../operations/planning-usage.js';
const D = createRequire(import.meta.url)('../../frontend/js/app-diagnostics.js');
test('PostgreSQL enforces atomic dedupe/conflict, row/age bounds and aggregate semantics', { skip: !process.env.UGT_DIAGNOSTIC_TEST_DB }, async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.UGT_DIAGNOSTIC_TEST_DB, max: 3, statement_timeout: 10000 });
    try {
        await pool.query('CREATE SCHEMA IF NOT EXISTS consensus');
        await pool.query(readFileSync(new URL('../db/planning-diagnostics.sql', import.meta.url), 'utf8'));
        await pool.query('TRUNCATE consensus.planning_diagnostic');
        for (const name of ['plan', 'design', 'agreement']) {
            await pool.query(`CREATE TABLE IF NOT EXISTS consensus.${name} (cid text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`);
            await pool.query(`TRUNCATE consensus.${name}`);
        }
        const d = D.create({ uuid: randomUUID });
        d.event('create', 'success', { entity: 'plan', planKey: 'one local composition' });
        d.event('save', 'success', { entity: 'plan', planKey: 'one local composition' });
        const rows = validateDiagnosticReport({ version: 1, entries: d.snapshot().entries.map(D.wire) }).value;
        const store = createDiagnosticStore(pool);
        assert.deepEqual(await store.insert(rows), { accepted: 2 });
        assert.deepEqual(await store.insert(rows), { accepted: 2 });
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM consensus.planning_diagnostic')).rows[0].n, 2);
        const conflicting = { ...rows[0], outcome: 'failure' };
        assert.equal((await store.insert([{ ...rows[1], id: randomUUID() }, conflicting])).conflict, true);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM consensus.planning_diagnostic')).rows[0].n, 2);
        // Two revisions are two publication records, never two people or two unique local plans.
        await pool.query("INSERT INTO consensus.plan(cid) VALUES ('revision-one'), ('revision-two')");
        const report = await readPlanningUsage(pool, { diagnostics: true });
        assert.equal(report.publicationRecords.daily[0].revisions, 2);
        assert.equal(report.diagnostics.handles[0].observed_sessions, 1);
        assert.equal(report.diagnostics.handles[0].observed_plan_handles, 1);
        assert.equal(report.diagnostics.outcomes.length, 2);
        // Seed excess and expired rows in this disposable DB; production writers never bypass the cap.
        await pool.query(`INSERT INTO consensus.planning_diagnostic(id, payload)
            SELECT gen_random_uuid(), $1::jsonb FROM generate_series(1, $2::int)`, [JSON.stringify(rows[0]), MAX_ROWS]);
        await pool.query("INSERT INTO consensus.planning_diagnostic(id, payload, received_at) VALUES ($1, $2, now() - interval '8 days')", [randomUUID(), JSON.stringify(rows[0])]);
        assert.equal((await store.insert([])).accepted, 0);
        const count = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE received_at < now() - interval '7 days')::int AS expired FROM consensus.planning_diagnostic");
        assert.equal(count.rows[0].n, MAX_ROWS); assert.equal(count.rows[0].expired, 0);
        const lock = await pool.connect();
        try {
            await lock.query('BEGIN'); await lock.query('SELECT pg_advisory_xact_lock(867530912)');
            assert.equal((await store.insert(rows)).busy, true);
            await lock.query('ROLLBACK');
        } finally { lock.release(); }
    } finally { await pool.end(); }
});
