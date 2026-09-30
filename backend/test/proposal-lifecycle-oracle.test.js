// Pure contract tests for the first land-event oracle: account decoding, immutable evidence and
// recipe hashing. They do not require Solana RPC or PostgreSQL.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { encodeBase58, loadIdls } from '../solana/tx-decoder.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';
import {
    buildProposalLifecycleEvent,
    buildProposalLifecycleRecipe,
    buildProposalLifecycleRecipeV2,
    readProposalLens,
    recipeForProposalAccount,
    readProposalStatus,
    STATUS_CANCELLED,
    STATUS_EXECUTED,
    STATUS_EXPIRED,
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

function cancellationTransaction() {
    const discriminator = createHash('sha256').update('global:cancel_and_refund').digest().subarray(0, 8);
    return {
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
}

describe('proposal lifecycle oracle', () => {
    it('decodes source status without converting missing data into a plausible status', () => {
        expect(readProposalStatus(proposalAccount(STATUS_EXECUTED))).toBe(STATUS_EXECUTED);
        expect(readProposalStatus(proposalAccount(STATUS_CANCELLED))).toBe(STATUS_CANCELLED);
        expect(() => readProposalStatus(Buffer.alloc(12))).toThrow(/length|ended|status/);
    });

    it('reads the lens after accepted_parcels and refuses a truncated one', () => {
        const data = proposalAccountBytes({ status: STATUS_EXECUTED, acceptedParcels: ['HR-1', 'HR-22'], lens: [OWNER, PROGRAM] });
        expect(readProposalStatus(data)).toBe(STATUS_EXECUTED);
        expect(readProposalLens(data)).toEqual([OWNER, PROGRAM]);
        expect(readProposalLens(proposalAccountBytes({ lens: [] }))).toEqual([]);
        expect(() => readProposalLens(data.subarray(0, data.length - 20))).toThrow(/lens/);
        // v1 accounts end at status in the old fixture below: no lens, never an invented one.
        expect(() => readProposalLens(proposalAccount(STATUS_EXECUTED))).toThrow();
    });

    it('treats Expired (3) as a terminal outcome anchored to settle_with_verdict', () => {
        const event = buildProposalLifecycleEvent({
            proposalAccount: 'proposal-1', status: STATUS_EXPIRED, accountData: proposalAccountBytes({ status: STATUS_EXPIRED }),
            transaction: 'tx-verdict', blockTime: 1_789_895_600
        });
        expect(event).toMatchObject({ outcome: 'expired', id: 'solana:devnet:proposal_lifecycle:proposal-1:expired' });
    });

    it('keeps proposal-lifecycle-v1 byte-identical: its hash is pinned and must never drift', () => {
        const recipe = buildProposalLifecycleRecipe({ proposalAccount: PROPOSAL, marketAccount: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB' });
        expect(recipe.hash).toBe('sha256:4ee703c741d7d49844bf830dd550610be0b2aa0155ba9c694059b7914538e48d');
        expect(buildProposalLifecycleRecipe({ proposalAccount: PROPOSAL }).hash)
            .toBe('sha256:7e52c7ae09e4d299011701104a2ed59d6ba846229f63652cfbc5a2d104e5bc2d');
        expect(recipe).toMatchObject({
            id: 'proposal-lifecycle-v1', version: 1,
            trustedAttesters: [{ kind: 'solana_program', address: PROGRAM }],
            outcomes: { executed: 'YES', cancelled: 'NO' }
        });
    });

    it('hashes the full subject-specific v2 recipe deterministically and commits it to the lens', () => {
        const lens = [OWNER];
        const first = buildProposalLifecycleRecipeV2({ proposalAccount: 'proposal-1', marketAccount: 'market-1', lens });
        const replay = buildProposalLifecycleRecipeV2({ proposalAccount: 'proposal-1', marketAccount: 'market-1', lens });
        const other = buildProposalLifecycleRecipeV2({ proposalAccount: 'proposal-2', marketAccount: 'market-1', lens });
        const otherLens = buildProposalLifecycleRecipeV2({ proposalAccount: 'proposal-1', marketAccount: 'market-1', lens: [PROGRAM] });
        expect(first).toEqual(replay);
        expect(first.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(other.hash).not.toBe(first.hash);
        expect(otherLens.hash).not.toBe(first.hash);
        expect(first).toMatchObject({
            id: 'proposal-lifecycle-v2', version: 2,
            eventType: 'proposal_lifecycle', outcomes: { executed: 'YES', cancelled: 'NO', expired: 'NO' },
            verification: { permissionless: true, statusBytes: { executed: 1, cancelled: 2, expired: 3 } }
        });
        expect(first.trustedAttesters.map(attester => [attester.kind, attester.address]))
            .toEqual([['solana_program', PROGRAM], ['solana_sas_issuer', OWNER]]);
        expect(() => buildProposalLifecycleRecipeV2({ proposalAccount: 'proposal-1' })).toThrow(/lens is required/);
        expect(() => buildProposalLifecycleRecipeV2({ proposalAccount: 'proposal-1', lens: [] })).toThrow(/lens is required/);
    });

    it('picks v2 for an account with a lens key and v1 otherwise', () => {
        const withLens = proposalAccountBytes({ status: STATUS_EXECUTED, lens: [OWNER] });
        expect(recipeForProposalAccount({ proposalAccount: PROPOSAL, accountData: withLens }).id).toBe('proposal-lifecycle-v2');
        expect(recipeForProposalAccount({ proposalAccount: PROPOSAL, accountData: proposalAccountBytes({ lens: [] }) }).id).toBe('proposal-lifecycle-v1');
        expect(recipeForProposalAccount({ proposalAccount: PROPOSAL, accountData: proposalAccount(STATUS_EXECUTED) }).id).toBe('proposal-lifecycle-v1');
        const event = buildProposalLifecycleEvent({
            proposalAccount: PROPOSAL, status: STATUS_EXECUTED, accountData: withLens, transaction: 'tx-1', blockTime: 1_789_895_600
        });
        expect(event.evidence.recipeId).toBe('proposal-lifecycle-v2');
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
        const raw = cancellationTransaction();
        const idls = loadIdls(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../blockchain/solana/idl'));
        expect(sourceForProposal([{ signature: 'tx-cancel', raw }], PROPOSAL, STATUS_CANCELLED, idls))
            .toMatchObject({ signature: 'tx-cancel' });
        expect(sourceForProposal([{ signature: 'tx-cancel', raw }], PROPOSAL, STATUS_EXECUTED, idls)).toBeNull();
    });

    it('atomically persists verified events and reconciles the proposal read model', async () => {
        const calls = [];
        const pool = {
            query: async (sql, params = []) => {
                calls.push({ sql, params });
                if (sql.includes('SELECT DISTINCT')) return { rows: [{ proposal_account: PROPOSAL }] };
                if (sql.includes('consensus.solana_transaction')) {
                    return { rows: [{
                        signature: 'tx-cancel', slot: 10, block_time: 1_789_895_600,
                        raw: cancellationTransaction()
                    }] };
                }
                if (sql.includes('WITH inserted_event')) return { rows: [{ inserted: 1, reconciled: 1 }] };
                throw new Error(`unexpected query: ${sql}`);
            }
        };
        const connection = {
            getMultipleAccountsInfo: async () => [{
                owner: new PublicKey(PROGRAM),
                data: proposalAccount(STATUS_CANCELLED)
            }]
        };

        const result = await syncProposalLifecycleEvents({ pool, connection });

        expect(result).toMatchObject({ terminal: 1, inserted: 1, reconciled: 1, missingEvidence: [] });
        const persistence = calls.find(call => call.sql.includes('WITH inserted_event'));
        expect(persistence.sql).toMatch(/INSERT INTO consensus\.land_event[\s\S]*UPDATE proposal/);
        expect(persistence.sql).toMatch(/proposal_data = CASE[\s\S]*jsonb_set/);
        expect(persistence.params.at(-1)).toBe('Cancelled');
        expect(persistence.params[3]).toBe(PROPOSAL);
    });

    it('does not reconcile the proposal read model during a dry run', async () => {
        const calls = [];
        const pool = {
            query: async (sql, params = []) => {
                calls.push({ sql, params });
                if (sql.includes('SELECT DISTINCT')) return { rows: [{ proposal_account: PROPOSAL }] };
                return { rows: [{
                    signature: 'tx-cancel', slot: 10, block_time: 1_789_895_600,
                    raw: cancellationTransaction()
                }] };
            }
        };
        const connection = {
            getMultipleAccountsInfo: async () => [{
                owner: new PublicKey(PROGRAM),
                data: proposalAccount(STATUS_CANCELLED)
            }]
        };

        const result = await syncProposalLifecycleEvents({ pool, connection, dryRun: true });

        expect(result).toMatchObject({ terminal: 1, inserted: 0, reconciled: 0, dryRun: true });
        expect(calls.some(call => call.sql.includes('UPDATE proposal'))).toBe(false);
    });
});
