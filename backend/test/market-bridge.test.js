import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bridgeSource = fs.readFileSync(new URL('../../frontend/js/solana/market-bridge.js', import.meta.url), 'utf8');

describe('Solana market bridge', () => {
    it('loads an optional market and both connected-wallet positions through the shared client', async () => {
        const wallet = { toBase58: () => 'wallet-1' };
        const market = { stakeMint: 'mint-1', yesPool: 100n, noPool: 50n, resolved: false };
        const client = {
            constants: { SIDE_YES: 1, SIDE_NO: 0 },
            readMarket: vi.fn(async () => market),
            readPosition: vi.fn(async (_connection, _proposal, _wallet, side) => ({ side, amount: 10n }))
        };
        const window = {
            solanaWeb3: { Transaction: class Transaction {} },
            SolanaMarketClient: client,
            SolanaChainDataLoader: { getConnection: vi.fn(() => ({ rpc: 'devnet' })) },
            solanaWalletManager: { getCluster: vi.fn(() => 'devnet'), getProvider: vi.fn(() => ({ publicKey: wallet })) }
        };
        vm.runInNewContext(bridgeSource, { window });

        await expect(window.SolanaMarketBridge.readSummary('proposal-1')).resolves.toMatchObject({
            market, wallet: 'wallet-1', yes: { side: 1 }, no: { side: 0 }
        });
        expect(client.readPosition).toHaveBeenCalledTimes(2);
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
            simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
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
            simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
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
