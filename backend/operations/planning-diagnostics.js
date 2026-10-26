// No network addresses, headers, URL paths, content CIDs or untrusted error text are recorded.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const D = createRequire(import.meta.url)('../../frontend/js/app-diagnostics.js');
export const MAX_BATCH = 20;
export const MAX_ROWS = 10000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 16384;
const FIELDS = ['id', 'correlationId', 'sessionId', 'planId', 'kind', 'operation', 'entity', 'outcome', 'code', 'context'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const uuid = value => typeof value === 'string' && D.UUID.test(value);

export function validateDiagnosticReport(body) {
    const fail = () => ({ error: 'invalid-diagnostic-report' });
    if (!plain(body) || !exactKeys(body, ['version', 'entries']) || body.version !== 1 || !Array.isArray(body.entries)
        || body.entries.length < 1 || body.entries.length > MAX_BATCH) return fail();
    const ids = new Set(), entries = [];
    for (const row of body.entries) {
        if (!plain(row) || !exactKeys(row, FIELDS) || FIELDS.some(key => !Object.hasOwn(row, key))) return fail();
        if (!uuid(row.id) || ids.has(row.id.toLowerCase()) || !uuid(row.correlationId) || !uuid(row.sessionId)) return fail();
        ids.add(row.id.toLowerCase());
        if (row.planId !== null && (!uuid(row.planId) || row.entity !== 'plan')) return fail();
        if (!D.ENTITIES.includes(row.entity) || !['success', 'failure', 'cancelled'].includes(row.outcome)) return fail();
        if (!plain(row.context) || !exactKeys(row.context, ['surface', 'format', 'httpStatus'])) return fail();
        const context = D.contextOf(row.context);
        if (JSON.stringify(Object.entries(context).sort()) !== JSON.stringify(Object.entries(row.context).sort())) return fail();
        if (row.kind === 'operation') {
            if (!D.OPERATIONS.includes(row.operation) || row.code !== null) return fail();
        } else if (row.kind === 'error') {
            if (row.operation !== null || row.outcome !== 'failure' || typeof row.code !== 'string' || !Object.hasOwn(D.CATALOG, row.code) || row.planId !== null) return fail();
        } else return fail();
        entries.push({ ...D.wire(row), source: 'ui', evidence: 'client-report', test: 'unknown' });
    }
    return { value: entries };
}

// A fixed global budget avoids keeping IP addresses or accepting unbounded identity keys.
// It may discard diagnostics under load, which is preferable to interfering with authoring.
export function createBudget({ limit = 60, windowMs = 60000, now = Date.now } = {}) {
    let start = now(), count = 0;
    return () => {
        const at = now();
        if (at - start >= windowMs) { start = at; count = 0; }
        return ++count <= limit;
    };
}

export function createDiagnosticStore(pool) {
    let active = 0;
    return {
        async insert(entries) {
            if (active >= 2) return { busy: true };
            active++;
            let client, abandoned = false;
            try {
                let timer;
                const pending = Promise.resolve().then(() => pool.connect());
                // A caller timeout cannot cancel pg-pool's checkout. Keep its slot until it
                // settles so a starved shared pool never accumulates more diagnostics waiters.
                pending.then(value => {
                    if (abandoned) { try { value.release(); } finally { active--; } }
                }, () => { if (abandoned) active--; }).catch(() => {});
                try {
                    client = await Promise.race([pending, new Promise((_, reject) => {
                        timer = setTimeout(() => { abandoned = true; reject(new Error('diagnostic DB acquisition timeout')); }, 2000);
                    })]);
                } finally { clearTimeout(timer); }
                await client.query('BEGIN');
                await client.query('SET LOCAL statement_timeout = 2000');
                // All writers use this lock: row trimming and insertion have one strict bound.
                const lock = await client.query('SELECT pg_try_advisory_xact_lock(867530912) AS locked');
                if (!lock.rows[0]?.locked) { await client.query('ROLLBACK'); return { busy: true }; }
                await client.query("DELETE FROM consensus.planning_diagnostic WHERE received_at < now() - interval '7 days'");
                const result = await client.query(`
                    INSERT INTO consensus.planning_diagnostic AS existing (id, payload)
                    SELECT (item->>'id')::uuid, item FROM jsonb_array_elements($1::jsonb) item
                    ON CONFLICT (id) DO UPDATE SET id = existing.id
                    WHERE existing.payload = EXCLUDED.payload
                    RETURNING id`, [JSON.stringify(entries)]);
                if (result.rows.length !== entries.length) {
                    await client.query('ROLLBACK'); return { conflict: true };
                }
                await client.query(`DELETE FROM consensus.planning_diagnostic WHERE id IN (
                    SELECT id FROM consensus.planning_diagnostic ORDER BY received_at DESC, id DESC OFFSET $1
                )`, [MAX_ROWS]);
                await client.query('COMMIT');
                return { accepted: entries.length };
            } catch {
                if (client) { try { await client.query('ROLLBACK'); } catch { /* no private error output */ } }
                return { unavailable: true };
            } finally {
                if (!abandoned) { try { client?.release(); } finally { active--; } }
            }
        }
    };
}

const API_WRITES = Object.freeze({ '/plans': 'plan', '/designs': 'design', '/agreements': 'artifact', '/pins': 'artifact', '/ipfs/upload': 'artifact' });
export function createApiObservation(req, res, { knownTest = false } = {}) {
    const entity = API_WRITES[req.route?.path];
    if (req.method !== 'POST' || !entity) return null;
    return { id: randomUUID(), correlationId: randomUUID(), sessionId: null, planId: null,
        kind: 'operation', operation: 'publish', entity, outcome: res.statusCode < 400 ? 'success' : 'failure',
        code: null, context: { surface: 'api', httpStatus: res.statusCode }, source: 'api', evidence: 'server', test: knownTest ? 'known-test' : 'unknown' };
}

export const MCP_ACTIONS = Object.freeze({
    ugt_draft_plan: ['create', 'plan'], ugt_edit_plan: ['edit', 'plan'], ugt_publish_plan: ['publish', 'plan'],
    ugt_draft_design: ['create', 'design'], ugt_edit_design: ['edit', 'design'], ugt_modify_design: ['edit', 'design'],
    ugt_publish_design: ['publish', 'design'],
    ugt_draft_road: ['create', 'design'], ugt_draft_building: ['create', 'design'], ugt_draft_track: ['create', 'design'],
    ugt_draft_station: ['create', 'design'], ugt_draft_space: ['create', 'design'], ugt_draft_parcel_layout: ['create', 'design'],
    ugt_draft_urban_rule: ['create', 'design']
});
export function createMcpObserver({ record = null, knownTest = false } = {}) {
    return async (name, call, isSuccessful = result => !result?.isError) => {
        const action = MCP_ACTIONS[name];
        if (!record || !action) return call();
        const note = outcome => {
            try {
                // No request arguments, returned content, CIDs, draftRefs or invented MCP sessions.
                Promise.resolve(record({ id: randomUUID(), correlationId: randomUUID(), sessionId: null, planId: null,
                    kind: 'operation', operation: action[0], entity: action[1], outcome, code: null,
                    context: { surface: 'mcp' }, source: 'mcp', evidence: 'server', test: knownTest ? 'known-test' : 'unknown' })).catch(() => {});
            } catch { /* optional diagnostics never change tool results */ }
        };
        try {
            const result = await call();
            let valid = false;
            try { valid = isSuccessful(result); } catch { /* rejected output is a failure, never telemetry text */ }
            note(valid ? 'success' : 'failure'); return result;
        }
        catch (error) { note('failure'); throw error; }
    };
}
