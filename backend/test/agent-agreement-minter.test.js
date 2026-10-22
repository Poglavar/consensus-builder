// agents/agreement-minter.js against the agreement program emulator (helpers/agent-chain-fakes.js): the
// account is PDA(sponsor, CID); create and fund go in one transaction and a rerun funds only what the
// escrow lacks; the lens's decision is recorded only when the program would take it; execute pays the
// escrow to the payout and expire returns it to the sponsor; every step reads the chain first.
import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import {
    AGREEMENT_PROGRAM_ID, agreementAccountOf, creationSignature, executeAgreement, expireAgreement, fundAgreement,
    mintAgreement, readAgreementAccount, recordAgreementDecision
} from '../agents/agreement-minter.js';
import { createAgreementChain, decisionAttestation } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const Cid = require('../../frontend/js/cid.js');

const CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'Six storeys on the corner lot' });
const OTHER_CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'A counter-agreement' });
const T0 = Math.floor(Date.now() / 1000);
const iso = seconds => new Date(seconds * 1000).toISOString();

let clock;
let chain;
let sponsor;
let lens;
const mint = (overrides = {}) => mintAgreement({
    connection: chain.connection, sponsorKeypair: sponsor, cid: CID, lens: lens.publicKey.toBase58(),
    deadline: iso(T0 + 7 * 86400), lamports: '5000000', sendAndConfirm: chain.sendAndConfirm, ...overrides
});

beforeEach(() => {
    clock = T0;
    chain = createAgreementChain({ now: () => clock });
    sponsor = Keypair.generate();
    lens = Keypair.generate();
});

describe('the agreement account', () => {
    it('is PDA(sponsor, sha256(CID)) under the agreement program, so another sponsor has another account', () => {
        const account = agreementAccountOf(CID, sponsor.publicKey);
        expect(account).toBe(agreementClient.getAgreementPda(CID, sponsor.publicKey, AGREEMENT_PROGRAM_ID)[0].toBase58());
        expect(agreementAccountOf(CID, Keypair.generate().publicKey)).not.toBe(account);
        expect(agreementAccountOf(OTHER_CID, sponsor.publicKey)).not.toBe(account);
    });
});

describe('mintAgreement', () => {
    it('creates and funds the escrow in one transaction, with the agreement\'s lens, deadline and payout', async () => {
        const minted = await mint();
        const account = agreementAccountOf(CID, sponsor.publicKey);
        expect(minted).toMatchObject({
            account, programId: AGREEMENT_PROGRAM_ID, created: true, fundedLamports: '5000000', requiredLamports: '5000000',
            escrowLamports: '5000000', status: 'Active'
        });
        expect(minted.signature).toBe(chain.signed()[0].signature);
        expect(minted.createSignature).toBe(minted.signature);
        expect(chain.signed()).toHaveLength(1);
        expect(chain.signed()[0].steps).toEqual(['create', 'fund']);
        const state = await readAgreementAccount(chain.connection, { cid: CID, sponsor: sponsor.publicKey.toBase58() });
        expect(state).toMatchObject({
            cid: CID, authority: sponsor.publicKey.toBase58(), lens: lens.publicKey.toBase58(), payout: sponsor.publicKey.toBase58(),
            deadline: T0 + 7 * 86400, requiredLamports: 5000000n, escrowLamports: 5000000n, status: 'Active', decision: 'Pending', openGround: false
        });
    });

    it('signs nothing on a rerun and reports the create transaction it finds on chain', async () => {
        const first = await mint();
        const again = await mint();
        expect(again).toMatchObject({ created: false, signature: null, fundedLamports: '0', escrowLamports: '5000000', status: 'Active' });
        expect(again.createSignature).toBe(first.signature);
        expect(chain.signed()).toHaveLength(1);
    });

    it('funds only what the escrow lacks when a run stopped after the create', async () => {
        const account = agreementAccountOf(CID, sponsor.publicKey);
        chain.putAgreement(account, {
            cid: CID, authority: sponsor.publicKey.toBase58(), lens: lens.publicKey.toBase58(), payout: sponsor.publicKey.toBase58(),
            deadline: T0 + 7 * 86400, requiredLamports: 5000000n, escrowLamports: 2000000n
        });
        const topped = await mint();
        expect(topped).toMatchObject({ created: false, fundedLamports: '3000000', escrowLamports: '5000000' });
        expect(chain.signed().at(-1).steps).toEqual(['fund']);
    });

    it('creates without a fund instruction when the agreement needs no escrow', async () => {
        const minted = await mint({ lamports: 0n, deadline: null });
        expect(minted).toMatchObject({ created: true, fundedLamports: '0', requiredLamports: '0', escrowLamports: '0' });
        expect(chain.signed()[0].steps).toEqual(['create']);
        expect(chain.agreement(minted.account).deadline).toBe(0);
    });

    it('pays out to another account when one is named', async () => {
        const payout = Keypair.generate().publicKey.toBase58();
        const minted = await mint({ payout });
        expect(chain.agreement(minted.account).payout).toBe(payout);
    });

    it('refuses an existing account with other terms, and an account that can no longer be funded, signing nothing', async () => {
        await mint();
        await expect(mint({ lens: Keypair.generate().publicKey.toBase58() })).rejects.toThrow(/exists with other terms \(lens /);
        await expect(mint({ deadline: iso(T0 + 8 * 86400) })).rejects.toThrow(/other terms \(deadline/);
        await expect(mint({ lamports: '6000000' })).rejects.toThrow(/other terms \(required lamports/);
        expect(chain.signed()).toHaveLength(1);

        const account = agreementAccountOf(OTHER_CID, sponsor.publicKey);
        chain.putAgreement(account, {
            cid: OTHER_CID, authority: sponsor.publicKey.toBase58(), lens: lens.publicKey.toBase58(), payout: sponsor.publicKey.toBase58(),
            deadline: T0 + 7 * 86400, requiredLamports: 5000000n, escrowLamports: 0n, status: 2
        });
        await expect(mint({ cid: OTHER_CID })).rejects.toThrow(/is Cancelled; its escrow can no longer be funded/);
        expect(chain.signed()).toHaveLength(1);
    });

    it('refuses a sponsor that names itself as the lens', async () => {
        await expect(mint({ lens: sponsor.publicKey.toBase58() })).rejects.toThrow(/cannot attest its own agreement/);
        expect(chain.transactions).toHaveLength(0);
    });

    it('cannot be read under another sponsor: the CID alone names no account', async () => {
        await mint();
        expect(await readAgreementAccount(chain.connection, { cid: CID, sponsor: Keypair.generate().publicKey.toBase58() })).toBeNull();
        expect(await creationSignature(chain.connection, agreementAccountOf(CID, sponsor.publicKey))).toBe('fakeSig1');
        await expect(creationSignature(chain.connection, agreementAccountOf(OTHER_CID, sponsor.publicKey))).rejects.toThrow(/no transaction touched/);
    });
});

describe('fundAgreement', () => {
    it('tops the escrow up to a target once, and only for an active agreement of this sponsor', async () => {
        await mint({ lamports: '1000' });
        const topped = await fundAgreement({ connection: chain.connection, sponsorKeypair: sponsor, cid: CID, targetLamports: '4000', sendAndConfirm: chain.sendAndConfirm });
        expect(topped).toMatchObject({ replayed: false, fundedLamports: '3000', escrowLamports: '4000' });
        const replay = await fundAgreement({ connection: chain.connection, sponsorKeypair: sponsor, cid: CID, targetLamports: 4000, sendAndConfirm: chain.sendAndConfirm });
        expect(replay).toMatchObject({ replayed: true, signature: null, fundedLamports: '0' });
        expect(chain.signed()).toHaveLength(2);
        await expect(fundAgreement({ connection: chain.connection, sponsorKeypair: Keypair.generate(), cid: CID, targetLamports: 1, sendAndConfirm: chain.sendAndConfirm }))
            .rejects.toThrow(/has no account of sponsor/);
        await expect(fundAgreement({ connection: chain.connection, sponsorKeypair: sponsor, cid: CID, targetLamports: '-1', sendAndConfirm: chain.sendAndConfirm }))
            .rejects.toThrow(/whole number of lamports/);
    });
});

describe('recording the lens decision, executing and expiring', () => {
    const attestationFor = (overrides = {}) => decisionAttestation({
        lensKey: lens.publicKey.toBase58(), agreementCid: CID, sponsor: sponsor.publicKey.toBase58(), sourceObservedAt: T0 - 30, ...overrides
    });
    const record = (account, attestation, overrides = {}) => recordAgreementDecision({
        connection: chain.connection, payerKeypair: sponsor, account, attestation, nowSeconds: clock, sendAndConfirm: chain.sendAndConfirm, ...overrides
    });

    it('records the satisfied decision, executes the escrow to the payout, and replays both without signing', async () => {
        const payout = Keypair.generate().publicKey.toBase58();
        const { account } = await mint({ payout });
        const fact = attestationFor();
        chain.putAttestation(fact.address, fact.bytes);
        const recorded = await record(account, fact.address);
        expect(recorded).toMatchObject({ replayed: false, decision: 'Satisfied', attestation: fact.address });
        expect(chain.agreement(account)).toMatchObject({ decision: 'Satisfied', decisionAttestation: fact.address, decisionObservedAt: T0 - 30 });
        expect(await record(account, fact.address)).toMatchObject({ replayed: true, signature: null, decision: 'Satisfied', attestation: fact.address });

        // Execution is permissionless: any payer signs it.
        const executed = await executeAgreement({ connection: chain.connection, payerKeypair: Keypair.generate(), account, nowSeconds: clock, sendAndConfirm: chain.sendAndConfirm });
        expect(executed).toMatchObject({ replayed: false, status: 'Executed', payout, paidLamports: '5000000' });
        expect(chain.agreement(account)).toMatchObject({ status: 'Executed', escrowLamports: 0n, executedAt: clock });
        expect(chain.balances.get(payout)).toBe(5000000n);
        expect(chain.balances.get(sponsor.publicKey.toBase58())).toBe(-5000000n);
        expect(await executeAgreement({ connection: chain.connection, payerKeypair: sponsor, account, nowSeconds: clock, sendAndConfirm: chain.sendAndConfirm }))
            .toMatchObject({ replayed: true, signature: null, status: 'Executed' });
        expect(chain.signed().map(tx => tx.steps)).toEqual([['create', 'fund'], ['attest'], ['execute']]);
    });

    it('refuses to sign a decision the program would refuse: another sponsor, another lens, a passed deadline', async () => {
        const { account } = await mint();
        const strangers = attestationFor({ sponsor: Keypair.generate().publicKey.toBase58() });
        chain.putAttestation(strangers.address, strangers.bytes);
        await expect(record(account, strangers.address)).rejects.toThrow(/cannot be recorded .*: wrong-sponsor/);

        const otherLens = decisionAttestation({ lensKey: Keypair.generate().publicKey.toBase58(), agreementCid: CID, sponsor: sponsor.publicKey.toBase58(), sourceObservedAt: T0 - 30 });
        chain.putAttestation(otherLens.address, otherLens.bytes);
        await expect(record(account, otherLens.address)).rejects.toThrow(/wrong-lens/);

        const fact = attestationFor();
        chain.putAttestation(fact.address, fact.bytes);
        await expect(record(account, fact.address, { nowSeconds: T0 + 8 * 86400 })).rejects.toThrow(/deadline-passed/);
        expect(chain.signed()).toHaveLength(1);
        expect(chain.agreement(account).decision).toBe('Pending');
    });

    it('executes only a decided, funded agreement before its deadline', async () => {
        const { account } = await mint();
        await expect(executeAgreement({ connection: chain.connection, payerKeypair: sponsor, account, nowSeconds: clock, sendAndConfirm: chain.sendAndConfirm }))
            .rejects.toThrow(/no satisfied decision recorded/);
        const fact = attestationFor();
        chain.putAttestation(fact.address, fact.bytes);
        await record(account, fact.address);
        await expect(executeAgreement({ connection: chain.connection, payerKeypair: sponsor, account, nowSeconds: T0 + 8 * 86400, sendAndConfirm: chain.sendAndConfirm }))
            .rejects.toThrow(/past its deadline; it can only expire/);
        expect(chain.agreement(account).status).toBe('Active');
    });

    it('expires an agreement after its deadline, refunding the escrow to the sponsor, and replays', async () => {
        const { account } = await mint({ deadline: iso(T0 + 100) });
        const expire = nowSeconds => expireAgreement({ connection: chain.connection, signerKeypair: Keypair.generate(), account, nowSeconds, sendAndConfirm: chain.sendAndConfirm });
        await expect(expire(T0 + 50)).rejects.toThrow(/has not reached its deadline/);
        clock = T0 + 200;
        expect(await expire(clock)).toMatchObject({ replayed: false, status: 'Expired', refundedLamports: '5000000' });
        expect(chain.agreement(account)).toMatchObject({ status: 'Expired', escrowLamports: 0n });
        expect(chain.balances.get(sponsor.publicKey.toBase58())).toBe(0n);
        expect(await expire(clock)).toMatchObject({ replayed: true, signature: null, status: 'Expired' });
        // Another terminal state is reported, never signed.
        expect(await executeAgreement({ connection: chain.connection, payerKeypair: sponsor, account, nowSeconds: clock, sendAndConfirm: chain.sendAndConfirm }))
            .toMatchObject({ replayed: true, signature: null, status: 'Expired', skipped: 'terminal' });
        expect(chain.signed().map(tx => tx.steps)).toEqual([['create', 'fund'], ['expire']]);
    });
});
