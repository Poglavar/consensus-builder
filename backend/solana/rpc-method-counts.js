// Count actual JSON-RPC calls at the fetch boundary, including SDK batches and transport retries.
export function createRpcMethodCounter() {
    const counts = Object.create(null);
    const onRequest = body => {
        let requests;
        try { requests = typeof body === 'string' ? JSON.parse(body) : body; } catch { return; }
        if (Array.isArray(requests) && requests.every(item => typeof item === 'string')) {
            requests = requests.map(method => ({ method }));
        }
        for (const request of Array.isArray(requests) ? requests : [requests]) {
            const method = request?.method;
            if (typeof method === 'string' && method) counts[method] = (counts[method] || 0) + 1;
        }
    };

    const total = () => Object.values(counts).reduce((sum, n) => sum + n, 0);

    return { onRequest, snapshot: () => ({ ...counts }), total };
}

/** Delta between two snapshots (after - before), omitting zero entries. */
export function diffRpcCounts(before = {}, after = {}) {
    const out = Object.create(null);
    for (const [method, count] of Object.entries(after || {})) {
        const delta = (Number(count) || 0) - (Number(before?.[method]) || 0);
        if (delta > 0) out[method] = delta;
    }
    return out;
}

export function sumRpcCounts(counts = {}) {
    return Object.values(counts || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
}
