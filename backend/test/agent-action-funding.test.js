import { describe, expect, it, vi } from 'vitest';
import { execute as executeSociety } from '../agents/society-run.mjs';
import { executeSupport } from '../agents/support-run.mjs';

describe('action funding wiring', () => {
    const connection = { name: 'fake connection' };
    const keypair = { publicKey: 'fake key' };
    const pool = { query: vi.fn() };
    const persona = { name: 'supporter-01' };
    const runId = '2026-10-19-supporter-01';

    it('funds a society stake before staking and passes the run context', async () => {
        const events = [];
        const action = { type: 'stake', side: 'no', amount: '0.02', usdc: 0.02, proposalAccount: 'proposal' };
        const adapters = {
            fundBotAction: vi.fn(async args => { events.push('fund'); expect(args).toEqual({ action, connection, pool, persona, runId }); }),
            ensureMarketAndStake: vi.fn(async args => { events.push('stake'); return { stakeSignature: 'stake-signature', args }; })
        };
        const result = await executeSociety({ action, connection, keypair, caps: { maxUsdc: 0.05 }, pool, persona, runId, adapters });
        expect(events).toEqual(['fund', 'stake']);
        expect(result.stakeSignature).toBe('stake-signature');
        expect(adapters.ensureMarketAndStake).toHaveBeenCalledWith(expect.objectContaining({
            proposalPda: 'proposal', amountAtomic: 20_000n, targetAmount: true
        }));
    });

    it('does not fund society claims or pledge revocations', async () => {
        const fundBotAction = vi.fn();
        const adapters = {
            fundBotAction,
            claimProposalMarket: vi.fn(async () => ({ signature: 'claim-signature' })),
            revokePledge: vi.fn(async () => ({ signature: 'revoke-signature' }))
        };
        const context = { connection, keypair, caps: { maxUsdc: 0.05 }, pool, persona, runId, adapters };
        await executeSociety({ ...context, action: { type: 'claim', side: 'yes', usdc: 0, proposalAccount: 'proposal' } });
        await executeSociety({ ...context, action: { type: 'revokePledge', usdc: 0, proposalAccount: 'proposal' } });
        expect(fundBotAction).not.toHaveBeenCalled();
        expect(adapters.claimProposalMarket).toHaveBeenCalledTimes(1);
        expect(adapters.revokePledge).toHaveBeenCalledTimes(1);
    });

    it.each(['stake', 'donate'])('funds a support %s before its chain adapter', async type => {
        const events = [];
        const decision = { type, amount: '0.20', proposalId: 'proposal-id', proposalAccount: 'proposal' };
        const adapters = {
            assertSupportEligibility: vi.fn(async () => { events.push('eligible'); }),
            fundBotAction: vi.fn(async args => { events.push('fund'); expect(args).toEqual({ action: decision, connection, pool, persona, runId }); }),
            ensureMarketAndStake: vi.fn(async () => { events.push('stake'); return { signature: 'stake-signature' }; }),
            ensureDonationEscrowAndDonate: vi.fn(async () => { events.push('donate'); return { signature: 'donation-signature' }; })
        };
        await executeSupport({ decision, connection, keypair, pool, persona, runId, adapters });
        expect(events).toEqual(['eligible', 'fund', type]);
        const chain = type === 'stake' ? adapters.ensureMarketAndStake : adapters.ensureDonationEscrowAndDonate;
        expect(chain).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: 200_000n }));
    });


    it('refuses a target that became terminal before any funding or signing', async () => {
        const fundBotAction = vi.fn(), ensureMarketAndStake = vi.fn();
        await expect(executeSupport({
            decision: { type: 'stake', amount: '0.10', proposalAccount: 'proposal' },
            connection, keypair, pool, persona, runId, adapters: {
                assertSupportEligibility: async () => { throw new Error('target is Expired on-chain'); },
                fundBotAction, ensureMarketAndStake
            }
        })).rejects.toThrow('target is Expired on-chain');
        expect(fundBotAction).not.toHaveBeenCalled();
        expect(ensureMarketAndStake).not.toHaveBeenCalled();
    });

    it('rejects a support action above its USDC cap before funding', async () => {
        vi.stubEnv('AGENT_SUPPORT_USDC_CAP', '0.25');
        try {
            const fundBotAction = vi.fn();
            const ensureMarketAndStake = vi.fn();
            await expect(executeSupport({
                decision: { type: 'stake', amount: '0.26', proposalAccount: 'proposal' },
                connection, keypair, pool, persona, runId, adapters: { fundBotAction, ensureMarketAndStake }
            })).rejects.toThrow(/AGENT_SUPPORT_USDC_CAP/);
            expect(fundBotAction).not.toHaveBeenCalled();
            expect(ensureMarketAndStake).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
