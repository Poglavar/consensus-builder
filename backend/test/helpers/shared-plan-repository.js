// Test-only repository with the same serialized mutation boundary as PostgreSQL.
export function createMemorySharedPlanRepository({ maxEntries = 1000, maxBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
    const rows = new Map(), listeners = new Map();
    let writes = Promise.resolve();
    const clone = value => structuredClone(value);
    const serialize = operation => {
        const result = writes.then(operation);
        writes = result.catch(() => {});
        return result;
    };
    const size = value => Buffer.byteLength(JSON.stringify(value));
    function publish(id, value) {
        for (const { listener, onError } of listeners.get(id) || []) {
            try { listener(clone(value)); } catch (error) { try { onError?.(error); } catch {} }
        }
    }
    function prune() {
        for (const [id, value] of rows) if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now()) { rows.delete(id); publish(id); }
    }
    function ensureCapacity(next, previous) {
        let bytes = 0;
        for (const [id, value] of rows) bytes += size(id === next.id ? next : value);
        if (!rows.has(next.id)) bytes += size(next);
        const entries = rows.size + (rows.has(next.id) ? 0 : 1);
        if (entries > maxEntries || bytes > maxBytes) throw Object.assign(new Error('Shared plan storage is full.'), { code: 'shared-plan-capacity', status: 503 });
    }
    return {
        async read(id) { const value = rows.get(id); return value === undefined ? undefined : clone(value); },
        async insert(state) {
            return serialize(() => {
                prune();
                if (rows.has(state.id)) throw new Error('Shared plan already exists.');
                const next = clone(state); ensureCapacity(next); rows.set(next.id, next); publish(next.id, next); return clone(next);
            });
        },
        async change(id, mutate) {
            return serialize(() => {
                prune();
                const previous = rows.get(id);
                if (previous === undefined) return mutate(undefined);
                const next = mutate(clone(previous));
                ensureCapacity(next, previous); rows.set(id, clone(next)); publish(id, next); return clone(next);
            });
        },
        async remove(id, authorize) {
            return serialize(() => {
                authorize(clone(rows.get(id)));
                rows.delete(id); publish(id);
            });
        },
        async subscribe(id, listener, onError) {
            const set = listeners.get(id) || new Set(); set.add({ listener, onError }); listeners.set(id, set);
            return () => { for (const row of set) if (row.listener === listener) set.delete(row); if (!set.size) listeners.delete(id); };
        },
        async dispose() { listeners.clear(); await writes; }
    };
}
