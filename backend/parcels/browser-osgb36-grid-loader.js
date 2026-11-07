// Fetch the hash-bound OSTN15 asset only when a British National Grid source is actually read.
// It is served from the uk-cadastre R2 bucket next to the HMLR tile releases, named by its hash.
import { initializeOstn15, OSTN15_GRID_SHA256 } from './osgb36-projection.js';

export const OSTN15_GRID_URL = `https://uk-cadastre.urbangametheory.xyz/grids/${OSTN15_GRID_SHA256}.gsb`;

let pending;
export function ensureOstn15() {
    if (!pending) pending = (async () => {
        const response = await fetch(OSTN15_GRID_URL,
            { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error('Official OSTN15 grid asset is unavailable.');
        await initializeOstn15(await response.arrayBuffer());
    })().catch(error => { pending = null; throw error; });
    return pending;
}
