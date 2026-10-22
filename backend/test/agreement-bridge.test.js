// Unit tests for frontend/js/solana/agreement-bridge.js, the wallet side of the agreement program:
// the pure helpers (SOL amounts, explorer links, the minted record's account, the lens a mint names,
// what the program would accept now, the lens decision an account can record, Anchor errors), and
// mint / fund / attest / execute / cancel / expire over a fake wallet and connection with the real
// AgreementClient and web3 Transaction: every refusal comes before a wallet is asked to sign, and a
// mint sends the one create instruction the agreement and its sponsor call for.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/agreement-client.js');
const Bridge = require('../../frontend/js/solana/agreement-bridge.js');

client.configure({ web3 });
afterAll(() => { client.configure({ web3: null }); });

const { PublicKey } = web3;
const C = client.constants;
const keyOf = byte => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const SPONSOR = keyOf(7);
const STRANGER = keyOf(9);
const LENS = keyOf(11);
const PAYOUT = keyOf(13);
const CREDENTIAL = keyOf(17);
const ATTESTATION = keyOf(19);
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const ACCOUNT = client.getAgreementPda(CID, SPONSOR)[0].toBase58();
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ';
const nowSeconds = () => Math.floor(Date.now() / 1000);
const thrown = async fn => { try { await fn(); } catch (error) { return error; } return null; };

// ---- accounts as the chain holds them ------------------------------------------------------------

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const str = text => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text, 'utf8')]);

// An Agreement account (README offsets): status/decision as codes, lamports as BigInt.
function agreementData({ authority = SPONSOR, lens = LENS, payout = PAYOUT, deadline = 0, required = 1_000_000_000n, escrow = 0n, status = 0, decision = 0 } = {}) {
    const bytes = Buffer.alloc(C.AGREEMENT_ACCOUNT_SPACE);
    Buffer.from(client.ACCOUNT_DISCRIMINATORS.Agreement).copy(bytes, 0);
    new PublicKey(authority).toBuffer().copy(bytes, 8);
    new PublicKey(lens).toBuffer().copy(bytes, 40);
    new PublicKey(payout).toBuffer().copy(bytes, 72);
    bytes.writeBigInt64LE(BigInt(deadline), 104);
    bytes.writeBigUInt64LE(required, 120);
    bytes.writeBigUInt64LE(escrow, 128);
    bytes[136] = status;
    bytes[138] = decision;
    str(CID).copy(bytes, 228);
    return bytes;
}

// The lens's AgreementDecision-v1 SAS attestation for this agreement.
function attestationData({ signer = LENS, decision = 'satisfied', sponsor = SPONSOR } = {}) {
    const payload = Buffer.concat([str(CID), str(sponsor), str(decision), str('sha256:receipts'), i64(nowSeconds() - 60)]);
    return Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 21), new PublicKey(CREDENTIAL).toBuffer(),
        client.getDecisionSchemaPda(CREDENTIAL)[0].toBuffer(), u32(payload.length), payload,
        new PublicKey(signer).toBuffer(), i64(nowSeconds() + 3600), Buffer.alloc(32)]);
}

// ---- the wallet, the connection and the window --------------------------------------------------

// A connection that holds `accounts` (address → { owner, data }) and answers the send tail.
function fakeConnection({ deployed = true, accounts = new Map(), simulation = { err: null, logs: [] }, confirmation = { value: { err: null } } } = {}) {
    const calls = [];
    const programKey = new PublicKey(C.AGREEMENT_PROGRAM_ID);
    return {
        calls,
        sent: [],
        getAccountInfo: vi.fn(async key => {
            const address = key.toBase58();
            if (address === C.AGREEMENT_PROGRAM_ID) return deployed ? { executable: true, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), data: Buffer.alloc(36) } : null;
            const account = accounts.get(address);
            return account ? { owner: account.owner || programKey, data: account.data } : null;
        }),
        getLatestBlockhash: vi.fn(async () => { calls.push('getLatestBlockhash'); return { blockhash: BLOCKHASH, lastValidBlockHeight: 99 }; }),
        // web3 1.x takes a legacy Transaction with signers, never a config object.
        simulateTransaction: vi.fn(async (transaction, ...rest) => { calls.push(`simulateTransaction/${rest.length}`); return { value: simulation }; }),
        sendRawTransaction: vi.fn(async () => { calls.push('sendRawTransaction'); return 'sig-1'; }),
        confirmTransaction: vi.fn(async () => {
            calls.push('confirmTransaction');
            if (confirmation instanceof Error) throw confirmation;
            return confirmation;
        })
    };
}

function fakeWindow({ wallet = SPONSOR, connection = fakeConnection(), web3Loaded = true } = {}) {
    const provider = wallet ? {
        publicKey: new PublicKey(wallet),
        signTransaction: vi.fn(async transaction => { connection.sent.push(transaction); return { serialize: () => Buffer.from('signed') }; })
    } : null;
    const win = {
        solanaWeb3: web3Loaded ? web3 : undefined,
        SolanaChainDataLoader: { getConnection: vi.fn(() => connection) },
        solanaWalletManager: {
            getProvider: () => provider,
            getCluster: () => 'devnet',
            getState: () => (wallet ? { status: 'connected', accounts: [wallet] } : { status: 'disconnected', accounts: [] })
        }
    };
    return { win, bridge: Bridge.browser(win), provider, connection };
}

// A proposed agreement as the store keeps it.
const proposed = (extra = {}) => ({
    id: 'ag-1', deadline: null, inputs: { parcels: [], openGroundM2: 0 },
    rule: { electorate: 'owners', binding: true, lens: [LENS] },
    published: { cid: CID, publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test', sponsor: SPONSOR },
    onchain: null, ...extra
});
const minted = (extra = {}) => proposed({ onchain: { chain: 'solana', cluster: 'devnet', account: ACCOUNT }, ...extra });
const mintedOn = (data, extra = {}) => fakeConnection({ accounts: new Map([[ACCOUNT, { data }]]), ...extra });

// The instruction a transaction the wallet was asked to sign carries, decoded.
function sentInstruction(connection) {
    expect(connection.sent).toHaveLength(1);
    const [instruction] = connection.sent[0].instructions;
    expect(connection.sent[0].instructions).toHaveLength(1);
    return instruction;
}

vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('pure helpers', () => {
    it('reads SOL as exact lamports, and nothing it cannot hold', () => {
        expect(Bridge.lamportsFromSol(1.5)).toBe(1_500_000_000n);
        expect(Bridge.lamportsFromSol(0.000000001)).toBe(1n);
        expect(Bridge.lamportsFromSol(0)).toBeNull();
        expect(Bridge.lamportsFromSol(0, { allowZero: true })).toBe(0n);
        for (const bad of [-1, 0.0000000001, Number.NaN, Infinity, '1', null, 1e10]) {
            expect(Bridge.lamportsFromSol(bad), String(bad)).toBeNull();
        }
        expect(Bridge.solOf(1_500_000_000n)).toBe(1.5);
        expect(Bridge.solOf('2000000000')).toBe(2);
        expect(Bridge.solOf(undefined)).toBe(0);
    });

    it('links an account or a transaction on its cluster\'s explorer', () => {
        expect(Bridge.explorerUrl({ account: ACCOUNT })).toBe(`https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet`);
        expect(Bridge.explorerUrl({ signature: 'sig 1', cluster: 'testnet' })).toBe('https://explorer.solana.com/tx/sig%201?cluster=testnet');
        expect(Bridge.explorerUrl({ account: ACCOUNT, cluster: 'mainnet-beta' })).toBe(`https://explorer.solana.com/address/${ACCOUNT}`);
    });

    it('finds the Solana account a minted record names, and nothing else', () => {
        expect(Bridge.onchainRef(minted())).toEqual({ cluster: 'devnet', account: ACCOUNT });
        expect(Bridge.onchainRef(minted({ onchain: { chain: 'solana', cluster: ' devnet ', account: ` ${ACCOUNT} `, status: 'active' } })))
            .toEqual({ cluster: 'devnet', account: ACCOUNT });
        for (const onchain of [null, { chain: 'evm', cluster: 'devnet', account: ACCOUNT }, { chain: 'solana', cluster: '', account: ACCOUNT }, { chain: 'solana', cluster: 'devnet' }]) {
            expect(Bridge.onchainRef(proposed({ onchain })), JSON.stringify(onchain)).toBeNull();
        }
        expect(Bridge.onchainRef(null)).toBeNull();
    });

    it('names the rule\'s first lens key in a mint, or for a community vote the first one configured', () => {
        expect(Bridge.mintLens(proposed({ rule: { electorate: 'owners', lens: ['not-a-key', { address: LENS }, PAYOUT] } }))).toBe(LENS);
        expect(Bridge.mintLens(proposed({ rule: { electorate: 'owners', lens: [] } }), [LENS])).toBeNull();
        expect(Bridge.mintLens(proposed({ rule: { electorate: 'community', lens: [] } }), [{ address: 'nope' }, { address: PAYOUT }])).toBe(PAYOUT);
        expect(Bridge.mintLens(proposed({ rule: { electorate: 'community' } }))).toBeNull();
        expect(Bridge.mintLens(null)).toBeNull();
    });

    it('says what the program would accept now, from the account and the connected wallet', () => {
        const value = (fields = {}) => client.readAgreement(agreementData(fields));
        const now = 1_790_000_000;
        const actions = (fields, options = {}) => Bridge.chainActions(value(fields), { wallet: SPONSOR, nowSeconds: now, ...options });
        expect(actions()).toEqual({ fund: true, attest: false, execute: false, cancel: true, expire: false, authority: true, funded: false, deadlinePassed: false });
        expect(actions({}, { attestation: ATTESTATION })).toMatchObject({ attest: true });
        expect(actions({}, { wallet: STRANGER, attestation: ATTESTATION })).toMatchObject({ fund: false, cancel: false, attest: true, authority: false });
        expect(actions({}, { wallet: null, attestation: ATTESTATION })).toMatchObject({ fund: false, attest: false, cancel: false, execute: false, expire: false });
        // Recorded: no second attest, no cancel; execute once the escrow holds what it needs.
        expect(actions({ decision: 1 }, { attestation: ATTESTATION })).toMatchObject({ attest: false, cancel: false, execute: false });
        expect(actions({ decision: 1, escrow: 1_000_000_000n })).toMatchObject({ execute: true, funded: true });
        expect(actions({ decision: 1, required: 0n })).toMatchObject({ execute: true, funded: true });
        // Past the deadline only expiry is left (cancel stays the sponsor's while undecided).
        expect(actions({ deadline: now - 1, decision: 1, escrow: 1_000_000_000n }, { attestation: ATTESTATION }))
            .toEqual({ fund: false, attest: false, execute: false, cancel: false, expire: true, authority: true, funded: true, deadlinePassed: true });
        expect(actions({ deadline: now - 1 })).toMatchObject({ cancel: true, expire: true });
        // A closed agreement accepts nothing.
        for (const status of [1, 2, 3]) {
            expect(actions({ status, deadline: now - 1 }, { attestation: ATTESTATION }), String(status))
                .toMatchObject({ fund: false, attest: false, execute: false, cancel: false, expire: false });
        }
        expect(Bridge.chainActions(null, { wallet: SPONSOR })).toMatchObject({ fund: false, cancel: false, expire: false, authority: false });
    });

    it('picks the lens decision the account can record from a member\'s listed attestations', () => {
        const value = client.readAgreement(agreementData());
        const listed = (extra = {}) => ({ kind: 'decision', address: ATTESTATION, authority: LENS, expiry: nowSeconds() + 60,
            payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied' }, ...extra });
        const fits = listed();
        expect(Bridge.decisionAttestationOf([listed({ kind: 'ownership' }), fits], { cid: CID, value })).toBe(fits);
        expect(Bridge.decisionAttestationOf([listed({ expiry: null })], { cid: CID, value })).not.toBeNull();
        for (const other of [listed({ authority: STRANGER }), listed({ payload: { agreementCid: 'bafkreiother', sponsor: SPONSOR } }),
            listed({ payload: { agreementCid: CID, sponsor: STRANGER } }), listed({ expiry: 1 })]) {
            expect(Bridge.decisionAttestationOf([other], { cid: CID, value }), JSON.stringify(other)).toBeNull();
        }
        expect(Bridge.decisionAttestationOf([fits], { cid: CID, value: null })).toBeNull();
        expect(Bridge.decisionAttestationOf(null, { cid: CID, value })).toBeNull();
    });

    it('reads the Anchor error a failed simulation logged', () => {
        expect(Bridge.anchorError(['Program log: Instruction: Create', 'Program log: AnchorError occurred. Error Code: DeadlinePassed. Error Number: 6002. Error Message: The agreement\'s deadline has passed.']))
            .toEqual({ code: 'DeadlinePassed', number: 6002, message: 'The agreement\'s deadline has passed' });
        expect(Bridge.anchorError(['Program log: ok'])).toBeNull();
        expect(Bridge.anchorError(null)).toBeNull();
    });
});

describe('minting', () => {
    it('sends create from the sponsor\'s wallet at its address, for this CID, lens, deadline, escrow and payout', async () => {
        const deadline = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
        const { bridge, provider, connection } = fakeWindow();
        const states = [];
        const result = await bridge.mint({ agreement: proposed({ deadline, inputs: { parcels: [], openGroundM2: 12 } }), lens: LENS,
            requiredLamports: 2_000_000_000n, payout: PAYOUT, onStatus: status => states.push(status.state) });
        expect(result).toEqual({ signature: 'sig-1', account: ACCOUNT, cluster: 'devnet', explorerUrl: 'https://explorer.solana.com/tx/sig-1?cluster=devnet' });
        expect(states).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
        expect(connection.calls).toEqual(['getLatestBlockhash', 'simulateTransaction/0', 'sendRawTransaction', 'confirmTransaction']);
        expect(provider.signTransaction).toHaveBeenCalledTimes(1);
        const instruction = sentInstruction(connection);
        const expected = client.buildCreateIx({ authority: SPONSOR, cid: CID, lens: LENS, deadline: client.toDeadlineSeconds(deadline),
            openGround: true, requiredLamports: 2_000_000_000n, payout: PAYOUT }).instruction;
        expect(instruction.programId.toBase58()).toBe(C.AGREEMENT_PROGRAM_ID);
        expect(Buffer.from(instruction.data)).toEqual(Buffer.from(expected.data));
        expect(instruction.keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, SPONSOR, C.SYSTEM_PROGRAM_ID]);
        expect(connection.sent[0].feePayer.toBase58()).toBe(SPONSOR);
    });

    it('returns the account without sending when the agreement is already on chain at its address', async () => {
        const connection = mintedOn(agreementData());
        const { bridge, provider } = fakeWindow({ connection });
        await expect(bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT }))
            .resolves.toEqual({ signature: null, account: ACCOUNT, cluster: 'devnet', explorerUrl: `https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet` });
        expect(provider.signTransaction).not.toHaveBeenCalled();
        expect(connection.calls).toEqual([]);
    });

    it('refuses before any wallet is asked to sign', async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const cases = [
            ['not-proposed', fakeWindow(), { agreement: proposed({ published: null }) }],
            ['already-minted', fakeWindow(), { agreement: minted() }],
            ['no-sponsor', fakeWindow(), { agreement: proposed({ published: { ...proposed().published, sponsor: null } }) }],
            ['wallet-required', fakeWindow({ wallet: null }), {}],
            ['not-sponsor', fakeWindow({ wallet: STRANGER }), {}],
            ['no-lens', fakeWindow(), { lens: ' ' }],
            ['deadline-passed', fakeWindow(), { agreement: proposed({ deadline: past }) }],
            ['deadline-passed', fakeWindow(), { deadline: past }],
            ['program-not-deployed', fakeWindow({ connection: fakeConnection({ deployed: false }) }), {}],
            ['web3-unavailable', fakeWindow({ web3Loaded: false }), {}]
        ];
        for (const [code, { bridge, provider, connection }, options] of cases) {
            const error = await thrown(() => bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT, ...options }));
            expect(error?.code, code).toBe(code);
            expect(error.message, code).toBeTruthy();
            if (provider) expect(provider.signTransaction, code).not.toHaveBeenCalled();
            expect(connection.sendRawTransaction, code).not.toHaveBeenCalled();
        }
    });

    it('words the refusals the user can act on', async () => {
        expect((await thrown(() => fakeWindow({ wallet: STRANGER }).bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT }))).message)
            .toBe(`Only the sponsor’s wallet (${SPONSOR.slice(0, 4)}…${SPONSOR.slice(-4)}) can mint this agreement.`);
        expect((await thrown(() => fakeWindow({ connection: fakeConnection({ deployed: false }) }).bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT }))).message)
            .toBe('The agreement program is not deployed on Solana devnet yet.');
        expect((await thrown(() => fakeWindow({ wallet: null }).bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT }))).message)
            .toBe('Connect a Solana wallet first.');
    });

    it('names the program\'s error when the simulation fails, and signs nothing', async () => {
        const connection = fakeConnection({ simulation: { err: { InstructionError: [0, { Custom: 6011 }] }, logs: ['Program log: AnchorError occurred. Error Code: InvalidPayout. Error Number: 6011. Error Message: The payout must be a real account other than the agreement itself.'] } });
        const { bridge, provider } = fakeWindow({ connection });
        const error = await thrown(() => bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT }));
        expect(error).toMatchObject({ code: 'simulation-failed', programError: 'InvalidPayout' });
        expect(error.message).toBe('The transaction would fail: The payout must be a real account other than the agreement itself');
        expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it('says whether a sent transaction failed or its confirmation is unknown', async () => {
        const failed = fakeWindow({ connection: fakeConnection({ confirmation: { value: { err: { InstructionError: [0, 'Custom'] } } } }) });
        expect(await thrown(() => failed.bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT })))
            .toMatchObject({ code: 'confirmation-failed', signature: 'sig-1', explorerUrl: 'https://explorer.solana.com/tx/sig-1?cluster=devnet' });
        const timedOut = fakeWindow({ connection: fakeConnection({ confirmation: new Error('block height exceeded') }) });
        expect(await thrown(() => timedOut.bridge.mint({ agreement: proposed(), lens: LENS, payout: PAYOUT })))
            .toMatchObject({ code: 'confirmation-unknown', signature: 'sig-1' });
    });
});

describe('after the mint', () => {
    it('reads the account checked against the agreement\'s sponsor, and null when it is gone', async () => {
        const { bridge } = fakeWindow({ connection: mintedOn(agreementData({ escrow: 250_000_000n })) });
        await expect(bridge.read(minted())).resolves.toMatchObject({ address: ACCOUNT, cid: CID, authority: SPONSOR, escrowLamports: 250_000_000n, status: 'Active' });
        await expect(fakeWindow().bridge.read(minted())).resolves.toBeNull();
        const squatted = fakeWindow({ connection: mintedOn(agreementData({ authority: STRANGER })) });
        await expect(squatted.bridge.read(minted())).rejects.toThrow(/belongs to/);
        expect(await thrown(() => squatted.bridge.read(proposed()))).toMatchObject({ code: 'not-minted' });
    });

    it('lets only the sponsor fund and cancel', async () => {
        const fund = fakeWindow({ connection: mintedOn(agreementData()) });
        await expect(fund.bridge.fund({ agreement: minted(), lamports: 500_000_000n })).resolves.toMatchObject({ signature: 'sig-1', account: ACCOUNT });
        expect(Buffer.from(sentInstruction(fund.connection).data))
            .toEqual(Buffer.from(client.buildFundIx({ agreement: ACCOUNT, authority: SPONSOR, lamports: 500_000_000n }).data));
        for (const action of ['fund', 'cancel']) {
            const stranger = fakeWindow({ wallet: STRANGER, connection: mintedOn(agreementData()) });
            expect(await thrown(() => stranger.bridge[action]({ agreement: minted(), lamports: 1n })), action).toMatchObject({ code: 'not-authority' });
            expect(stranger.provider.signTransaction).not.toHaveBeenCalled();
        }
        const cancel = fakeWindow({ connection: mintedOn(agreementData()) });
        await cancel.bridge.cancel({ agreement: minted() });
        expect(sentInstruction(cancel.connection).keys.map(key => [key.pubkey.toBase58(), key.isSigner])).toEqual([[ACCOUNT, false], [SPONSOR, true]]);
    });

    it('lets anyone execute to the payout fixed at mint, and expire back to the sponsor', async () => {
        const execute = fakeWindow({ wallet: STRANGER, connection: mintedOn(agreementData({ decision: 1, escrow: 1_000_000_000n })) });
        await execute.bridge.execute({ agreement: minted() });
        expect(sentInstruction(execute.connection).keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, PAYOUT]);
        const expire = fakeWindow({ wallet: STRANGER, connection: mintedOn(agreementData({ deadline: nowSeconds() - 60 })) });
        await expire.bridge.expire({ agreement: minted() });
        expect(sentInstruction(expire.connection).keys.map(key => [key.pubkey.toBase58(), key.isSigner])).toEqual([[ACCOUNT, false], [SPONSOR, false]]);
        expect(await thrown(() => fakeWindow().bridge.execute({ agreement: minted() }))).toMatchObject({ code: 'account-missing' });
    });

    it('records the lens decision only when the program would accept it', async () => {
        const sas = owner => ({ owner: new PublicKey(C.SAS_PROGRAM_ID), data: attestationData(owner) });
        const accounts = (attestation = sas()) => new Map([[ACCOUNT, { data: agreementData() }], [ATTESTATION, attestation]]);
        const ok = fakeWindow({ wallet: STRANGER, connection: fakeConnection({ accounts: accounts() }) });
        await expect(ok.bridge.attest({ agreement: minted(), attestation: ATTESTATION })).resolves.toMatchObject({ signature: 'sig-1', decision: 'satisfied' });
        expect(sentInstruction(ok.connection).keys.map(key => key.pubkey.toBase58())).toEqual([ACCOUNT, ATTESTATION, CREDENTIAL]);
        const refusals = [
            ['attestation-missing', null, fakeConnection({ accounts: new Map([[ACCOUNT, { data: agreementData() }]]) }), {}],
            ['precheck-failed', 'wrong-lens', fakeConnection({ accounts: accounts(sas({ signer: STRANGER })) }), {}],
            ['precheck-failed', 'unknown-decision', fakeConnection({ accounts: accounts(sas({ decision: 'refused' })) }), {}],
            ['precheck-failed', 'credential-mismatch', fakeConnection({ accounts: accounts() }), { credential: STRANGER }],
            ['precheck-failed', 'decision-recorded', fakeConnection({ accounts: new Map([[ACCOUNT, { data: agreementData({ decision: 1 }) }], [ATTESTATION, sas()]]) }), {}]
        ];
        for (const [code, reason, connection, options] of refusals) {
            const { bridge, provider } = fakeWindow({ connection });
            const error = await thrown(() => bridge.attest({ agreement: minted(), attestation: ATTESTATION, ...options }));
            expect(error, `${code} ${reason}`).toMatchObject(reason ? { code, reason } : { code });
            expect(provider.signTransaction).not.toHaveBeenCalled();
        }
    });

    it('finds the lens decision at the service of the member the account names', async () => {
        const value = client.readAgreement(agreementData());
        const { win, bridge } = fakeWindow();
        const listed = { kind: 'decision', address: ATTESTATION, authority: LENS, expiry: nowSeconds() + 60, payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied' } };
        const fetchAttestations = vi.fn(async () => ({ status: 200, attestations: [listed] }));
        win.LensPicker = { loadDirectory: async () => ({ members: [{ key: STRANGER, serviceUrl: 'https://other.example' }, { key: LENS, serviceUrl: 'https://lens.example' }] }) };
        win.LensServiceClient = { fetchAttestations };
        await expect(bridge.findAttestation(minted(), value)).resolves.toEqual({ address: ATTESTATION, decision: 'satisfied', member: LENS });
        expect(fetchAttestations).toHaveBeenCalledWith({ serviceUrl: 'https://lens.example', filter: { kind: 'decision', agreementCid: CID } });
        await expect(bridge.findAttestation(minted(), null)).resolves.toBeNull();
        fetchAttestations.mockResolvedValueOnce({ status: 200, attestations: [{ ...listed, authority: STRANGER }] });
        await expect(bridge.findAttestation(minted(), value)).resolves.toBeNull();
        fetchAttestations.mockResolvedValueOnce({ status: 502, attestations: null, outcome: { message: 'bad gateway' } });
        expect(await thrown(() => bridge.findAttestation(minted(), value))).toMatchObject({ code: 'lens-unavailable', message: 'The lens member could not be asked for its decision: bad gateway' });
        win.LensPicker = { loadDirectory: async () => ({ members: [{ key: LENS }] }) };
        await expect(bridge.findAttestation(minted(), value)).resolves.toBeNull();
    });

    it('knows the connected wallet without asking it', () => {
        expect(fakeWindow().bridge.connectedWallet()).toBe(SPONSOR);
        expect(fakeWindow({ wallet: null }).bridge.connectedWallet()).toBeNull();
    });
});
