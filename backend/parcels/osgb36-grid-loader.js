// Load the vendored official grid once in Node; the browser builder substitutes its asset loader.
import { readFile } from 'node:fs/promises';
import { initializeOstn15 } from './osgb36-projection.js';

let pending;
export function ensureOstn15() {
    if (!pending) pending = readFile(new URL('./grids/ostn15/OSTN15_NTv2_OSGBtoETRS.gsb', import.meta.url))
        .then(initializeOstn15).catch(error => { pending = null; throw error; });
    return pending;
}
