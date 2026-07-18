#!/usr/bin/env node

import { access, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const destination = path.join(repositoryRoot, 'frontend/js/vendor/transit-station-models.js');
const candidates = [
    process.env.ZAGREB_ISOCHRONE_ROOT,
    path.resolve(repositoryRoot, '../zagreb-isochrone-main'),
    '/Users/simun/Code/zagreb-isochrone-main'
].filter(Boolean);

let source = null;
for (const root of candidates) {
    const candidate = path.join(root, 'website/shared/transit-station-models.js');
    try {
        await access(candidate);
        source = candidate;
        break;
    } catch (_) { }
}

if (!source) {
    throw new Error('Could not find zagreb-isochrone-main/website/shared/transit-station-models.js. Set ZAGREB_ISOCHRONE_ROOT.');
}

if (process.argv.includes('--check')) {
    const [canonical, vendored] = await Promise.all([
        readFile(source),
        readFile(destination)
    ]);
    if (!canonical.equals(vendored)) {
        console.error('Transit station model copy is stale. Run node scripts/sync-transit-station-models.mjs.');
        process.exitCode = 1;
    } else {
        console.log('Transit station model copy matches the Zagreb Isochrone source.');
    }
} else {
    await copyFile(source, destination);
    console.log(`Synced ${path.relative(repositoryRoot, destination)} from ${source}.`);
}
