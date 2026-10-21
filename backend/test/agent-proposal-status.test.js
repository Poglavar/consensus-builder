import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { applyProposalStatuses, refreshProposalStatuses } from '../agents/discovery.js';
import { selectSupportAction } from '../agents/supporter-picker.js';
import { PROPOSAL_PROGRAM_ID } from '../agents/lifecycle-actions.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';

const addresses = [PublicKey.default.toBase58(), PROPOSAL_PROGRAM_ID, 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB'];
const proposals = () => addresses.map((address, index) => ({ proposalId: `p-${index}`, lifecycleStatus: 'Active',
    onchain: { proposalId: address, chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID } }));
const info = status => ({ owner: new PublicKey(PROPOSAL_PROGRAM_ID), data: proposalAccountBytes({ status }) });

describe('confirmed proposal lifecycle inputs and API reconciliation', () => {
    it('excludes ordinary proposals incorrectly advertised as active once chain state is terminal', () => {
        const rows = proposals();
        applyProposalStatuses(rows, [info(3), info(2), info(1)]);
        expect(rows.map(p => p.lifecycleStatus)).toEqual(['Expired', 'Cancelled', 'Executed']);
        expect(selectSupportAction({ day: '2026-10-20', persona: { name: 'supporter' }, proposals: rows }).selected).toBeNull();
    });

    it('batches to the provider limit and repairs only terminal lifecycle columns', async () => {
        const rows = proposals();
        const states = new Map(addresses.map((address, i) => [address, info([3, 0, 2][i])]));
        const connection = { getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => states.get(key.toBase58()))) };
        const pool = { query: vi.fn(async () => ({ rowCount: 2 })) }, log = vi.fn();
        await refreshProposalStatuses(rows, connection, { env: { SOLANA_RPC_MAX_ACCOUNTS: '2' }, pool, log });
        expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([2, 1]);
        const [sql, params] = pool.query.mock.calls[0];
        expect(JSON.parse(params[0])).toEqual([{ account: addresses[0], status: 'Expired' }, { account: addresses[2], status: 'Cancelled' }]);
        expect(sql).toContain('updated_at = now()');
        expect(sql).toContain("p.onchain_data->>'proposalId' = observed.account");
        expect(sql).toContain("= 'solana-devnet'");
        expect(sql).not.toMatch(/SET proposal_data|SET onchain_data/);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('reconciled 2'));
    });

    it('never persists on a read-only call, or writes Active over a terminal read model', async () => {
        const pool = { query: vi.fn() };
        await refreshProposalStatuses(proposals().slice(0, 1), { getMultipleAccountsInfo: async () => [info(3)] });
        await refreshProposalStatuses(proposals().slice(0, 1), { getMultipleAccountsInfo: async () => [info(0)] }, { pool });
        expect(pool.query).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', null],
        ['foreign', { ...info(0), owner: PublicKey.default }],
        ['wrong discriminator', { ...info(0), data: Buffer.alloc(4096) }],
        ['unknown status', info(255)],
        ['truncated', { ...info(0), data: info(0).data.subarray(0, 18) }]
    ])('fails closed on a %s account before changing inputs or the API', async (_label, badInfo) => {
        const rows = proposals().slice(0, 2), pool = { query: vi.fn() };
        await expect(refreshProposalStatuses(rows, { getMultipleAccountsInfo: async () => [info(3), badInfo] }, { pool })).rejects.toThrow();
        expect(rows.map(p => p.lifecycleStatus)).toEqual(['Active', 'Active']);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('keeps a past local expiry ineligible without inventing a terminal chain state', async () => {
        const rows = proposals().slice(0, 1);
        rows[0].expiresAt = '2000-01-01T00:00:00Z';
        const pool = { query: vi.fn() };
        await refreshProposalStatuses(rows, { getMultipleAccountsInfo: async () => [info(0)] }, { pool });
        expect(rows[0]).toMatchObject({ lifecycleStatus: 'Expired', onchainLifecycleStatus: 'Active' });
        expect(pool.query).not.toHaveBeenCalled();
        expect(selectSupportAction({ day: '2026-10-20', persona: { name: 'supporter' }, proposals: rows }).selected).toBeNull();
    });

    it('propagates RPC and database failures' , async () => {
        await expect(refreshProposalStatuses(proposals(), { getMultipleAccountsInfo: async () => { throw new Error('RPC offline'); } })).rejects.toThrow('RPC offline');
        await expect(refreshProposalStatuses(proposals().slice(0, 1), { getMultipleAccountsInfo: async () => [info(3)] }, {
            pool: { query: async () => { throw new Error('database offline'); } }
        })).rejects.toThrow('database offline');
    });

    it('leaves unminted and other-chain records outside the Solana read', async () => {
        const rows = [{ proposalId: 'draft', lifecycleStatus: 'draft' }, { proposalId: 'evm', lifecycleStatus: 'Active', onchain: { chainId: '0xaa36a7', proposalId: '0x5' } }];
        const connection = { getMultipleAccountsInfo: vi.fn() };
        expect(await refreshProposalStatuses(rows, connection)).toBe(rows);
        expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });
});
