import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, isLocalDatabase } from '../db/connection.cjs';
import { createSharedPlanRepository } from '../agents/shared-plan-repository.js';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createSharedPlanClient } from '../agents/shared-plan-client.js';
import { canonicalArtifact } from '../agents/shared-plan-artifact.js';
import { setupSharedPlanSessionsRoute } from '../routes/shared-plan-sessions.js';
import { designContent } from './helpers/content-fixtures.js';
import { cidOfObject } from '../cid.js';

// Explicit opt-in. Uses an isolated schema in the existing local geodata database, never production.
describe.skipIf(process.env.SHARED_PLAN_PG_TESTS !== '1')('shared plans in PostgreSQL', () => {
    const schema = `test_shared_plan_${randomBytes(6).toString('hex')}`;
    const stores = [], closers = [];
    let pool, createdSchema = false;
    const artifact = title => {
        const content = designContent(), cid = cidOfObject(content);
        const plan = { schema: 'plan/v1', title, designCids: [cid], view: { at: '45.8,15.97,18', mode: 'model' } };
        return canonicalArtifact({ cid: cidOfObject(plan), plan, designs: [{ cid, content, parcelSourceId: null }] });
    };
    function store(options = {}) {
        const value = createSharedPlanSessions({ repository: createSharedPlanRepository({ pool, schema, ...options }), validateArtifact: canonicalArtifact });
        stores.push(value); return value;
    }
    beforeAll(async () => {
        if (!isLocalDatabase()) throw new Error('PostgreSQL session tests require a local database');
        pool = createPool({ max: 8, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
        const client = await pool.connect();
        try {
            await client.query('SET ROLE geo_user');
            await client.query(`CREATE SCHEMA ${schema} AUTHORIZATION geo_user`); createdSchema = true;
            const ddl = readFileSync(new URL('../db/shared-plan-session-ddl.sql', import.meta.url), 'utf8').replaceAll('consensus.', `${schema}.`);
            await client.query(ddl); await client.query(ddl); // Deployment DDL must be idempotent.
        } finally { client.release(); }
    });
    beforeEach(async () => { await pool.query(`DELETE FROM ${schema}.shared_plan_session`); });
    afterEach(async () => {
        for (const close of closers.splice(0).reverse()) await close();
        await Promise.all(stores.splice(0).map(value => value.dispose()));
    });
    afterAll(async () => {
        if (createdSchema) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        await pool?.end();
    });
    it('stores private content with hashed capabilities and reads it from a fresh store', async () => {
        const first = store(), created = await first.create(artifact('First'));
        const row = (await pool.query(`SELECT state, created_at, updated_at FROM ${schema}.shared_plan_session WHERE id = $1`, [created.id])).rows[0];
        expect(row.state.ownerTokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(row)).not.toContain(created.ownerToken);
        expect(JSON.stringify(row)).not.toContain(created.inviteToken);
        expect(row.created_at).toBeInstanceOf(Date); expect(row.updated_at).toBeInstanceOf(Date);
        await first.dispose();
        expect(await store().inspect(created.id, created.inviteToken)).toMatchObject({ version: 0, artifact: artifact('First') });
    });
    it('serializes independent writers and notifies another worker only of committed state', async () => {
        const first = store(), second = store(), created = await first.create(artifact('First'));
        const observed = [];
        const off = await second.subscribe(created.id, created.ownerToken, async () => observed.push(await second.eventState(created.id, created.ownerToken)));
        const results = await Promise.allSettled([
            first.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' }),
            second.replace(created.id, created.ownerToken, { expectedVersion: 0, artifact: artifact('Concurrent') })
        ]);
        expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(value => value.status === 'rejected').reason.code).toBe('shared-plan-version-conflict');
        await vi.waitFor(() => expect(observed).toHaveLength(1));
        expect(observed[0].version).toBe(1); off();
    });
    it('rolls back rejected quota growth without replacing the accepted artifact', async () => {
        const first = store(), created = await first.create(artifact('First'));
        const limited = store({ maxBytes: 1 });
        await expect(limited.replace(created.id, created.ownerToken, { expectedVersion: 0, artifact: artifact('Rejected') })).rejects.toMatchObject({ code: 'shared-plan-capacity' });
        expect(await first.inspect(created.id, created.ownerToken)).toMatchObject({ version: 0, cid: created.cid });
        const bounded = store({ maxEntries: 1 });
        await expect(bounded.create(artifact('Extra'))).rejects.toMatchObject({ code: 'shared-plan-capacity' });
        expect((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.shared_plan_session`)).rows[0].count).toBe(1);
    });
    it('persists undo and invitation revocation across independent workers', async () => {
        const first = store(), created = await first.create(artifact('First'));
        await first.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        await first.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: artifact('Edited') });
        const second = store();
        const revoked = await second.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner', revoke: true });
        await expect(first.inspect(created.id, created.inviteToken)).rejects.toMatchObject({ code: 'shared-plan-forbidden' });
        expect(await first.inspect(created.id, revoked.inviteToken)).toMatchObject({ canUndo: true });
        expect(await second.undo(created.id, created.ownerToken, { expectedVersion: 3 })).toMatchObject({ version: 4, cid: created.cid, canUndo: false });
    });
    it('delivers peer-worker edits through the real authenticated API client and closes revoked streams', async () => {
        async function api() {
            const app = express(); app.use(express.json());
            const route = setupSharedPlanSessionsRoute(app, pool, { sessions: store() });
            const server = app.listen(0); await once(server, 'listening');
            closers.push(async () => { await route.close(); await new Promise(resolve => server.close(resolve)); });
            const remote = createSharedPlanClient({ env: { UGT_API_BASE: `http://127.0.0.1:${server.address().port}` } });
            closers.push(() => remote.dispose()); return remote;
        }
        const a = await api(), b = await api(), created = await a.create(artifact('First'));
        const states = [], errors = [];
        await a.subscribe(created.id, created.inviteToken, async () => {
            try { states.push(await a.eventState(created.id, created.inviteToken)); } catch {}
        }, error => errors.push(error));
        await b.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
        await b.replace(created.id, created.inviteToken, { expectedVersion: 1, artifact: artifact('From another worker') });
        await vi.waitFor(() => expect(states.some(value => value.version === 2)).toBe(true));
        expect(await a.inspect(created.id, created.ownerToken)).toMatchObject({ version: 2, canUndo: true });
        await b.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner', revoke: true });
        await vi.waitFor(() => expect(errors).toHaveLength(1));
    });
});
