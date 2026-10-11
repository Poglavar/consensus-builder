// Worker entrypoint keeps provider parsing, projection and geometry work off the map's UI thread.
import { createBrowserParcelRuntime } from './browser-source-runtime.js';
let runtime, relayBase;
self.addEventListener('message', async ({ data }) => {
    const { id, sourceId, method, args, customDescriptor } = data || {};
    try {
        if (!Number.isSafeInteger(id) || !Array.isArray(args) || typeof sourceId !== 'string') throw new Error('Invalid browser parcel request.');
        if (!runtime || data.relayBase !== relayBase) {
            relayBase = data.relayBase;
            runtime = createBrowserParcelRuntime({ relayBase });
        }
        self.postMessage({ id, result: await runtime.query(sourceId, method, args, customDescriptor) });
    } catch (error) {
        self.postMessage({ id, error: { message: error.message, status: error.status, code: error.code,
            upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds } });
    }
});
