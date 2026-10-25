// Share an optional request-start budget across adapter instances for one provider endpoint.
export function createSourceRequestQueue({ now = Date.now,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const queues = new Map();
    return function queueRequest(key, intervalMs, request) {
        if (intervalMs === undefined) return request();
        let queue = queues.get(key);
        if (!queue) {
            queue = { lastStartedAt: null, tail: Promise.resolve() };
            queues.set(key, queue);
        }
        const run = queue.tail.then(async () => {
            if (queue.lastStartedAt !== null) {
                const delay = queue.lastStartedAt + intervalMs - now();
                if (delay > 0) await wait(delay);
            }
            queue.lastStartedAt = now();
            return request();
        });
        queue.tail = run.then(() => undefined, () => undefined);
        return run;
    };
}
