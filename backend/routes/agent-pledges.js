// Free, read-only discovery surface for the on-chain pledge program. Writes go directly to Solana;
// the API never takes custody and never accepts a client-reported balance as truth.
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
            const escrow = await pledgeClient.readEscrow(getConnection(), proposal);
            if (!escrow) {
                const [escrowPda] = pledgeClient.getEscrowPda(proposal);
                return res.json({ exists: false, proposal: proposal.toBase58(), escrow: escrowPda.toBase58() });
            }
            return res.json({
                exists: true,
                proposal: escrow.proposal,
                escrow: pledgeClient.getEscrowPda(proposal)[0].toBase58(),
                beneficiary: escrow.beneficiary,
                mint: escrow.pledgeMint,
                vault: escrow.vault,
                totalPledgedAtomic: escrow.totalPledged.toString(),
                totalPledgedUsdc: pledgeClient.formatUsdc(escrow.totalPledged),
                totalReleasedAtomic: escrow.totalReleased.toString(),
                totalRefundedAtomic: escrow.totalRefunded.toString(),
                pledgeCount: escrow.pledgeCount.toString(),
                backerCount: escrow.backerCount.toString(),
                released: escrow.released
            });
        } catch (error) {
            console.error('Failed to read proposal pledge escrow:', error);
            return res.status(502).json({ error: 'Solana pledge state is unavailable' });
        }
    });
}
