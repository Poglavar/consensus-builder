// agents/lifecycle-actions.js adapters on an agreement's chain account as subject: market resolve and
// claim, donation refund and release, pledge revoke, fulfil and void. Each reads its accounts first (a
// replay signs nothing); release and fulfil wait for the agreement account to be Executed, read through
// the agreement codec. Accounts are real codec bytes in the emulator's map; sends are recorded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import {
    SIGNED_SETTLEMENT_STEPS, agreementStatusOf, claimAgreementMarket, fulfillPledge, refundDonation, releaseDonations,
    resolveAgreementMarket, revokePledge, voidPledge
} from '../agents/lifecycle-actions.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { donationIdBytes } from '../agents/donor.js';
import {
    createAgreementChain, donationEscrowAccount, donationPositionAccount, encodeAgreementAccount, lmsrMarketAccount, lmsrPositionAccount, marketAccount, pledgeBookAccount,
    pledgeCommitmentAccount, positionAccount
} from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const pledgeClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
const lmsrClient = require('../../frontend/js/solana/lmsr-client.js');
const Cid = require('../../frontend/js/cid.js');

const CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'Lifecycle subject' });
const STATUS = { Active: 0, Executed: 1, Cancelled: 2, Expired: 3 };

let chain;
let sponsor;
let subject;
let beneficiary;
let actor;
let sent;
const sendAndConfirm = (...args) => sent(...args);

function agreementFields(status) {
    return {
        cid: CID, authority: sponsor.publicKey.toBase58(), lens: Keypair.generate().publicKey.toBase58(), payout: sponsor.publicKey.toBase58(),
        deadline: Math.floor(Date.now() / 1000) + 86400, status: STATUS[status]
    };
}
const setAgreement = status => chain.putAgreement(subject, agreementFields(status));
const instructionOf = call => call[1].instructions[0];
const keysOf = instruction => instruction.keys.map(meta => meta.pubkey.toBase58());

beforeEach(() => {
    chain = createAgreementChain();
    sponsor = Keypair.generate();
    actor = Keypair.generate();
    beneficiary = sponsor.publicKey.toBase58();
    subject = agreementAccountOf(CID, sponsor.publicKey);
    sent = vi.fn(async () => 'adapter-signature');
});

describe('the status word of agreement account bytes', () => {
    it('reads each status from the account and nothing from other accounts', () => {
        for (const [word, code] of Object.entries(STATUS)) {
            const bytes = encodeAgreementAccount({ ...agreementFields('Active'), status: code });
            expect(agreementStatusOf(bytes)).toBe(word);
            expect(agreementStatusOf([...bytes])).toBe(word);
        }
        expect(agreementStatusOf(marketAccount({ agreement: Keypair.generate().publicKey.toBase58() }).data)).toBeNull();
        expect(agreementStatusOf(new Uint8Array(296))).toBeNull();
        expect(SIGNED_SETTLEMENT_STEPS).toEqual(['attest', 'execute', 'expire', 'resolve', 'claim']);
    });
});

describe('donations', () => {
    const release = () => releaseDonations({ connection: chain.connection, releaserKeypair: actor, subject, sendAndConfirm });

    it('releases the escrow to its beneficiary only once the agreement executed, and replays a released one', async () => {
        await expect(release()).rejects.toThrow('donation escrow does not exist');
        chain.put(donationEscrowAccount({ agreement: subject, beneficiary, totalDonated: 500000n }));
        await expect(release()).rejects.toThrow(`agreement account ${subject} does not exist`);
        setAgreement('Active');
        await expect(release()).rejects.toThrow(`agreement ${subject} is Active, not Executed`);
        setAgreement('Expired');
        await expect(release()).rejects.toThrow(/is Expired, not Executed/);
        expect(sent).not.toHaveBeenCalled();

        setAgreement('Executed');
        expect(await release()).toEqual({ replayed: false, signature: 'adapter-signature', released: true });
        const instruction = instructionOf(sent.mock.calls[0]);
        expect(instruction.programId.toBase58()).toBe(pledgeClient.constants.PROGRAM_ID);
        expect(keysOf(instruction)).toEqual(expect.arrayContaining([subject, beneficiary, actor.publicKey.toBase58()]));

        chain.put(donationEscrowAccount({ agreement: subject, beneficiary, totalDonated: 500000n, released: true }));
        expect(await release()).toEqual({ replayed: true, signature: null, released: true });
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('refunds the donor\'s own position once', async () => {
        const donationId = donationIdBytes('donation-1');
        const refund = () => refundDonation({ connection: chain.connection, donorKeypair: actor, subject, operationId: 'donation-1', sendAndConfirm });
        await expect(refund()).rejects.toThrow('donation position does not exist');
        chain.put(donationPositionAccount({ agreement: subject, owner: actor.publicKey.toBase58(), donationId, amount: 250000n }));
        expect(await refund()).toEqual({ replayed: false, signature: 'adapter-signature', refunded: true });
        expect(keysOf(instructionOf(sent.mock.calls[0]))).toContain(subject);
        chain.put(donationPositionAccount({ agreement: subject, owner: actor.publicKey.toBase58(), donationId, amount: 250000n, refunded: true }));
        expect(await refund()).toEqual({ replayed: true, signature: null, refunded: true });
        expect(sent).toHaveBeenCalledTimes(1);
        await expect(refundDonation({ connection: chain.connection, donorKeypair: actor, subject, operationId: ' ', sendAndConfirm })).rejects.toThrow('operationId is required');
    });
});

describe('pledges', () => {
    const owner = () => actor.publicKey.toBase58();
    const commitment = (status, amount = 100000n) => chain.put(pledgeCommitmentAccount({ agreement: subject, owner: owner(), amount, status }));

    it('fulfils an active pledge to the book\'s beneficiary only once the agreement executed', async () => {
        const fulfil = () => fulfillPledge({ connection: chain.connection, pledgerKeypair: actor, subject, sendAndConfirm });
        await expect(fulfil()).rejects.toThrow('pledge book does not exist');
        chain.put(pledgeBookAccount({ agreement: subject, beneficiary, activePledged: 100000n }));
        commitment(pledgeClient.constants.PLEDGE_ACTIVE);
        setAgreement('Cancelled');
        await expect(fulfil()).rejects.toThrow(`agreement ${subject} is Cancelled, not Executed`);
        expect(sent).not.toHaveBeenCalled();
        setAgreement('Executed');
        expect(await fulfil()).toEqual({ replayed: false, signature: 'adapter-signature', fulfilled: true });
        expect(keysOf(instructionOf(sent.mock.calls[0]))).toEqual(expect.arrayContaining([subject, beneficiary, owner()]));
        commitment(pledgeClient.constants.PLEDGE_FULFILLED);
        expect(await fulfil()).toEqual({ replayed: true, signature: null, fulfilled: true });
        commitment(pledgeClient.constants.PLEDGE_REVOKED);
        await expect(fulfil()).rejects.toThrow('pledge is not active (status 2)');
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('revokes an active pledge once, and voids another pledger\'s for any fee payer', async () => {
        const revoke = () => revokePledge({ connection: chain.connection, pledgerKeypair: actor, subject, sendAndConfirm });
        await expect(revoke()).rejects.toThrow('pledge commitment does not exist');
        commitment(pledgeClient.constants.PLEDGE_ACTIVE);
        expect(await revoke()).toEqual({ replayed: false, signature: 'adapter-signature', revoked: true });
        commitment(pledgeClient.constants.PLEDGE_REVOKED);
        expect(await revoke()).toEqual({ replayed: true, signature: null, revoked: true });

        commitment(pledgeClient.constants.PLEDGE_ACTIVE);
        const payer = Keypair.generate();
        const voided = await voidPledge({ connection: chain.connection, feePayerKeypair: payer, subject, pledger: owner(), sendAndConfirm });
        expect(voided).toEqual({ replayed: false, signature: 'adapter-signature', voided: true });
        const [book] = pledgeClient.getPledgeBookPda(subject);
        expect(keysOf(instructionOf(sent.mock.calls[1]))).toEqual([book.toBase58(), subject, pledgeClient.getPledgeCommitmentPda(book, owner())[0].toBase58()]);
        expect(sent.mock.calls[1][2].map(signer => signer.publicKey.toBase58())).toEqual([payer.publicKey.toBase58()]);
        commitment(pledgeClient.constants.PLEDGE_VOIDED);
        expect(await voidPledge({ connection: chain.connection, feePayerKeypair: payer, subject, pledger: owner(), sendAndConfirm }))
            .toEqual({ replayed: true, signature: null, voided: true });
        expect(sent).toHaveBeenCalledTimes(2);
    });
});

describe('the agreement\'s market', () => {
    it('resolves an open market from the agreement account and reads the outcome back; a resolved one is a replay', async () => {
        const resolve = () => resolveAgreementMarket({ connection: chain.connection, resolverKeypair: actor, subject, sendAndConfirm });
        setAgreement('Executed');
        await expect(resolve()).rejects.toThrow('canonical agreement market');
        chain.put(lmsrMarketAccount({ agreement: subject, sponsor: sponsor.publicKey.toBase58(), closesAt: agreementFields('Executed').deadline, qYes: 300000n, qNo: 100000n }));
        sent = vi.fn(async () => {
            chain.put(lmsrMarketAccount({ agreement: subject, sponsor: sponsor.publicKey.toBase58(), closesAt: agreementFields('Executed').deadline,
                qYes: 300000n, qNo: 100000n, resolved: true, outcome: 1 }));
            return 'resolve-signature';
        });
        expect(await resolve()).toEqual({ replayed: false, signature: 'resolve-signature', outcome: 'YES' });
        const [marketPda] = require('../../frontend/js/solana/lmsr-client.js').getMarketPda(subject, sponsor.publicKey);
        expect(keysOf(instructionOf(sent.mock.calls[0])).slice(0, 2)).toEqual([marketPda.toBase58(), subject]);
        chain.put(lmsrMarketAccount({ agreement: subject, sponsor: sponsor.publicKey.toBase58(), closesAt: agreementFields('Executed').deadline, resolved: true, outcome: 0 }));
        expect(await resolve()).toEqual({ replayed: true, signature: null, outcome: 'NO' });
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('claims a resolved market\'s position once, on the side asked', async () => {
        const claim = (side = 'yes') => claimAgreementMarket({ connection: chain.connection, claimerKeypair: actor, subject, side, sendAndConfirm });
        setAgreement('Active');
        const deadline = agreementFields('Active').deadline;
        chain.put(lmsrMarketAccount({ agreement: subject, sponsor: sponsor.publicKey.toBase58(), closesAt: deadline, qYes: 300000n }));
        await expect(claim()).rejects.toThrow('agreement market is not resolved');
        chain.put(lmsrMarketAccount({ agreement: subject, sponsor: sponsor.publicKey.toBase58(), closesAt: deadline, qYes: 300000n, resolved: true, outcome: 1 }));
        await expect(claim()).rejects.toThrow('market position does not exist');
        const [marketPda] = require('../../frontend/js/solana/lmsr-client.js').getMarketPda(subject, sponsor.publicKey);
        chain.put(lmsrPositionAccount({ market: marketPda, owner: actor.publicKey.toBase58(), side: 1, amount: 300000n }));
        expect(await claim()).toEqual({ replayed: false, signature: 'adapter-signature', claimed: true });
        expect(keysOf(sent.mock.calls[0][1].instructions[1]).slice(0, 2)).toEqual([marketPda.toBase58(), lmsrClient.getPositionPda(marketPda, actor.publicKey, 1)[0].toBase58()]);
        chain.put(lmsrPositionAccount({ market: marketPda, owner: actor.publicKey.toBase58(), side: 1, amount: 300000n, claimed: true }));
        expect(await claim('YES')).toEqual({ replayed: true, signature: null, claimed: true });
        await expect(claim('maybe')).rejects.toThrow('side must be yes or no');
        expect(sent).toHaveBeenCalledTimes(1);
    });
});
