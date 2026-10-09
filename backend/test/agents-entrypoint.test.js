// The runners' "am I the entry point" guard must hold both for `node agents/x.mjs` and under PM2,
// whose fork container makes argv[1] its own file and names the script in pm_exec_path instead.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from '../agents/entrypoint.js';

const here = path.resolve('agents/society-run.mjs');
const self = pathToFileURL(here).href;

describe('isEntrypoint', () => {
    it('matches a direct `node script` invocation', () => {
        expect(isEntrypoint(self, { argv: ['node', here], env: {} })).toBe(true);
        expect(isEntrypoint(self, { argv: ['node', path.resolve('agents/run.mjs')], env: {} })).toBe(false);
    });

    it('matches under PM2, where argv[1] is the container and pm_exec_path names the script', () => {
        const container = '/usr/local/lib/node_modules/pm2/lib/ProcessContainerFork.js';
        expect(isEntrypoint(self, { argv: ['node', container], env: { pm_exec_path: here } })).toBe(true);
        expect(isEntrypoint(self, { argv: ['node', container], env: {} })).toBe(false);
    });

    it('compares real paths, so a symlinked or relative script path still matches', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
        const link = path.join(dir, 'society-run.mjs');
        fs.symlinkSync(here, link);
        try {
            expect(isEntrypoint(self, { argv: ['node', link], env: {} })).toBe(true);
            expect(isEntrypoint(self, { argv: ['node', path.relative(process.cwd(), here)], env: {} })).toBe(true);
            expect(isEntrypoint(self, { argv: ['node', path.join(dir, 'missing.mjs')], env: {} })).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('is the guard the society and lens-member runners use', () => {
        for (const file of ['agents/society-run.mjs', 'agents/lens-member-run.mjs']) {
            const source = fs.readFileSync(file, 'utf8');
            expect(source).toContain('if (isEntrypoint(import.meta.url)) {');
            expect(source).not.toContain('file://${process.argv[1]}');
        }
    });
});
