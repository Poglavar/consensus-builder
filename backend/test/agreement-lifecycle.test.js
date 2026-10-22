// The agreement lifecycle oracle (oracle/agreement-lifecycle.js, plan-design-agreement.md M3): the agreement
// program's own `Program data:` logs and terminal events, the transaction that left an account terminal,
// the land events of a terminal account (one agreement_lifecycle, and one agreement_executed per input
// parcel timed by the account's executed_at), and whole passes over a stateful fake index and a fake
// chain: a dry run, an applied pass, an idempotent second pass and the per-agreement problems. Also the
// CLI's usage and refusals, all of which exit before a database is opened.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createMockPool } from './helpers/mock-pool.js';
import { cidOf } from './helpers/content-fixtures.js';
import { agreementAccountBytes, agreementAccountInfo } from './fixtures/agreement-account.js';
import { AGREEMENT_PROGRAM_ID, AgreementClient, DEVNET_GENESIS_HASH, agreementAccountOf, createAgreementChain } from '../agreements/onchain.js';
import {
    AGREEMENT_EXECUTED_EVENT_TYPE, AGREEMENT_LIFECYCLE_EVENT_TYPE, LAND_EVENT_COLUMNS, TERMINAL_SEARCH_LIMIT,
    buildAgreementEvents, decodeTerminalEvent, findTerminalTransaction, landEventParams, programDataLogs, syncAgreementLifecycle
} from '../oracle/agreement-lifecycle.js';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const IDL = JSON.parse(fs.readFileSync(new URL('../../blockchain/solana/idl/agreement.json', import.meta.url), 'utf8'));

const keyFrom = seed => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + seed) % 256)).publicKey.toBase58();
const SPONSOR = keyFrom(1);
const STRANGER = keyFrom(2);
const LENS = keyFrom(3);
const PAYOUT = keyFrom(4);
const ATTESTATION = keyFrom(5);
const OTHER_PROGRAM = keyFrom(6);
const EXECUTED_AT = Math.floor(Date.parse('2026-10-22T07:30:00.000Z') / 1000);
const CANCELLED_AT = Math.floor(Date.parse('2026-10-22T06:15:00.000Z') / 1000);
const iso = seconds => new Date(seconds * 1000).toISOString();
const agreementCid = label => cidOf({ schema: 'agreement/v1', title: label });

// ---- the program's events, encoded in the IDL's field order --------------------------------------

const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const key = value => new PublicKey(value).toBuffer();
const str = value => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u64(bytes.length).subarray(0, 4), bytes]); };
const discriminator = name => Buffer.from(IDL.events.find(event => event.name === name).discriminator);
const fieldsOf = name => IDL.types.find(type => type.name === name).type.fields.map(field => field.name);

const executedEvent = ({ agreement, cid, payout = PAYOUT, lamports = 5000, lens = LENS, attestation = ATTESTATION, at = EXECUTED_AT }) => Buffer.concat([
    discriminator('AgreementExecuted'), key(agreement), str(cid), key(payout), u64(lamports), key(lens), key(attestation), i64(at)
]);
const refundEvent = (name, { agreement, cid, refunded = 5000, at }) => Buffer.concat([discriminator(name), key(agreement), str(cid), u64(refunded), i64(at)]);
const fundedEvent = ({ agreement, cid }) => Buffer.concat([discriminator('AgreementFunded'), key(agreement), str(cid), u64(5000), u64(5000), i64(CANCELLED_AT - 60)]);

// The log lines of one transaction in which `program` emitted `payloads` at the top of the stack.
const logsOf = (payloads, program = AGREEMENT_PROGRAM_ID) => [
    `Program ${program} invoke [1]`,
    'Program log: Instruction: Execute',
    ...payloads.map(payload => `Program data: ${payload.toString('base64')}`),
    `Program ${program} consumed 4321 of 200000 compute units`,
    `Program ${program} success`
];
const transaction = (logMessages, { slot = 880, err = null } = {}) => ({ slot, meta: { err, logMessages } });

describe('the program\'s events', () => {
    it('are encoded here in the order the IDL lists their fields', () => {
        expect(fieldsOf('AgreementExecuted')).toEqual(['agreement', 'cid', 'payout', 'lamports', 'lens', 'decision_attestation', 'executed_at']);
        expect(fieldsOf('AgreementCancelled')).toEqual(['agreement', 'cid', 'refunded_lamports', 'cancelled_at']);
        expect(fieldsOf('AgreementExpired')).toEqual(['agreement', 'cid', 'refunded_lamports', 'expired_at']);
    });

    it('keeps only the agreement program\'s own Program data, walking the invoke stack', () => {
        const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(text => Buffer.from(text));
        const logs = [
            `Program ${AGREEMENT_PROGRAM_ID} invoke [1]`,
            `Program data: ${a.toString('base64')}`,
            `Program ${OTHER_PROGRAM} invoke [2]`,
            `Program data: ${b.toString('base64')}`,
            `Program ${OTHER_PROGRAM} success`,
            `Program data: ${c.toString('base64')}`,
            `Program ${AGREEMENT_PROGRAM_ID} success`,
            `Program ${OTHER_PROGRAM} invoke [1]`,
            `Program data: ${d.toString('base64')}`,
            `Program ${OTHER_PROGRAM} failed: custom program error: 0x1`
        ];
        expect(programDataLogs(logs, AGREEMENT_PROGRAM_ID).map(String)).toEqual(['a', 'c']);
        expect(programDataLogs(logs, OTHER_PROGRAM).map(String)).toEqual(['b', 'd']);
        expect(programDataLogs(undefined, AGREEMENT_PROGRAM_ID)).toEqual([]);
    });

    it('decodes the three terminal events with exact lamports and the chain\'s times, and nothing else', () => {
        const account = keyFrom(20);
        const cid = agreementCid('decode');
        expect(decodeTerminalEvent(executedEvent({ agreement: account, cid, lamports: 18446744073709551615n }))).toEqual({
            outcome: 'executed', agreement: account, cid, payout: PAYOUT, lamports: '18446744073709551615', lens: LENS,
            decisionAttestation: ATTESTATION, at: EXECUTED_AT
        });
        expect(decodeTerminalEvent(refundEvent('AgreementCancelled', { agreement: account, cid, at: CANCELLED_AT })))
            .toEqual({ outcome: 'cancelled', agreement: account, cid, refundedLamports: '5000', at: CANCELLED_AT });
        expect(decodeTerminalEvent(refundEvent('AgreementExpired', { agreement: account, cid, refunded: 0, at: CANCELLED_AT })))
            .toEqual({ outcome: 'expired', agreement: account, cid, refundedLamports: '0', at: CANCELLED_AT });
        expect(decodeTerminalEvent(fundedEvent({ agreement: account, cid }))).toBeNull();
        expect(decodeTerminalEvent(Buffer.alloc(0))).toBeNull();
        expect(decodeTerminalEvent(Buffer.from('not an event at all'))).toBeNull();
    });

    it('refuses a terminal event that is cut short or carries trailing bytes', () => {
        const event = refundEvent('AgreementCancelled', { agreement: keyFrom(20), cid: agreementCid('decode'), at: CANCELLED_AT });
        expect(() => decodeTerminalEvent(event.subarray(0, event.length - 3))).toThrow(/ended early/);
        expect(() => decodeTerminalEvent(Buffer.concat([event, Buffer.from([0])]))).toThrow(/trailing bytes/);
    });
});

// ---- the land events of one account ----------------------------------------------------------------

const CID_A = agreementCid('executed');
const ACC_A = agreementAccountOf(CID_A, SPONSOR);
const fieldsA = (overrides = {}) => ({
    cid: CID_A, authority: SPONSOR, lens: LENS, payout: PAYOUT, deadline: EXECUTED_AT + 86400, requiredLamports: 5000,
    escrowLamports: 0, status: 1, decision: 1, decisionAttestation: ATTESTATION, decisionHash: Buffer.alloc(32, 0xab),
    executedAt: EXECUTED_AT, ...overrides
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

describe('buildAgreementEvents', () => {
    const data = agreementAccountBytes(fieldsA());
    const account = AgreementClient.readAgreement(new Uint8Array(data), ACC_A);
    const source = { signature: 'A-exec', slot: 880, event: decodeTerminalEvent(executedEvent({ agreement: ACC_A, cid: CID_A })) };
    const agreement = { cid: CID_A, inputParcelIds: ['HR-1/1', 'HR-1/2'], parcelSourceId: 'hr-cadastre' };

    it('writes one lifecycle event and one execution entry per input parcel, timed by executed_at and sourced from the transaction', () => {
        const events = buildAgreementEvents({ agreement, account, accountData: data, cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, source });
        const sourceRef = {
            chain: 'solana:devnet',
            accountUrl: `https://explorer.solana.com/address/${ACC_A}?cluster=devnet`,
            transactionUrl: 'https://explorer.solana.com/tx/A-exec?cluster=devnet',
            transaction: 'A-exec', slot: 880, hash: `sha256:${sha256(data)}`
        };
        const decision = { lens: LENS, decision: 'satisfied', attestation: ATTESTATION, attestationHash: `sha256:${'ab'.repeat(32)}` };
        expect(events).toEqual([
            {
                id: `solana:devnet:agreement_lifecycle:${ACC_A}:executed`, eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
                subjectType: 'agreement', subjectId: ACC_A, outcome: 'executed', observedAt: iso(EXECUTED_AT),
                attester: { kind: 'solana_program', address: AGREEMENT_PROGRAM_ID }, source: sourceRef,
                evidence: {
                    agreementCid: CID_A, account: ACC_A, sponsor: SPONSOR, ...decision, statusByte: 1, payout: PAYOUT, paidLamports: '5000',
                    inputParcelIds: ['HR-1/1', 'HR-1/2'], parcelSourceId: 'hr-cadastre', accountDataBase64: data.toString('base64')
                }
            },
            ...['HR-1/1', 'HR-1/2'].map(parcelId => ({
                id: `solana:devnet:agreement_executed:${ACC_A}:${parcelId}`, eventType: AGREEMENT_EXECUTED_EVENT_TYPE,
                subjectType: 'parcel', subjectId: parcelId, outcome: 'executed', observedAt: iso(EXECUTED_AT),
                attester: { kind: 'solana_program', address: AGREEMENT_PROGRAM_ID }, source: sourceRef,
                evidence: { agreementCid: CID_A, account: ACC_A, ...decision, parcelSourceId: 'hr-cadastre' }
            }))
        ]);
    });

    it('writes a cancelled or expired account as one event timed by the program\'s event, with no decision attestation', () => {
        for (const [status, name, outcome] of [[2, 'AgreementCancelled', 'cancelled'], [3, 'AgreementExpired', 'expired']]) {
            const bytes = agreementAccountBytes(fieldsA({ status, decision: 0, executedAt: 0, escrowLamports: 0, decisionAttestation: ATTESTATION }));
            const terminal = AgreementClient.readAgreement(new Uint8Array(bytes), ACC_A);
            const events = buildAgreementEvents({
                agreement, account: terminal, accountData: bytes, cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID,
                source: { signature: `A-${outcome}`, slot: 870, event: decodeTerminalEvent(refundEvent(name, { agreement: ACC_A, cid: CID_A, refunded: 5000, at: CANCELLED_AT })) }
            });
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                id: `solana:devnet:agreement_lifecycle:${ACC_A}:${outcome}`, outcome, observedAt: iso(CANCELLED_AT),
                evidence: { decision: 'pending', attestation: null, attestationHash: null, refundedLamports: '5000', statusByte: status }
            });
            expect(events[0].evidence).not.toHaveProperty('paidLamports');
        }
    });

    it('refuses an account that is not terminal and a transaction that does not record this account\'s outcome', () => {
        const build = (overrides = {}, eventOverrides = {}) => {
            const bytes = agreementAccountBytes(fieldsA(overrides));
            return () => buildAgreementEvents({
                agreement, account: AgreementClient.readAgreement(new Uint8Array(bytes), ACC_A), accountData: bytes, cluster: 'devnet',
                programId: AGREEMENT_PROGRAM_ID, source: { ...source, event: { ...source.event, ...eventOverrides } }
            });
        };
        expect(build({ status: 0 })).toThrow(/is active, not terminal/);
        expect(build({}, { outcome: 'cancelled' })).toThrow(/does not record executed/);
        expect(build({}, { agreement: STRANGER })).toThrow(/does not record executed/);
        expect(build({}, { cid: agreementCid('other') })).toThrow(/does not record executed/);
        expect(build({}, { at: EXECUTED_AT + 1 })).toThrow(/stores executed_at/);
        expect(build({ executedAt: 0 }, { at: 0 })).toThrow(/no valid chain time/);
    });

    it('stores an event as the land_event columns, in order', () => {
        const [lifecycle] = buildAgreementEvents({ agreement, account, accountData: data, cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, source });
        expect(LAND_EVENT_COLUMNS.replace(/\s+/g, ' ')).toBe('(event_id, event_type, subject_type, subject_id, outcome, source_url, source_hash, source_observed_at, attester, transaction_signature, evidence)');
        const params = landEventParams(lifecycle);
        expect(params.slice(0, 10)).toEqual([
            lifecycle.id, 'agreement_lifecycle', 'agreement', ACC_A, 'executed', lifecycle.source.accountUrl, lifecycle.source.hash,
            iso(EXECUTED_AT), AGREEMENT_PROGRAM_ID, 'A-exec'
        ]);
        expect(JSON.parse(params[10])).toEqual({ source: lifecycle.source, ...lifecycle.evidence });
    });
});

// ---- the terminal transaction ----------------------------------------------------------------------

describe('findTerminalTransaction', () => {
    it('takes the newest successful transaction whose agreement-program logs carry this account\'s outcome', async () => {
        const forged = executedEvent({ agreement: ACC_A, cid: CID_A });
        const transactions = new Map([
            ['A-failed', transaction(logsOf([forged]), { err: { InstructionError: [0, 'Custom'] } })],
            ['A-cpi', transaction(logsOf([forged], OTHER_PROGRAM))],
            ['A-other-account', transaction(logsOf([executedEvent({ agreement: STRANGER, cid: CID_A })]))],
            ['A-exec', transaction(logsOf([fundedEvent({ agreement: ACC_A, cid: CID_A }), forged]), { slot: 880 })]
        ]);
        const asked = [];
        const connection = {
            async getSignaturesForAddress(address, options, commitment) {
                asked.push({ address: address.toBase58(), options, commitment });
                return [{ signature: 'A-skipped', slot: 890, err: { InstructionError: [0, 'Custom'] } }, ...[...transactions.keys()].map(signature => ({ signature, slot: 880, err: null }))];
            },
            async getTransaction(signature) { return transactions.get(signature) ?? null; }
        };
        const found = await findTerminalTransaction(connection, { account: ACC_A, outcome: 'executed', programId: AGREEMENT_PROGRAM_ID });
        expect(found).toMatchObject({ signature: 'A-exec', slot: 880, event: { outcome: 'executed', agreement: ACC_A, cid: CID_A } });
        expect(asked).toEqual([{ address: ACC_A, options: { limit: TERMINAL_SEARCH_LIMIT }, commitment: 'confirmed' }]);
        expect(await findTerminalTransaction(connection, { account: ACC_A, outcome: 'cancelled', programId: AGREEMENT_PROGRAM_ID })).toBeNull();
    });
});

// ---- whole passes ------------------------------------------------------------------------------------

/**
 * The index: minted agreements ({ cid, sponsor, inputParcelIds, parcelSourceId, onchain }) and the
 * land_event table, keyed by event id, inserted once (ON CONFLICT (event_id) DO NOTHING) and onchain
 * written under the observedSlot guard.
 */
function indexFake(agreements) {
    const pool = createMockPool();
    const rows = new Map(agreements.map(agreement => [agreement.cid, structuredClone(agreement)]));
    const events = new Map();
    pool.answer(/FROM consensus\.agreement\s+WHERE onchain->>'chain' = 'solana' AND onchain->>'cluster' = \$1/, (sql, params) => ({
        rows: [...rows.values()].filter(row => row.onchain?.cluster === params[0]).map(row => ({
            cid: row.cid, sponsor: row.sponsor, input_parcel_ids: row.inputParcelIds, parcel_source_id: row.parcelSourceId ?? null, onchain: structuredClone(row.onchain)
        }))
    }));
    pool.answer(/FROM consensus\.land_event\s+WHERE event_type = ANY/, (sql, params) => {
        const counts = new Map();
        for (const stored of events.values()) {
            const account = JSON.parse(stored[10]).account;
            if (!params[0].includes(stored[1]) || !params[1].includes(account)) continue;
            const id = `${account}|${stored[1]}`;
            const previous = counts.get(id);
            const endedAt = previous?.ended_at && previous.ended_at > stored[7] ? previous.ended_at : stored[7];
            counts.set(id, { account, event_type: stored[1], events: (previous?.events || 0) + 1, ended_at: endedAt });
        }
        return { rows: [...counts.values()] };
    });
    pool.answer(/UPDATE consensus\.agreement/, (sql, params) => {
        const row = rows.get(params[0]);
        if (!row || !(row.onchain === null || (row.onchain.observedSlot ?? 0) <= Number(params[2]))) return { rows: [], rowCount: 0 };
        row.onchain = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
    });
    pool.answer(/INSERT INTO consensus\.land_event/, (sql, params) => {
        expect(sql).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
        if (events.has(params[0])) return { rows: [] };
        events.set(params[0], params);
        return { rows: [{ inserted: 1 }] };
    });
    return { pool, rows, events, writes: () => pool.getCalls().filter(call => /^\s*(UPDATE|INSERT)/.test(call.sql)) };
}

/** The chain: account infos by address, newest-first signatures by address, transactions by signature (an Error throws). */
function chainFake({ accounts, signatures = new Map(), transactions = new Map(), slot = 900 }) {
    const searched = [];
    const connection = {
        async getGenesisHash() { return DEVNET_GENESIS_HASH; },
        async getMultipleAccountsInfoAndContext(keys) {
            return { context: { slot }, value: keys.map(address => accounts.get(address.toBase58()) ?? null) };
        },
        async getSignaturesForAddress(address, options) {
            searched.push(address.toBase58());
            return (signatures.get(address.toBase58()) || []).slice(0, options.limit);
        },
        async getTransaction(signature) {
            const tx = transactions.get(signature);
            if (tx instanceof Error) throw tx;
            return tx ?? null;
        }
    };
    return { chain: createAgreementChain({ connection, env: {} }), searched, accounts };
}

const storedOnchain = (account, overrides = {}) => ({
    chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account, sponsor: SPONSOR, lens: LENS,
    status: 'active', decision: 'pending', deadline: iso(EXECUTED_AT + 86400), requiredLamports: '5000', escrowLamports: '0',
    executedAt: null, observedAt: '2026-10-21T00:00:00.000Z', observedSlot: 800, signature: 'create-sig', ...overrides
});

// Three minted agreements: A executed on two parcels, B active with a new escrow, C cancelled.
function threeAgreements() {
    const CID_B = agreementCid('active');
    const CID_C = agreementCid('cancelled');
    const [ACC_B, ACC_C] = [agreementAccountOf(CID_B, SPONSOR), agreementAccountOf(CID_C, SPONSOR)];
    const index = indexFake([
        { cid: CID_A, sponsor: SPONSOR, inputParcelIds: ['HR-1/1', 'HR-1/2'], parcelSourceId: 'hr-cadastre', onchain: storedOnchain(ACC_A) },
        { cid: CID_B, sponsor: SPONSOR, inputParcelIds: ['HR-3/1'], onchain: storedOnchain(ACC_B) },
        { cid: CID_C, sponsor: SPONSOR, inputParcelIds: ['HR-2/1'], onchain: storedOnchain(ACC_C) },
        { cid: agreementCid('unminted'), sponsor: SPONSOR, inputParcelIds: ['HR-9/1'], onchain: null }
    ]);
    const forged = executedEvent({ agreement: ACC_A, cid: CID_A });
    const fake = chainFake({
        accounts: new Map([
            [ACC_A, agreementAccountInfo(fieldsA())],
            [ACC_B, agreementAccountInfo({ ...fieldsA({ cid: CID_B, status: 0, decision: 0, executedAt: 0 }), escrowLamports: 5000 })],
            [ACC_C, agreementAccountInfo(fieldsA({ cid: CID_C, status: 2, decision: 0, executedAt: 0 }))]
        ]),
        signatures: new Map([
            [ACC_A, ['A-failed', 'A-cpi', 'A-exec', 'A-fund'].map((signature, index) => ({ signature, slot: 880 - index, err: signature === 'A-failed' ? {} : null }))],
            [ACC_C, [{ signature: 'C-cancel', slot: 870, err: null }]]
        ]),
        transactions: new Map([
            ['A-cpi', transaction(logsOf([forged], OTHER_PROGRAM))],
            ['A-exec', transaction(logsOf([forged]), { slot: 879 })],
            ['A-fund', transaction(logsOf([fundedEvent({ agreement: ACC_A, cid: CID_A })]))],
            ['C-cancel', transaction(logsOf([refundEvent('AgreementCancelled', { agreement: ACC_C, cid: CID_C, at: CANCELLED_AT })]), { slot: 870 })]
        ])
    });
    return { index, fake, CID_B, CID_C, ACC_B, ACC_C };
}

describe('syncAgreementLifecycle', () => {
    const NOW = () => Date.parse('2026-10-22T08:00:00.000Z');

    it('reads every minted agreement and, as a dry run, says what it would write without writing', async () => {
        const { index, fake, ACC_C } = threeAgreements();
        const lines = [];
        const result = await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, now: NOW, log: line => lines.push(line) });
        expect(result).toMatchObject({ scanned: 3, reconciled: 0, moved: 3, terminal: 2, inserted: 0, invalidAccounts: [], missingEvidence: [], failed: [], dryRun: true });
        expect(result.events.map(event => event.id)).toEqual([
            `solana:devnet:agreement_lifecycle:${ACC_A}:executed`,
            `solana:devnet:agreement_executed:${ACC_A}:HR-1/1`,
            `solana:devnet:agreement_executed:${ACC_A}:HR-1/2`,
            `solana:devnet:agreement_lifecycle:${ACC_C}:cancelled`
        ]);
        expect(result.events.every(event => event.source.transaction === (event.subjectId === ACC_C ? 'C-cancel' : 'A-exec'))).toBe(true);
        expect(index.writes()).toEqual([]);
        expect(lines[0]).toMatch(/3 minted agreement\(s\) on devnet \(dry run: nothing is written\)/);
        expect(lines.some(line => line.startsWith('progress 3/3'))).toBe(true);
    });

    it('applies: refreshes every onchain record and inserts the events; a second pass writes no event and searches no transaction', async () => {
        const { index, fake, CID_B, CID_C } = threeAgreements();
        const first = await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, apply: true, now: NOW });
        expect(first).toMatchObject({ scanned: 3, reconciled: 3, moved: 3, terminal: 2, inserted: 4, dryRun: false });
        expect([...index.events.keys()]).toHaveLength(4);
        // The index row says how and when each agreement ended, in the chain's own time (executed_at, or
        // the program's cancel event): what contest planning and the markets read, whoever ended it.
        expect(index.rows.get(CID_A).onchain).toEqual(storedOnchain(ACC_A, {
            status: 'executed', decision: 'satisfied', executedAt: iso(EXECUTED_AT), endedAt: iso(EXECUTED_AT),
            observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 900
        }));
        expect(index.rows.get(CID_B).onchain).toMatchObject({ status: 'active', escrowLamports: '5000', observedSlot: 900 });
        expect(index.rows.get(CID_B).onchain).not.toHaveProperty('endedAt');
        expect(index.rows.get(CID_C).onchain).toMatchObject({ status: 'cancelled', endedAt: iso(CANCELLED_AT), signature: 'create-sig' });
        const parcelEvent = index.events.get(`solana:devnet:agreement_executed:${ACC_A}:HR-1/2`);
        expect(parcelEvent.slice(0, 10)).toEqual([
            `solana:devnet:agreement_executed:${ACC_A}:HR-1/2`, 'agreement_executed', 'parcel', 'HR-1/2', 'executed',
            `https://explorer.solana.com/address/${ACC_A}?cluster=devnet`, `sha256:${sha256(agreementAccountBytes(fieldsA()))}`,
            iso(EXECUTED_AT), AGREEMENT_PROGRAM_ID, 'A-exec'
        ]);
        const searches = fake.searched.length;
        // A row whose events are complete but whose end time was never written (an earlier pass).
        delete index.rows.get(CID_C).onchain.endedAt;

        const second = await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, apply: true, now: NOW });
        expect(second).toMatchObject({ moved: 0, terminal: 2, events: [], inserted: 0, missingEvidence: [], failed: [] });
        expect(fake.searched).toHaveLength(searches);
        expect(index.events.size).toBe(4);
        // Without a transaction search the end time comes from the stored lifecycle event.
        expect(index.rows.get(CID_C).onchain.endedAt).toBe(iso(CANCELLED_AT));
    });

    it('completes an executed account whose parcel entries are missing, inserting only those', async () => {
        const { index, fake } = threeAgreements();
        await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, apply: true, now: NOW });
        index.events.delete(`solana:devnet:agreement_executed:${ACC_A}:HR-1/1`);
        index.events.delete(`solana:devnet:agreement_executed:${ACC_A}:HR-1/2`);
        const repair = await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, apply: true, now: NOW });
        expect(repair.events.map(event => event.id)).toEqual([
            `solana:devnet:agreement_lifecycle:${ACC_A}:executed`,
            `solana:devnet:agreement_executed:${ACC_A}:HR-1/1`,
            `solana:devnet:agreement_executed:${ACC_A}:HR-1/2`
        ]);
        expect(repair.inserted).toBe(2);
        expect(index.events.size).toBe(4);
    });

    it('records each agreement\'s problem and goes on with the next', async () => {
        const cids = ['missing', 'other-cid', 'stranger', 'no-evidence', 'rpc-down', 'bad-time', 'healthy'].map(agreementCid);
        const [missing, otherCid, stranger, noEvidence, rpcDown, badTime, healthy] = cids;
        const accountOf = cid => agreementAccountOf(cid, SPONSOR);
        const index = indexFake(cids.map(cid => ({ cid, sponsor: SPONSOR, inputParcelIds: ['HR-5/1'], onchain: storedOnchain(accountOf(cid)) })));
        const executedOf = cid => agreementAccountInfo(fieldsA({ cid }));
        const fake = chainFake({
            accounts: new Map([
                [accountOf(otherCid), executedOf(healthy)],
                [accountOf(stranger), agreementAccountInfo(fieldsA({ cid: stranger, authority: STRANGER }))],
                ...[noEvidence, rpcDown, badTime, healthy].map(cid => [accountOf(cid), executedOf(cid)])
            ]),
            signatures: new Map([noEvidence, rpcDown, badTime, healthy].map(cid => [accountOf(cid), [{ signature: `${cid}-tx`, slot: 880, err: null }]])),
            transactions: new Map([
                [`${noEvidence}-tx`, transaction(logsOf([fundedEvent({ agreement: accountOf(noEvidence), cid: noEvidence })]))],
                [`${rpcDown}-tx`, new Error('rpc down')],
                [`${badTime}-tx`, transaction(logsOf([executedEvent({ agreement: accountOf(badTime), cid: badTime, at: EXECUTED_AT - 5 })]))],
                [`${healthy}-tx`, transaction(logsOf([executedEvent({ agreement: accountOf(healthy), cid: healthy })]))]
            ])
        });
        const result = await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, apply: true, now: NOW });
        expect(result.invalidAccounts).toEqual([
            { cid: missing, account: accountOf(missing), problem: 'missing' },
            { cid: otherCid, account: accountOf(otherCid), problem: `stores CID ${healthy}` },
            { cid: stranger, account: accountOf(stranger), problem: `belongs to ${STRANGER}, not the sponsor` }
        ]);
        expect(result.missingEvidence).toEqual([accountOf(noEvidence), accountOf(badTime)]);
        expect(result.failed).toEqual([{ cid: rpcDown, error: 'rpc down' }]);
        expect(result.events.map(event => event.subjectId)).toEqual([accountOf(healthy), 'HR-5/1']);
        expect(result.inserted).toBe(2);
        // Nothing is written for an account that is not the agreement's.
        const updated = index.writes().filter(call => /^\s*UPDATE/.test(call.sql)).map(call => call.params[0]);
        expect(updated).toEqual([noEvidence, rpcDown, badTime, healthy]);
    });

    it('needs a pool and a chain, and reads nothing when nothing is minted', async () => {
        await expect(syncAgreementLifecycle({ pool: createMockPool() })).rejects.toThrow(/pool and chain are required/);
        const index = indexFake([]);
        const fake = chainFake({ accounts: new Map() });
        expect(await syncAgreementLifecycle({ pool: index.pool, chain: fake.chain, apply: true })).toMatchObject({ scanned: 0, events: [], inserted: 0 });
        expect(fake.searched).toEqual([]);
    });
});

// ---- the CLI -----------------------------------------------------------------------------------------

// Each case exits while parsing its options, before dotenv or a database pool: no DATABASE_URL is given.
function job(args) {
    return spawnSync(process.execPath, [path.join(BACKEND, 'oracle', 'agreement-lifecycle-job.mjs'), ...args], {
        cwd: BACKEND, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000
    });
}

describe('agreement-lifecycle-job.mjs', () => {
    it('prints its usage for --help and for no arguments, and does nothing else', () => {
        for (const args of [['--help'], []]) {
            const run = job(args);
            expect(run.status, args.join(' ')).toBe(0);
            expect(run.stdout).toMatch(/^Usage: node oracle\/agreement-lifecycle-job\.mjs \(--once \| --apply\)/);
            expect(run.stdout).toMatch(/--apply\s+Write: refresh consensus\.agreement\.onchain and insert the land events/);
            expect(run.stdout).not.toMatch(/DRY RUN|APPLY on/);
        }
    });

    it('refuses an unknown flag, a pass mode it cannot run and a bad interval or cluster', () => {
        const unknown = job(['--bogus']);
        expect(unknown.status).toBe(2);
        expect(unknown.stderr).toMatch(/Unknown option '--bogus'/);
        expect(job(['--interval', '60']).status).toBe(2);
        const once = job(['--once', '--interval', '60']);
        expect([once.status, once.stderr]).toEqual([1, expect.stringMatching(/--interval is for repeated passes/)]);
        const short = job(['--apply', '--interval', '5']);
        expect([short.status, short.stderr]).toEqual([1, expect.stringMatching(/--interval must be whole seconds, at least 10; got 5/)]);
        const cluster = job(['--once', '--cluster', 'mainnet-beta']);
        expect([cluster.status, cluster.stderr]).toEqual([1, expect.stringMatching(/unknown --cluster mainnet-beta/)]);
    });
});
