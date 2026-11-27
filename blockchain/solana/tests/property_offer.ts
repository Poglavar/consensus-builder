// Local-validator lifecycle of property_offer v2: each side names its lens, the buyer's money is
// escrowed when the buyer acts, the offer waits for its lens members' PropertyOfferConfirmation-v1
// confirmations, then pays the schedule in SOL or devnet USDC; cancel and expiry refund the buyer.
// The mock SAS genesis program and the local USDC mint are configured in Anchor.toml.
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { expect } from 'chai';
import { attestationBytes, borshBytes, chainNow, createLensMember, LensMember, schemaPda, waitForProgramsVisible, writeSasAccount } from './sas-mock.ts';
import { waitForChainTime } from './agreement-helpers.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const payoutHash = (payouts: { recipient: PublicKey; amount: number }[]) => hash(Buffer.concat(payouts.map(p => {
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(p.amount)); return Buffer.concat([p.recipient.toBuffer(), amount]);
})));
const cid = () => `bafkrei${randomBytes(24).toString('hex').slice(0, 48)}`;
const fixtureDir = path.join(__dirname, 'fixtures');
const fixtures = JSON.parse(readFileSync(path.join(fixtureDir, 'pledge-fixtures.json'), 'utf8'));
const usdcAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(fixtureDir, 'local-usdc-mint-authority.keypair.json'), 'utf8'))));
const USDC = new PublicKey(fixtures.usdcMint);
const errorCode = (error: unknown) => String((error as any)?.error?.errorCode?.code || error);

describe('property_offer v2 lifecycle', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
    const program = anchor.workspace.PropertyOffer as Program;
    const connection = provider.connection;
    const payer = (provider.wallet as any).payer as Keypair;
    const NONE = program.programId; // Anchor's placeholder for an absent optional account

    async function wallet(sol = 2) {
        const kp = Keypair.generate();
        await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: sol * anchor.web3.LAMPORTS_PER_SOL })));
        return kp;
    }
    const offerPda = (maker: PublicKey, offerCid: string) => PublicKey.findProgramAddressSync([Buffer.from('property-offer'), maker.toBuffer(), hash(Buffer.from(offerCid))], program.programId)[0];

    /** A lens member's PropertyOfferConfirmation-v1, at an address derived from the asset and holding. */
    async function confirmAs(member: LensMember, offer: PublicKey, o: { cid: string; terms: Buffer; payouts: { recipient: PublicKey; amount: number }[]; buyer: PublicKey; seller: PublicKey }, role: 0 | 1, version = 1) {
        const payload = Buffer.concat([borshBytes(o.cid), borshBytes(offer.toBase58()), borshBytes(o.terms.toString('hex')), borshBytes(payoutHash(o.payouts).toString('hex')),
            borshBytes(o.buyer.toBase58()), borshBytes(o.seller.toBase58()), Buffer.from([role]), borshBytes(hash(Buffer.from('["parcel/v1","test-source","P-1"]')).toString('hex')),
            borshBytes(role === 0 ? 'first-holding' : ''), i64((await chainNow(connection)) - 1)]);
        const attestation = await writeSasAccount(provider, attestationBytes({ credential: member.credential, schema: schemaPda(member.credential, version === 1 ? 'PropertyOfferConfirmation' : 'PropertyOfferDecision', version), payload, authority: member.publicKey }));
        return program.methods.confirm().accountsStrict({ offer, attestation, credential: member.credential }).rpc();
    }

    before(async () => { await waitForProgramsVisible(connection); });

    it('sells for SOL once the buyer’s and the seller’s lenses confirm, and pays the schedule atomically', async () => {
        const seller = await wallet(); const buyer = await wallet(); const outsider = await createLensMember(provider);
        const recipients = [seller.publicKey, (await wallet(0.01)).publicKey];
        const payouts = [{ recipient: recipients[0], amount: 600_000 }, { recipient: recipients[1], amount: 300_000 }];
        const price = 900_000; const offerCid = cid(); const terms = hash(Buffer.from(offerCid));
        const [b1, b2, s1] = [await createLensMember(provider), await createLensMember(provider), await createLensMember(provider)];
        const offer = offerPda(seller.publicKey, offerCid);
        const deadline = (await chainNow(connection)) + 300;
        await program.methods.create(offerCid, { sell: {} }, Array.from(terms), new anchor.BN(price), new anchor.BN(deadline), payouts.map(p => ({ recipient: p.recipient, amount: new anchor.BN(p.amount) })), [s1.publicKey], 1)
            .accountsStrict({ offer, maker: seller.publicKey, mint: NONE, makerTokens: NONE, vault: NONE, tokenProgram: NONE, systemProgram: SystemProgram.programId }).signers([seller]).rpc();
        let selfDeal: unknown;
        try { await program.methods.commit([], [b1.publicKey], 1).accountsStrict({ offer, counterparty: seller.publicKey, counterpartyTokens: NONE, vault: NONE, tokenProgram: NONE, systemProgram: SystemProgram.programId }).signers([seller]).rpc(); } catch (e) { selfDeal = e; }
        expect(errorCode(selfDeal)).to.contain('SelfDeal');
        const before = await connection.getBalance(offer);
        await program.methods.commit([], [b1.publicKey, b2.publicKey], 2).accountsStrict({ offer, counterparty: buyer.publicKey, counterpartyTokens: NONE, vault: NONE, tokenProgram: NONE, systemProgram: SystemProgram.programId }).signers([buyer]).rpc();
        expect((await connection.getBalance(offer)) - before).to.equal(price);
        const o = { cid: offerCid, terms, payouts, buyer: buyer.publicKey, seller: seller.publicKey };
        const execute = () => program.methods.execute().accountsStrict({ offer, vault: NONE, tokenProgram: NONE }).remainingAccounts(recipients.map(pubkey => ({ pubkey, isSigner: false, isWritable: true }))).rpc();
        let early: unknown; try { await execute(); } catch (e) { early = e; }
        expect(errorCode(early)).to.contain('LensNotMet');
        let outsiderError: unknown; try { await confirmAs(outsider, offer, o, 0); } catch (e) { outsiderError = e; }
        expect(errorCode(outsiderError)).to.contain('NotALensMember');
        let wrongRole: unknown; try { await confirmAs(b1, offer, o, 1); } catch (e) { wrongRole = e; }
        expect(errorCode(wrongRole)).to.contain('NotALensMember');
        let oldSchema: unknown; try { await confirmAs(b1, offer, o, 0, 2); } catch (e) { oldSchema = e; }
        expect(errorCode(oldSchema)).to.contain('WrongSchema');
        await confirmAs(b1, offer, o, 0);
        let twice: unknown; try { await confirmAs(b1, offer, o, 0); } catch (e) { twice = e; }
        expect(errorCode(twice)).to.contain('MemberAlreadyConfirmed');
        await confirmAs(b2, offer, o, 0);
        let sellerLensPending: unknown; try { await execute(); } catch (e) { sellerLensPending = e; }
        expect(errorCode(sellerLensPending)).to.contain('LensNotMet');
        await confirmAs(s1, offer, o, 1);
        const balances = await Promise.all(recipients.map(r => connection.getBalance(r)));
        await execute();
        const after = await Promise.all(recipients.map(r => connection.getBalance(r)));
        expect(after.map((b, i) => b - balances[i])).to.deep.equal([600_000, 300_000]);
        const account: any = await program.account.propertyOffer.fetch(offer);
        expect(Object.keys(account.status)[0]).to.equal('settled');
        expect(account.escrow.toNumber()).to.equal(0);
    });

    it('buys for USDC: the bid is escrowed at once, the seller sets the schedule, the buyer’s lens settles it', async () => {
        const buyer = await wallet(); const seller = await wallet(); const b1 = await createLensMember(provider);
        const buyerUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC, buyer.publicKey)).address;
        await mintTo(connection, payer, USDC, buyerUsdc, usdcAuthority, 5_000_000);
        const offerCid = cid(); const terms = hash(Buffer.from(offerCid)); const price = 2_500_000;
        const offer = offerPda(buyer.publicKey, offerCid);
        const vault = getAssociatedTokenAddressSync(USDC, offer, true);
        const deadline = (await chainNow(connection)) + 300;
        const createIx = await program.methods.create(offerCid, { buy: {} }, Array.from(terms), new anchor.BN(price), new anchor.BN(deadline), [], [b1.publicKey], 1)
            .accountsStrict({ offer, maker: buyer.publicKey, mint: USDC, makerTokens: buyerUsdc, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
        await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, vault, offer, USDC), createIx), [buyer]);
        expect(Number((await getAccount(connection, vault)).amount)).to.equal(price);
        const payouts = [{ recipient: seller.publicKey, amount: price }];
        await program.methods.commit(payouts.map(p => ({ recipient: p.recipient, amount: new anchor.BN(p.amount) })), [], 0)
            .accountsStrict({ offer, counterparty: seller.publicKey, counterpartyTokens: NONE, vault: NONE, tokenProgram: NONE, systemProgram: SystemProgram.programId }).signers([seller]).rpc();
        await confirmAs(b1, offer, { cid: offerCid, terms, payouts, buyer: buyer.publicKey, seller: seller.publicKey }, 0);
        const sellerUsdc = getAssociatedTokenAddressSync(USDC, seller.publicKey);
        const executeIx = await program.methods.execute().accountsStrict({ offer, vault, tokenProgram: TOKEN_PROGRAM_ID }).remainingAccounts([{ pubkey: sellerUsdc, isSigner: false, isWritable: true }]).instruction();
        await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, sellerUsdc, seller.publicKey, USDC), executeIx));
        expect(Number((await getAccount(connection, sellerUsdc)).amount)).to.equal(price);
        expect(Number((await getAccount(connection, vault)).amount)).to.equal(0);
    });

    it('cancels an open USDC bid and expires an unconfirmed SOL sale, refunding the buyer each time', async () => {
        const buyer = await wallet(); const seller = await wallet(); const b1 = await createLensMember(provider);
        const buyerUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC, buyer.publicKey)).address;
        await mintTo(connection, payer, USDC, buyerUsdc, usdcAuthority, 1_000_000);
        const bidCid = cid(); const bid = offerPda(buyer.publicKey, bidCid); const vault = getAssociatedTokenAddressSync(USDC, bid, true);
        const createIx = await program.methods.create(bidCid, { buy: {} }, Array.from(hash(Buffer.from(bidCid))), new anchor.BN(1_000_000), new anchor.BN((await chainNow(connection)) + 300), [], [b1.publicKey], 1)
            .accountsStrict({ offer: bid, maker: buyer.publicKey, mint: USDC, makerTokens: buyerUsdc, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
        await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, vault, bid, USDC), createIx), [buyer]);
        expect(Number((await getAccount(connection, buyerUsdc)).amount)).to.equal(0);
        await program.methods.cancel().accountsStrict({ offer: bid, maker: buyer.publicKey, vault, refundTokens: buyerUsdc, tokenProgram: TOKEN_PROGRAM_ID }).signers([buyer]).rpc();
        expect(Number((await getAccount(connection, buyerUsdc)).amount)).to.equal(1_000_000);

        const saleCid = cid(); const sale = offerPda(seller.publicKey, saleCid); const deadline = (await chainNow(connection)) + 4;
        await program.methods.create(saleCid, { sell: {} }, Array.from(hash(Buffer.from(saleCid))), new anchor.BN(700_000), new anchor.BN(deadline), [{ recipient: seller.publicKey, amount: new anchor.BN(700_000) }], [], 0)
            .accountsStrict({ offer: sale, maker: seller.publicKey, mint: NONE, makerTokens: NONE, vault: NONE, tokenProgram: NONE, systemProgram: SystemProgram.programId }).signers([seller]).rpc();
        await program.methods.commit([], [b1.publicKey], 1).accountsStrict({ offer: sale, counterparty: buyer.publicKey, counterpartyTokens: NONE, vault: NONE, tokenProgram: NONE, systemProgram: SystemProgram.programId }).signers([buyer]).rpc();
        const expire = (refundTo: PublicKey) => program.methods.expire().accountsStrict({ offer: sale, refundTo, vault: NONE, tokenProgram: NONE }).rpc();
        let early: unknown; try { await expire(buyer.publicKey); } catch (e) { early = e; }
        expect(errorCode(early)).to.contain('DeadlineNotPassed');
        await waitForChainTime(connection, deadline + 1);
        let wrongRefund: unknown; try { await expire(seller.publicKey); } catch (e) { wrongRefund = e; }
        expect(errorCode(wrongRefund)).to.contain('WrongRecipient');
        const before = await connection.getBalance(buyer.publicKey);
        await expire(buyer.publicKey);
        expect((await connection.getBalance(buyer.publicKey)) - before).to.equal(700_000);
    });
});
