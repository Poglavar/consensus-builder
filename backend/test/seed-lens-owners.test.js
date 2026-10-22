// scripts/seed-lens-owners.mjs: the CLI refuses to run without parameters (usage) and on bad ones before it
// touches a database; on a mock pool its core lists the day's picks as a dry run, registers them under
// --apply (each parcel under its lock, read back), skips contest picks, and exits 3 on a parcel held by
// another wallet or wanted by two personas, never replacing an owner.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { EXIT_CONFLICTS, picksOfRuns, proposerPersonas, seedLensOwners } from '../scripts/seed-lens-owners.mjs';
import { createLedgerPool } from './helpers/agent-chain-fakes.js';

const SCRIPT = fileURLToPath(new URL('../scripts/seed-lens-owners.mjs', import.meta.url));
const densifier = Keypair.generate().publicKey.toBase58();
const builder = Keypair.generate().publicKey.toBase58();
const stranger = Keypair.generate().publicKey.toBase58();
const personas = proposerPersonas({ personas: [
    { name: 'densifier-01', role: 'proposer', wallet: densifier },
    { name: 'builder-02', wallet: builder },
    { name: 'gentle-01', role: 'proposer', wallet: Keypair.generate().publicKey.toBase58() },
    { name: 'unfunded-01', role: 'proposer' },
    { name: 'notary-01', role: 'lens-member', wallet: stranger }
] });

function run(persona, day, picks, { slot = null } = {}) {
    return {
        run_id: `${slot ? `${day}-${slot}` : day}-${persona}`, persona, day,
        summary: {
            candidates: picks.map(([parcelId, rival]) => ({ candidateId: `${persona}:${parcelId}`, parcelId, ...(rival ? { rival: { persona: rival, agreementCid: 'x' } } : {}) })),
            picks: picks.map(([parcelId], index) => ({ candidateId: `${persona}:${parcelId}`, pickId: `agent-${persona}-${day}-${index + 1}` }))
        }
    };
}
const RUNS = [
    run('densifier-01', '2026-10-22', [['HR-1'], ['HR-2']], { slot: 'h08' }),
    run('builder-02', '2026-10-22', [['HR-3']]),
    run('gentle-01', '2026-10-22', [['HR-1', 'densifier-01']]),
    run('densifier-01', '2026-10-21', [['HR-9']])
];
const quiet = () => {};

describe('the CLI', () => {
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30000 });

    it('prints its usage and runs nothing without parameters or with --help', () => {
        for (const args of [[], ['--help']]) {
            const result = cli(...args);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Usage:');
            expect(result.stdout).toContain('--apply');
            expect(result.stdout).not.toContain('dry run ·');
        }
    });

    it('refuses bad parameters before it reads any configuration', () => {
        for (const args of [['--parcel', 'HR-1'], ['--day', '22-10-2026'], ['--day', '2026-10-22', '--slot', '../x'], ['--bogus'], ['--parcel', 'HR-1', '--persona', 'densifier-01', '--day', '2026-10-22'], ['--day']]) {
            const result = cli(...args);
            expect(result.status, args.join(' ')).toBe(2);
            expect(result.stdout).toContain('Usage:');
        }
    });
});

describe('the picks of a day', () => {
    it('wants each pick\'s parcel for its persona, skipping contest picks and picks without a candidate', () => {
        const broken = run('builder-02', '2026-10-22', [['HR-7']]);
        broken.summary.candidates = [];
        const { wanted, skipped } = picksOfRuns([...RUNS.slice(0, 3), broken], personas, { day: '2026-10-22' });
        expect(wanted.map(item => [item.parcelId, item.persona, item.wallet])).toEqual([
            ['HR-1', 'densifier-01', densifier], ['HR-2', 'densifier-01', densifier], ['HR-3', 'builder-02', builder]
        ]);
        expect(skipped).toEqual([
            { runId: '2026-10-22-gentle-01', pickId: 'agent-gentle-01-2026-10-22-1', parcelId: 'HR-1', reason: 'contest pick answering densifier-01' },
            { runId: '2026-10-22-builder-02', pickId: 'agent-builder-02-2026-10-22-1', reason: 'no candidate parcel in the checkpoint' }
        ]);
    });

    it('narrows to one persona or one slot, and only proposers count', () => {
        expect(picksOfRuns(RUNS, personas, { day: '2026-10-22', persona: 'builder-02' }).wanted.map(item => item.parcelId)).toEqual(['HR-3']);
        expect(picksOfRuns(RUNS, personas, { day: '2026-10-22', slot: 'h08' }).wanted.map(item => item.parcelId)).toEqual(['HR-1', 'HR-2']);
        const lensRun = run('notary-01', '2026-10-22', [['HR-5']]);
        expect(picksOfRuns([lensRun], personas, { day: '2026-10-22' }).wanted).toEqual([]);
        expect(() => picksOfRuns([run('unfunded-01', '2026-10-22', [['HR-6']])], personas, { day: '2026-10-22' })).toThrow(/has no wallet yet/);
    });
});

describe('registering the day\'s picks', () => {
    it('lists what it would register in a dry run and writes nothing', async () => {
        const pool = createLedgerPool({ runs: RUNS });
        const logged = [];
        const result = await seedLensOwners({ day: '2026-10-22', apply: false }, { pool, personas, log: line => logged.push(line) });
        expect(result.exitCode).toBe(0);
        expect(result.plan.register.map(item => item.parcelId).sort()).toEqual(['HR-1', 'HR-2', 'HR-3']);
        expect(pool.getCalls().some(call => /INSERT/.test(call.sql))).toBe(false);
        expect(pool.owners('HR-1')).toEqual([]);
        expect(logged).toContain(`   would register HR-1 → densifier-01 ${densifier}`);
        expect(logged).toContain('dry run: nothing written (add --apply)');
        // Only that day's runs are read.
        expect(pool.getCalls().find(call => /consensus\.agent_run/.test(call.sql)).params).toEqual(['2026-10-22']);
    });

    it('registers under --apply, reads the registry back, and registers nothing again on a rerun', async () => {
        const pool = createLedgerPool({ runs: RUNS });
        const applied = await seedLensOwners({ day: '2026-10-22', apply: true }, { pool, personas, log: quiet });
        expect(applied.exitCode).toBe(0);
        expect(applied.results.map(item => [item.parcelId, item.outcome]).sort()).toEqual([['HR-1', 'inserted'], ['HR-2', 'inserted'], ['HR-3', 'inserted']]);
        expect(pool.owners('HR-1')).toEqual([expect.objectContaining({ owner_wallet: densifier, owner_count: 1, note: 'agent densifier-01 (seed-lens-owners.mjs)' })]);
        expect(pool.owners('HR-3')).toEqual([expect.objectContaining({ owner_wallet: builder })]);
        expect(pool.getCalls().filter(call => /pg_advisory_xact_lock/.test(call.sql)).map(call => call.params[1]).sort()).toEqual(['HR-1', 'HR-2', 'HR-3']);

        const rerun = await seedLensOwners({ day: '2026-10-22', apply: true }, { pool, personas, log: quiet });
        expect(rerun).toMatchObject({ exitCode: 0, results: [] });
        expect(rerun.plan.registered.map(item => item.parcelId).sort()).toEqual(['HR-1', 'HR-2', 'HR-3']);
    });

    it('exits 3 on a parcel another wallet holds, registering the rest and leaving that owner in place', async () => {
        const pool = createLedgerPool({ runs: RUNS, owners: [{ parcelUid: 'HR-2', owner: stranger }] });
        const result = await seedLensOwners({ day: '2026-10-22', apply: true }, { pool, personas, log: quiet });
        expect(result.exitCode).toBe(EXIT_CONFLICTS);
        expect(EXIT_CONFLICTS).toBe(3);
        expect(result.plan.conflicts).toEqual([expect.objectContaining({ parcelId: 'HR-2', persona: 'densifier-01', reason: `registered to ${stranger}` })]);
        expect(pool.owners('HR-2')).toEqual([expect.objectContaining({ owner_wallet: stranger })]);
        expect(pool.owners('HR-1')).toEqual([expect.objectContaining({ owner_wallet: densifier })]);
    });

    it('exits 3 when two personas want one parcel, and registers one parcel named with --parcel', async () => {
        const twice = [run('densifier-01', '2026-10-22', [['HR-4']]), run('builder-02', '2026-10-22', [['HR-4']])];
        const contested = await seedLensOwners({ day: '2026-10-22', apply: false }, { pool: createLedgerPool({ runs: twice }), personas, log: quiet });
        expect(contested.exitCode).toBe(EXIT_CONFLICTS);
        // The first run read (newest first) claims the parcel; the other persona's pick is the conflict.
        expect(contested.plan.conflicts).toHaveLength(1);
        const [conflict] = contested.plan.conflicts;
        const claimant = contested.plan.register[0];
        expect(conflict.parcelId).toBe('HR-4');
        expect([conflict.persona, claimant.persona].sort()).toEqual(['builder-02', 'densifier-01']);
        expect(conflict.reason).toBe(`also picked by ${claimant.persona}`);

        const pool = createLedgerPool();
        const one = await seedLensOwners({ parcel: 'HR-8', persona: 'builder-02', apply: true }, { pool, personas, log: quiet });
        expect(one).toMatchObject({ exitCode: 0, wanted: [{ parcelId: 'HR-8', wallet: builder, persona: 'builder-02' }] });
        expect(pool.owners('HR-8')).toEqual([expect.objectContaining({ owner_wallet: builder })]);
        expect(pool.getCalls().some(call => /consensus\.agent_run/.test(call.sql))).toBe(false);
        await expect(seedLensOwners({ parcel: 'HR-8', persona: 'nobody', apply: false }, { pool, personas, log: quiet })).rejects.toThrow(/no proposer persona named nobody/);
    });
});
