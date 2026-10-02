// The notary-01 persona runner: which lens/run.mjs command it starts in dry run and live, and what it refuses.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lensMemberCommand, loadLensMemberPersona } from '../agents/lens-member-run.mjs';

const LENS_RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lens', 'run.mjs');

describe('lens-member persona runner', () => {
    it('starts the reference member in dry run from the persona service block', () => {
        const persona = loadLensMemberPersona('notary-01');
        const { args, env, keypairPath } = lensMemberCommand(persona, { owners: '/tmp/owners.json' });
        expect(args[0]).toMatch(/backend\/lens\/run\.mjs$/);
        expect(args.slice(1)).toEqual(['--dry-run', '--port', '3095', '--kind', 'owner-consent', '--credential-name', 'LensMember', '--identity', 'devnet-registry', '--owners', '/tmp/owners.json']);
        expect(env).toEqual({ LENS_OWNERSHIP_PRICE_USDC: '0.01' });
        expect(keypairPath).toBeNull();
    });

    it('passes the persona keypair only in live mode and refuses a dry-run owners file there', () => {
        const persona = loadLensMemberPersona('notary-01');
        const live = lensMemberCommand(persona, { live: true, port: 4000 });
        expect(live.args).toEqual(expect.arrayContaining(['--live', '--port', '4000', '--keypair', live.keypairPath, '--cluster', 'devnet']));
        expect(live.keypairPath).toMatch(/\.config\/solana\/ugt-notary-01\.json$/);
        expect(() => lensMemberCommand(persona, { live: true, owners: 'x.json' })).toThrow(/dry-run registry/);
    });

    it('announces the live member at its public service URL', () => {
        const persona = loadLensMemberPersona('notary-01');
        const { args } = lensMemberCommand(persona, { live: true });
        expect(args).toEqual(expect.arrayContaining([
            '--announce', 'https://api.urbangametheory.xyz',
            '--public-url', persona.service.publicUrl, '--name', 'notary-01'
        ]));
        expect(lensMemberCommand(persona).args).not.toContain('--announce');
    });

    it('refuses personas that are not lens members', () => {
        expect(() => loadLensMemberPersona('densifier-01')).toThrow(/not lens-member/);
        expect(() => loadLensMemberPersona('nobody')).toThrow(/no persona named/);
    });

    it('passes the persona service kind, so a lifecycle member does not report owner-consent', () => {
        const { args } = lensMemberCommand(loadLensMemberPersona('lifecycle-01'));
        expect(args.slice(args.indexOf('--kind'), args.indexOf('--kind') + 2)).toEqual(['--kind', 'lifecycle']);
    });
});

describe('lens/run.mjs --kind', () => {
    it('refuses an unknown kind before starting anything', () => {
        const run = spawnSync(process.execPath, [LENS_RUN, '--dry-run', '--kind', 'oracle', '--owners', '/nonexistent.json'], { encoding: 'utf8' });
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/unknown --kind oracle/);
    });

    it('serves /lens/status with the kind it was started with (dry run, owners file, no PG)', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-kind-'));
        const owners = path.join(directory, 'owners.json');
        fs.writeFileSync(owners, '[]');
        const port = 40000 + Math.floor(Math.random() * 20000);
        const child = spawn(process.execPath, [LENS_RUN, '--dry-run', '--kind', 'lifecycle', '--owners', owners, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            await new Promise((resolve, reject) => {
                let output = '';
                const onData = chunk => { output += chunk; if (output.includes('listening on')) resolve(); };
                child.stdout.on('data', onData);
                child.stderr.on('data', onData);
                child.on('exit', code => reject(new Error(`lens/run.mjs exited ${code}: ${output}`)));
            });
            const status = await (await fetch(`http://127.0.0.1:${port}/lens/status`)).json();
            expect(status).toMatchObject({ kind: 'lifecycle', dryRun: true });
        } finally {
            child.kill('SIGTERM');
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }, 20000);
});
