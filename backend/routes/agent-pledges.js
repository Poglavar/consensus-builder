// Free, read-only discovery surface for on-chain proposal donations and soft pledges. Writes go
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

    app.get('/agent/pledges/:proposal', async (req, res) => {
        let proposal;
        try {
            proposal = new web3.PublicKey(req.params.proposal);
        } catch {
            return res.status(400).json({ error: 'proposal must be a Solana public key' });
        }
        try {
            const [donations, pledges] = await Promise.all([
                pledgeClient.readDonationEscrow(getConnection(), proposal),
                pledgeClient.readPledgeBook(getConnection(), proposal)
            ]);
            return res.json({
                exists: Boolean(donations || pledges),
                proposal: proposal.toBase58(),
                donations: donations ? {
                    escrow: pledgeClient.getDonationEscrowPda(proposal)[0].toBase58(),
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
                    book: pledgeClient.getPledgeBookPda(proposal)[0].toBase58(),
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
            console.error('Failed to read proposal pledge escrow:', error);
            return res.status(502).json({ error: 'Solana pledge state is unavailable' });
        }
    });
}
