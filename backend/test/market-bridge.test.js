import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bridgeSource = fs.readFileSync(new URL('../../frontend/js/solana/market-bridge.js', import.meta.url), 'utf8');

describe('Solana market bridge', () => {
    it('loads an optional market and both connected-wallet positions through the shared client', async () => {
        const wallet = { toBase58: () => 'wallet-1' };
        const market = { stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', yesPool: 100n, noPool: 50n, resolved: false };
        const client = {
            constants: { SIDE_YES: 1, SIDE_NO: 0 },
            getMarketPda: vi.fn(() => [{ toBase58: () => 'market-pda-1' }]),
            readMarket: vi.fn(async () => market),
            readPosition: vi.fn(async (_connection, _proposal, _wallet, side) => ({ side, amount: 10n }))
        };
        const window = {
            solanaWeb3: { Transaction: class Transaction {} },
            SolanaMarketClient: client,
            SolanaChainDataLoader: { getConnection: vi.fn(), getVerifiedConnection: vi.fn(async () => ({ rpc: 'devnet' })) },
            // The market's subject is an agreement account (M3): its status and deadline (unix seconds)
            // are read from the agreement program.
            AgreementClient: { fetchAgreement: vi.fn(async () => ({ status: 'Active', deadline: 1795000000 })) },
            solanaWalletManager: { getCluster: vi.fn(() => 'mainnet-beta'), getProvider: vi.fn(() => ({ publicKey: wallet })) }
        };
        vm.runInNewContext(bridgeSource, { window });

        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).resolves.toMatchObject({
            market, marketAddress: 'market-pda-1', wallet: 'wallet-1', yes: { side: 1 }, no: { side: 0 },
            chainStatus: 'Active', deadline: '2026-11-18T11:06:40.000Z'
        });
        expect(window.AgreementClient.fetchAgreement).toHaveBeenCalledWith({ rpc: 'devnet' }, { address: 'proposal-1' });
        expect(client.readPosition).toHaveBeenCalledTimes(2);
        expect(window.SolanaChainDataLoader.getVerifiedConnection).toHaveBeenCalledWith('devnet');
        expect(window.SolanaChainDataLoader.getConnection).not.toHaveBeenCalled();
        market.stakeMint = 'another-mint';
        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).rejects.toThrow('stake mint');
        market.stakeMint = window.SolanaMarketBridge.DEVNET_USDC_MINT;
        // A stored deadline of 0 is none; a pool-less summary carries the agreement's state too.
        window.AgreementClient.fetchAgreement.mockResolvedValue({ status: 'Active', deadline: 0 });
        client.readMarket.mockResolvedValueOnce(null);
        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).resolves.toEqual({
            market: null, marketAddress: 'market-pda-1', wallet: 'wallet-1', chainStatus: 'Active', deadline: null
        });
        // A deadline the read did not yield is not "no deadline": the summary fails.
        window.AgreementClient.fetchAgreement.mockResolvedValue({ status: 'Active' });
        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).rejects.toThrow('Agreement account deadline is unavailable');
        // A missing account, or a status byte the decoder does not know, fails the summary.
        window.AgreementClient.fetchAgreement.mockResolvedValue(null);
        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).rejects.toThrow('Agreement account status is unavailable');
        window.AgreementClient.fetchAgreement.mockResolvedValue({ status: 'Unknown(9)' });
        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).rejects.toThrow('Agreement account status is unavailable');
    });

    it('reads the connected wallet\'s positions for a whole list of proposals in one RPC call', async () => {
        const wallet = { toBase58: () => 'wallet-1' };
        const client = {
            constants: { SIDE_YES: 1, SIDE_NO: 0 },
            getMarketPda: vi.fn(proposal => [{ toBase58: () => `market:${proposal}` }]),
            getPositionPda: vi.fn((market, _owner, side) => [{ key: `${market.toBase58()}:${side}` }]),
            readPositionAccount: vi.fn(info => info.data)
        };
        const connection = {
            getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => (key.key === 'market:proposal-2:0' ? { data: { amount: 50000n, side: 0 } } : null)))
        };
        const window = {
            solanaWeb3: { Transaction: class Transaction {} },
            SolanaMarketClient: client,
            SolanaChainDataLoader: { getConnection: vi.fn(() => connection), getVerifiedConnection: vi.fn(async () => connection) },
            solanaWalletManager: { getCluster: vi.fn(() => 'devnet'), getProvider: vi.fn(() => ({ publicKey: wallet })) }
        };
        vm.runInNewContext(bridgeSource, { window });

        const positions = await window.SolanaMarketBridge.readPositions(['proposal-1', 'proposal-2', 'proposal-1', null]);
        expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
        expect(connection.getMultipleAccountsInfo.mock.calls[0][0].map(key => key.key))
            .toEqual(['market:proposal-1:1', 'market:proposal-1:0', 'market:proposal-2:1', 'market:proposal-2:0']);
        expect(positions).toEqual({
            'proposal-1': { yes: null, no: null },
            'proposal-2': { yes: null, no: { amount: 50000n, side: 0 } }
        });

        window.solanaWalletManager.getProvider = vi.fn(() => null);
        await expect(window.SolanaMarketBridge.readPositions(['proposal-1'])).resolves.toEqual({});
        expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);

        window.solanaWalletManager.getProvider = vi.fn(() => ({ publicKey: wallet }));
        connection.getMultipleAccountsInfo.mockResolvedValue([]);
        await expect(window.SolanaMarketBridge.readPositions(['proposal-1'])).rejects.toThrow('incomplete');
    });

    it('preflights, signs, confirms, and reports every stake transaction state', async () => {
        class Transaction {
            constructor(options) { this.options = options; this.instructions = []; }
            add(instruction) { this.instructions.push(instruction); return this; }
        }
        const wallet = { toBase58: () => 'wallet-1' };
        const tokenAccount = { toBase58: () => 'token-1' };
        const connection = {
            getLatestBlockhash: vi.fn(async () => ({ blockhash: 'block', lastValidBlockHeight: 1 })),
            simulateTransaction: vi.fn(async (_transaction, config) => {
                // Mirrors web3.js 1.x: a legacy Transaction takes signers here, never a config object.
                if (config !== undefined && !Array.isArray(config)) throw new Error('Invalid arguments');
                return { value: { err: null } };
            }),
            getBalance: vi.fn(async () => 1),
            getTokenAccountBalance: vi.fn(async () => ({ value: { amount: '2000000' } })),
            sendRawTransaction: vi.fn(async () => 'stake-tx'),
            confirmTransaction: vi.fn(async () => ({ value: { err: null } }))
        };
        const client = {
            constants: { SIDE_YES: 1, SIDE_NO: 0 },
            readMarket: vi.fn(async () => ({ stakeMint: 'mint-1', resolved: false })),
            getAssociatedTokenAddress: vi.fn(() => tokenAccount),
            buildStakeIx: vi.fn(options => ({ kind: 'stake', ...options }))
        };
        const window = {
            solanaWeb3: { Transaction }, SolanaMarketClient: client,
            SolanaChainDataLoader: { getConnection: vi.fn(() => connection) },
            solanaWalletManager: {
                getCluster: vi.fn(() => 'devnet'),
                getProvider: vi.fn(() => ({ publicKey: wallet, signTransaction: vi.fn(async tx => ({ serialize: () => tx.instructions })) }))
            }
        };
        vm.runInNewContext(bridgeSource, { window });
        const states = [];
        const result = await window.SolanaMarketBridge.stake({ proposal: 'proposal-1', side: 1, amount: 1_500_000n, onStatus: status => states.push(status.state) });

        expect(client.buildStakeIx).toHaveBeenCalledWith(expect.objectContaining({ proposal: 'proposal-1', stakeMint: 'mint-1', staker: wallet, side: 1, amount: 1_500_000n }));
        expect(states).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
        expect(result).toEqual({ transactionHash: 'stake-tx', explorerUrl: 'https://explorer.solana.com/tx/stake-tx?cluster=devnet' });
    });

    it('lets a connected human open the single devnet-USDC market', async () => {
        class Transaction {
            constructor(options) { this.options = options; this.instructions = []; }
            add(instruction) { this.instructions.push(instruction); return this; }
        }
        const wallet = { toBase58: () => 'wallet-1' };
        const connection = {
            getBalance: vi.fn(async () => 1),
            getLatestBlockhash: vi.fn(async () => ({ blockhash: 'block', lastValidBlockHeight: 1 })),
            simulateTransaction: vi.fn(async (_transaction, config) => {
                // Mirrors web3.js 1.x: a legacy Transaction takes signers here, never a config object.
                if (config !== undefined && !Array.isArray(config)) throw new Error('Invalid arguments');
                return { value: { err: null } };
            }),
            sendRawTransaction: vi.fn(async () => 'create-market-tx'),
            confirmTransaction: vi.fn(async () => ({ value: { err: null } }))
        };
        const client = {
            readMarket: vi.fn(async () => null),
            buildCreateMarketIx: vi.fn(options => ({ kind: 'createMarket', ...options }))
        };
        const window = {
            solanaWeb3: { Transaction }, SolanaMarketClient: client,
            SolanaChainDataLoader: { getConnection: vi.fn(() => connection) },
            solanaWalletManager: {
                getCluster: vi.fn(() => 'devnet'),
                getProvider: vi.fn(() => ({ publicKey: wallet, signTransaction: vi.fn(async tx => ({ serialize: () => tx.instructions })) }))
            }
        };
        vm.runInNewContext(bridgeSource, { window });
        const result = await window.SolanaMarketBridge.createMarket({ proposal: 'proposal-1' });

        expect(client.buildCreateMarketIx).toHaveBeenCalledWith(expect.objectContaining({
            proposal: 'proposal-1', creator: wallet, stakeMint: window.SolanaMarketBridge.DEVNET_USDC_MINT
        }));
        expect(result.transactionHash).toBe('create-market-tx');
    });
});
