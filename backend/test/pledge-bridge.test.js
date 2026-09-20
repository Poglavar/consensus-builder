import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bridgeSource = fs.readFileSync(new URL('../../frontend/js/solana/pledge-bridge.js', import.meta.url), 'utf8');

describe('Solana pledge bridge', () => {
    it('loads the lazy Solana vendor before reading walletless funding totals', async () => {
        const window = {
            ensureWalletVendors: vi.fn(async () => {
                window.solanaWeb3 = { Transaction: class Transaction {} };
            }),
            SolanaPledgeClient: {
                readDonationEscrow: vi.fn(async () => ({ totalDonated: 10n })),
                readPledgeBook: vi.fn(async () => ({ activePledged: 20n })),
                readPledgeCommitment: vi.fn(),
                listDonationPositions: vi.fn()
            },
            SolanaChainDataLoader: { getConnection: vi.fn(() => ({ rpc: 'devnet' })) },
            solanaWalletManager: {
                getCluster: vi.fn(() => 'devnet'),
                getProvider: vi.fn(() => null)
            }
        };

        vm.runInNewContext(bridgeSource, { window });
        const result = await window.SolanaPledgeBridge.readSummary('proposal-account');

        expect(window.ensureWalletVendors).toHaveBeenCalledOnce();
        expect(window.SolanaChainDataLoader.getConnection).toHaveBeenCalledWith('devnet');
        expect(result).toMatchObject({
            donations: { totalDonated: 10n },
            pledges: { activePledged: 20n },
            myPledge: null,
            myDonations: [],
            wallet: null
        });
    });

    it('reports connected wallet balances without requiring a support transaction', async () => {
        const wallet = { toBase58: () => 'wallet-1' };
        const tokenAccount = { toBase58: () => 'usdc-account-1' };
        const connection = {
            getBalance: vi.fn(async () => 12500000),
            getTokenAccountBalance: vi.fn(async () => ({ value: { amount: '3500000' } }))
        };
        const window = {
            solanaWeb3: { Transaction: class Transaction {} },
            SolanaPledgeClient: {
                constants: { USDC_DEVNET_MINT: 'mint' },
                getAssociatedTokenAddress: vi.fn(() => tokenAccount),
                formatUsdc: vi.fn(value => value === 3500000n ? '3.5' : String(value))
            },
            SolanaChainDataLoader: { getConnection: vi.fn(() => connection) },
            solanaWalletManager: {
                getCluster: vi.fn(() => 'devnet'),
                getProvider: vi.fn(() => ({ publicKey: wallet, signTransaction: vi.fn() }))
            }
        };
        vm.runInNewContext(bridgeSource, { window });

        await expect(window.SolanaPledgeBridge.walletBalances()).resolves.toMatchObject({
            wallet: 'wallet-1', cluster: 'devnet', solLamports: 12500000, sol: 0.0125,
            usdcAtomic: 3500000n, usdc: '3.5', hasUsdcAccount: true, tokenAccount: 'usdc-account-1'
        });
    });

    it('chunks many donation refunds into bounded Solana transactions', async () => {
        class Transaction {
            constructor() { this.instructions = []; }
            add(instruction) { this.instructions.push(instruction); }
        }
        const wallet = { toBase58: () => 'wallet-1' };
        let transactionNumber = 0;
        const connection = {
            getLatestBlockhash: vi.fn(async () => ({ blockhash: 'block', lastValidBlockHeight: 1 })),
            simulateTransaction: vi.fn(async transaction => ({ value: { err: null, instructionCount: transaction.instructions.length } })),
            sendRawTransaction: vi.fn(async () => `tx-${++transactionNumber}`),
            confirmTransaction: vi.fn(async () => ({ value: { err: null } }))
        };
        const window = {
            solanaWeb3: { Transaction },
            SolanaPledgeClient: {
                listDonationPositions: vi.fn(async () => Array.from({ length: 9 }, (_, index) => ({ donationId: `d-${index}`, refunded: false }))),
                buildRefundDonationIx: vi.fn(({ donationId }) => ({ donationId }))
            },
            SolanaChainDataLoader: { getConnection: vi.fn(() => connection) },
            solanaWalletManager: {
                getCluster: vi.fn(() => 'devnet'),
                getProvider: vi.fn(() => ({
                    publicKey: wallet,
                    signTransaction: vi.fn(async transaction => ({ serialize: () => new Uint8Array(transaction.instructions.length) }))
                }))
            }
        };
        vm.runInNewContext(bridgeSource, { window });

        const result = await window.SolanaPledgeBridge.refundMyDonations({ proposal: 'proposal-1' });

        expect(connection.sendRawTransaction).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({ refunded: 9, transactionHash: 'tx-1', transactionHashes: ['tx-1', 'tx-2', 'tx-3'] });
    });
});
