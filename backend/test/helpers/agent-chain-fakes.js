// In-memory stand-ins for the agent pipeline tests: the agreement program as an emulator (accounts by
// address; create, fund, attest, execute, cancel and expire applied with the program's checks, decoded
// with the browser codec), a connection over it, the market and pledge accounts on an agreement, the
// lens's AgreementDecision-v1 attestation account, a mock pool that keeps consensus.agent_run and
// consensus.lens_devnet_owner rows in memory, and a fetch that dispatches to an Express app in-process.
// No database, RPC or real keypair is involved.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import request from 'supertest';
import { buildSasAttestationAccount, deriveLensSchemaPdas, encodeLensPayload, SAS_PROGRAM_ID } from '../../oracle/lens-schemas.js';
import { deriveAttestationPda, factNonce } from '../../lens/member.js';
import { createMockPool } from './mock-pool.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../../frontend/js/solana/agreement-client.js');
const marketClient = require('../../../frontend/js/solana/market-client.js');
const pledgeClient = require('../../../frontend/js/solana/pledge-client.js');
agreementClient.configure({ web3 });
marketClient.configure({ web3 });
pledgeClient.configure({ web3 });

const { constants, IX_DISCRIMINATORS, ACCOUNT_DISCRIMINATORS } = agreementClient;
export const AGREEMENT_PROGRAM_ID = constants.AGREEMENT_PROGRAM_ID;
const systemNow = () => Math.floor(Date.now() / 1000);

// ---- the Agreement account -------------------------------------------------------------------------

function u64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
function i64(value) { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; }
const key = value => new web3.PublicKey(value).toBuffer();
function str(text) { const bytes = Buffer.from(text, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]); }

/**
 * The Agreement account bytes (programs/agreement/README.md, "Agreement account"): 296 bytes, the CID
 * last and zero-padded to the account's fixed space. Read back with agreement-client readAgreement.
 */
export function encodeAgreementAccount({
    authority, lens, payout, deadline = 0, createdAt = 0, requiredLamports = 0n, escrowLamports = 0n, status = 0,
    openGround = false, decision = 0, decisionAttestedAt = 0, decisionObservedAt = 0,
    decisionAttestation = web3.PublicKey.default.toBase58(), decisionHash = Buffer.alloc(32), executedAt = 0, bump = 255, cid
}) {
    const data = Buffer.concat([
        Buffer.from(ACCOUNT_DISCRIMINATORS.Agreement), key(authority), key(lens), key(payout), i64(deadline), i64(createdAt),
        u64(requiredLamports), u64(escrowLamports), Buffer.from([status, openGround ? 1 : 0, decision]),
        i64(decisionAttestedAt), i64(decisionObservedAt), key(decisionAttestation), Buffer.from(decisionHash),
        i64(executedAt), Buffer.from([bump]), str(cid)
    ]);
    const out = Buffer.alloc(constants.AGREEMENT_ACCOUNT_SPACE);
    data.copy(out);
    return new Uint8Array(out);
}

// ---- market and support accounts on an agreement ----------------------------------------------------
// Byte layouts of proposal_market and proposal_pledge accounts whose subject is an agreement account, as
// their codecs decode them (market-client.js decodeMarket/decodePosition, pledge-client.js decode*).

/** proposal_market Market at PDA ["market", agreement]: { address, owner, data }. */
export function marketAccount({ agreement, stakeMint = pledgeClient.constants.USDC_DEVNET_MINT, yesPool = 0n, noPool = 0n, resolved = false, outcome = 0 }) {
    const [address] = marketClient.getMarketPda(agreement);
    const vault = marketClient.getVaultAddress(address, stakeMint);
    const data = Buffer.concat([Buffer.from(marketClient.ACCOUNT_DISCRIMINATORS.Market), key(agreement), key(stakeMint), key(vault),
        u64(yesPool), u64(noPool), Buffer.from([resolved ? 1 : 0, outcome, 254])]);
    return { address: address.toBase58(), owner: marketClient.constants.PROGRAM_ID, data: new Uint8Array(data) };
}

/** proposal_market Position of `owner` on `side` (1 YES, 0 NO) in the agreement's market. */
export function positionAccount({ agreement, owner, side = 1, amount = 0n, claimed = false }) {
    const [market] = marketClient.getMarketPda(agreement);
    const [address] = marketClient.getPositionPda(market, owner, side);
    const data = Buffer.concat([Buffer.from(marketClient.ACCOUNT_DISCRIMINATORS.Position), key(market), key(owner), Buffer.from([side]),
        u64(amount), Buffer.from([claimed ? 1 : 0, 253])]);
    return { address: address.toBase58(), owner: marketClient.constants.PROGRAM_ID, data: new Uint8Array(data) };
}

/** proposal_pledge DonationEscrow at PDA ["donation_escrow", agreement]. */
export function donationEscrowAccount({ agreement, beneficiary, totalDonated = 0n, released = false }) {
    const [address] = pledgeClient.getDonationEscrowPda(agreement);
    const mint = pledgeClient.constants.USDC_DEVNET_MINT;
    const data = Buffer.concat([Buffer.from(pledgeClient.ACCOUNT_DISCRIMINATORS.DonationEscrow), key(agreement), key(beneficiary), key(mint),
        key(web3.PublicKey.default), u64(totalDonated), u64(0n), u64(0n), u64(1n), u64(1n), Buffer.from([released ? 1 : 0, 252])]);
    return { address: address.toBase58(), owner: pledgeClient.constants.PROGRAM_ID, data: new Uint8Array(data) };
}

/** proposal_pledge DonationPosition of `owner` for `donationId` (32 bytes) in the agreement's escrow. */
export function donationPositionAccount({ agreement, owner, donationId, amount = 0n, refunded = false }) {
    const [escrow] = pledgeClient.getDonationEscrowPda(agreement);
    const [address] = pledgeClient.getDonationPositionPda(escrow, owner, donationId);
    const data = Buffer.concat([Buffer.from(pledgeClient.ACCOUNT_DISCRIMINATORS.DonationPosition), key(escrow), key(owner), Buffer.from(donationId),
        u64(amount), Buffer.from([refunded ? 1 : 0, 251])]);
    return { address: address.toBase58(), owner: pledgeClient.constants.PROGRAM_ID, data: new Uint8Array(data) };
}

/** proposal_pledge PledgeBook at PDA ["pledge_book", agreement]. */
export function pledgeBookAccount({ agreement, beneficiary, activePledged = 0n }) {
    const [address] = pledgeClient.getPledgeBookPda(agreement);
    const data = Buffer.concat([Buffer.from(pledgeClient.ACCOUNT_DISCRIMINATORS.PledgeBook), key(agreement), key(beneficiary),
        key(pledgeClient.constants.USDC_DEVNET_MINT), u64(activePledged), u64(0n), u64(0n), u64(1n), u64(1n), u64(0n), Buffer.from([250])]);
    return { address: address.toBase58(), owner: pledgeClient.constants.PROGRAM_ID, data: new Uint8Array(data) };
}

/** proposal_pledge PledgeCommitment of `owner` in the agreement's pledge book (status 0 active … 3 voided). */
export function pledgeCommitmentAccount({ agreement, owner, amount = 0n, status = 0 }) {
    const [book] = pledgeClient.getPledgeBookPda(agreement);
    const [address] = pledgeClient.getPledgeCommitmentPda(book, owner);
    const data = Buffer.concat([Buffer.from(pledgeClient.ACCOUNT_DISCRIMINATORS.PledgeCommitment), key(book), key(agreement), key(owner),
        u64(amount), Buffer.from([status, 1, 249])]);
    return { address: address.toBase58(), owner: pledgeClient.constants.PROGRAM_ID, data: new Uint8Array(data) };
}

// ---- the lens's attestation --------------------------------------------------------------------------

/**
 * An AgreementDecision-v1 SAS attestation account issued under `lensKey`'s credential, at the address
 * lens/member.js would give it: { address, credential, schema, bytes }.
 */
export function decisionAttestation({
    lensKey, credentialName = 'LensMember', agreementCid, sponsor, decision = 'satisfied',
    evidenceRef = 'sha256:counted', sourceObservedAt = systemNow() - 60, expiry = systemNow() + 365 * 86400
}) {
    const { credential, schemas } = deriveLensSchemaPdas({ authority: lensKey, credentialName });
    const nonce = factNonce(['AgreementDecision-v1', agreementCid, sponsor, decision, sourceObservedAt]);
    const address = deriveAttestationPda({ credential, schema: schemas.decision, nonce });
    const payload = encodeLensPayload('decision', { agreementCid, sponsor, decision, evidenceRef, sourceObservedAt });
    const bytes = buildSasAttestationAccount({ nonce, credential, schema: schemas.decision, payload, authority: lensKey, expiry });
    return { address, credential, schema: schemas.decision, bytes: new Uint8Array(bytes) };
}

// ---- the agreement program ----------------------------------------------------------------------------

const DISCRIMINATOR_NAMES = new Map(Object.entries(IX_DISCRIMINATORS).map(([name, bytes]) => [Buffer.from(bytes).toString('hex'), name]));

function programError(code, message) {
    return Object.assign(new Error(`agreement program: ${code}${message ? ` (${message})` : ''}`), { programError: code });
}

/**
 * An agreement program over in-memory accounts. `sendAndConfirm(connection, transaction, signers)` has the
 * signature of web3.sendAndConfirmTransaction: it applies every instruction of the transaction or none,
 * checks that each signer the instruction requires signed, and returns a fake signature recorded against
 * every account the transaction touched (getSignaturesForAddress, newest first).
 * @param {{ now?: () => number }} options now: the chain's clock in unix seconds (real time by default)
 */
export function createAgreementChain({ now = systemNow } = {}) {
    const accounts = new Map();
    const balances = new Map();
    const signaturesByAccount = new Map();
    const transactions = [];
    let counter = 0;

    const credit = (address, lamports) => balances.set(address, (balances.get(address) ?? 0n) + BigInt(lamports));
    const read = address => {
        const entry = accounts.get(address);
        return entry && entry.owner === AGREEMENT_PROGRAM_ID ? agreementClient.readAgreement(entry.data, address) : null;
    };
    const write = (address, state) => {
        accounts.set(address, { owner: AGREEMENT_PROGRAM_ID, data: encodeAgreementAccount({
            ...state, status: state.statusCode, decision: state.decisionCode,
            decisionAttestation: state.decisionAttestation ?? web3.PublicKey.default.toBase58(),
            decisionHash: state.decisionHash ? Buffer.from(state.decisionHash, 'hex') : Buffer.alloc(32)
        }) });
    };

    function apply(instruction, signerKeys) {
        if (instruction.programId.toBase58() !== AGREEMENT_PROGRAM_ID) throw new Error(`fake chain runs only the agreement program, not ${instruction.programId.toBase58()}`);
        const data = Buffer.from(instruction.data);
        const name = DISCRIMINATOR_NAMES.get(data.subarray(0, 8).toString('hex'));
        const keys = instruction.keys.map(meta => meta.pubkey.toBase58());
        for (const meta of instruction.keys) {
            if (meta.isSigner && !signerKeys.has(meta.pubkey.toBase58())) throw new Error(`missing signature for ${meta.pubkey.toBase58()}`);
        }
        const time = now();
        const [address] = keys;
        if (name === 'create') {
            let offset = 8;
            const cidLength = data.readUInt32LE(offset); offset += 4;
            const cid = data.subarray(offset, offset + cidLength).toString('utf8'); offset += cidLength;
            const lens = new web3.PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
            const deadline = Number(data.readBigInt64LE(offset)); offset += 8;
            const openGround = data[offset] === 1; offset += 1;
            const requiredLamports = data.readBigUInt64LE(offset); offset += 8;
            const payout = new web3.PublicKey(data.subarray(offset, offset + 32)).toBase58();
            const authority = keys[1];
            const [pda, bump] = agreementClient.getAgreementPda(cid, authority, AGREEMENT_PROGRAM_ID);
            if (pda.toBase58() !== address) throw programError('ConstraintSeeds', 'the agreement is not PDA(authority, cid)');
            if (accounts.has(address)) throw programError('AccountAlreadyInUse', address);
            if (deadline !== 0 && deadline <= time) throw programError('DeadlineInPast');
            write(address, {
                authority, lens, payout, deadline, createdAt: time, requiredLamports, escrowLamports: 0n, statusCode: 0, openGround,
                decisionCode: 0, decisionAttestedAt: 0, decisionObservedAt: 0, executedAt: 0, bump, cid
            });
            return { name, account: address };
        }
        const state = read(address);
        if (!state) throw programError('AccountNotInitialized', address);
        const active = state.statusCode === constants.STATUS_ACTIVE;
        const passed = agreementClient.deadlinePassed(state, time);
        if (name === 'fund') {
            const lamports = data.readBigUInt64LE(8);
            if (keys[1] !== state.authority) throw programError('NotAuthority');
            if (!active) throw programError('NotActive');
            if (passed) throw programError('DeadlinePassed');
            credit(keys[1], -lamports);
            write(address, { ...state, escrowLamports: state.escrowLamports + lamports });
        } else if (name === 'attest') {
            const [, attestationKey, credentialKey] = keys;
            if (!active) throw programError('NotActive');
            if (state.decisionCode !== constants.DECISION_PENDING) throw programError('DecisionRecorded');
            if (passed) throw programError('DeadlinePassed');
            const entry = accounts.get(attestationKey);
            if (!entry || entry.owner !== SAS_PROGRAM_ID) throw programError('InvalidAttestation', 'not a SAS account');
            const attestation = agreementClient.readDecisionAttestation(entry.data, attestationKey);
            if (attestation.credential !== credentialKey) throw programError('InvalidAttestation', 'another credential');
            if (attestation.fields.sponsor !== state.authority) throw programError('WrongSponsor');
            const reason = agreementClient.checkDecisionForAttest({ agreement: state, attestation, nowSeconds: time });
            if (reason) throw programError('InvalidAttestation', reason);
            write(address, {
                ...state, decisionCode: constants.DECISION_SATISFIED, decisionAttestedAt: time,
                decisionObservedAt: attestation.fields.sourceObservedAt, decisionAttestation: attestationKey,
                decisionHash: createHash('sha256').update(entry.data).digest('hex')
            });
        } else if (name === 'execute') {
            if (!active) throw programError('NotActive');
            if (state.decisionCode !== constants.DECISION_SATISFIED) throw programError('DecisionNotSatisfied');
            if (passed) throw programError('DeadlinePassed');
            if (state.escrowLamports < state.requiredLamports) throw programError('InsufficientEscrow');
            if (keys[1] !== state.payout) throw programError('WrongPayout');
            credit(state.payout, state.escrowLamports);
            write(address, { ...state, escrowLamports: 0n, statusCode: constants.STATUS_EXECUTED, executedAt: time });
        } else if (name === 'cancel') {
            if (keys[1] !== state.authority) throw programError('NotAuthority');
            if (!active) throw programError('NotActive');
            if (state.decisionCode !== constants.DECISION_PENDING) throw programError('DecisionRecorded');
            credit(state.authority, state.escrowLamports);
            write(address, { ...state, escrowLamports: 0n, statusCode: constants.STATUS_CANCELLED });
        } else if (name === 'expire') {
            if (keys[1] !== state.authority) throw programError('NotAuthority');
            if (!active) throw programError('NotActive');
            if (!(state.deadline !== 0 && passed)) throw programError('DeadlineNotPassed');
            credit(state.authority, state.escrowLamports);
            write(address, { ...state, escrowLamports: 0n, statusCode: constants.STATUS_EXPIRED });
        } else {
            throw new Error(`unknown agreement instruction ${data.subarray(0, 8).toString('hex')}`);
        }
        return { name, account: address };
    }

    async function sendAndConfirm(_connection, transaction, signers = []) {
        const signerKeys = new Set(signers.map(signer => signer.publicKey.toBase58()));
        if (!transaction.feePayer || !signerKeys.has(transaction.feePayer.toBase58())) throw new Error('the fee payer did not sign');
        const snapshot = { accounts: new Map(accounts), balances: new Map(balances) };
        let applied;
        try {
            applied = transaction.instructions.map(instruction => apply(instruction, signerKeys));
        } catch (error) {
            accounts.clear(); snapshot.accounts.forEach((value, address) => accounts.set(address, value));
            balances.clear(); snapshot.balances.forEach((value, address) => balances.set(address, value));
            transactions.push({ ok: false, error: error.message, instructions: transaction.instructions.length });
            throw error;
        }
        counter += 1;
        const signature = `fakeSig${counter}`;
        transactions.push({ ok: true, signature, steps: applied.map(step => step.name), feePayer: transaction.feePayer.toBase58() });
        for (const step of applied) {
            const list = signaturesByAccount.get(step.account) ?? [];
            list.unshift(signature);
            signaturesByAccount.set(step.account, list);
        }
        return signature;
    }

    const connection = {
        async getAccountInfo(address) {
            const entry = accounts.get(typeof address === 'string' ? address : address.toBase58());
            return entry ? { owner: new web3.PublicKey(entry.owner), data: Buffer.from(entry.data), lamports: 1_000_000, executable: false } : null;
        },
        async getSignaturesForAddress(address, { limit = 1000, before } = {}) {
            const list = signaturesByAccount.get(address.toBase58()) ?? [];
            const start = before ? list.indexOf(before) + 1 : 0;
            return list.slice(start, start + limit).map(signature => ({ signature }));
        }
    };

    return {
        connection,
        sendAndConfirm,
        accounts,
        balances,
        transactions,
        signed: () => transactions.filter(tx => tx.ok),
        agreement: address => read(address),
        /** Place an Agreement account directly (state as readAgreement returns it, codes and all). */
        putAgreement(address, fields) {
            accounts.set(address, { owner: AGREEMENT_PROGRAM_ID, data: encodeAgreementAccount(fields) });
        },
        /** Place a SAS attestation account (decisionAttestation().bytes). */
        putAttestation(address, bytes) {
            accounts.set(address, { owner: SAS_PROGRAM_ID, data: new Uint8Array(bytes) });
        },
        /** Place any other program's account ({ address, owner, data }, e.g. marketAccount()). */
        put({ address, owner, data }) {
            accounts.set(address, { owner, data: new Uint8Array(data) });
        }
    };
}

// ---- the ledger and the devnet owner registry ------------------------------------------------------------

const clone = value => JSON.parse(JSON.stringify(value));

/**
 * A mock pool (helpers/mock-pool.js) whose consensus.agent_run and consensus.lens_devnet_owner statements
 * are answered from memory as ledger.js and lens-owner-registry.js issue them: startRun inserts, updateRun
 * merges the summary patch shallowly (jsonb ||), listRuns lists, the registry reads and inserts rows, and
 * a transaction's insert is kept only when it commits.
 * @param {{ runs?: object[], owners?: { parcelUid, owner, ownerCount?, establishedAt?, note? }[] }} seed
 */
export function createLedgerPool({ runs = [], owners = [] } = {}) {
    const pool = createMockPool();
    const table = new Map(runs.map((row, index) => [row.run_id, { id: index + 1, mode: 'live', status: 'done', stage: null, ...clone(row) }]));
    const registry = owners.map(row => ({ parcel_uid: row.parcelUid, owner_wallet: row.owner, owner_count: row.ownerCount ?? 1,
        established_at: row.establishedAt ?? '2026-10-01T00:00:00.000Z', note: row.note ?? null }));
    let staged = null;
    pool.answer(sql => /^\s*BEGIN\b/.test(sql), () => { staged = []; return { rows: [] }; });
    pool.answer(sql => /^\s*COMMIT\b/.test(sql), () => { registry.push(...(staged || [])); staged = null; return { rows: [] }; });
    pool.answer(sql => /^\s*ROLLBACK\b/.test(sql), () => { staged = null; return { rows: [] }; });
    pool.answer(/pg_advisory_xact_lock/, { rows: [{ pg_advisory_xact_lock: '' }] });
    pool.answer(/INSERT INTO consensus\.lens_devnet_owner/, (_sql, [parcelUid, wallet, note]) => {
        const row = { parcel_uid: parcelUid, owner_wallet: wallet, owner_count: 1, established_at: new Date().toISOString(), note };
        if (staged) staged.push(row); else registry.push(row);
        return { rows: [], rowCount: 1 };
    });
    pool.answer(/FROM consensus\.lens_devnet_owner\s+WHERE parcel_uid = ANY/, (_sql, [ids]) => ({
        rows: registry.filter(row => ids.includes(row.parcel_uid))
            .sort((a, b) => a.parcel_uid.localeCompare(b.parcel_uid) || a.owner_wallet.localeCompare(b.owner_wallet)).map(clone)
    }));
    pool.answer(/FROM consensus\.lens_devnet_owner WHERE parcel_uid = \$1/, (_sql, [parcelUid]) => ({
        rows: registry.filter(row => row.parcel_uid === parcelUid).map(clone)
    }));
    pool.answer(/INSERT INTO consensus\.agent_run/, (_sql, [runId, persona, day, mode]) => {
        const row = table.get(runId) ?? { id: table.size + 1, run_id: runId, persona, day, mode, stage: null, summary: {} };
        table.set(runId, { ...row, status: 'running' });
        return { rows: [clone(table.get(runId))] };
    });
    pool.answer(/UPDATE consensus\.agent_run/, (_sql, [runId, stage, status, patch]) => {
        const row = table.get(runId);
        if (!row) return { rows: [] };
        table.set(runId, { ...row, stage: stage ?? row.stage, status: status ?? row.status, summary: { ...(row.summary || {}), ...JSON.parse(patch) } });
        return { rows: [clone(table.get(runId))] };
    });
    pool.answer(/FROM consensus\.agent_run WHERE run_id = \$1/, (_sql, [runId]) => ({ rows: table.has(runId) ? [clone(table.get(runId))] : [] }));
    pool.answer(/FROM consensus\.agent_run\s+WHERE \(\$1::date IS NULL/, (_sql, [day]) => ({
        rows: [...table.values()].filter(row => !day || String(row.day).slice(0, 10) === day).reverse().map(clone)
    }));
    return Object.assign(pool, {
        run: runId => (table.has(runId) ? clone(table.get(runId)) : null),
        owners: parcelUid => registry.filter(row => row.parcel_uid === parcelUid).map(clone)
    });
}

// ---- HTTP -----------------------------------------------------------------------------------------------

/**
 * A fetch that hands each request to an Express app in-process (supertest), so clients built on fetch
 * talk to the real route handlers. `mount` is a path prefix the app sits under behind a proxy (stripped
 * before the app sees the request, as nginx does for /lens-members/<name>). `calls` records every request.
 */
export function fetchVia(app, { mount = '' } = {}) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const { pathname, search } = new URL(url);
        const method = String(init.method || 'GET').toLowerCase();
        if (mount && !pathname.startsWith(`${mount}/`)) throw new Error(`fetchVia: ${pathname} is outside ${mount}`);
        let pending = request(app)[method](pathname.slice(mount.length) + search);
        for (const [name, value] of Object.entries(init.headers || {})) pending = pending.set(name, value);
        if (init.body !== undefined) pending = pending.send(init.body);
        const response = await pending;
        calls.push({ method: method.toUpperCase(), path: pathname, search, status: response.status, body: init.body ? JSON.parse(init.body) : null });
        return {
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            text: async () => response.text,
            headers: { get: name => response.headers[String(name).toLowerCase()] ?? null }
        };
    };
    return Object.assign(fetchImpl, { calls });
}
