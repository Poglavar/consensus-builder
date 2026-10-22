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

    it('loads the persona rights registry only in live mode, and an explicit --rights in either', () => {
        const persona = loadLensMemberPersona('notary-01');
        const live = lensMemberCommand(persona, { live: true });
        expect(live.rightsPath).toMatch(/\.config\/ugt\/notary-01-rights\.json$/);
        expect(live.args.slice(live.args.indexOf('--rights'), live.args.indexOf('--rights') + 2)).toEqual(['--rights', live.rightsPath]);
        expect(lensMemberCommand(persona).args).not.toContain('--rights');
        expect(lensMemberCommand(persona, { rights: '/tmp/rights.json' }).args).toEqual(expect.arrayContaining(['--rights', '/tmp/rights.json']));
        expect(lensMemberCommand(loadLensMemberPersona('lifecycle-01'), { live: true, sourceEnv: { AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN: 't' } }).rightsPath).toBeNull();
    });

    it('refuses to start when the named rights registry is missing', () => {
        const run = spawnSync(process.execPath, [path.join(path.dirname(LENS_RUN), '..', 'agents', 'lens-member-run.mjs'),
            '--persona', 'notary-01', '--dry-run', '--owners', '/tmp/owners.json', '--rights', '/nonexistent/rights.json', '--print'], { encoding: 'utf8' });
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/rights registry \/nonexistent\/rights\.json does not exist/);
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

    // Starts lens/run.mjs in dry run on a free-ish port and reads its /lens/status, then stops it.
    async function statusOf(args, env = {}) {
        const port = 40000 + Math.floor(Math.random() * 20000);
        const child = spawn(process.execPath, [LENS_RUN, '--dry-run', ...args, '--port', String(port), '--host', '::'],
            { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
        try {
            await new Promise((resolve, reject) => {
                let output = '';
                const onData = chunk => { output += chunk; if (output.includes('listening on')) resolve(); };
                child.stdout.on('data', onData);
                child.stderr.on('data', onData);
                child.on('exit', code => reject(new Error(`lens/run.mjs exited ${code}: ${output}`)));
            });
            return await (await fetch(`http://127.0.0.1:${port}/lens/status`)).json();
        } finally {
            child.kill('SIGTERM');
        }
    }

    it('serves /lens/status with the kind it was started with, checking approval facts against the devnet owner registry', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-kind-'));
        const owners = path.join(directory, 'owners.json');
        fs.writeFileSync(owners, '[]');
        try {
            // Dry run with an owners file: no database, so no agreement index for decisions.
            const status = await statusOf(['--kind', 'lifecycle', '--owners', owners], { LENS_OPERATOR_TOKEN: 'test-operator' });
            expect(status).toMatchObject({ kind: 'lifecycle', dryRun: true });
            expect(status.approval).toMatchObject({ enabled: true, source: 'devnet-owners', identity: 'devnet-registry' });
            expect(status.decisions).toEqual({ operatorToken: true, agreementIndex: false });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }, 20000);

    it('checks approval facts against a --rights file instead when one is given', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-rights-'));
        const owners = path.join(directory, 'owners.json');
        const rights = path.join(directory, 'rights.json');
        fs.writeFileSync(owners, '[]');
        fs.writeFileSync(rights, JSON.stringify({
            schema: 'lens-rights-registry/v1',
            parcels: [{ parcelId: 'HR-335550-1/1', areaM2: 412, owners: [{ ownerId: 'owner-7f3a', share: '1/1' }] }],
            signers: [{ ownerId: 'owner-7f3a', wallet: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ' }]
        }));
        try {
            const status = await statusOf(['--owners', owners, '--rights', rights]);
            expect(status.approval).toMatchObject({ enabled: true, source: 'file', parcels: 1, owners: 1, authorities: 0, signers: 1 });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }, 20000);
});
