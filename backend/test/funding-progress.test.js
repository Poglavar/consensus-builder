// Crowdfunding progress read from the chain (frontend/js/solana/funding-progress.js): many rounds in
// one batched account read, the escrow decoded by the pledge client, a failed or unminted round never
// reading as nothing raised.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const funding = require('../../frontend/js/solana/funding-progress.js');
const pledgeClient = require('../../frontend/js/solana/pledge-client.js').configure({ web3 });
const realAgreementClient = require('../../frontend/js/solana/agreement-client.js').configure({ web3 });
const record = require('../../frontend/js/agreement-record.js');

const key = () => web3.Keypair.generate().publicKey.toBase58();
const SPONSOR = key();
const cidOf = index => `bafkrei${String(index).padStart(52, 'a')}`;

function round(index, { minted = true } = {}) {
    const cid = cidOf(index);
    return { cid, content: { sponsor: SPONSOR, rule: { electorate: 'investors', lens: [] }, funding: { targetUsdcAtomic: '2500000000' } },
        onchain: minted ? { chain: 'solana', cluster: 'devnet', account: realAgreementClient.getAgreementPda(cid, SPONSOR)[0].toBase58() } : null };
}

// A DonationEscrow account as the proposal_pledge program writes it.
function escrowBytes(proposal, { donated, refunded, donors }) {
    const data = new Uint8Array(pledgeClient.DONATION_ESCROW_SIZE);
    data.set(pledgeClient.ACCOUNT_DISCRIMINATORS.DonationEscrow, 0);
    const view = new DataView(data.buffer);
    let at = 8;
    for (const value of [proposal, key(), pledgeClient.constants.USDC_DEVNET_MINT, key()]) { data.set(new web3.PublicKey(value).toBytes(), at); at += 32; }
    for (const value of [donated, 0n, refunded, 3n, donors]) { view.setBigUint64(at, value, true); at += 8; }
    return data;
}

function chain({ escrows = {}, missing = new Set() } = {}) {
    const calls = [];
    const owner = id => ({ toBase58: () => id });
    const byAddress = new Map();
    return {
        calls,
        connection: { async getMultipleAccountsInfo(keys) {
            calls.push(keys.length);
            return keys.map(pubkey => byAddress.get(pubkey.toBase58()) ?? null);
        } },
        add(agreement) {
            const account = agreement.onchain.account;
            if (!missing.has(agreement.cid)) byAddress.set(account, { owner: owner(realAgreementClient.constants.AGREEMENT_PROGRAM_ID), data: new Uint8Array([agreement.cid.length]) });
            const escrow = escrows[agreement.cid];
            if (escrow) byAddress.set(pledgeClient.getDonationEscrowPda(account)[0].toBase58(), { owner: owner(pledgeClient.constants.PROGRAM_ID), data: escrowBytes(account, escrow) });
        }
    };
}
// The agreement account as AgreementClient.readAgreement decodes it (its byte layout is the client's own test).
const agreementClient = { ...realAgreementClient, readAgreement: (_data, address) => {
    const agreement = rounds.find(row => row.onchain?.account === address);
    return { cid: agreement.cid, authority: SPONSOR, status: 'Active', decision: 'Pending', fundingMet: false, lensConfirmed: [], requiredFunding: 2500000000n };
} };
const rounds = Array.from({ length: 60 }, (_, index) => round(index));

describe('reading crowdfunding progress from the chain', () => {
    it('reads every round in batches of 100 accounts: contributions less refunds, contributors, the target', async () => {
        const fake = chain({ escrows: { [rounds[0].cid]: { donated: 1500000000n, refunded: 500000000n, donors: 4n } } });
        rounds.forEach(fake.add);
        const progress = await funding.readProgress(rounds, { connectionFor: async () => fake.connection, agreementClient, pledgeClient, record, web3 });
        // 60 rounds × (agreement + escrow) = 120 accounts: two requests, not 120.
        expect(fake.calls).toEqual([100, 20]);
        expect(progress.get(rounds[0].cid)).toMatchObject({ state: 'read', chainStatus: 'Active', raisedUsdcAtomic: 1000000000n,
            targetUsdcAtomic: 2500000000n, share: 0.4, contributors: 4, apartmentsOffered: null });
        // No escrow yet: nobody has contributed, a known zero.
        expect(progress.get(rounds[1].cid)).toMatchObject({ state: 'read', raisedUsdcAtomic: 0n, contributors: 0 });
    });

    it('says an unminted round is not minted and a missing account failed, never 0 raised', async () => {
        const unminted = round(100, { minted: false });
        const gone = round(101);
        rounds.push(gone);
        const fake = chain({ missing: new Set([gone.cid]) });
        fake.add(gone);
        const progress = await funding.readProgress([unminted, gone], { connectionFor: async () => fake.connection, agreementClient, pledgeClient, record, web3 });
        expect(progress.get(unminted.cid)).toEqual({ state: 'unminted' });
        expect(progress.get(gone.cid)).toEqual({ state: 'failed', reason: 'The agreement account is not on Solana devnet.' });
    });

    it('refuses an indexed account that is not the sponsor’s agreement account for the CID', async () => {
        const wrong = { ...round(102), onchain: { chain: 'solana', cluster: 'devnet', account: key() } };
        const progress = await funding.readProgress([wrong], { connectionFor: async () => chain().connection, agreementClient, pledgeClient, record, web3 });
        expect(progress.get(wrong.cid).state).toBe('failed');
    });

    it('keeps every round failed with the reason when the RPC refuses', async () => {
        const progress = await funding.readProgress(rounds.slice(0, 2), { connectionFor: async () => ({ getMultipleAccountsInfo: async () => { throw new Error('429 Too Many Requests'); } }),
            agreementClient, pledgeClient, record, web3 });
        expect([...progress.values()]).toEqual([{ state: 'failed', reason: '429 Too Many Requests' }, { state: 'failed', reason: '429 Too Many Requests' }]);
    });
});

describe('the progress line', () => {
    const t = (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]);
    const text = progress => funding.progressText(progress, { t, formatUsdc: record.formatUsdc, formatInteger: String });
    it('reads raised of target, contributors and apartments', () => {
        expect(text({ state: 'read', raisedUsdcAtomic: 1000000000n, targetUsdcAtomic: 2500000000n, contributors: 3, apartmentsOffered: 4, apartmentsReserved: 1 }))
            .toBe('1000 of 2500 USDC raised · 3 contributors · 1 of 4 apartments reserved');
        expect(text({ state: 'unminted' })).toBe('Not minted');
        expect(text({ state: 'failed', reason: 'RPC 429' })).toBe('Chain not read: RPC 429');
    });
    it('tells a crowdfunding round from other agreements', () => {
        expect(funding.isCrowdfunding(rounds[0])).toBe(true);
        expect(funding.isCrowdfunding({ rule: { electorate: 'owners' } })).toBe(false);
    });
});
