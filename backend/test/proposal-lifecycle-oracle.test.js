// Pure contract tests for the first land-event oracle: account decoding, immutable evidence and
// recipe hashing. They do not require Solana RPC or PostgreSQL.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeBase58, loadIdls } from '../solana/tx-decoder.js';
import {
    buildProposalLifecycleEvent,
    buildProposalLifecycleRecipe,
    readProposalStatus,
    STATUS_CANCELLED,
    STATUS_EXECUTED,
    sourceForProposal,
    syncProposalLifecycleEvents
} from '../oracle/proposal-lifecycle.js';

const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const OWNER = 'AMbsiEBzgfFbRF2Nu72wFJYkL4iEULhzNffqJhPqmkoQ';
const PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

function proposalAccount(status) {
    const parcel = Buffer.from('HR-1');
    const uri = Buffer.from('https://example.test/proposal');
    const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
    return Buffer.concat([
        Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(32),
        u32(1), u32(parcel.length), parcel,
        Buffer.from([0]), u32(uri.length), uri, Buffer.from([1, status])
    ]);
}

describe('proposal lifecycle oracle', () => {
    it('decodes source status without converting missing data into a plausible status', () => {
        expect(readProposalStatus(proposalAccount(STATUS_EXECUTED))).toBe(STATUS_EXECUTED);
        expect(readProposalStatus(proposalAccount(STATUS_CANCELLED))).toBe(STATUS_CANCELLED);
        expect(() => readProposalStatus(Buffer.alloc(12))).toThrow(/length|ended|status/);
    });

    it('hashes the full subject-specific recipe deterministically', () => {
        const first = buildProposalLifecycleRecipe({ proposalAccount: 'proposal-1', marketAccount: 'market-1' });
        const replay = buildProposalLifecycleRecipe({ proposalAccount: 'proposal-1', marketAccount: 'market-1' });
        const other = buildProposalLifecycleRecipe({ proposalAccount: 'proposal-2', marketAccount: 'market-1' });
        expect(first).toEqual(replay);
        expect(first.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(other.hash).not.toBe(first.hash);
        expect(first).toMatchObject({
            eventType: 'proposal_lifecycle', outcomes: { executed: 'YES', cancelled: 'NO' },
            verification: { permissionless: true }
        });
    });

    it('uses the chain block time and account bytes as event evidence', () => {
        const data = proposalAccount(STATUS_EXECUTED);
        const event = buildProposalLifecycleEvent({
            proposalAccount: 'proposal-1', status: STATUS_EXECUTED, accountData: data,
            transaction: 'tx-1', blockTime: 1_789_895_600, slot: 42
        });
        expect(event).toMatchObject({
            eventType: 'proposal_lifecycle', outcome: 'executed',
            observedAt: '2026-09-20T09:13:20.000Z',
            source: { transaction: 'tx-1', slot: 42 },
            evidence: { proposalStatusByte: STATUS_EXECUTED }
        });
        expect(event.source.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(() => buildProposalLifecycleEvent({
            proposalAccount: 'proposal-1', status: STATUS_EXECUTED, accountData: data,
            transaction: 'tx-1', blockTime: null
        })).toThrow(/block time/);
    });

    it('skips non-Solana proposal identifiers instead of aborting the oracle run', async () => {
        const pool = {
            query: async sql => sql.includes('SELECT DISTINCT')
                ? { rows: [{ proposal_account: '42' }] }
                : { rows: [] }
        };
        const connection = { getMultipleAccountsInfo: async () => { throw new Error('no RPC call expected'); } };
        const result = await syncProposalLifecycleEvents({ pool, connection, dryRun: true });
        expect(result).toMatchObject({ scanned: 0, terminal: 0, invalidAccounts: ['42'] });
    });

    it('anchors cancellation only to the matching successful program instruction', () => {
        const discriminator = createHash('sha256').update('global:cancel_and_refund').digest().subarray(0, 8);
        const raw = {
            slot: 10,
            blockTime: 1_789_895_600,
            meta: { err: null, fee: 5000, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
            transaction: {
                signatures: ['tx-cancel'],
                message: {
                    accountKeys: [
                        { pubkey: OWNER, signer: true, writable: true },
                        { pubkey: PROPOSAL, signer: false, writable: true },
                        { pubkey: PROGRAM, signer: false, writable: false }
                    ],
                    instructions: [{ programId: PROGRAM, accounts: [PROPOSAL, OWNER], data: encodeBase58(discriminator) }]
                }
            }
        };
        const idls = loadIdls(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../blockchain/solana/idl'));
        expect(sourceForProposal([{ signature: 'tx-cancel', raw }], PROPOSAL, STATUS_CANCELLED, idls))
            .toMatchObject({ signature: 'tx-cancel' });
        expect(sourceForProposal([{ signature: 'tx-cancel', raw }], PROPOSAL, STATUS_EXECUTED, idls)).toBeNull();
    });
});
