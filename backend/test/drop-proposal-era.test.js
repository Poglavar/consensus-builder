// The end-of-M3 drop of the proposal-era database objects (scripts/drop-proposal-era.mjs), never against a
// database: the CLI's usage and refusals (each exits while parsing its options), and the run itself on a
// fake client with fake pg_dump/pg_restore binaries: the dry-run listing, the refusal while something
// outside the set depends on it, no drop without a backup completed in the same run, the one-transaction
// drop with its row-count check, and a rerun that finds nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropProposalEra } from '../scripts/drop-proposal-era.mjs';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(BACKEND, 'scripts', 'drop-proposal-era.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-proposal-era-test-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ---- the CLI -----------------------------------------------------------------------------------------

// Every case here is refused or answered while the options are parsed, before dotenv and the client.
const cli = args => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: BACKEND, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000 });

describe('drop-proposal-era.mjs options', () => {
    it('prints its usage for --help and for no arguments', () => {
        for (const args of [['--help'], []]) {
            const run = cli(args);
            expect(run.status, args.join(' ')).toBe(0);
            expect(run.stdout).toMatch(/^Drop the proposal-era database objects \(end of M3\)\. Nothing runs without a parameter\./);
            expect(run.stdout).toMatch(/--apply\s+Back up \(needs --backup DIR\), then drop everything in one transaction/);
        }
    });

    it('refuses --apply without --backup, --apply with --dry-run, no mode, a bad role and an unknown option', () => {
        const cases = [
            [['--apply'], /--apply needs --backup DIR: nothing is dropped without a backup made in the same run/],
            [['--apply', '--dry-run', '--backup', scratch], /--apply and --dry-run exclude each other/],
            [['--role', 'geo_user'], /choose --dry-run, --backup DIR, or --backup DIR --apply/],
            [['--dry-run', '--role', 'Geo User'], /--role must be a plain role name/],
            [['--dry-run', '--bogus'], /Unknown option '--bogus'/]
        ];
        for (const [args, message] of cases) {
            const run = cli(args);
            expect(run.status, args.join(' ')).toBe(2);
            expect(run.stderr).toMatch(message);
            expect(run.stdout).toMatch(/^Drop the proposal-era database objects/);
        }
    });
});

// ---- the run on a fake client -------------------------------------------------------------------------

const TABLES = [
    { oid: 101, reltype: 201, schema: 'public', name: 'proposal', owner: 'geo_user', bytes: 2 * 1048576, backup: false },
    { oid: 102, reltype: 202, schema: 'consensus', name: 'proposal_site_backup_v1', owner: 'geo_user', bytes: 1048576, backup: true }
];
const FUNCTIONS = ['enforce_proposal_publication', 'enforce_named_plan_publication'].map((name, index) => ({
    oid: 301 + index, schema: 'public', name, args: '', definition: `CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`
}));

/**
 * A connected client over a database holding the proposal-era objects: `rows` per table (a later entry
 * of `rowsLater` is answered after the dump, as a write in between would), `dependents` outside the set.
 * After a DROP TABLE the objects are gone, so the post-drop discovery finds nothing.
 */
function fakeClient({ rows = { proposal: 3, proposal_site_backup_v1: 2 }, rowsLater = null, dependents = [], empty = false } = {}) {
    const calls = [];
    let dropped = empty;
    let locked = false;
    return {
        calls,
        async query(sql, params) {
            calls.push(sql.trim().replace(/\s+/g, ' '));
            if (/FROM pg_class c JOIN pg_namespace/.test(sql)) return { rows: dropped ? [] : TABLES.map(table => ({ ...table })) };
            if (/^SELECT count\(\*\)::int8 AS n FROM/.test(sql.trim())) {
                const name = /\."([^"]+)"$/.exec(sql.trim())[1];
                return { rows: [{ n: String((locked && rowsLater ? rowsLater : rows)[name]) }] };
            }
            if (/'index' AS kind/.test(sql)) return { rows: [{ kind: 'index', name: 'proposal_pkey' }, { kind: 'trigger', name: 'proposal_publication_immutable (enforce_proposal_publication)' }] };
            if (/FROM pg_proc p JOIN pg_namespace/.test(sql)) {
                // The script asks for its function names; the fake answers the ones it knows of them.
                return { rows: dropped ? [] : FUNCTIONS.filter(fn => params[1].includes(fn.name)).map(fn => ({ ...fn })) };
            }
            if (/'view or rule' AS kind/.test(sql)) return { rows: dropped ? [] : dependents };
            if (/^LOCK TABLE/.test(sql)) locked = true;
            if (/^DROP TABLE/.test(sql)) dropped = true;
            return { rows: [] };
        }
    };
}
const writes = client => client.calls.filter(sql => /^(BEGIN|SET LOCAL|LOCK|DROP|COMMIT|ROLLBACK)/.test(sql));

// pg_dump writes the dump it is asked for; pg_restore --list names the table the dump's file name holds.
function binaries({ dump = 'ok', list = 'ok' } = {}) {
    const dir = fs.mkdtempSync(path.join(scratch, 'bin-'));
    const write = (name, body) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return file;
    };
    const pgDump = write('pg_dump', dump === 'ok'
        ? 'for arg in "$@"; do case "$arg" in --file=*) printf "PGDMP fake dump" > "${arg#--file=}";; esac; done\nexit 0'
        : 'echo "pg_dump: error: connection failed" >&2\nexit 1');
    const pgRestore = write('pg_restore', list === 'ok'
        ? 'base=$(basename "$2" .dump); qualified=${base#*Z-}; echo "; Archive"; echo "3; 0 16400 TABLE DATA ${qualified%%.*} ${qualified#*.} geo_user"'
        : 'echo "; Archive with no data"');
    return { pgDump, pgRestore };
}

const deployScript = path.join(scratch, 'deploy-backend.sh');
fs.writeFileSync(deployScript, ['DDL_FILES=(', '    routes/proposals-ddl.sql', '    routes/design-ddl.sql', '    db/publication-immutability.sql', ')'].join('\n'));
const args = (overrides = {}) => ({ 'dry-run': false, backup: undefined, apply: false, role: 'geo_user', 'no-role': false,
    'pg-dump': 'pg_dump', 'pg-restore': 'pg_restore', 'deploy-script': deployScript, ...overrides });
const connection = { databaseUrl: () => 'postgres://tester@localhost:1/none', database: { database: 'none', host: 'localhost', port: 1, user: 'tester' } };

let lines;
beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation(line => lines.push(String(line).replace(/^\[[^\]]+\] /, '')));
});
afterEach(() => vi.restoreAllMocks());

describe('dropProposalEra', () => {
    it('lists every object with its rows, size and what goes with it, and the deploy lines, writing nothing on a dry run', async () => {
        const client = fakeClient();
        const result = await dropProposalEra(client, args({ 'dry-run': true }), connection);
        expect(result).toMatchObject({ manifest: null, dropped: false });
        expect(lines).toEqual(expect.arrayContaining([
            '2 table(s) and 2 function(s) to drop:',
            '   table public.proposal: 3 row(s), 2.00 MB, owner geo_user',
            '      with it: index proposal_pkey',
            '      with it: trigger proposal_publication_immutable (enforce_proposal_publication)',
            '   table consensus.proposal_site_backup_v1 (migration backup): 2 row(s), 1.00 MB, owner geo_user',
            '   function public.enforce_proposal_publication()',
            '   function public.enforce_named_plan_publication()',
            'nothing outside the set depends on these objects',
            'remove these 2 line(s) from deploy-backend.sh (DDL_FILES and the comment that names them) in the same change as the drop:',
            '      2:     routes/proposals-ddl.sql',
            '      4:     db/publication-immutability.sql',
            'dry run: nothing written (--backup DIR to dump, --backup DIR --apply to drop)'
        ]));
        expect(writes(client)).toEqual([]);
        expect(client.calls.every(sql => /^SELECT/.test(sql))).toBe(true);
    });

    it('refuses to back up or drop while anything outside the set depends on it', async () => {
        const dependents = [{ kind: 'view or rule', object: 'reporting.proposal_summary' }];
        await dropProposalEra(fakeClient({ dependents }), args({ 'dry-run': true }), connection);
        expect(lines).toEqual(expect.arrayContaining([
            'REFUSED: 1 object(s) outside the set depend on it; drop or re-point them first (no CASCADE):',
            '   view or rule reporting.proposal_summary'
        ]));
        const backupDir = path.join(scratch, 'refused');
        const client = fakeClient({ dependents });
        await expect(dropProposalEra(client, args({ backup: backupDir, apply: true, ...binaries() }), connection))
            .rejects.toThrow(/nothing was backed up or dropped/);
        expect(fs.existsSync(backupDir)).toBe(false);
        expect(writes(client)).toEqual([]);
    });

    it('drops nothing unless the backup of every table completed in the same run', async () => {
        for (const [bins, message] of [
            [binaries({ dump: 'fail' }), /pg_dump exited 1: pg_dump: error: connection failed/],
            [binaries({ list: 'empty' }), /the dump of public\.proposal holds no TABLE DATA entry; nothing is dropped/],
            [{ pgDump: path.join(scratch, 'no-such-pg_dump'), pgRestore: 'pg_restore' }, /no-such-pg_dump could not start/]
        ]) {
            const client = fakeClient();
            await expect(dropProposalEra(client, args({ backup: fs.mkdtempSync(path.join(scratch, 'dump-')), apply: true, 'pg-dump': bins.pgDump, 'pg-restore': bins.pgRestore }), connection))
                .rejects.toThrow(message);
            expect(writes(client)).toEqual([]);
        }
    });

    it('backs up every table and the functions with a manifest, and with --backup alone drops nothing', async () => {
        const dir = fs.mkdtempSync(path.join(scratch, 'backup-only-'));
        const bins = binaries();
        const client = fakeClient();
        const { manifest, dropped } = await dropProposalEra(client, args({ backup: dir, 'pg-dump': bins.pgDump, 'pg-restore': bins.pgRestore }), connection);
        expect(dropped).toBe(false);
        expect(manifest.files.map(file => [file.object, file.rows ?? null])).toEqual([['public.proposal', 3], ['consensus.proposal_site_backup_v1', 2], ['functions', null]]);
        for (const file of manifest.files) {
            const bytes = fs.readFileSync(path.join(dir, file.file));
            expect(file.bytes).toBe(bytes.length);
            expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(fs.readFileSync(path.join(dir, manifest.files[2].file), 'utf8')).toMatch(/enforce_proposal_publication[\s\S]*enforce_named_plan_publication/);
        expect(fs.readdirSync(dir).filter(name => name.endsWith('-manifest.json'))).toHaveLength(1);
        expect(JSON.stringify(manifest)).not.toContain('postgres://');
        expect(writes(client)).toEqual([]);
        expect(lines).toContain('backup only: nothing dropped (add --apply to drop after a fresh backup)');
    });

    it('drops everything in one transaction as the owner role after the backup, and a rerun finds nothing', async () => {
        const bins = binaries();
        const client = fakeClient();
        const result = await dropProposalEra(client, args({ backup: fs.mkdtempSync(path.join(scratch, 'apply-')), apply: true, 'pg-dump': bins.pgDump, 'pg-restore': bins.pgRestore }), connection);
        expect(result.dropped).toBe(true);
        expect(writes(client)).toEqual([
            'BEGIN',
            'SET LOCAL ROLE "geo_user"',
            "SET LOCAL lock_timeout = '30s'",
            'LOCK TABLE "public"."proposal", "consensus"."proposal_site_backup_v1" IN ACCESS EXCLUSIVE MODE',
            'DROP TABLE "public"."proposal", "consensus"."proposal_site_backup_v1"',
            'DROP FUNCTION "public"."enforce_proposal_publication"()',
            'DROP FUNCTION "public"."enforce_named_plan_publication"()',
            'COMMIT'
        ]);
        expect(client.calls.some(sql => /CASCADE/i.test(sql))).toBe(false);

        const rerun = fakeClient({ empty: true });
        const again = await dropProposalEra(rerun, args({ backup: fs.mkdtempSync(path.join(scratch, 'rerun-')), apply: true, 'pg-dump': path.join(scratch, 'never-run'), 'pg-restore': 'pg_restore' }), connection);
        expect(again).toMatchObject({ manifest: null, dropped: false });
        expect(writes(rerun)).toEqual([]);
        expect(lines).toContain('nothing proposal-era is left in this database');
    });

    it('rolls back when a table changed after its dump, and drops as the connecting user with --no-role', async () => {
        const bins = binaries();
        const changed = fakeClient({ rowsLater: { proposal: 4, proposal_site_backup_v1: 2 } });
        await expect(dropProposalEra(changed, args({ backup: fs.mkdtempSync(path.join(scratch, 'changed-')), apply: true, 'pg-dump': bins.pgDump, 'pg-restore': bins.pgRestore }), connection))
            .rejects.toThrow('public.proposal has 4 rows now, 3 when it was dumped; run again');
        expect(writes(changed).at(-1)).toBe('ROLLBACK');
        expect(writes(changed).some(sql => /^DROP|^COMMIT/.test(sql))).toBe(false);

        const plain = fakeClient();
        await dropProposalEra(plain, args({ backup: fs.mkdtempSync(path.join(scratch, 'no-role-')), apply: true, 'no-role': true, 'pg-dump': bins.pgDump, 'pg-restore': bins.pgRestore }), connection);
        expect(writes(plain).some(sql => sql.startsWith('SET LOCAL ROLE'))).toBe(false);
        expect(writes(plain).at(-1)).toBe('COMMIT');
    });
});
