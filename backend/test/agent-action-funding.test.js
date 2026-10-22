// The funding and adapter wiring of the support and society runners (support-run.mjs executeSupport,
// society-run.mjs execute): a USDC action is funded after its cap and eligibility checks and before its
// chain adapter, claims and revocations are never funded, and every adapter gets the agreement account
// as its subject.
import { describe, expect, it, vi } from 'vitest';
import { execute as executeSociety } from '../agents/society-run.mjs';
import { executeSupport } from '../agents/support-run.mjs';

const ACCOUNT = 'AgreementAccount111111111111111111111111111';
const CID = 'bafkreiagreementcid';

describe('action funding wiring', () => {
    const connection = { name: 'fake connection' };
    const keypair = { publicKey: 'fake key' };
    const pool = { query: vi.fn() };
    const persona = { name: 'supporter-01' };
    const runId = '2026-10-22-supporter-01';

    it('funds a society stake before staking it on the agreement account', async () => {
        const events = [];
        const action = { type: 'stake', side: 'no', amount: '0.02', usdc: 0.02, agreementCid: CID, account: ACCOUNT };
        const adapters = {
            fundBotAction: vi.fn(async args => { events.push('fund'); expect(args).toEqual({ action, connection, pool, persona, runId }); }),
            ensureMarketAndStake: vi.fn(async args => { events.push('stake'); return { stakeSignature: 'stake-signature', args }; })
        };
        const result = await executeSociety({ action, connection, keypair, caps: { maxUsdc: 0.05 }, pool, persona, runId, adapters });
        expect(events).toEqual(['fund', 'stake']);
        expect(result.stakeSignature).toBe('stake-signature');
        expect(adapters.ensureMarketAndStake).toHaveBeenCalledWith(expect.objectContaining({
            subject: ACCOUNT, side: 0, amountAtomic: 20_000n, targetAmount: true
        }));
    });

    it('does not fund society claims or pledge revocations', async () => {
        const fundBotAction = vi.fn();
        const adapters = {
            fundBotAction,
            claimAgreementMarket: vi.fn(async () => ({ signature: 'claim-signature' })),
            revokePledge: vi.fn(async () => ({ signature: 'revoke-signature' }))
        };
        const context = { connection, keypair, caps: { maxUsdc: 0.05 }, pool, persona, runId, adapters };
        await executeSociety({ ...context, action: { type: 'claim', side: 'yes', usdc: 0, agreementCid: CID, account: ACCOUNT } });
        await executeSociety({ ...context, action: { type: 'revokePledge', usdc: 0, agreementCid: CID, account: ACCOUNT } });
        expect(fundBotAction).not.toHaveBeenCalled();
        expect(adapters.claimAgreementMarket).toHaveBeenCalledWith(expect.objectContaining({ subject: ACCOUNT, side: 'yes' }));
        expect(adapters.revokePledge).toHaveBeenCalledWith(expect.objectContaining({ subject: ACCOUNT }));
    });

    it.each(['stake', 'donate', 'pledge'])('funds a support %s after the eligibility re-check and before its chain adapter', async type => {
        const events = [];
        const decision = { type, amount: '0.20', agreementCid: CID, account: ACCOUNT };
        const adapters = {
            assertSupportEligibility: vi.fn(async args => { events.push('eligible'); expect(args.decision).toBe(decision); }),
            fundBotAction: vi.fn(async args => { events.push('fund'); expect(args).toEqual({ action: decision, connection, pool, persona, runId }); }),
            ensureMarketAndStake: vi.fn(async () => { events.push('stake'); return { stakeSignature: 'stake-signature' }; }),
            ensureDonationEscrowAndDonate: vi.fn(async () => { events.push('donate'); return { signature: 'donation-signature' }; }),
            ensurePledgeBookAndSet: vi.fn(async () => { events.push('pledge'); return { signature: 'pledge-signature' }; })
        };
        await executeSupport({ decision, connection, keypair, pool, persona, runId, adapters });
        expect(events).toEqual(['eligible', 'fund', type]);
        const chain = { stake: adapters.ensureMarketAndStake, donate: adapters.ensureDonationEscrowAndDonate, pledge: adapters.ensurePledgeBookAndSet }[type];
        expect(chain).toHaveBeenCalledWith(expect.objectContaining({ subject: ACCOUNT, amountAtomic: 200_000n }));
        if (type === 'stake') expect(chain).toHaveBeenCalledWith(expect.objectContaining({ side: 1 }));
        // A donation's receipt is keyed by the run and the agreement, so a rerun of the run replays it.
        if (type === 'donate') expect(chain).toHaveBeenCalledWith(expect.objectContaining({ operationId: `${runId}:${CID}:donate` }));
    });

    it('refuses a target that became terminal before any funding or signing', async () => {
        const fundBotAction = vi.fn(), ensureMarketAndStake = vi.fn();
        await expect(executeSupport({
            decision: { type: 'stake', amount: '0.10', agreementCid: CID, account: ACCOUNT },
            connection, keypair, pool, persona, runId, adapters: {
                assertSupportEligibility: async () => { throw new Error('target is Expired on-chain'); },
                fundBotAction, ensureMarketAndStake
            }
        })).rejects.toThrow('target is Expired on-chain');
        expect(fundBotAction).not.toHaveBeenCalled();
        expect(ensureMarketAndStake).not.toHaveBeenCalled();
    });

    it('rejects a support action above its USDC cap before the re-check or funding', async () => {
        vi.stubEnv('AGENT_SUPPORT_USDC_CAP', '0.25');
        try {
            const assertSupportEligibility = vi.fn(), fundBotAction = vi.fn(), ensureMarketAndStake = vi.fn();
            await expect(executeSupport({
                decision: { type: 'stake', amount: '0.26', agreementCid: CID, account: ACCOUNT },
                connection, keypair, pool, persona, runId, adapters: { assertSupportEligibility, fundBotAction, ensureMarketAndStake }
            })).rejects.toThrow(/AGENT_SUPPORT_USDC_CAP/);
            expect(assertSupportEligibility).not.toHaveBeenCalled();
            expect(fundBotAction).not.toHaveBeenCalled();
            expect(ensureMarketAndStake).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('refuses an action type it cannot sign', async () => {
        const fundBotAction = vi.fn();
        await expect(executeSupport({
            decision: { type: 'vote', amount: '0.10', agreementCid: CID, account: ACCOUNT },
            connection, keypair, pool, persona, runId, adapters: { assertSupportEligibility: async () => {}, fundBotAction }
        })).rejects.toThrow(/unsupported support action vote/);
        await expect(executeSociety({ action: { type: 'mint', usdc: 0, account: ACCOUNT }, connection, keypair, caps: { maxUsdc: 0.05 }, pool, persona, runId, adapters: { fundBotAction } }))
            .rejects.toThrow(/cannot execute mint/);
    });
});
