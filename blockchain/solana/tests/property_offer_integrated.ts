// End-to-end property offer v2 through the real Solana Attestation Service, with the browser's own
// modules building every instruction (frontend/js/solana/property-statements.js, property-offer-client.js)
// and frontend/js/property-holders.js reading the holder back. A lens member states the first holder,
// a buyer bids for a flat in SOL, the seller accepts, the buyer's lens member confirms from its wallet
// at the holding's fixed address and the last confirmation pays out; the holder moves to the buyer;
// a second confirmation of the same holding by the same lens member is refused by SAS itself.
// Run against an isolated local validator with SAS cloned from devnet (blockchain/solana/README.md).
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect } from 'chai';

const frontend = createRequire(resolve(__dirname, '../../../frontend/js/package-anchor.js'));
const web3 = require('@solana/web3.js');
const offers = frontend('./solana/property-offer-client.js');
const statements = frontend('./solana/property-statements.js');
const holders = frontend('./property-holders.js');
offers.configure({ web3 }); statements.configure({ web3 });

const rpcUrl = process.env.ANCHOR_PROVIDER_URL || 'http://127.0.0.1:8899';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(rpcUrl).hostname)) throw new Error('This integration test requires an isolated local validator.');
const connection = new Connection(rpcUrl, 'confirmed');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest();
const chainNow = async () => Number((await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111')))!.data.readBigInt64LE(32));
const send = (signers: Keypair[], ...ixs: TransactionInstruction[]) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
async function funded(sol = 2) { const k = Keypair.generate(); await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed'); return k; }
const getAccount = async (address: string) => (await connection.getAccountInfo(new PublicKey(address), 'confirmed'))?.data || null;

describe('property_offer v2 with the real SAS', () => {
    it('states a first holder, sells once through the buyer’s lens member, and refuses a second confirmation of that holding', async () => {
        const [member, seller, buyer, other] = await Promise.all([funded(), funded(), funded(), funded()]);
        const assetKey = JSON.stringify(['flat/v1', 'design::bafkreieyimgcelmg7a3tlylacmtjngd3zefgml3plwxgesgjaj6ijaoqry::0', 4, 2]);
        const assetHash = hash(assetKey).toString('hex');
        // The lens member registers its credential and schemas, and states the seller as first holder.
        const now = await chainNow();
        await send([member], ...(await statements.setupIxs(connection, { payer: member.publicKey, authority: member.publicKey })));
        const first = statements.buildHoldingIx({ payer: member.publicKey, authority: member.publicKey, assetHash, asset: assetKey, holder: seller.publicKey.toBase58(), basis: 'developer', observedAt: now });
        await send([member], first.instruction);
        let view = await holders.viewOf({ member: member.publicKey.toBase58(), assetHash, getAccount, statements, offers });
        expect(view.holder).to.equal(seller.publicKey.toBase58());

        // The buyer bids 0.5 SOL with the lens member as its lens; the seller accepts.
        const bid = async (maker: Keypair, price: number) => {
            const cid = `bafkrei${randomBytes(26).toString('hex').slice(0, 52)}`;
            const { offer, instructions } = offers.buildCreateIxs({ maker: maker.publicKey, currency: 'SOL', cid, side: 'buy', termsHash: hash(cid), price, deadline: (await chainNow()) + 600, lens: [member.publicKey], lensThreshold: 1 });
            await send([maker], ...instructions);
            return { offer, cid };
        };
        const first_bid = await bid(buyer, LAMPORTS_PER_SOL / 2);
        const payouts = [{ recipient: seller.publicKey.toBase58(), amount: String(LAMPORTS_PER_SOL / 2) }];
        await send([seller], ...offers.buildCommitIxs({ offer: first_bid.offer, counterparty: seller.publicKey, currency: 'SOL', side: 'buy', payouts, lens: [], lensThreshold: 0 }));

        // The lens member confirms at the holding's address and the same transaction pays out.
        const confirm = async (target: { offer: PublicKey; cid: string }, sellerKey: PublicKey, buyerKey: PublicKey, holding: string, schedule = payouts) => {
            const chain = await offers.fetchPropertyOffer(connection, { address: target.offer });
            const payload = offers.encodeDecisionPayload({ cid: target.cid, offer: target.offer.toBase58(), termsHash: chain.termsHash, payoutsHash: chain.payoutsHash,
                buyer: buyerKey.toBase58(), seller: sellerKey.toBase58(), role: 0, assetHash, holding, observedAt: await chainNow() });
            const issued = statements.buildCreateAttestationIx({ payer: member.publicKey, authority: member.publicKey, kind: 'confirmation',
                nonce: offers.decisionNonce({ role: 0, assetHash, holding }), payload, expiry: (await chainNow()) + 86400 * 365 });
            return send([member], issued.instruction, offers.buildConfirmIx({ offer: target.offer, attestation: issued.attestation, credential: issued.credential }),
                ...offers.buildExecuteIxs({ offer: target.offer, currency: 'SOL', recipients: schedule.map(p => p.recipient), payer: member.publicKey }));
        };
        const before = await connection.getBalance(seller.publicKey);
        await confirm(first_bid, seller.publicKey, buyer.publicKey, view.holding);
        expect((await connection.getBalance(seller.publicKey)) - before).to.equal(LAMPORTS_PER_SOL / 2);
        view = await holders.viewOf({ member: member.publicKey.toBase58(), assetHash, getAccount, statements, offers });
        expect(view.holder).to.equal(buyer.publicKey.toBase58());
        expect(view.sales).to.have.length(1);

        // The seller tries to sell the same holding again to another buyer through the same lens member.
        const second_bid = await bid(other, LAMPORTS_PER_SOL / 4);
        const payouts2 = [{ recipient: seller.publicKey.toBase58(), amount: String(LAMPORTS_PER_SOL / 4) }];
        await send([seller], ...offers.buildCommitIxs({ offer: second_bid.offer, counterparty: seller.publicKey, currency: 'SOL', side: 'buy', payouts: payouts2, lens: [], lensThreshold: 0 }));
        let refused: unknown;
        try { await confirm(second_bid, seller.publicKey, other.publicKey, statements.holdingAddress(member.publicKey, assetHash).toBase58(), payouts2); } catch (error) { refused = error; }
        expect(String((refused as any)?.logs?.join('\n') || refused)).to.match(/already in use/);
        const stuck = await offers.fetchPropertyOffer(connection, { address: second_bid.offer });
        expect(stuck.status).to.equal('Committed');
        expect(stuck.buyerLens.met).to.equal(false);
    });
});
