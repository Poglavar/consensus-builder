import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { setupPlanningDiagnostics } from '../routes/planning-diagnostics.js';
const D = createRequire(import.meta.url)('../../frontend/js/app-diagnostics.js');
async function server(t, env = {}, result = { accepted: 1 }) {
    const inserts = [], app = express();
    setupPlanningDiagnostics(app, {}, { env, store: { insert: async rows => { inserts.push(rows); return result; } } });
    app.post('/plans', (_req, res) => res.status(201).json({ ok: true }));
    const http = createServer(app).listen(0); await once(http, 'listening');
    t.after(() => { app.locals.stopPlanningDiagnosticCleanup?.(); http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
    const url = `http://127.0.0.1:${http.address().port}`;
    return { inserts, app, post: (body, headers = {}) => fetch(url + '/diagnostics/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body)
    }), url };
}
function report() { const d = D.create({ uuid: randomUUID }); d.event('edit', 'success'); return { version: 1, entries: d.snapshot().entries.map(D.wire) }; }
test('ingest is disabled before body parsing and no public dashboard is exposed', async t => {
    const s = await server(t); const response = await s.post('{malformed'); assert.equal(response.status, 404);
    assert.equal(s.inserts.length, 0); assert.equal((await fetch(s.url + '/diagnostics/reports')).status, 404);
    assert.equal((await fetch(s.url + '/diagnostics/metrics')).status, 404);
});
test('enabled ingest validates/redacts, rejects malformed/oversize reports and replies without echoing private input', async t => {
    const s = await server(t, { UGT_DIAGNOSTICS_INGEST: 'true' });
    assert.equal((await s.post(report())).status, 202); assert.equal(s.inserts[1][0].evidence, 'client-report');
    for (const [body, status] of [['{SECRET', 400], [JSON.stringify({ version: 1, entries: [], message: 'SECRET' }), 400],
        [JSON.stringify({ secret: 'SECRET'.repeat(4000) }), 413]]) {
        const response = await s.post(body); assert.equal(response.status, status); assert.ok(!(await response.text()).includes('SECRET'));
    }
    assert.equal(s.inserts.length, 2); // startup pruning plus the accepted batch
});
test('global request budget and storage conflict/busy/outage responses remain bounded', async t => {
    for (const [result, status] of [[{ conflict: true }, 409], [{ busy: true }, 429], [{ unavailable: true }, 503]]) {
        const s = await server(t, { UGT_DIAGNOSTICS_INGEST: 'true' }, result);
        assert.equal((await s.post(report())).status, status);
    }
    const s = await server(t, { UGT_DIAGNOSTICS_INGEST: 'true' });
    for (let i = 0; i < 60; i++) assert.equal((await s.post(report())).status, 202);
    assert.equal((await s.post(report())).status, 429); assert.equal(s.inserts.length, 61);
});
test('API observer requires its independent gate and never changes the planning response', async t => {
    const off = await server(t, { UGT_DIAGNOSTICS_INGEST: 'true' });
    assert.equal((await fetch(off.url + '/plans', { method: 'POST' })).status, 201); assert.equal(off.inserts.length, 1);
    const on = await server(t, { UGT_PLANNING_SERVER_OBSERVATIONS: 'true', NODE_ENV: 'test' });
    assert.equal((await fetch(on.url + '/plans?token=SECRET', { method: 'POST' })).status, 201);
    assert.equal(on.inserts.at(-1)[0].source, 'api'); assert.equal(on.inserts.at(-1)[0].test, 'known-test');
    assert.ok(!JSON.stringify(on.inserts).includes('SECRET'));
});
