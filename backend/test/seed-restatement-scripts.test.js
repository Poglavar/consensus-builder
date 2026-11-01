// The restatement seed scripts (backend/scripts/seed-*.mjs, all but seed-lens-owners.mjs) since M3: each
// rebuilds one restatement's canonical archives from its sources, with --dry-run (validate, write nothing)
// or --export (write the archives), and none writes a database row any more: the archives are published
// as designs and agreements by publish-restatement-archives.mjs. They run here as child processes with a
// non-local DATABASE_URL, so a step that reached for the cadastre is refused before it connects.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const RESTATEMENTS = fileURLToPath(new URL('../../restatements/', import.meta.url));
const NOT_LOCAL = 'postgres://reader@db.invalid:5432/none';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-scripts-'));
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));
const CHILD_ENV = { ...process.env };
// Node warns when the parent runner sets both colour controls. Script stderr remains reserved for
// the dry run's own diagnostics.
delete CHILD_ENV.NO_COLOR;

// The nine seeds, and whether their sources include the local cadastre (else only committed files).
const SEEDS = [
    ['seed-borongaj-proposal.mjs', false],
    ['seed-lovinciceva-proposal.mjs', true],
    ['seed-neighbourhood-reconstructions.mjs', true],
    ['seed-pionir-observed-circulation.mjs', true],
    ['seed-pionir-observed-proposals.mjs', true],
    ['seed-rudes-zagrebacka-avenija-proposal.mjs', false],
    ['seed-savica-f1-f3-proposal.mjs', true],
    ['seed-selska-drniska-proposal.mjs', true],
    ['seed-spansko-sjever-proposal.mjs', true]
];

const run = (script, args) => spawnSync(process.execPath, [`scripts/${script}`, ...args], {
    cwd: BACKEND, encoding: 'utf8', timeout: 120_000, env: { ...CHILD_ENV, HOME, DATABASE_URL: NOT_LOCAL }
});
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the seed scripts', () => {
    it('are exactly the nine restatement seeds, none of which writes a proposal row', () => {
        const found = fs.readdirSync(path.join(BACKEND, 'scripts')).filter(name => /^seed-.*\.mjs$/.test(name) && name !== 'seed-lens-owners.mjs').sort();
        expect(found).toEqual(SEEDS.map(([script]) => script));
        for (const [script] of SEEDS) {
            const source = fs.readFileSync(path.join(BACKEND, 'scripts', script), 'utf8');
            expect(source, script).not.toMatch(/INSERT\s+INTO\s+(public\.)?proposal\b/i);
            expect(source, script).not.toMatch(/canonical-seed-record/);
        }
    });

    it.each(SEEDS)('%s prints its usage without a mode and has no database write mode', script => {
        const usage = run(script, []);
        expect(usage.status).toBe(0);
        expect(usage.stdout).toContain(`Usage: node backend/scripts/${script} --dry-run|--export`);
        expect(usage.stdout.replace(/\s+/g, ' ')).toContain('Publish the archives with backend/scripts/publish-restatement-archives.mjs');
        // The retired upsert into the proposal table is an unknown mode now.
        const apply = run(script, ['--apply']);
        expect(apply.status).toBe(1);
        expect(apply.stderr).toMatch(/Choose exactly one of --dry-run or --export\.|Unknown argument: --apply/);
        const both = run(script, ['--dry-run', '--export']);
        expect(both.status).toBe(1);
        expect(both.stderr).toContain('Choose exactly one of --dry-run or --export.');
    }, 120_000);

    it.each(SEEDS.filter(([, cadastre]) => cadastre))('%s refuses to read its sources from a database that is not local', script => {
        const dry = run(script, ['--dry-run']);
        expect(dry.status).toBe(1);
        expect(dry.stderr).toContain('Refusing to read the reconstruction sources from non-local database host db.invalid.');
        expect(dry.stdout).not.toContain('Dry run complete');
    }, 120_000);

    it.each([
        ['seed-borongaj-proposal.mjs', 'pionir-paron/borongajska-caviceva/proposal.geojson', 9],
        ['seed-rudes-zagrebacka-avenija-proposal.mjs', 'pionir-paron/zagrebacka-avenija-rudes/proposal.geojson', 7]
    ])('%s --dry-run validates the committed sources and writes no archive', (script, archive, buildings) => {
        const file = path.join(RESTATEMENTS, archive);
        const before = sha(file);
        const dry = run(script, ['--dry-run']);
        expect(dry.stderr).toBe('');
        expect(dry.status).toBe(0);
        expect(dry.stdout).toContain('Dry run complete; no archive was written.');
        const summary = JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{'), dry.stdout.lastIndexOf('}') + 1));
        expect(summary.buildings).toBe(buildings);
        expect(summary.proposalId).toMatch(/location-permit/);
        expect(sha(file)).toBe(before);
    }, 120_000);
});
