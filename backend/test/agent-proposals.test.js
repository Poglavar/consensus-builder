// Route tests for routes/agent-proposals.js — the x402 pay-to-post gate in front of the shared
// proposal create handler. The real @x402 middleware runs and the payment payload is a real,
// partially signed Solana transaction built offline; only the facilitator (the remote party that
// settles the USDC transfer) is faked. So these tests exercise the actual challenge →
// settle-before-handler → stamp sequence, including the payer being read off the signed
// transaction, without a network.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    AccountRole,
    address,
    appendTransactionMessageInstruction,
    blockhash,
    compileTransaction,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    partiallySignTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash
} from '@solana/kit';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';
import { createMockPool } from './helpers/mock-pool.js';
import { validProposalBody, insertResult, updateResult } from './helpers/fixtures.js';
import { setupProposalsRoute } from '../routes/proposals.js';
import { setupAgentProposalsRoute, AGENT_PROPOSALS_PATH } from '../routes/agent-proposals.js';
import { CDP_FACILITATOR_URL, hashAgentProposalRequest } from '../utils/x402-payment.js';
import { generateAndStoreProposalThumbnail } from '../thumbnails/proposal-thumbnail.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TX = '5igNaTuReOfTheSettledTransfer';
const PAYMENT_ID = 'proposal_1234567890abcdef';

// Real keys: x402 validates addresses, and the payer is read back off the signed transaction.
let agent;       // the paying wallet
let feePayer;    // the facilitator's fee payer
let treasury;    // X402_PAY_TO
let sourceAta;   // any account standing in for the agent's USDC account
let ENV;

beforeAll(async () => {
    [agent, feePayer, treasury, sourceAta] = await Promise.all([
        generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()
    ]);
    ENV = {
        X402_NETWORK: NETWORK,
        X402_FACILITATOR_URL: 'https://facilitator.test',
        X402_PAY_TO: treasury.address,
        X402_PRICE_PROPOSAL: '$0.05'
    };
});

// A partially signed SPL TransferChecked from the agent to the treasury: exactly what an x402
// client sends, minus the facilitator's fee-payer signature (added at settlement).
async function signedTransfer(signer, { destination = treasury.address, amount = 50000n } = {}) {
    const data = new Uint8Array(1 + 8 + 1);
    data[0] = 12; // TransferChecked
    new DataView(data.buffer).setBigUint64(1, amount, true);
    data[9] = 6;
    const instruction = {
        programAddress: address(TOKEN_PROGRAM),
        accounts: [
            { address: sourceAta.address, role: AccountRole.WRITABLE },
            { address: address(USDC_DEVNET), role: AccountRole.READONLY },
            { address: address(destination), role: AccountRole.WRITABLE },
            { address: signer.address, role: AccountRole.READONLY_SIGNER }
        ],
        data
    };
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayer(feePayer.address, m),
        m => setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n }, m),
        m => appendTransactionMessageInstruction(instruction, m)
    );
    const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(message));
    return getBase64EncodedWireTransaction(signed);
}

// Records the order of facilitator calls and DB writes so a test can prove settlement happened
// BEFORE the row was written.
function createFakeFacilitator(sequence, { settlePayer } = {}) {
    return {
        getSupported: vi.fn(async () => ({
            kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: feePayer.address } }],
            extensions: [],
            signers: { 'solana:*': [feePayer.address] }
        })),
        verify: vi.fn(async () => {
            sequence.push('verify');
            return { isValid: true, payer: settlePayer ?? agent.address };
        }),
        settle: vi.fn(async () => {
            sequence.push('settle');
            return { success: true, transaction: TX, network: NETWORK, payer: settlePayer ?? agent.address };
        })
    };
}

function createApp(pool, facilitator, env = ENV) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    setupProposalsRoute(app, pool);
    setupAgentProposalsRoute(app, pool, { env, facilitatorClient: facilitator });
    return app;
}

// A body with no author: the payer becomes the author. `agent` carries what a persona would send.
function agentBody(overrides = {}) {
    const body = validProposalBody({
        agent: { persona: 'densifier-01', rationale: 'Infill on an underused corner.', run_id: 'run-1' },
        ...overrides
    });
    if (!('author' in overrides)) delete body.author;
    return body;
}

// Fetch the challenge and answer it the way an x402 client does: echo the accepted requirement
// and attach the signed transaction.
async function payFor(app, body, { signer = agent, transaction, paymentId = PAYMENT_ID } = {}) {
    const challenge = await request(app).post(AGENT_PROPOSALS_PATH).send(body);
    expect(challenge.status).toBe(402);
    const required = decodePaymentRequiredHeader(challenge.headers['payment-required']);
    const extensions = structuredClone(required.extensions);
    if (paymentId !== null) appendPaymentIdentifierToExtensions(extensions, paymentId);
    return encodePaymentSignatureHeader({
        x402Version: 2,
        resource: required.resource,
        accepted: required.accepts[0],
        payload: { transaction: transaction ?? await signedTransfer(signer) },
        // Bazaar catalogs the route, while payment-identifier makes the operation replay-safe.
        extensions
    });
}

// A refusal raised at settlement time travels as a failed settlement receipt, not a new challenge.
function paymentError(res) {
    return decodePaymentResponseHeader(res.headers['payment-response']).errorReason;
}

let pool;
let sequence;
let facilitator;
let app;
let idempotencyRows;
let takenProposalIds;
let advisoryLocks;   // lock key → session holding it (exclusive side), as Postgres would track it
let lockEvents;

const PROPOSAL_ID_CHECK = 'SELECT 1 FROM proposal WHERE proposal_id = $1';

// Session-aware stand-in for Postgres advisory locks: pool.query is session 0, every connect() is a
// new session. A session never conflicts with its own lock, exactly like the real lock manager.
function advisoryLockAnswer(sql, params, session) {
    if (sql.includes('pg_try_advisory_lock(')) {
        const key = `${params[0]}:${params[1]}`;
        const holder = advisoryLocks.get(key);
        const locked = holder === undefined || holder === session;
        if (locked) advisoryLocks.set(key, session);
        lockEvents.push(locked ? `lock:${session}` : `busy:${session}`);
        return { rows: [{ locked }], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_unlock(')) {
        const key = `${params[0]}:${params[1]}`;
        if (advisoryLocks.get(key) === session) advisoryLocks.delete(key);
        lockEvents.push(`unlock:${session}`);
        return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    }
    return null;
}

// The free/paid INSERT … WHERE pg_try_advisory_xact_lock_shared(ns, hashtext($1)): nothing is
// inserted when ANOTHER session holds the exclusive side for that proposal_id.
function sharedLockBlocksInsert(sql, params, session) {
    if (!sql.includes('INSERT INTO proposal') || !sql.includes('pg_try_advisory_xact_lock_shared')) return false;
    const namespace = /pg_try_advisory_xact_lock_shared\((\d+)/.exec(sql)[1];
    const holder = advisoryLocks.get(`${namespace}:${params[0]}`);
    return holder !== undefined && holder !== session;
}

beforeEach(() => {
    pool = createMockPool();
    idempotencyRows = [];
    takenProposalIds = new Set();
    advisoryLocks = new Map();
    lockEvents = [];
    let nextSession = 1;
    const realQuery = pool.query.bind(pool);
    pool.connect = async () => {
        const session = nextSession++;
        return { query: (sql, params) => pool.query(sql, params, session), release() {}, on() {}, off() {} };
    };
    pool.query = (sql, params, session = 0) => {
        const lockAnswer = advisoryLockAnswer(sql, params, session);
        if (lockAnswer) return Promise.resolve(lockAnswer);
        sequence.push('db');
        if (sharedLockBlocksInsert(sql, params, session)) return Promise.resolve({ rows: [], rowCount: 0 });
        if (sql.includes('WHERE agent_payment_id = $1')) {
            return Promise.resolve({ rows: idempotencyRows, rowCount: idempotencyRows.length });
        }
        if (sql.includes(PROPOSAL_ID_CHECK)) {
            const rows = takenProposalIds.has(params[0]) ? [{ '?column?': 1 }] : [];
            return Promise.resolve({ rows, rowCount: rows.length });
        }
        return realQuery(sql, params);
    };
    sequence = [];
    facilitator = createFakeFacilitator(sequence);
    app = createApp(pool, facilitator);
    vi.mocked(generateAndStoreProposalThumbnail).mockReset();
    vi.mocked(generateAndStoreProposalThumbnail).mockResolvedValue(null);
});

describe(`POST ${AGENT_PROPOSALS_PATH} — unpaid`, () => {
    it('answers 402 with an x402 challenge for the configured network, treasury and price, and writes nothing', async () => {
        const res = await request(app).post(AGENT_PROPOSALS_PATH).send(agentBody());

        expect(res.status).toBe(402);
        expect(res.body.error).toMatch(/Payment required/);
        expect(res.body.docs).toBe('/docs/agents');

        const required = decodePaymentRequiredHeader(res.headers['payment-required']);
        expect(required.x402Version).toBe(2);
        const accept = required.accepts[0];
        expect(accept.scheme).toBe('exact');
        expect(accept.network).toBe(NETWORK);
        expect(accept.payTo).toBe(treasury.address);
        expect(accept.asset).toBe(USDC_DEVNET);
        expect(accept.amount).toBe('50000'); // $0.05 in USDC atomic units
        expect(accept.extra.paymentFlow).toBe('upfront');
        expect(accept.extra.feePayer).toBe(feePayer.address);

        expect(required.resource.serviceName).toBe('Urban Game Theory');
        expect(required.resource.tags).toEqual(['urban-planning', 'land', 'proposals', 'agents']);
        const discovery = required.extensions.bazaar;
        expect(discovery.info.input.type).toBe('http');
        expect(discovery.info.input.method).toBe('POST');
        expect(discovery.info.input.bodyType).toBe('json');
        expect(discovery.info.input.body.cadastreParcelIds).toEqual(['HR-335550-1234/1']);
        expect(discovery.info.output.example).toMatchObject({ id: 1342, screenshotUrl: null });
        const discoveredBody = discovery.schema.properties.input.properties.body;
        expect(discoveredBody.required).toContain('cadastreParcelIds');
        expect(discoveredBody.properties.goal).toBeTruthy();
        expect(discoveredBody.properties.structureProposal.required).toEqual(['kind', 'geometry']);
        expect(discoveredBody.properties.ownershipFlow.items.required).toEqual(['parcelId', 'cededM2', 'destination']);
        expect(discoveredBody).not.toHaveProperty('$id');
        expect(required.extensions['payment-identifier'].info).toEqual({ required: true });

        expect(pool.getCalls()).toHaveLength(0);
        expect(facilitator.settle).not.toHaveBeenCalled();
    });

    it('rejects a malformed body with 400 before asking for payment', async () => {
        const res = await request(app)
            .post(AGENT_PROPOSALS_PATH)
            .send(agentBody({ cadastreParcelIds: 'not-an-array' }));

        expect(res.status).toBe(400);
        expect(res.headers['payment-required']).toBeUndefined();
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });
});

describe(`POST ${AGENT_PROPOSALS_PATH} — paid`, () => {
    it('settles before writing, binds author to the payer and stamps the agent receipt', async () => {
        pool.setResults([insertResult(), updateResult()]);
        const header = await payFor(app, agentBody());
        sequence.length = 0;

        const res = await request(app)
            .post(AGENT_PROPOSALS_PATH)
            .set('PAYMENT-SIGNATURE', header)
            .send(agentBody());

        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('id', 1);
        expect(res.body).toHaveProperty('proposalId', 'test-proposal-001');
        // Settlement receipt echoed to the client by the middleware.
        expect(res.headers['payment-response']).toBeTruthy();

        // Upfront flow: idempotency + proposal-id checks, settle, THEN the two DB writes of the
        // create handler. No separate verify.
        expect(sequence).toEqual(['db', 'db', 'settle', 'db', 'db']);
        expect(facilitator.settle.mock.calls[0][0].extensions.bazaar.info.input.method).toBe('POST');
        expect(facilitator.settle.mock.calls[0][0].extensions['payment-identifier'].info.id).toBe(PAYMENT_ID);

        const calls = pool.getCalls();
        expect(calls[0].sql).toContain('INSERT INTO proposal');
        const params = calls[0].params;
        expect(params[5]).toBe(agent.address); // author column
        const stored = JSON.parse(params[32]); // proposal_data JSONB
        expect(stored.author).toBe(agent.address);
        expect(stored.agent).toEqual({
            persona: 'densifier-01',
            rationale: 'Infill on an underused corner.',
            run_id: 'run-1',
            wallet: agent.address,
            paid: { id: PAYMENT_ID, network: NETWORK, asset: USDC_DEVNET, amount: '0.05', amountAtomic: '50000', tx: TX }
        });
        expect(params[36]).toBe(PAYMENT_ID);
        expect(params[37]).toBe(hashAgentProposalRequest(agentBody()));
    });

    it('accepts a body whose author already names the paying wallet', async () => {
        pool.setResults([insertResult(), updateResult()]);
        const body = agentBody({ author: agent.address });
        const header = await payFor(app, body);

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(body);

        expect(res.status).toBe(201);
        expect(pool.getCalls()[0].params[5]).toBe(agent.address);
    });

    it('refuses a body that names another author before any settlement, reading the payer off the transaction', async () => {
        const body = agentBody({ author: treasury.address });
        const header = await payFor(app, body);
        sequence.length = 0;

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(body);

        expect(res.status).toBe(402);
        expect(paymentError(res)).toBe('author_mismatch');
        expect(res.body.error).toBe('author_mismatch');
        expect(res.body.message).toContain(agent.address);
        expect(sequence).toEqual([]);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('refuses a payload whose transaction cannot be decoded, before any settlement', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const header = await payFor(app, agentBody(), { transaction: 'AAAA' });

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());
        error.mockRestore();

        expect(res.status).toBe(402);
        expect(paymentError(res)).toBe('invalid_payment_payload');
        expect(res.body.error).toBe('invalid_payment_payload');
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('requires the standard payment identifier before any settlement', async () => {
        const header = await payFor(app, agentBody(), { paymentId: null });

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());

        expect(res.status).toBe(402);
        expect(paymentError(res)).toBe('payment_identifier_required');
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('returns the original 201 for an exact replay without settling or writing again', async () => {
        const body = agentBody();
        const header = await payFor(app, body);
        idempotencyRows = [{
            id: 77,
            proposal_id: body.proposalId,
            created_at: new Date('2026-09-20T02:01:03.000Z'),
            screenshot_url: null,
            author: agent.address,
            agent_request_hash: hashAgentProposalRequest(body),
            paid: { id: PAYMENT_ID, network: NETWORK, tx: TX }
        }];
        sequence.length = 0;

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(body);

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            id: 77,
            proposalId: body.proposalId,
            createdAt: '2026-09-20T02:01:03.000Z',
            screenshotUrl: null
        });
        expect(decodePaymentResponseHeader(res.headers['payment-response'])).toMatchObject({
            success: true,
            transaction: TX,
            payer: agent.address
        });
        expect(sequence).toEqual(['db']);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('rejects reuse of a payment identifier for a changed request before settlement', async () => {
        const body = agentBody();
        const changed = agentBody({ description: 'A different operation.' });
        const header = await payFor(app, changed);
        idempotencyRows = [{
            id: 77,
            proposal_id: body.proposalId,
            created_at: new Date(),
            screenshot_url: null,
            author: agent.address,
            agent_request_hash: hashAgentProposalRequest(body),
            paid: { id: PAYMENT_ID, network: NETWORK, tx: TX }
        }];

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(changed);

        expect(res.status).toBe(402);
        expect(paymentError(res)).toBe('payment_identifier_conflict');
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('falls back to the transaction payer when the facilitator receipt omits it', async () => {
        facilitator = createFakeFacilitator(sequence, { settlePayer: '' });
        app = createApp(pool, facilitator);
        pool.setResults([insertResult(), updateResult()]);
        const header = await payFor(app, agentBody());

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());

        expect(res.status).toBe(201);
        expect(pool.getCalls()[0].params[5]).toBe(agent.address);
        expect(JSON.parse(pool.getCalls()[0].params[32]).agent.wallet).toBe(agent.address);
    });

    it('does not write a row when settlement fails', async () => {
        facilitator.settle.mockImplementationOnce(async () => {
            sequence.push('settle');
            return { success: false, errorReason: 'insufficient_funds', transaction: '', network: NETWORK };
        });
        const header = await payFor(app, agentBody());
        sequence.length = 0;

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());

        expect(res.status).toBe(402);
        expect(sequence).toEqual(['db', 'db', 'settle']);
        expect(pool.getCalls()).toHaveLength(0);
    });

    // Everything the create handler would 400 on is refused BEFORE the gate: previously the
    // facilitator settled first and the handler's 400 left the payer charged with no row written.
    it.each([
        ['empty cadastreParcelIds', { cadastreParcelIds: [] }],
        ['duplicate cadastral ids', { cadastreParcelIds: ['HR-1234-5678', 'HR-1234-5678'] }],
        ['padded cadastral ids', { cadastreParcelIds: [' HR-1234-5678'] }],
        ['a generated parcel id', { cadastreParcelIds: ['HR-1234-5678#p1'] }],
        ['ownershipFlow outside scope', { ownershipFlow: [{ parcelId: 'HR-9', cededM2: 5, destination: 'public' }] }],
        ['a retired land declaration', { parentParcelIds: ['HR-1234-5678'] }],
        ['an unknown lifecycle', { lifecycleStatus: 'Approved' }],
        ['a purely numeric proposalId', { proposalId: '51' }],
        ['no type', { type: '' }],
        ['an offer the column cannot hold', { offer: 1e15 }]
    ])('refuses %s with 400 before settling, even with a payment attached', async (_label, override) => {
        const header = await payFor(app, agentBody());
        sequence.length = 0;
        const invalid = agentBody(override);

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(invalid);

        expect(res.status).toBe(400);
        expect(res.body.error).toBeTruthy();
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(sequence).toEqual([]);
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('refuses a proposal id that is already taken at the settle hook, before any USDC moves', async () => {
        takenProposalIds.add('test-proposal-001');
        const header = await payFor(app, agentBody());
        sequence.length = 0;

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());

        expect(res.status).toBe(402);
        expect(paymentError(res)).toBe('proposal_id_taken');
        expect(res.body.message).toMatch(/test-proposal-001 already exists/);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('still reports a duplicate proposal id as 409 when it is taken between the check and the insert', async () => {
        const dup = Object.assign(new Error('duplicate key'), { code: '23505', detail: 'Key (proposal_id)=(test-proposal-001) already exists.' });
        pool.query = async (sql, params, session = 0) => {
            const lockAnswer = advisoryLockAnswer(sql, params, session);
            if (lockAnswer) return lockAnswer;
            sequence.push('db');
            if (sql.includes('WHERE agent_payment_id = $1')) return { rows: [], rowCount: 0 };
            if (sql.includes(PROPOSAL_ID_CHECK)) return { rows: [], rowCount: 0 };
            throw dup;
        };
        const header = await payFor(app, agentBody());
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());
        error.mockRestore();

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already exists/);
    });
});

function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

// Makes the mock behave like the real table for these tests: the unique index on proposal_id, and
// the pre-settle "taken" check seeing rows inserted by an earlier request.
function withProposalTable() {
    const inner = pool.query;
    const insertedIds = new Set();
    let nextId = 1;
    pool.query = async (sql, params, session = 0) => {
        if (sql.includes('INSERT INTO proposal') && !sharedLockBlocksInsert(sql, params, session)) {
            sequence.push('db');
            if (insertedIds.has(params[0])) {
                throw Object.assign(new Error('duplicate key'), { code: '23505', detail: `Key (proposal_id)=(${params[0]}) already exists.` });
            }
            insertedIds.add(params[0]);
            return { rows: [{ id: nextId++, proposal_id: params[0], created_at: new Date() }], rowCount: 1 };
        }
        if (sql.includes(PROPOSAL_ID_CHECK) && insertedIds.has(params[0])) {
            sequence.push('db');
            return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        return inner(sql, params, session);
    };
    return insertedIds;
}

// Holds every settlement open until released, so a second request can arrive mid-settlement.
function holdSettlement() {
    const started = deferred();
    const release = deferred();
    facilitator.settle.mockImplementation(async () => {
        sequence.push('settle');
        started.resolve();
        await release.promise;
        return { success: true, transaction: TX, network: NETWORK, payer: agent.address };
    });
    return { started, release };
}

describe(`POST ${AGENT_PROPOSALS_PATH} — concurrent requests for one proposal id`, () => {
    it('settles exactly one of two concurrent paid requests; the other is refused before any USDC moves', async () => {
        const insertedIds = withProposalTable();
        const settlement = holdSettlement();
        const body = agentBody();
        const headerA = await payFor(app, body, { paymentId: 'proposal_aaaaaaaaaaaaaaaa' });
        const headerB = await payFor(app, body, { paymentId: 'proposal_bbbbbbbbbbbbbbbb' });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        const first = request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', headerA).send(body).then(r => r);
        await settlement.started.promise; // A has passed every check and is settling
        const second = request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', headerB).send(body)
            .then(r => { settlement.release.resolve(); return r; });
        // Old behaviour: B also reaches settlement. Let both finish so the test reports instead of hanging.
        vi.waitFor(() => expect(facilitator.settle).toHaveBeenCalledTimes(2), { timeout: 2000 })
            .then(() => settlement.release.resolve(), () => {});
        const [a, b] = await Promise.all([first, second]);
        error.mockRestore();

        expect(facilitator.settle).toHaveBeenCalledTimes(1);
        expect(a.status).toBe(201);
        expect(b.status).toBe(402);
        expect(paymentError(b)).toBe('proposal_id_in_flight');
        expect([...insertedIds]).toEqual(['test-proposal-001']);
        // The reservation is let go once A's response is out.
        await vi.waitFor(() => expect(advisoryLocks.size).toBe(0));
    });

    it('a free upload of the same id during a paid settlement gets 409, and the payer still gets the row', async () => {
        const insertedIds = withProposalTable();
        const settlement = holdSettlement();
        const body = agentBody();
        const header = await payFor(app, body);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const paid = request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(body).then(r => r);
        await settlement.started.promise;
        const free = await request(app).post('/proposals').send(validProposalBody());
        settlement.release.resolve();
        const paidRes = await paid;
        warn.mockRestore();

        expect(free.status).toBe(409);
        expect(paidRes.status).toBe(201);
        expect(paidRes.body.proposalId).toBe('test-proposal-001');
        expect([...insertedIds]).toEqual(['test-proposal-001']);
    });

    it('releases the reservation when settlement fails', async () => {
        facilitator.settle.mockImplementationOnce(async () => {
            sequence.push('settle');
            return { success: false, errorReason: 'insufficient_funds', transaction: '', network: NETWORK };
        });
        const header = await payFor(app, agentBody());

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());

        expect(res.status).toBe(402);
        expect(lockEvents[0]).toMatch(/^lock:/);
        await vi.waitFor(() => expect(advisoryLocks.size).toBe(0));
    });

    it('releases the reservation when the id turns out to be taken', async () => {
        takenProposalIds.add('test-proposal-001');
        const header = await payFor(app, agentBody());

        const res = await request(app).post(AGENT_PROPOSALS_PATH).set('PAYMENT-SIGNATURE', header).send(agentBody());

        expect(paymentError(res)).toBe('proposal_id_taken');
        expect(advisoryLocks.size).toBe(0);
    });
});

describe('the free route and the unconfigured server', () => {
    it('leaves POST /proposals exactly as it was: no challenge, no settlement, author from the body', async () => {
        pool.setResults([insertResult(), updateResult()]);

        const res = await request(app).post('/proposals').send(validProposalBody());

        expect(res.status).toBe(201);
        expect(res.headers['payment-required']).toBeUndefined();
        expect(res.headers['payment-response']).toBeUndefined();
        expect(facilitator.verify).not.toHaveBeenCalled();
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()[0].params[5]).toBe('0xABCDEF1234567890');
        expect(JSON.parse(pool.getCalls()[0].params[32]).agent).toBeUndefined();
    });

    it('answers 503 naming the missing variables when x402 is not configured, and charges nothing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bare = createApp(pool, facilitator, { X402_NETWORK: NETWORK });
        warn.mockRestore();

        const res = await request(bare).post(AGENT_PROPOSALS_PATH).send(agentBody());

        expect(res.status).toBe(503);
        expect(res.body.missing).toEqual(['X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PRICE_PROPOSAL']);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });

    it('fails closed when the hosted CDP facilitator has no server credentials', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bare = createApp(pool, facilitator, { ...ENV, X402_FACILITATOR_URL: CDP_FACILITATOR_URL });
        warn.mockRestore();

        const res = await request(bare).post(AGENT_PROPOSALS_PATH).send(agentBody());

        expect(res.status).toBe(503);
        expect(res.body.missing).toEqual(['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET']);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(pool.getCalls()).toHaveLength(0);
    });
});
