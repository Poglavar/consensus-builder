// Fetch the hash-bound OSTN15 asset only when a British National Grid source is actually read.
import { initializeOstn15, OSTN15_GRID_SHA256 } from './osgb36-projection.js';

let pending;
export function ensureOstn15() {
    if (!pending) pending = (async () => {
        const response = await fetch(`/assets/parcel-adapters/grids/${OSTN15_GRID_SHA256}.gsb`,
            { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error('Official OSTN15 grid asset is unavailable.');
        await initializeOstn15(await response.arrayBuffer());
    })().catch(error => { pending = null; throw error; });
    return pending;
}
