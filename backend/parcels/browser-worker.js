// Worker entrypoint keeps provider parsing, projection and geometry work off the map's UI thread.
import { createBrowserParcelRuntime } from './browser-source-runtime.js';
let runtime, relayBase;
// The page cancels a request it no longer needs (a superseded viewport) with { cancel: id }.
const controllers = new Map();
self.addEventListener('message', async ({ data }) => {
    if (Number.isSafeInteger(data?.cancel)) { controllers.get(data.cancel)?.abort(); return; }
    const { id, sourceId, method, args, customDescriptor } = data || {};
    const controller = new AbortController();
    try {
        if (!Number.isSafeInteger(id) || !Array.isArray(args) || typeof sourceId !== 'string') throw new Error('Invalid browser parcel request.');
        controllers.set(id, controller);
        if (!runtime || data.relayBase !== relayBase) {
            relayBase = data.relayBase;
            runtime = createBrowserParcelRuntime({ relayBase });
        }
        const onProgress = data.trackProgress ? progress => { if (!controller.signal.aborted) self.postMessage({ id, progress }); } : undefined;
        self.postMessage({ id, result: await runtime.query(sourceId, method, args, customDescriptor, { onProgress, signal: controller.signal }) });
    } catch (error) {
        self.postMessage({ id, error: { message: error.message, status: error.status, code: error.code,
            upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds } });
    } finally { if (controllers.get(id) === controller) controllers.delete(id); }
});
