// Localnet suite for parcel_nft v2: parcels are ownerless anchors (lens-model.md). Anyone pays to
// create one, nobody owns it, and there is no metadata update instruction any more.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { findParcelPDA, airdrop } from "./helpers.ts";
import { waitForProgramsVisible } from "./sas-mock.ts";
import { createHash } from "node:crypto";

describe("parcel_nft", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ParcelNft as Program;
    const offerProgram = anchor.workspace.PropertyOffer as Program;

    // First suite mocha runs: the genesis-loaded programs only become callable after slot 1.
    before(() => waitForProgramsVisible(provider.connection));

    function mint(parcelId: string, metadataUri: string, payer?: Keypair) {
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);
        const builder = program.methods
            .mintParcel(parcelId, metadataUri)
            .accountsStrict({
                parcel: parcelPDA,
                payer: payer?.publicKey ?? provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            });
        return payer ? builder.signers([payer]).rpc() : builder.rpc();
    }

    function apartmentHash(label: string): number[] {
        return [...createHash("sha256").update(JSON.stringify(["apartment/v1", "xray-" + label, "unit-1"])).digest()];
    }

    function mintApartment(identityHash: number[], payer: Keypair) {
        const [apartment] = PublicKey.findProgramAddressSync([Buffer.from("apartment"), Buffer.from(identityHash)], program.programId);
        const builder = program.methods.mintApartment(identityHash).accountsStrict({
            apartment, payer: payer.publicKey, systemProgram: SystemProgram.programId,
        }).signers([payer]);
        return { apartment, promise: builder.rpc() };
    }

    it("mints an ownerless parcel anchor", async () => {
        const parcelId = "HR-test-mint-1";
        const metadataUri = "https://api.urbangametheory.xyz/parcels/parcelIds?ids=HR-test-mint-1";
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        await mint(parcelId, metadataUri);

        const account = await program.account.parcel.fetch(parcelPDA);
        expect(account.parcelId).to.equal(parcelId);
        expect(account.metadataUri).to.equal(metadataUri);
        expect(account.owner.toBase58()).to.equal(PublicKey.default.toBase58());
    });

    it("lets any wallet pay for an anchor without becoming its owner", async () => {
        const payer = Keypair.generate();
        await airdrop(provider.connection, payer.publicKey, anchor.web3.LAMPORTS_PER_SOL);
        const parcelId = "HR-test-mint-payer";
        await mint(parcelId, "ipfs://meta", payer);

        const account = await program.account.parcel.fetch(findParcelPDA(program.programId, parcelId)[0]);
        expect(account.owner.toBase58()).to.equal(PublicKey.default.toBase58());
        expect(await provider.connection.getBalance(payer.publicKey)).to.be.below(anchor.web3.LAMPORTS_PER_SOL);
    });

    it("prevents duplicate parcel minting", async () => {
        const parcelId = "HR-test-dup";
        await mint(parcelId, "ipfs://meta");

        try {
            await mint(parcelId, "ipfs://meta-2");
            expect.fail("should have thrown");
        } catch (err: any) {
            // PDA already initialized — Anchor throws constraint error
            expect(err.toString()).to.include("already in use");
        }
    });

    it("rejects empty parcel_id", async () => {
        try {
            await mint("", "ipfs://meta");
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("InvalidParcelId");
        }
    });

    it("rejects empty metadata_uri", async () => {
        try {
            await mint("HR-no-meta", "");
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("InvalidMetadataUri");
        }
    });

    it("has no metadata update instruction", () => {
        const camel = (name: string) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        expect(program.idl.instructions.map(ix => camel(ix.name))).to.have.members(["mintParcel", "mintApartment"]);
    });

    it("mints an idempotent ownerless apartment anchor for each identity hash", async () => {
        const first = Keypair.generate(); const second = Keypair.generate();
        await Promise.all([airdrop(provider.connection, first.publicKey, anchor.web3.LAMPORTS_PER_SOL), airdrop(provider.connection, second.publicKey, anchor.web3.LAMPORTS_PER_SOL)]);
        const hashA = apartmentHash("same"); const hashB = apartmentHash("other");
        const a1 = mintApartment(hashA, first); await a1.promise;
        const accountA = await program.account.apartmentAnchor.fetch(a1.apartment);
        expect([...accountA.identityHash]).to.deep.equal(hashA); expect(accountA.bump).to.be.a("number");
        const balanceBefore = await provider.connection.getBalance(second.publicKey);
        const a2 = mintApartment(hashA, second); await a2.promise;
        expect(a2.apartment.toBase58()).to.equal(a1.apartment.toBase58());
        const accountAgain = await program.account.apartmentAnchor.fetch(a1.apartment);
        expect([...accountAgain.identityHash]).to.deep.equal(hashA);
        expect(await provider.connection.getBalance(second.publicKey)).to.equal(balanceBefore);
        const b = mintApartment(hashB, second); await b.promise;
        expect(b.apartment.toBase58()).not.to.equal(a1.apartment.toBase58());
        expect((await program.account.apartmentAnchor.fetch(b.apartment)).identityHash).to.deep.equal(hashB);
    });

    it("anchors an apartment and creates a standalone offer atomically", async () => {
        const identityHash = apartmentHash("offer-asset");
        const payer = provider.wallet.publicKey;
        const [apartment] = PublicKey.findProgramAddressSync([Buffer.from("apartment"), Buffer.from(identityHash)], program.programId);
        const cid = `apartmentoffer${Date.now()}`;
        const [offer] = PublicKey.findProgramAddressSync([Buffer.from("property-offer"), payer.toBuffer(), createHash("sha256").update(cid).digest()], offerProgram.programId);
        const lens = Keypair.generate().publicKey;
        const termsHash = apartmentHash("offer-terms");
        const clock = await provider.connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
        const now = Number(clock!.data.readBigInt64LE(32));
        const anchorIx = await program.methods.mintApartment(identityHash).accountsStrict({ apartment, payer, systemProgram: SystemProgram.programId }).instruction();
        const offerIx = await offerProgram.methods.create(cid, lens, { buy: {} }, termsHash, new anchor.BN(1000), new anchor.BN(now + 600), [])
            .accountsStrict({ offer, maker: payer, systemProgram: SystemProgram.programId }).instruction();
        await provider.sendAndConfirm(new anchor.web3.Transaction().add(offerIx, anchorIx));
        const apartmentAccount: any = await program.account.apartmentAnchor.fetch(apartment);
        expect([...apartmentAccount.identityHash]).to.deep.equal(identityHash);
        expect(apartmentAccount.owner).to.equal(undefined);
        const offerAccount: any = await offerProgram.account.propertyOffer.fetch(offer);
        expect(offerAccount.cid).to.equal(cid);
        expect(offerAccount.maker.toBase58()).to.equal(payer.toBase58());
    });
});
