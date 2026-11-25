import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createRequire } from 'node:module';
// The lens member's view of a crowdfunding round (lens/agreement-decision.js observeInvestorFunding),
// which it reads to qualify apartment buyers; the funding target itself is the program's confirm_funding.
import request from 'supertest';
import agreementRecord from '../../frontend/js/agreement-record.js';
import { createLensMember } from '../lens/member.js';
import { createLensMemberApp, OPERATOR_TOKEN_HEADER } from '../lens/server.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { observeInvestorFunding } from '../lens/agreement-decision.js';
import { cidOfObject } from '../cid.js';

const require = createRequire(import.meta.url);
const pledge = require('../../frontend/js/solana/pledge-client.js').configure({ web3: require('@solana/web3.js') });
const sponsor = Keypair.generate().publicKey.toBase58();
const lens = Keypair.generate().publicKey.toBase58();
const account = Keypair.generate().publicKey.toBase58();
const escrow = Keypair.generate().publicKey.toBase58();
const vault = Keypair.generate().publicKey.toBase58();
const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const now = Math.floor(Date.now() / 1000);
const fundingContent = { schema: 'agreement/v1', sponsor, inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'EUR', lines: [] }, valuation: null, consultation: null,
        funding: { targetUsdcAtomic: '1000000', contract: { name: 'investors.txt', mediaType: 'text/plain', data: 'VGVybXM=' } },
        rule: { electorate: 'investors', binding: true, approvalConfig: null, settlement: null, lens: [lens] }, deadline: new Date((now + 3600) * 1000).toISOString() };
const base = {
    cid: cidOfObject(fundingContent), content: fundingContent,
    onchain: { chain: 'solana', cluster: 'devnet', account, sponsor, lenses: [lens], lensThreshold: 1, decision: 'pending' }, status: 'active',
    deadline: fundingContent.deadline
};
const observed = (overrides = {}) => ({
    slot: 42, blockTime: now - 3, escrow, vault, vaultUsdcAtomic: 1000000n,
    agreement: { address: account, cid: base.cid, authority: sponsor, payout: sponsor, openGround: false, lenses: [lens], status: 'Active', decision: 'Pending', requiredLamports: 0n, deadline: now + 3600,
        fundingMint: mint, requiredFunding: 1000000n },
    donation: { proposal: account, beneficiary: sponsor, mint, vault, totalDonated: 1250000n, totalRefunded: 250000n, totalReleased: 0n, released: false },
    ...overrides
});
const chain = (row = observed()) => ({ agreementProgramId: 'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ', pledgeProgramId: '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g', observe: async () => row });

describe('investor funding observation', () => {
    const observe = (agreement = base, row = observed(), lensKey = lens) => observeInvestorFunding({ agreement, lensKey, nowSeconds: now, chain: chain(row) });

    it('reads an active round that names this member among its lens members and carries the published target', async () => {
        await expect(observe()).resolves.toMatchObject({ netDeposits: 1000000n, onchain: base.onchain });
        const other = Keypair.generate().publicKey.toBase58();
        const content = { ...fundingContent, rule: { ...fundingContent.rule, lens: [other, lens], lensThreshold: 2 } };
        const agreement = { ...base, cid: cidOfObject(content), content, onchain: { ...base.onchain, lenses: [other, lens], lensThreshold: 2 } };
        await expect(observe(agreement, observed({ agreement: { ...observed().agreement, cid: agreement.cid, lenses: [other, lens] } })))
            .resolves.toMatchObject({ netDeposits: 1000000n });
    });

    it('refuses a member outside the lens, and an account without the published devnet USDC target', async () => {
        const stranger = Keypair.generate().publicKey.toBase58();
        await expect(observe(base, observed(), stranger)).rejects.toMatchObject({ code: 'invalid_funding_rule' });
        await expect(observe({ ...base, onchain: { ...base.onchain, lenses: [stranger] } })).rejects.toMatchObject({ code: 'not_agreement_lens' });
        await expect(observe(base, observed({ agreement: { ...observed().agreement, lenses: [stranger] } }))).rejects.toMatchObject({ code: 'invalid_agreement_account' });
        await expect(observe(base, observed({ agreement: { ...observed().agreement, requiredFunding: 999999n } }))).rejects.toMatchObject({ code: 'invalid_agreement_account' });
        await expect(observe(base, observed({ agreement: { ...observed().agreement, fundingMint: stranger } }))).rejects.toMatchObject({ code: 'invalid_agreement_account' });
    });

    it('allows surplus USDC but fails closed on a shortfall or released escrow', async () => {
        await expect(observe(base, observed({ vaultUsdcAtomic: 1000001n }))).resolves.toMatchObject({ netDeposits: 1000000n });
        await expect(observe(base, observed({ vaultUsdcAtomic: 999999n }))).rejects.toMatchObject({ code: 'invalid_donation_vault' });
        await expect(observe(base, observed({ donation: { ...observed().donation, released: true } }))).rejects.toMatchObject({ code: 'invalid_donation_vault' });
    });

    it('refuses an owner rule, an observation after its time, and content that no longer hashes to its CID', async () => {
        await expect(observe({ ...base, content: { ...base.content, rule: { ...base.content.rule, electorate: 'owners' } } })).rejects.toMatchObject({ code: 'invalid_funding_content' });
        await expect(observe(base, observed({ blockTime: now + 1 }))).rejects.toMatchObject({ code: 'funding_observation_after_deadline' });
        await expect(observe({ ...base, content: { ...base.content, funding: { ...base.content.funding, targetUsdcAtomic: '2' } } })).rejects.toMatchObject({ code: 'invalid_funding_content' });
        await expect(observe({ ...base, content: { ...base.content, funding: { ...base.content.funding, contract: { ...base.content.funding.contract, data: 'QW1lbmRlZA==' } } } }))
            .rejects.toMatchObject({ code: 'invalid_funding_content' });
    });

    it('lets the named operator qualify one buyer for a listed apartment before any deposit', async () => {
        const unit = { unitId: 'a-23', label: 'A4-C-23', xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::A4-C-23',
            at: '45.7665,15.9722,19', priceUsdcAtomic: '2000000', depositUsdcAtomic: '1000000',
            drawing: { name: 'a-23.pdf', mediaType: 'application/pdf', data: 'JVBERi0xLjQK' } };
        const funding = { ...base.content.funding, apartments: { projectId: 'podbrezje', units: [unit] } };
        const content = { ...base.content, funding };
        const agreement = { ...base, cid: cidOfObject(content), content };
        const [listing] = pledge.apartmentOffers(funding, sponsor, agreementRecord);
        const available = { ...listing, status: 'available' };
        const observation = observed({ reservations: [available], agreement: { ...observed().agreement, cid: agreement.cid } });
        const buyer = Keypair.generate().publicKey.toBase58(), otherBuyer = Keypair.generate().publicKey.toBase58();
        let seconds = now;
        const clock = { nowSeconds: () => seconds };
        const store = createMemoryStore();
        const makeApp = (authority = lens) => createLensMemberApp({
            member: createLensMember({ authority, identity: {}, clock, store, issuer: createFakeIssuer({ authority, clock }), expirySeconds: 60 }),
            pricing: {}, operatorToken: 'test-operator', agreements: { load: async () => agreement }, fundingChain: chain(observation), clock
        });
        const app = makeApp(), path = `/lens/agreements/${agreement.cid}/apartments/${unit.unitId}`;
        const read = (service, wallet) => request(service).get(`${path}/qualification`).query({ buyer: wallet });
        const grant = (service, wallet) => request(service).post(`${path}/qualify`).set(OPERATOR_TOKEN_HEADER, 'test-operator').send({ buyer: wallet });
        expect((await read(app, buyer)).body.error).toBe('qualification_pending');
        expect((await request(app).post(`${path}/qualify`).send({ buyer })).status).toBe(401);
        expect((await grant(makeApp(otherBuyer), buyer)).body.error).toBe('invalid_funding_rule');
        expect((await grant(app, sponsor)).body.error).toBe('invalid_counterparty');
        const approved = await grant(app, buyer);
        expect(approved.status).toBe(201);
        expect(approved.body.payload).toMatchObject({ cid: agreement.cid, offer: listing.account, termsHash: listing.termsHash,
            counterpartyQualified: 1, buyer, seller: sponsor });
        expect((await read(makeApp(), buyer)).body.address).toBe(approved.body.address);
        expect((await grant(app, buyer)).body.reused).toBe(true);
        expect((await read(app, otherBuyer)).status).toBe(409);
        observation.reservations = [{ ...available, deposit: '2000000' }];
        expect((await read(app, buyer)).body.error).toBe('terms_mismatch');
        observation.reservations = [{ ...available, status: 'reserved' }];
        expect((await read(app, buyer)).body.error).toBe('unit_unavailable');
        observation.reservations = [available];
        seconds = now + 61;
        expect((await read(app, buyer)).body.error).toBe('qualification_pending');
    });
});
