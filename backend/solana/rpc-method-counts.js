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

    return { onRequest, snapshot: () => ({ ...counts }) };
}
