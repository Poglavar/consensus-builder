import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { planInvestorFundingDecision } from '../lens/agreement-decision.js';
import { cidOfObject } from '../cid.js';

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
});
