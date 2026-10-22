// agents/lens-owner-registry.js over a mock pool: reading a parcel's owner set from the lens member's
// devnet owner registry, planning sole-owner registrations (never replacing another owner), and writing
// each parcel in its own transaction under a per-parcel advisory lock, re-reading the parcel inside it.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
    OWNER_TABLE, REGISTRATION_LOCK_NAMESPACE, agentRegistrationNote, isSoleOwner, planOwnerRegistrations, readParcelOwners, registerSoleOwners
} from '../agents/lens-owner-registry.js';
import { createMockPool } from './helpers/mock-pool.js';
import { createLedgerPool } from './helpers/agent-chain-fakes.js';

const densifier = Keypair.generate().publicKey.toBase58();
const builder = Keypair.generate().publicKey.toBase58();
const stranger = Keypair.generate().publicKey.toBase58();
const statements = pool => pool.getCalls().map(call => call.sql.replace(/\s+/g, ' ').trim());

describe('reading owner sets', () => {
    it('reads every asked parcel in one statement, an empty set for a parcel nobody owns', async () => {
        const pool = createLedgerPool({ owners: [
            // pg returns owner_count as text from some drivers' paths: it is read back as a number.
            { parcelUid: 'HR-2', owner: builder, ownerCount: '2', establishedAt: '2026-10-01T00:00:00.000Z', note: 'agent builder-02' },
            { parcelUid: 'HR-2', owner: densifier, ownerCount: 2, establishedAt: '2026-10-02T00:00:00.000Z' },
            { parcelUid: 'HR-9', owner: stranger }
        ] });
        const owners = await readParcelOwners(pool, ['HR-2', 'HR-1', 'HR-2', '']);
        expect([...owners.keys()]).toEqual(['HR-2', 'HR-1']);
        expect(owners.get('HR-1')).toEqual([]);
        const shared = owners.get('HR-2');
        expect(shared.map(row => row.owner)).toEqual([builder, densifier].sort());
        expect(shared.find(row => row.owner === builder)).toEqual({ owner: builder, ownerCount: 2, establishedAt: '2026-10-01T00:00:00.000Z', note: 'agent builder-02' });
        expect(shared.find(row => row.owner === densifier)).toEqual({ owner: densifier, ownerCount: 2, establishedAt: '2026-10-02T00:00:00.000Z', note: null });
        expect(pool.getCalls()).toHaveLength(1);
        expect(pool.getCalls()[0].params).toEqual([['HR-2', 'HR-1']]);
        expect(statements(pool)[0]).toContain(`FROM ${OWNER_TABLE}`);
        const none = createMockPool();
        expect(await readParcelOwners(none, [])).toEqual(new Map());
        expect(none.getCalls()).toEqual([]);
    });

    it('calls a wallet the sole owner only when it is the one owner with a count of one', () => {
        expect(isSoleOwner([{ owner: densifier, ownerCount: 1 }], densifier)).toBe(true);
        expect(isSoleOwner([{ owner: densifier, ownerCount: 2 }], densifier)).toBe(false);
        expect(isSoleOwner([{ owner: builder, ownerCount: 1 }], densifier)).toBe(false);
        expect(isSoleOwner([{ owner: densifier, ownerCount: 1 }, { owner: builder, ownerCount: 1 }], densifier)).toBe(false);
        expect(isSoleOwner([], densifier)).toBe(false);
    });
});

describe('planning registrations', () => {
    it('registers unowned parcels, keeps a persona\'s own and never replaces anyone else\'s', () => {
        const owners = new Map([
            ['HR-1', []],
            ['HR-2', [{ owner: densifier, ownerCount: 1 }]],
            ['HR-3', [{ owner: stranger, ownerCount: 1 }]],
            ['HR-4', [{ owner: densifier, ownerCount: 2 }, { owner: stranger, ownerCount: 2 }]]
        ]);
        const plan = planOwnerRegistrations([
            { parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01' },
            { parcelId: 'HR-2', wallet: densifier, persona: 'densifier-01' },
            { parcelId: 'HR-3', wallet: densifier, persona: 'densifier-01' },
            { parcelId: 'HR-4', wallet: densifier, persona: 'densifier-01' },
            { parcelId: 'HR-1', wallet: builder, persona: 'builder-02' },
            { parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01' }
        ], owners);
        expect(plan.register).toEqual([{ parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01' }]);
        expect(plan.registered).toEqual([{ parcelId: 'HR-2', wallet: densifier, persona: 'densifier-01' }]);
        expect(plan.conflicts).toEqual([
            { parcelId: 'HR-3', wallet: densifier, persona: 'densifier-01', reason: `registered to ${stranger}` },
            { parcelId: 'HR-4', wallet: densifier, persona: 'densifier-01', reason: `registered to ${densifier}, ${stranger}` },
            { parcelId: 'HR-1', wallet: builder, persona: 'builder-02', reason: 'also picked by densifier-01' }
        ]);
    });
});

describe('writing registrations', () => {
    it('inserts each parcel in its own transaction under its advisory lock, with the agent\'s note', async () => {
        const pool = createLedgerPool();
        const logged = [];
        const results = await registerSoleOwners(pool, [
            { parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01' },
            { parcelId: 'HR-2', wallet: builder, persona: 'builder-02' }
        ], { note: agentRegistrationNote('run.mjs --seed-owners'), log: line => logged.push(line) });
        expect(results.map(result => result.outcome)).toEqual(['inserted', 'inserted']);
        expect(pool.owners('HR-1')).toEqual([expect.objectContaining({ owner_wallet: densifier, owner_count: 1, note: 'agent densifier-01 (run.mjs --seed-owners)' })]);
        expect(pool.owners('HR-2')).toEqual([expect.objectContaining({ owner_wallet: builder, owner_count: 1 })]);
        const sql = statements(pool);
        expect(sql.slice(0, 5)).toEqual([
            'BEGIN',
            'SELECT pg_advisory_xact_lock($1, hashtext($2))',
            `SELECT owner_wallet, owner_count FROM ${OWNER_TABLE} WHERE parcel_uid = $1`,
            expect.stringContaining(`INSERT INTO ${OWNER_TABLE}`),
            'COMMIT'
        ]);
        expect(pool.getCalls()[1].params).toEqual([REGISTRATION_LOCK_NAMESPACE, 'HR-1']);
        expect(sql.filter(text => text === 'BEGIN')).toHaveLength(2);
        expect(logged).toEqual([`1/2 HR-1 → densifier-01 ${densifier}: inserted`, `2/2 HR-2 → builder-02 ${builder}: inserted`]);
    });

    it('leaves a parcel registered meanwhile as it is: its own wallet\'s is reported registered, another\'s a conflict', async () => {
        const pool = createLedgerPool({ owners: [{ parcelUid: 'HR-1', owner: densifier }, { parcelUid: 'HR-2', owner: stranger }] });
        const results = await registerSoleOwners(pool, [
            { parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01' },
            { parcelId: 'HR-2', wallet: densifier, persona: 'densifier-01' }
        ]);
        expect(results).toEqual([
            { parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01', outcome: 'registered', owners: [densifier] },
            { parcelId: 'HR-2', wallet: densifier, persona: 'densifier-01', outcome: 'conflict', owners: [stranger] }
        ]);
        expect(statements(pool).filter(text => text.startsWith('INSERT'))).toEqual([]);
        expect(statements(pool).filter(text => text === 'ROLLBACK')).toHaveLength(2);
        expect(pool.owners('HR-2')).toEqual([expect.objectContaining({ owner_wallet: stranger })]);
    });

    it('rolls back and releases the client when a write fails', async () => {
        const pool = createMockPool();
        let released = 0;
        pool.answer(/INSERT INTO consensus\.lens_devnet_owner/, () => { throw new Error('duplicate key value'); });
        const connect = pool.connect.bind(pool);
        pool.connect = async () => ({ ...(await connect()), release: () => { released += 1; } });
        await expect(registerSoleOwners(pool, [{ parcelId: 'HR-1', wallet: densifier, persona: 'densifier-01' }])).rejects.toThrow('duplicate key value');
        expect(statements(pool).at(-1)).toBe('ROLLBACK');
        expect(statements(pool)).not.toContain('COMMIT');
        expect(released).toBe(1);
    });
});
