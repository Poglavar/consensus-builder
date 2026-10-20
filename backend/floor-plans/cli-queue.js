// Share queue probes across workers and park empty stages until discovery refreshes them.
import { cliTaskSelection } from './cli-worker.js';

export function createCliTaskPicker({ stages, order, claimed, finished }) {
    const empty = new Set(), probes = new Map(), batches = new Map();
    let turn = 0;
    async function rowsFor(name, db) {
        if (empty.has(name)) return [];
        if (batches.get(name)?.length) return batches.get(name);
        if (!probes.has(name)) {
            const adapter = stages[name];
            const pending = db.query(cliTaskSelection(adapter), [adapter.processor, 16])
                .then(({ rows }) => {
                    if (!rows.length) empty.add(name);
                    const batch = rows.slice(); batches.set(name, batch); return batch;
                })
                .finally(() => probes.delete(name));
            probes.set(name, pending);
        }
        return probes.get(name);
    }
    return {
        async pick(db) {
            const start = turn++, checked = new Set();
            for (let i = 0; i < order.length; i++) {
                const name = order[(start + i) % order.length];
                if (checked.has(name) || empty.has(name)) continue;
                checked.add(name);
                const rows = await rowsFor(name, db);
                const index = rows.findIndex(row => !claimed.has(row.id) && !finished.has(row.id));
                if (index !== -1) {
                    const [task] = rows.splice(index, 1); claimed.add(task.id); return { name, task };
                }
                batches.delete(name);
            }
            return null;
        },
        refresh() { empty.clear(); batches.clear(); },
        get emptyStages() { return [...empty]; },
    };
}
