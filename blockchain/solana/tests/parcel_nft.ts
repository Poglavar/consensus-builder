// Localnet suite for parcel_nft v2: parcels are ownerless anchors (lens-model.md). Anyone pays to
// create one, nobody owns it, and there is no metadata update instruction any more.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { findParcelPDA, airdrop } from "./helpers.ts";
import { waitForProgramsVisible } from "./sas-mock.ts";

describe("parcel_nft", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ParcelNft as Program;

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
        expect(program.idl.instructions.map(ix => camel(ix.name))).to.deep.equal(["mintParcel"]);
    });
});
