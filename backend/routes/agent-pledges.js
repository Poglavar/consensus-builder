// Free, read-only discovery surface for the on-chain donations and soft pledges backing an agreement:
// their subject is the agreement's chain account (PDA ["agreement", sponsor, sha256(cid)]). Writes go
// directly to Solana; the API never takes custody or accepts client-reported balances as truth.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledgeClient = require('../../frontend/js/solana/pledge-client.js');
pledgeClient.configure({ web3 });

export function setupAgentPledgesRoute(app, { env = process.env, connection = null } = {}) {
    let rpcConnection = connection;
    const getConnection = () => {
        if (!rpcConnection) rpcConnection = new web3.Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        return rpcConnection;
    };

    app.get('/agent/pledges/:agreementAccount', async (req, res) => {
        let account;
        try {
            account = new web3.PublicKey(req.params.agreementAccount);
        } catch {
            return res.status(400).json({ error: 'the agreement account must be a Solana public key' });
        }
        try {
            const [donations, pledges] = await Promise.all([
                pledgeClient.readDonationEscrow(getConnection(), account),
                pledgeClient.readPledgeBook(getConnection(), account)
            ]);
            return res.json({
                exists: Boolean(donations || pledges),
                agreementAccount: account.toBase58(),
                donations: donations ? {
                    escrow: pledgeClient.getDonationEscrowPda(account)[0].toBase58(),
                    beneficiary: donations.beneficiary,
                    vault: donations.vault,
                    totalAtomic: donations.totalDonated.toString(),
                    totalUsdc: pledgeClient.formatUsdc(donations.totalDonated),
                    releasedAtomic: donations.totalReleased.toString(),
                    refundedAtomic: donations.totalRefunded.toString(),
                    donationCount: donations.donationCount.toString(),
                    donorCount: donations.donorCount.toString(),
                    released: donations.released
                } : null,
                pledges: pledges ? {
                    book: pledgeClient.getPledgeBookPda(account)[0].toBase58(),
                    beneficiary: pledges.beneficiary,
                    activeAtomic: pledges.activePledged.toString(),
                    activeUsdc: pledgeClient.formatUsdc(pledges.activePledged),
                    fulfilledAtomic: pledges.totalFulfilled.toString(),
                    revokedAtomic: pledges.totalRevoked.toString(),
                    pledgeCount: pledges.pledgeCount.toString(),
                    activeCount: pledges.activeCount.toString(),
                    fulfilledCount: pledges.fulfilledCount.toString()
                } : null
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Failed to read the support of agreement account ${account.toBase58()}:`, error);
            return res.status(502).json({ error: 'Solana pledge state is unavailable' });
        }
    });
}
