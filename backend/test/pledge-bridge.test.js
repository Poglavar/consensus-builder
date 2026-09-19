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
});
