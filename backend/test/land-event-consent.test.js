// Lens-model v2 evidence log: proposal_acceptance events from AcceptanceRecord accounts,
// proposal_verdict events from VerdictSettled logs in the transaction store, and the attester
// directory refresh. Fake RPC and pool; covers both the not-yet-deployed no-op and a populated run.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodeParsedTransaction, encodeBase58, loadIdls } from '../solana/tx-decoder.js';
import {
    ACCEPTANCE_RECORD_DISCRIMINATOR,
    buildVerdictEvent,
    decodeAcceptanceRecord,
    decodeVerdictSettled,
    membersFromRecords,
    programDataLogs,
    syncProposalConsentEvents,
    VERDICT_SETTLED_DISCRIMINATOR
} from '../oracle/proposal-consent.js';
import { IDL_DIR, PROPOSAL_PROGRAM_ID, sourceForProposal, STATUS_EXECUTED, STATUS_EXPIRED } from '../oracle/proposal-lifecycle.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(fs.readFileSync(path.join(here, '../../blockchain/solana/idl/proposal_nft.json'), 'utf8'));
const idls = loadIdls(IDL_DIR);
const decode = raw => decodeParsedTransaction(raw, { idls });

const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const MEMBER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const OWNER_A = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const OWNER_B = '8ErKUqcQR3bvuZx2Rt9ke7u38vQBwPPSXWrXJD8YUPyw';
const ATTESTATION_A = 'EVFpL5JVXmsWpJieChQRhXxAHSNCVh8v3KwWdsoniiwB';
const ATTESTATION_B = 'DDi6wgNuAR3GYu2Zirmys4HnB6Ee3DiHpY84bqauqQHH';
const RECORD_A = '6NPKGcQQ6yDzFLyPejeegsjrArHDQcAkHGvX8runxkjB';
const RECORD_B = '2kVqTDdSZG9sTzuvDRUmNgtzJyUmKFF4gytJiv2LmBog';
const VERDICT = 'LU6ENfBJU9BJSgsFJMoBNcafSaMkoZHrjY4bZ61Aim9';
const SYSTEM = '11111111111111111111111111111111';
const PARCEL_ANCHOR = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';
const CREDENTIAL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TALLY = '3kch82dBbEGMJhwjoT6X6xFuyfQLP7o8c6WTnA7Svpz9';
const FOREIGN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ACCEPTED_A = 1_790_000_000;
const ACCEPTED_B = 1_790_000_600;
const SETTLED = 1_790_100_000;

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const key = value => new PublicKey(value).toBuffer();
const str = value => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)]);

function recordBytes({ owner, attestation, acceptedAt, payout = SYSTEM, parcel = 'HR-335649-507' }) {
    return Buffer.concat([
        ACCEPTANCE_RECORD_DISCRIMINATOR, key(PROPOSAL), str(parcel), key(owner), key(MEMBER), key(attestation),
        Buffer.alloc(32, 0xab), key(payout), i64(acceptedAt), Buffer.from([255])
    ]);
}

// v2 events end after settled_at; v3 appends the verdict byte (pass `verdict`).
function verdictPayload(status = STATUS_EXPIRED, verdict = null) {
    return Buffer.concat([
        VERDICT_SETTLED_DISCRIMINATOR, key(PROPOSAL), key(VERDICT), Buffer.alloc(32, 0xcd), key(MEMBER), Buffer.from([status]), i64(SETTLED),
        verdict === null ? Buffer.alloc(0) : Buffer.from([verdict])
    ]);
}

function ixData(name, values) {
    const ix = idl.instructions.find(entry => entry.name === name);
    const parts = ix.args.map(arg => {
        if (arg.type === 'string') return str(values[arg.name]);
        if (arg.type?.option) return values[arg.name] ? Buffer.concat([Buffer.from([1]), key(values[arg.name])]) : Buffer.from([0]);
        throw new Error(`cannot encode ${JSON.stringify(arg.type)}`);
    });
    return encodeBase58(Buffer.concat([Buffer.from(ix.discriminator), ...parts]));
}

function acceptTx(signature, owner, attestation, record) {
    const accounts = [PROPOSAL, PARCEL_ANCHOR, attestation, CREDENTIAL, TALLY, record, owner, owner, SYSTEM];
    return {
        signature, slot: 5, block_time: ACCEPTED_A,
        raw: {
            slot: 5, blockTime: ACCEPTED_A,
            meta: { err: null, fee: 5000, innerInstructions: [], logMessages: [`Program ${PROPOSAL_PROGRAM_ID} invoke [1]`, `Program ${PROPOSAL_PROGRAM_ID} success`] },
            transaction: {
                signatures: [signature],
                message: {
                    accountKeys: [{ pubkey: owner, signer: true, writable: true }, { pubkey: PROPOSAL_PROGRAM_ID, signer: false, writable: false }],
                    instructions: [{ programId: PROPOSAL_PROGRAM_ID, accounts, data: ixData('accept_with_attestations', { parcel_id: 'HR-335649-507', payout: null }) }]
                }
            }
        }
    };
}

// settle_with_verdict v2 carries six accounts: the permanent VerdictRecord PDA and the system program
// joined the original four when verdicts became on-chain records.
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const VERDICT_RECORD = PublicKey.findProgramAddressSync(
    [Buffer.from('verdict'), new PublicKey(PROPOSAL).toBuffer(), new PublicKey(VERDICT).toBuffer()], new PublicKey(PROPOSAL_PROGRAM_ID)
)[0].toBase58();

function settleTx(signature, { err = null, emitter = PROPOSAL_PROGRAM_ID, status = STATUS_EXPIRED } = {}) {
    const logs = emitter === PROPOSAL_PROGRAM_ID
        ? [`Program ${PROPOSAL_PROGRAM_ID} invoke [1]`, `Program data: ${verdictPayload(status).toString('base64')}`, `Program ${PROPOSAL_PROGRAM_ID} success`]
        : [`Program ${PROPOSAL_PROGRAM_ID} invoke [1]`, `Program ${emitter} invoke [2]`, `Program data: ${verdictPayload(status).toString('base64')}`,
            `Program ${emitter} success`, `Program ${PROPOSAL_PROGRAM_ID} success`];
    return {
        signature, slot: 9, block_time: SETTLED + 1,
        raw: {
            slot: 9, blockTime: SETTLED + 1,
            meta: { err, fee: 5000, innerInstructions: [], logMessages: logs },
            transaction: {
                signatures: [signature],
                message: {
                    accountKeys: [{ pubkey: MEMBER, signer: true, writable: true }, { pubkey: PROPOSAL, signer: false, writable: true }, { pubkey: PROPOSAL_PROGRAM_ID, signer: false, writable: false }],
                    instructions: [{ programId: PROPOSAL_PROGRAM_ID, accounts: [PROPOSAL, VERDICT, CREDENTIAL, VERDICT_RECORD, MEMBER, SYSTEM_PROGRAM], data: ixData('settle_with_verdict', {}) }]
                }
            }
        }
    };
}

function programAccount(address, data) {
    return { pubkey: new PublicKey(address), account: { owner: new PublicKey(PROPOSAL_PROGRAM_ID), data } };
}

function fakes({ accounts = [], storeRows = [], proposalStatus = STATUS_EXECUTED } = {}) {
    const calls = [];
    const pool = {
        query: async (sql, params = []) => {
            calls.push({ sql, params });
            if (sql.includes('FROM consensus.solana_transaction')) return { rows: storeRows };
            if (sql.includes('INSERT INTO consensus.land_event')) return { rows: [{ '?column?': 1 }] };
            if (sql.includes('INSERT INTO consensus.lens_member')) {
                return { rows: [{ key: params[0], kind: params[1], coverage: JSON.parse(params[6]) }] };
            }
            throw new Error(`unexpected query: ${sql}`);
        }
    };
    const rpc = [];
    const connection = {
        getProgramAccounts: async (program, config) => { rpc.push({ program: program.toBase58(), config }); return accounts; },
        getMultipleAccountsInfo: async keys => keys.map(() => ({
            owner: new PublicKey(PROPOSAL_PROGRAM_ID), data: proposalAccountBytes({ status: proposalStatus, lens: [MEMBER] })
        }))
    };
    return { pool, connection, calls, rpc };
}

const RECORDS = [
    programAccount(RECORD_A, recordBytes({ owner: OWNER_A, attestation: ATTESTATION_A, acceptedAt: ACCEPTED_A })),
    programAccount(RECORD_B, recordBytes({ owner: OWNER_B, attestation: ATTESTATION_B, acceptedAt: ACCEPTED_B, payout: OWNER_B }))
];
const STORE = [acceptTx('sig-a', OWNER_A, ATTESTATION_A, RECORD_A), acceptTx('sig-b', OWNER_B, ATTESTATION_B, RECORD_B), settleTx('sig-verdict')];

describe('lens-model v2 account and event layouts', () => {
    it('pins the discriminators to the checked-in proposal_nft IDL', () => {
        expect([...ACCEPTANCE_RECORD_DISCRIMINATOR]).toEqual(idl.accounts.find(a => a.name === 'AcceptanceRecord').discriminator);
        expect([...VERDICT_SETTLED_DISCRIMINATOR]).toEqual(idl.events.find(e => e.name === 'VerdictSettled').discriminator);
    });

    it('decodes the fields in IDL order', () => {
        const fields = name => idl.types.find(t => t.name === name).type.fields.map(f => f.name);
        expect(fields('AcceptanceRecord')).toEqual(['proposal', 'parcel_id', 'owner', 'member', 'ownership_attestation', 'ownership_hash', 'payout', 'accepted_at', 'bump']);
        expect(fields('VerdictSettled')).toEqual(['proposal', 'verdict_attestation', 'verdict_hash', 'member', 'status', 'settled_at', 'verdict']);
        expect(decodeAcceptanceRecord(RECORDS[0].account.data)).toEqual({
            proposal: PROPOSAL, parcelUid: 'HR-335649-507', owner: OWNER_A, member: MEMBER,
            ownershipAttestation: ATTESTATION_A, ownershipHash: 'ab'.repeat(32), payout: null, acceptedAt: ACCEPTED_A
        });
        expect(decodeAcceptanceRecord(RECORDS[1].account.data).payout).toBe(OWNER_B);
        // A v2 event (no trailing verdict byte): the status it set is what the verdict said.
        expect(decodeVerdictSettled(verdictPayload())).toEqual({
            proposal: PROPOSAL, verdictAttestation: VERDICT, verdictHash: 'cd'.repeat(32), member: MEMBER, status: STATUS_EXPIRED, settledAt: SETTLED,
            verdict: STATUS_EXPIRED
        });
        // v3: an executed verdict that only cleared open ground leaves the proposal Active (0).
        expect(decodeVerdictSettled(verdictPayload(0, STATUS_EXECUTED))).toMatchObject({ status: 0, verdict: STATUS_EXECUTED });
        expect(() => decodeVerdictSettled(Buffer.concat([verdictPayload(0, 1), Buffer.from([0])]))).toThrow(/trailing/);
        const cleared = buildVerdictEvent({ verdict: decodeVerdictSettled(verdictPayload(0, STATUS_EXECUTED)), transaction: 'sig' });
        expect(cleared).toMatchObject({ outcome: 'executed', evidence: { proposalStatusByte: 0, clearedOpenGroundOnly: true } });
        expect(buildVerdictEvent({ verdict: decodeVerdictSettled(verdictPayload()), transaction: 'sig' }).evidence.clearedOpenGroundOnly).toBe(false);
        expect(() => decodeAcceptanceRecord(RECORDS[0].account.data.subarray(0, 100))).toThrow(/ended early/);
    });

    it('attributes Program data logs to the program on top of the invoke stack', () => {
        expect(programDataLogs(settleTx('x').raw.meta.logMessages, PROPOSAL_PROGRAM_ID)).toHaveLength(1);
        expect(programDataLogs(settleTx('x', { emitter: FOREIGN_PROGRAM }).raw.meta.logMessages, PROPOSAL_PROGRAM_ID)).toHaveLength(0);
    });

    it('anchors an Expired proposal to its settle_with_verdict transaction', () => {
        expect(sourceForProposal([settleTx('sig-verdict')], PROPOSAL, STATUS_EXPIRED, idls)).toMatchObject({ signature: 'sig-verdict' });
    });
});

describe('syncProposalConsentEvents', () => {
    it('is a no-op while the v2 program is not deployed (no acceptance records, no verdict logs)', async () => {
        const v1History = { signature: 'sig-v1', slot: 1, block_time: 1, raw: { meta: { err: null, logMessages: [] }, transaction: { signatures: ['sig-v1'], message: { accountKeys: [], instructions: [] } } } };
        const f = fakes({ storeRows: [v1History] });
        const result = await syncProposalConsentEvents({ pool: f.pool, connection: f.connection, decode });
        expect(result).toMatchObject({ records: 0, acceptanceEvents: 0, verdictEvents: 0, inserted: 0, members: 0, missingEvidence: [], invalidRecords: [] });
        expect(f.calls.some(call => call.sql.includes('INSERT'))).toBe(false);
        // Filtered by the AcceptanceRecord discriminator on the proposal program.
        expect(f.rpc[0]).toMatchObject({ program: PROPOSAL_PROGRAM_ID, config: { filters: [{ memcmp: { offset: 0, bytes: encodeBase58(ACCEPTANCE_RECORD_DISCRIMINATOR) } }] } });
    });

    it('writes acceptance and verdict events timed by the chain, and refreshes the member directory', async () => {
        const f = fakes({ accounts: RECORDS, storeRows: STORE });
        const result = await syncProposalConsentEvents({ pool: f.pool, connection: f.connection, decode });
        expect(result).toMatchObject({ records: 2, acceptanceEvents: 2, verdictEvents: 1, inserted: 3, members: 1, missingEvidence: [] });

        const [first, second, verdict] = result.events;
        expect(first).toMatchObject({
            id: `solana:devnet:proposal_acceptance:${RECORD_A}`,
            eventType: 'proposal_acceptance', subjectType: 'proposal', subjectId: PROPOSAL, outcome: 'accepted',
            observedAt: new Date(ACCEPTED_A * 1000).toISOString(),
            attester: { kind: 'solana_program', address: PROPOSAL_PROGRAM_ID },
            source: { transaction: 'sig-a' },
            evidence: { parcelUid: 'HR-335649-507', owner: OWNER_A, member: MEMBER, ownershipAttestation: ATTESTATION_A, ownershipHash: `sha256:${'ab'.repeat(32)}` }
        });
        expect(first.source.hash).toBe(`sha256:${createHash('sha256').update(RECORDS[0].account.data).digest('hex')}`);
        expect(second).toMatchObject({ source: { transaction: 'sig-b' }, evidence: { owner: OWNER_B, payout: OWNER_B } });
        expect(verdict).toMatchObject({
            id: `solana:devnet:proposal_verdict:${PROPOSAL}:${VERDICT}`,
            eventType: 'proposal_verdict', outcome: 'expired', observedAt: new Date(SETTLED * 1000).toISOString(),
            source: { transaction: 'sig-verdict', hash: `sha256:${'cd'.repeat(32)}` },
            evidence: { verdictAttestation: VERDICT, member: MEMBER, proposalStatusByte: STATUS_EXPIRED }
        });

        const inserts = f.calls.filter(call => call.sql.includes('INSERT INTO consensus.land_event'));
        expect(inserts).toHaveLength(3);
        expect(inserts[0].sql).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
        expect(inserts[0].params[7]).toBe(new Date(ACCEPTED_A * 1000).toISOString());

        const upserts = f.calls.filter(call => call.sql.includes('INSERT INTO consensus.lens_member'));
        expect(upserts.map(call => call.params[7])).toEqual([new Date(ACCEPTED_A * 1000).toISOString(), new Date(ACCEPTED_B * 1000).toISOString()]);
        expect(upserts[0].params.slice(0, 2)).toEqual([MEMBER, 'owner-consent']);
        expect(JSON.parse(upserts[0].params[6])).toEqual({ ownership: 2, parcels: 1, executed: 1 });
    });

    it('writes nothing in a dry run', async () => {
        const f = fakes({ accounts: RECORDS, storeRows: STORE });
        const result = await syncProposalConsentEvents({ pool: f.pool, connection: f.connection, decode, dryRun: true });
        expect(result).toMatchObject({ records: 2, inserted: 0, dryRun: true });
        expect(result.events).toHaveLength(3);
        expect(f.calls.some(call => call.sql.includes('INSERT'))).toBe(false);
    });

    it('reports a record whose transaction is not in the store, and ignores failed or foreign verdicts', async () => {
        const f = fakes({
            accounts: RECORDS,
            storeRows: [STORE[0], settleTx('sig-failed', { err: { InstructionError: [0, 'Custom'] } }), settleTx('sig-forged', { emitter: FOREIGN_PROGRAM })]
        });
        const result = await syncProposalConsentEvents({ pool: f.pool, connection: f.connection, decode, dryRun: true });
        expect(result.missingEvidence).toEqual([RECORD_B]);
        expect(result.acceptanceEvents).toBe(1);
        expect(result.verdictEvents).toBe(0);
    });
});

describe('membersFromRecords', () => {
    it('counts distinct attestations, parcels and executed proposals per member', () => {
        const records = RECORDS.map(({ account }) => ({ record: decodeAcceptanceRecord(account.data) }));
        expect(membersFromRecords(records)).toEqual([{
            key: MEMBER, kind: 'owner-consent', coverage: { ownership: 2, parcels: 1, executed: 0 },
            firstSeen: ACCEPTED_A, lastSeen: ACCEPTED_B
        }]);
    });
});
