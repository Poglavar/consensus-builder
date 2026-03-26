import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { findParcelPDA, airdrop } from "./helpers";

describe("parcel_nft", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ParcelNft as Program;

    it("mints a parcel successfully", async () => {
        const parcelId = "HR-test-mint-1";
        const metadataUri = "ipfs://test-metadata-1";
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        await program.methods
            .mintParcel(parcelId, metadataUri)
            .accounts({
                parcel: parcelPDA,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        const account = await program.account.parcel.fetch(parcelPDA);
        expect(account.parcelId).to.equal(parcelId);
        expect(account.metadataUri).to.equal(metadataUri);
        expect(account.owner.toString()).to.equal(provider.wallet.publicKey.toString());
    });

    it("prevents duplicate parcel minting", async () => {
        const parcelId = "HR-test-dup";
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        await program.methods
            .mintParcel(parcelId, "ipfs://meta")
            .accounts({
                parcel: parcelPDA,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        try {
            await program.methods
                .mintParcel(parcelId, "ipfs://meta-2")
                .accounts({
                    parcel: parcelPDA,
                    owner: provider.wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            // PDA already initialized — Anchor throws constraint error
            expect(err.toString()).to.include("already in use");
        }
    });

    it("rejects empty parcel_id", async () => {
        const parcelId = "";
        // PDA with empty seed still works but program validates
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        try {
            await program.methods
                .mintParcel(parcelId, "ipfs://meta")
                .accounts({
                    parcel: parcelPDA,
                    owner: provider.wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("InvalidParcelId");
        }
    });

    it("rejects empty metadata_uri", async () => {
        const parcelId = "HR-no-meta";
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        try {
            await program.methods
                .mintParcel(parcelId, "")
                .accounts({
                    parcel: parcelPDA,
                    owner: provider.wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("InvalidMetadataUri");
        }
    });

    it("owner can update metadata URI", async () => {
        const parcelId = "HR-update-meta";
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        await program.methods
            .mintParcel(parcelId, "ipfs://old")
            .accounts({
                parcel: parcelPDA,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        await program.methods
            .setParcelMetadataUri("ipfs://new")
            .accounts({
                parcel: parcelPDA,
                owner: provider.wallet.publicKey,
            } as any)
            .rpc();

        const account = await program.account.parcel.fetch(parcelPDA);
        expect(account.metadataUri).to.equal("ipfs://new");
    });

    it("non-owner cannot update metadata URI", async () => {
        const parcelId = "HR-non-owner";
        const [parcelPDA] = findParcelPDA(program.programId, parcelId);

        await program.methods
            .mintParcel(parcelId, "ipfs://owned")
            .accounts({
                parcel: parcelPDA,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        const intruder = Keypair.generate();
        await airdrop(provider.connection, intruder.publicKey);

        try {
            await program.methods
                .setParcelMetadataUri("ipfs://hacked")
                .accounts({
                    parcel: parcelPDA,
                    owner: intruder.publicKey,
                } as any)
                .signers([intruder])
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            // has_one constraint fails
            expect(err.toString()).to.include("ConstraintHasOne");
        }
    });
});
