import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createRequire } from 'node:module';
import request from 'supertest';
import agreementRecord from '../../frontend/js/agreement-record.js';
import { createLensMember } from '../lens/member.js';
import { createLensMemberApp, OPERATOR_TOKEN_HEADER } from '../lens/server.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { planInvestorFundingDecision } from '../lens/agreement-decision.js';
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
    onchain: { chain: 'solana', cluster: 'devnet', account, sponsor, lens, decision: 'pending' }, status: 'active',
    deadline: fundingContent.deadline
};
const observed = (overrides = {}) => ({
    slot: 42, blockTime: now - 3, escrow, vault, vaultUsdcAtomic: 1000000n,
    agreement: { address: account, cid: base.cid, authority: sponsor, payout: sponsor, openGround: false, lens, status: 'Active', decision: 'Pending', requiredLamports: 0n, deadline: now + 3600 },
    donation: { proposal: account, beneficiary: sponsor, mint, vault, totalDonated: 1250000n, totalRefunded: 250000n, totalReleased: 0n, released: false },
    ...overrides
});
const chain = (row = observed()) => ({ agreementProgramId: 'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ', pledgeProgramId: '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g', observe: async () => row });

describe('investor funding AgreementDecision-v1', () => {
    it('attests an active Agreement only from finalized paid USDC held in its canonical donation vault', async () => {
        const result = await planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now, chain: chain() });
        expect(result.fields).toMatchObject({ agreementCid: base.cid, sponsor, decision: 'satisfied', sourceObservedAt: now - 3 });
        expect(result.evidence).toMatchObject({ agreement: account, escrow, vault, mint, activeUsdcAtomic: '1000000', vaultUsdcAtomic: '1000000', slot: 42 });
        expect(result.tally).toBeNull();
        expect(result.counted).toBe(0);
    });

    it('refuses a finalized vault below its target', async () => {
        await expect(planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ donation: { ...observed().donation, totalDonated: 999999n, totalRefunded: 0n }, vaultUsdcAtomic: 999999n }))
        })).rejects.toMatchObject({ code: 'funding_target_not_met' });
        // An unsolicited direct transfer can raise the vault, but never the recorded contribution total.
        await expect(planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ donation: { ...observed().donation, totalDonated: 999999n, totalRefunded: 0n }, vaultUsdcAtomic: 2000000n }))
        })).rejects.toMatchObject({ code: 'funding_target_not_met' });
    });

    it('allows surplus USDC but fails closed on a shortfall or released escrow', async () => {
        await expect(planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ vaultUsdcAtomic: 1000001n }))
        })).resolves.toMatchObject({ evidence: { activeUsdcAtomic: '1000000', vaultUsdcAtomic: '1000001' } });
        await expect(planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ vaultUsdcAtomic: 999999n }))
        })).rejects.toMatchObject({ code: 'invalid_donation_vault' });
        await expect(planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ donation: { ...observed().donation, released: true } }))
        })).rejects.toMatchObject({ code: 'invalid_donation_vault' });
    });

    it('never lets an owner vote or an observation after its time decide funding', async () => {
        await expect(planInvestorFundingDecision({ agreement: { ...base, content: { ...base.content, rule: { ...base.content.rule, electorate: 'owners' } } }, lensKey: lens, nowSeconds: now, chain: chain() }))
            .rejects.toMatchObject({ code: 'invalid_funding_content' });
        await expect(planInvestorFundingDecision({ agreement: base, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ blockTime: now + 1 }))
        })).rejects.toMatchObject({ code: 'funding_observation_after_deadline' });
    });

    it('refuses an index row whose target or attached contract no longer hashes to its CID', async () => {
        await expect(planInvestorFundingDecision({ agreement: { ...base, content: { ...base.content, funding: { ...base.content.funding, targetUsdcAtomic: '2' } } }, lensKey: lens, nowSeconds: now, chain: chain() }))
            .rejects.toMatchObject({ code: 'invalid_funding_content' });
        await expect(planInvestorFundingDecision({ agreement: { ...base, content: { ...base.content, funding: { ...base.content.funding, contract: { ...base.content.funding.contract, data: 'QW1lbmRlZA==' } } } }, lensKey: lens, nowSeconds: now, chain: chain() }))
            .rejects.toMatchObject({ code: 'invalid_funding_content' });
    });

    it('counts only finalized reservations whose two unit ids, terms and deposits match the funding schedule', async () => {
        const drawing = { name: 'unit.pdf', mediaType: 'application/pdf', data: 'JVBERi0xLjQK' };
        const unitA = { unitId: 'unit-a', label: 'Unit A', xrayBuilding: 'zagreb::gdi-3d::building-1', unit: '3::a::000000000000000000000000', at: '45.8,15.96,18', priceUsdcAtomic: '600000', depositUsdcAtomic: '600000', drawing };
        const unitB = { unitId: 'unit-b', label: 'Unit B', xrayBuilding: 'zagreb::gdi-3d::building-1', unit: '4::a::000000000000000000000001', at: '45.8,15.96,18', priceUsdcAtomic: '400000', depositUsdcAtomic: '400000', drawing };
        const apartments = { projectId: 'preview-1', units: [unitA, unitB] };
        const content = { ...base.content, funding: { ...base.content.funding, targetUsdcAtomic: '1000000', apartments } };
        const agreement = { ...base, cid: cidOfObject(content), content };
        const reservations = [
            { unitId: 'unit-a', status: 'reserved', deposit: '600000', unitKey: 'a'.repeat(64), termsHash: 'b'.repeat(64), position: 'pos-a', qualification: Keypair.generate().publicKey.toBase58() },
            { unitId: 'unit-b', status: 'reserved', deposit: '400000', unitKey: 'c'.repeat(64), termsHash: 'd'.repeat(64), position: 'pos-b', qualification: Keypair.generate().publicKey.toBase58() }
        ];
        const valid = await planInvestorFundingDecision({ agreement, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ reservations, agreement: { ...observed().agreement, cid: agreement.cid } })) });
        expect(valid.evidence.kind).toBe('apartment_reservations');
        expect(valid.evidence.reservations).toHaveLength(2);
        await expect(planInvestorFundingDecision({ agreement, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ reservations: reservations.map(row => ({ ...row, qualification: null })), agreement: { ...observed().agreement, cid: agreement.cid } })) }))
            .rejects.toMatchObject({ code: 'apartment_qualification_missing' });
        await expect(planInvestorFundingDecision({ agreement, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ reservations: [reservations[0]], agreement: { ...observed().agreement, cid: agreement.cid } })) })).rejects.toMatchObject({ code: 'apartment_observation_missing' });
        await expect(planInvestorFundingDecision({ agreement, lensKey: lens, nowSeconds: now,
            chain: chain(observed({ reservations: reservations.map((row, i) => i ? { ...row, status: 'available' } : row), agreement: { ...observed().agreement, cid: agreement.cid } })) })).rejects.toMatchObject({ code: 'funding_target_not_met' });
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
