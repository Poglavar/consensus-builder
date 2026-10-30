// Worker entrypoint keeps provider parsing, projection and geometry work off the map's UI thread.
import { createBrowserParcelRuntime } from './browser-source-runtime.js';
import { createBrowserBuildingCells } from '../buildings/browser-building-cells.js';
let runtime, relayBase, buildingCells;
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
        if (method === 'describe') { self.postMessage({ id, result: runtime.describe(sourceId, customDescriptor) }); return; }
        // One building cell of a URL building source, read from its service directly (no relay).
        if (method === 'buildingCell') {
            buildingCells ||= createBrowserBuildingCells();
            self.postMessage({ id, result: await buildingCells.read(sourceId, args[0], { signal: controller.signal }) });
            return;
        }
        const onProgress = data.trackProgress ? progress => { if (!controller.signal.aborted) self.postMessage({ id, progress }); } : undefined;
        self.postMessage({ id, result: await runtime.query(sourceId, method, args, customDescriptor, { onProgress, signal: controller.signal }) });
    } catch (error) {
        self.postMessage({ id, error: { message: error.message, status: error.status, code: error.code,
            upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds, knownLimit: error.knownLimit, accessCountry: error.accessCountry } });
    } finally { if (controllers.get(id) === controller) controllers.delete(id); }
});
