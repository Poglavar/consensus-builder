// PostgreSQL is the source of truth; each mutation checks authority against its locked row.
export function createSharedPlanRepository({ pool, schema = 'consensus', maxEntries = 1024, maxBytes = 128 * 1024 * 1024 }) {
    if (!pool?.query || !/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Shared plans require a PostgreSQL pool and a valid schema');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Shared plan session bounds must be positive');
    const table = `${schema}.shared_plan_session`, channel = `${schema}_shared_plan_changed`;
    const listeners = new Set();
    let connection, connecting, disposed = false;
    async function read(id) { return (await pool.query(`SELECT state FROM ${table} WHERE id = $1`, [id])).rows[0]?.state; }
    async function write(id, change, insert = false) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // The small global quota must be checked atomically with every size-changing write.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
            const previous = insert ? undefined : (await client.query(`SELECT state FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0]?.state;
            const next = change(previous), json = JSON.stringify(next), bytes = Buffer.byteLength(json);
            const totals = (await client.query(`SELECT count(*)::int AS count, COALESCE(sum(storage_bytes), 0)::bigint AS bytes FROM ${table} WHERE id <> $1`, [id])).rows[0];
            if (totals.count >= maxEntries || Number(totals.bytes) + bytes > maxBytes) throw Object.assign(new Error('Shared plan storage is full.'), { code: 'shared-plan-capacity', status: 503 });
            if (insert) await client.query(`INSERT INTO ${table} (id, state, storage_bytes) VALUES ($1, $2::jsonb, $3)`, [id, json, bytes]);
            else await client.query(`UPDATE ${table} SET state = $2::jsonb, storage_bytes = $3, updated_at = now() WHERE id = $1`, [id, json, bytes]);
            // PostgreSQL delivers this only after COMMIT; the payload contains no content or capability.
            await client.query('SELECT pg_notify($1, $2)', [channel, id]);
            await client.query('COMMIT');
            return next;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }
    function failed(error) {
        const old = connection; connection = null;
        if (old) { old.removeAllListeners('notification'); old.removeAllListeners('error'); old.release(true); }
        for (const entry of [...listeners]) { try { entry.onError(error); } catch {} }
        listeners.clear();
    }
    async function listen() {
        if (disposed) throw new Error('Shared plan repository is closed');
        if (connection) return;
        if (!connecting) connecting = (async () => {
            const client = await pool.connect();
            client.on('error', failed);
            client.on('notification', event => {
                if (event.channel !== channel) return;
                for (const entry of [...listeners]) if (entry.id === event.payload) {
                    try { entry.listener(); } catch { /* An observer cannot undo a committed save. */ }
                }
            });
            try {
                await client.query(`LISTEN ${channel}`);
                if (disposed) throw new Error('Shared plan repository is closed');
                connection = client;
            } catch (error) { client.removeAllListeners(); client.release(true); throw error; }
        })().finally(() => { connecting = null; });
        await connecting;
    }
    return {
        read,
        insert: value => write(value.id, () => value, true),
        change: (id, mutate) => write(id, mutate),
        async subscribe(id, listener, onError = () => {}) {
            await listen();
            const entry = { id, listener, onError }; listeners.add(entry);
            return () => listeners.delete(entry);
        },
        async dispose() {
            disposed = true;
            await connecting?.catch(() => {});
            failed(new Error('Shared plan repository closed'));
        }
    };
}
