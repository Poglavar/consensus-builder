// The shared planner the app loads (frontend/vendor/interior-viewer) is exactly the release its receipt names: a copy
// edited here, or a newer release copied without updating the receipt, fails; with the interior-viewer repository next
// to this one at that release, the copies equal its dist/.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = resolve(import.meta.dirname, '../../frontend/vendor/interior-viewer');
const receipt = JSON.parse(readFileSync(resolve(here, 'receipt.json'), 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('vendored interior-viewer planner', () => {
    it('matches its receipt and is the release it names, with the parts the app reads', () => {
        for (const [file, hash] of Object.entries(receipt.files)) expect(sha(resolve(here, file)), file).toBe(hash);
        const planner = require(resolve(here, 'interior-planner.js'));
        expect(planner.version).toBe(receipt.version);
        for (const part of ['generator', 'rooms', 'core', 'context', 'workerClient']) expect(planner[part], part).toBeTruthy();
        expect(typeof planner.context.planBuilding).toBe('function');
        expect(typeof planner.workerClient.create).toBe('function');
    });
    const source = resolve(import.meta.dirname, '../../../interior-viewer');
    it.skipIf(!existsSync(resolve(source, 'package.json')))('equals the package repository\'s built files at that release', () => {
        const pkg = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
        if (pkg.version !== receipt.version) return;   // a newer release there is not drift here
        for (const file of Object.keys(receipt.files)) expect(sha(resolve(source, 'dist', file)), file).toBe(receipt.files[file]);
    });
});
