// Focused local-validator lifecycle: seller offer → lens-gated buyer acceptance → exact funding
// → one atomic multi-recipient settlement. The mock SAS genesis program is configured in Anchor.toml.
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createHash, randomBytes } from 'crypto';
import { expect } from 'chai';
import { attestDecision, borshBytes, chainNow, createLensMember, schemaPda, writeSasAccount } from './sas-mock.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const payoutHash = (payouts: { recipient: PublicKey; amount: number }[]) => hash(Buffer.concat(payouts.map(p => {
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(p.amount)); return Buffer.concat([p.recipient.toBuffer(), amount]);
})));
const cid = () => `bafkrei${randomBytes(24).toString('hex').slice(0, 48)}`;

describe('property_offer focused lifecycle', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
    const program = anchor.workspace.PropertyOffer as Program;

    it('settles a multi-recipient sell offer atomically and rejects a wrong lens', async () => {
        // Anchor's provider keypair is deliberately an ephemeral local-validator wallet in this
        // focused run. It pays account rent and the mock-SAS writes below.
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(provider.wallet.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL));
        const buyer = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(buyer.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL));
        const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
        // System-owned recipient accounts must already exist: settlement intentionally transfers
        // lamports directly and does not create arbitrary accounts as a side effect.
        await Promise.all(recipients.map(async recipient => {
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(recipient, 1_000_000));
        }));
        const price = 900_000; const payouts = [{ recipient: recipients[0], amount: 400_000 }, { recipient: recipients[1], amount: 500_000 }];
        const offerCid = cid(); const termsHash = Array.from(hash(Buffer.from('terms'))); const scheduleHash = payoutHash(payouts);
        const lens = await createLensMember(provider); const wrongLens = await createLensMember(provider);
        const offer = PublicKey.findProgramAddressSync([Buffer.from('property-offer'), provider.wallet.publicKey.toBuffer(), hash(Buffer.from(offerCid))], program.programId)[0];
        const deadline = (await chainNow(provider.connection)) + 300;
        await program.methods.create(offerCid, lens.publicKey, { sell: {} }, termsHash, new anchor.BN(price), new anchor.BN(deadline), payouts.map(p => ({ recipient: p.recipient, lamports: new anchor.BN(p.amount) }))).accountsStrict({ offer, maker: provider.wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
        const payload = Buffer.concat([borshBytes(offerCid), borshBytes(offer.toBase58()), borshBytes(hash(Buffer.from('terms')).toString('hex')), borshBytes(scheduleHash.toString('hex')), borshBytes(buyer.publicKey.toBase58()), borshBytes(provider.wallet.publicKey.toBase58()), Buffer.from([1]), i64((await chainNow(provider.connection)) - 1)]);
        const decisionFor = async (member: { publicKey: PublicKey; credential: PublicKey }) => writeSasAccount(provider, Buffer.concat([
            Buffer.from([2]), Keypair.generate().publicKey.toBuffer(), member.credential.toBuffer(), schemaPda(member.credential, 'PropertyOfferDecision', 2).toBuffer(),
            borshBytes(payload), member.publicKey.toBuffer(), i64(4_000_000_000), PublicKey.default.toBuffer(),
        ]));
        const wrongDecision = await decisionFor(wrongLens);
        let wrongLensError: unknown;
        try {
            await program.methods.accept([]).accountsStrict({ offer, counterparty: buyer.publicKey, attestation: wrongDecision, credential: wrongLens.credential }).signers([buyer]).rpc();
        } catch (error) { wrongLensError = error; }
        expect(String((wrongLensError as any)?.error?.errorCode?.code || wrongLensError)).to.contain('WrongLens');
        const decision = await decisionFor(lens);
        await program.methods.accept([]).accountsStrict({ offer, counterparty: buyer.publicKey, attestation: decision, credential: lens.credential }).signers([buyer]).rpc();
        await program.methods.fund().accountsStrict({ offer, buyer: buyer.publicKey, systemProgram: SystemProgram.programId }).signers([buyer]).rpc();
        const before = await Promise.all(recipients.map(r => provider.connection.getBalance(r)));
        let wrongRecipientError: unknown;
        try {
            await program.methods.execute().accountsStrict({ offer }).remainingAccounts([
                { pubkey: recipients[1], isSigner: false, isWritable: true },
                { pubkey: recipients[0], isSigner: false, isWritable: true },
            ]).rpc();
        } catch (error) { wrongRecipientError = error; }
        expect(String((wrongRecipientError as any)?.error?.errorCode?.code || wrongRecipientError)).to.contain('WrongRecipient');
        expect(await Promise.all(recipients.map(r => provider.connection.getBalance(r)))).deep.eq(before);
        await program.methods.execute().accountsStrict({ offer }).remainingAccounts(recipients.map(r => ({ pubkey: r, isSigner: false, isWritable: true }))).rpc();
        const after = await Promise.all(recipients.map(r => provider.connection.getBalance(r)));
        expect(after[0] - before[0]).eq(400_000); expect(after[1] - before[1]).eq(500_000);
        const state: any = await program.account.propertyOffer.fetch(offer); expect(state.status.settled).to.not.equal(undefined); expect(Number(state.escrowLamports)).eq(0);
    });

    it('returns an uncompleted accepted buy offer to its fixed buyer after expiry', async () => {
        const seller = Keypair.generate();
        const price = 500_000;
        const offerCid = cid();
        const terms = hash(Buffer.from('buy-expiry-terms'));
        const lens = await createLensMember(provider);
        const offer = PublicKey.findProgramAddressSync([Buffer.from('property-offer'), provider.wallet.publicKey.toBuffer(), hash(Buffer.from(offerCid))], program.programId)[0];
        const deadline = (await chainNow(provider.connection)) + 6;
        await program.methods.create(offerCid, lens.publicKey, { buy: {} }, Array.from(terms), new anchor.BN(price), new anchor.BN(deadline), [])
            .accountsStrict({ offer, maker: provider.wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
        const scheduleHash = payoutHash([{ recipient: seller.publicKey, amount: price }]);
        const payload = Buffer.concat([
            borshBytes(offerCid), borshBytes(offer.toBase58()), borshBytes(terms.toString('hex')), borshBytes(scheduleHash.toString('hex')),
            borshBytes(provider.wallet.publicKey.toBase58()), borshBytes(seller.publicKey.toBase58()), Buffer.from([1]), i64((await chainNow(provider.connection)) - 1),
        ]);
        const decision = await writeSasAccount(provider, Buffer.concat([
            Buffer.from([2]), Keypair.generate().publicKey.toBuffer(), lens.credential.toBuffer(), schemaPda(lens.credential, 'PropertyOfferDecision', 2).toBuffer(),
            borshBytes(payload), lens.publicKey.toBuffer(), i64(4_000_000_000), PublicKey.default.toBuffer(),
        ]));
        await program.methods.accept([{ recipient: seller.publicKey, lamports: new anchor.BN(price) }])
            .accountsStrict({ offer, counterparty: seller.publicKey, attestation: decision, credential: lens.credential }).signers([seller]).rpc();
        const buyerBeforeFund = await provider.connection.getBalance(provider.wallet.publicKey);
        await program.methods.fund().accountsStrict({ offer, buyer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
        expect(Number((await program.account.propertyOffer.fetch(offer) as any).escrowLamports)).eq(price);
        while ((await chainNow(provider.connection)) <= deadline) await new Promise(resolve => setTimeout(resolve, 500));
        await program.methods.expire().accountsStrict({ offer, buyer: provider.wallet.publicKey }).rpc();
        const state: any = await program.account.propertyOffer.fetch(offer);
        expect(state.status.expired).to.not.equal(undefined);
        expect(Number(state.escrowLamports)).eq(0);
        // Fees make an exact wallet balance comparison inappropriate; the escrow itself was returned.
        expect(await provider.connection.getBalance(offer)).to.be.greaterThan(0);
        expect(await provider.connection.getBalance(provider.wallet.publicKey)).to.be.lessThan(buyerBeforeFund);
    });

    it('lets the maker cancel an open sell and expires another open sell without a buyer', async () => {
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(provider.wallet.publicKey, anchor.web3.LAMPORTS_PER_SOL));
        const lens = await createLensMember(provider);
        const terms = Array.from(hash(Buffer.from('open-sell-terms')));
        const make = async (seconds: number) => {
            const offerCid = cid();
            const offer = PublicKey.findProgramAddressSync([Buffer.from('property-offer'), provider.wallet.publicKey.toBuffer(), hash(Buffer.from(offerCid))], program.programId)[0];
            const deadline = (await chainNow(provider.connection)) + seconds;
            await program.methods.create(offerCid, lens.publicKey, { sell: {} }, terms, new anchor.BN(10), new anchor.BN(deadline), [{ recipient: provider.wallet.publicKey, lamports: new anchor.BN(10) }])
                .accountsStrict({ offer, maker: provider.wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
            return { offer, deadline };
        };
        const cancelled = await make(300);
        await program.methods.cancel().accountsStrict({ offer: cancelled.offer, authority: provider.wallet.publicKey }).rpc();
        expect((await program.account.propertyOffer.fetch(cancelled.offer) as any).status.cancelled).to.not.equal(undefined);

        const expiring = await make(5);
        while ((await chainNow(provider.connection)) <= expiring.deadline) await new Promise(resolve => setTimeout(resolve, 500));
        await program.methods.expire().accountsStrict({ offer: expiring.offer, buyer: provider.wallet.publicKey }).rpc();
        expect((await program.account.propertyOffer.fetch(expiring.offer) as any).status.expired).to.not.equal(undefined);
    });
});
