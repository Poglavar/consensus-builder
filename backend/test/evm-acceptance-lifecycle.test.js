// Verify post-confirmation reads in the real wallet bridge, with only ethers/provider boundaries replaced.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const status = require('../../frontend/js/proposals/chain-status.js');
const source = readFileSync(new URL('../../frontend/js/blockchain-proposals.js', import.meta.url), 'utf8');
const address = `0x${'a'.repeat(40)}`;
const hash = `0x${'b'.repeat(64)}`;

function fixture({ statusCode = 1n, readError = false, networkChanged = false, transactionError = false } = {}) {
    const events = [];
    const read = vi.fn(async () => {
        events.push('read');
        if (readError) throw new Error('RPC read unavailable');
        return { status: statusCode };
    });
    let networkCalls = 0;
    const provider = {
        getSigner: async () => ({ identity: 'signer' }), getCode: async () => '0x6000',
        getNetwork: async () => ({ chainId: networkChanged && ++networkCalls > 1 ? 1n : 84532n })
    };
    const submit = vi.fn(async () => ({ hash, wait: async () => {
        events.push('confirmed');
        if (transactionError) throw new Error('Transaction reverted');
        return { hash, blockNumber: 42 };
    } }));
    const context = createContext({
        walletManager: { getProvider: () => ({}) }, ProposalChainStatus: status,
        console: { warn: vi.fn() },
        ethers: {
            BrowserProvider: class { constructor() { return provider; } },
            Contract: class { constructor(target, _abi, signer) {
                expect(target).toBe(address);
                expect(signer).toEqual({ identity: 'signer' });
                return { acceptProposal: submit, getProposal: read };
            } },
            getAddress: value => value
        }
    });
    context.window = context;
    runInContext(source, context);
    const accept = () => context.ProposalChainBridge.acceptProposal({ chainId: '84532', contractAddress: address, proposalId: '5', parcelId: 'base-a' });
    return { accept, read, submit, events, context };
}

describe('EVM acceptance lifecycle read', () => {
    it('reads the same contract at the receipt block after confirmation', async () => {
        const { accept, read, submit, events } = fixture();
        const before = Date.now();
        const result = await accept();
        expect(result).toMatchObject({ transactionHash: hash, chainId: '84532', contractAddress: address,
            proposalId: '5', blockNumber: 42, lifecycle: { statusCode: 1, blockNumber: 42 } });
        expect(Date.parse(result.lifecycle.observedAt)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(result.lifecycle.observedAt)).toBeLessThanOrEqual(Date.now());
        expect(events).toEqual(['confirmed', 'read']);
        expect(read).toHaveBeenCalledWith(5n, { blockTag: 42 });
        expect(submit).toHaveBeenCalledOnce();
    });

    it.each([{ readError: true }, { statusCode: null }, { statusCode: 9n }, { networkChanged: true }])(
        'keeps a successful transaction distinct from a failed status refresh: %s', async options => {
            const { accept, read, submit, context } = fixture(options);
            expect(await accept()).toMatchObject({ transactionHash: hash, lifecycle: null });
            expect(submit).toHaveBeenCalledOnce();
            expect(context.console.warn).toHaveBeenCalledOnce();
            if (options.networkChanged) expect(read).not.toHaveBeenCalled();
        });

    it('does not read or return success after a reverted transaction', async () => {
        const { accept, read } = fixture({ transactionError: true });
        await expect(accept()).rejects.toThrow('Transaction reverted');
        expect(read).not.toHaveBeenCalled();
    });
});
