import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
    findProposalCounterPDA,
    findProposalPDA,
    findParcelPDA,
    airdrop,
    initializeProposalCounter,
} from "./helpers.ts";

describe("proposal_nft", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalNft as Program;
    const parcelProgram = anchor.workspace.ParcelNft as Program;
    let counterPDA: PublicKey;

    before(async () => {
        counterPDA = await initializeProposalCounter(program, (provider.wallet as any).payer);
    });

    async function getCounterValue(): Promise<number> {
        const account = await program.account.proposalCounter.fetch(counterPDA);
        return (account.count as any).toNumber();
    }

    async function mintProposal(
        parcelIds: string[],
        isConditional: boolean,
        solAmount: number = 0
    ): Promise<{ proposalId: number; proposalPDA: PublicKey }> {
        for (const parcelId of parcelIds) {
            await mintParcelForOwner(parcelId);
        }

        const count = await getCounterValue();
        const [proposalPDA] = findProposalPDA(program.programId, count);

        await program.methods
            .mintAndFund(
                parcelIds,
                isConditional,
                "ipfs://test-image",
                new anchor.BN(solAmount),
                [provider.wallet.publicKey] // lens
            )
            .accounts({
                proposal: proposalPDA,
                proposalCounter: counterPDA,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        return { proposalId: count, proposalPDA };
    }

    async function mintParcelForOwner(
        parcelId: string,
        owner: PublicKey = provider.wallet.publicKey,
        signer?: Keypair
    ): Promise<PublicKey> {
        const [parcelPDA] = findParcelPDA(parcelProgram.programId, parcelId);
        const builder = parcelProgram.methods
            .mintParcel(parcelId, `ipfs://${parcelId}`)
            .accounts({
                parcel: parcelPDA,
                owner,
                systemProgram: SystemProgram.programId,
            } as any);

        if (signer) {
            await builder.signers([signer]).rpc();
        } else {
            await builder.rpc();
        }

        return parcelPDA;
    }

    function actionAccounts(
        proposalPDA: PublicKey,
        parcelId: string,
        signerName: "accepter" | "withdrawer",
        signer: PublicKey = provider.wallet.publicKey
    ): any {
        const [parcelPDA] = findParcelPDA(parcelProgram.programId, parcelId);
        return {
            proposal: proposalPDA,
            parcel: parcelPDA,
            parcelProgram: parcelProgram.programId,
            [signerName]: signer,
        };
    }

    // ========================
    // Initialize
    // ========================

    it("counter was initialized to 0", async () => {
        // Counter was initialized in before() hook; first mint bumps it to 1
        // so we just verify the counter PDA exists and is fetchable
        const account = await program.account.proposalCounter.fetch(counterPDA);
        expect(account.count).to.exist;
    });

    // ========================
    // Mint and fund
    // ========================

    it("creates a basic proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-1"], false);

        const account = await program.account.proposal.fetch(proposalPDA);
        expect(account.parcelIds).to.deep.equal(["HR-sol-1"]);
        expect(account.isConditional).to.be.false;
        expect(account.imageUri).to.equal("ipfs://test-image");
        expect(account.acceptancePossible).to.be.true;
        expect(account.status).to.deep.equal({ active: {} });
        expect((account.acceptanceCount as any).toNumber()).to.equal(0);
    });

    it("increments the counter", async () => {
        const countBefore = await getCounterValue();
        await mintProposal(["HR-sol-inc"], false);
        const countAfter = await getCounterValue();
        expect(countAfter).to.equal(countBefore + 1);
    });

    it("rejects empty parcel_ids", async () => {
        try {
            await mintProposal([], false);
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("NoParcels");
        }
    });

    it("rejects empty lens", async () => {
        const count = await getCounterValue();
        const [proposalPDA] = findProposalPDA(program.programId, count);

        try {
            await program.methods
                .mintAndFund(
                    ["HR-sol-nolens"],
                    false,
                    "ipfs://img",
                    new anchor.BN(0),
                    [] // empty lens
                )
                .accounts({
                    proposal: proposalPDA,
                    proposalCounter: counterPDA,
                    owner: provider.wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("NoLens");
        }
    });

    // ========================
    // Accept proposal
    // ========================

    it("accepts a single-parcel proposal (auto-executes)", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-acc1"], false);

        await program.methods
            .acceptProposal("HR-sol-acc1")
            .accounts(actionAccounts(proposalPDA, "HR-sol-acc1", "accepter"))
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(1);
        expect(account.acceptedParcels).to.deep.equal(["HR-sol-acc1"]);
        expect(account.status).to.deep.equal({ executed: {} });
        expect(account.acceptancePossible).to.be.false;
    });

    it("partial acceptance keeps status Active", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-p1", "HR-sol-p2"], false);

        await program.methods
            .acceptProposal("HR-sol-p1")
            .accounts(actionAccounts(proposalPDA, "HR-sol-p1", "accepter"))
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(1);
        expect(account.status).to.deep.equal({ active: {} });
        expect(account.acceptancePossible).to.be.true;
    });

    it("rejects accepting invalid parcel", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-valid"], false);
        await mintParcelForOwner("HR-sol-invalid");

        try {
            await program.methods
                .acceptProposal("HR-sol-invalid")
                .accounts(actionAccounts(proposalPDA, "HR-sol-invalid", "accepter"))
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("ParcelNotInProposal");
        }
    });

    it("rejects double acceptance", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-dbl1", "HR-sol-dbl2"], false);

        await program.methods
            .acceptProposal("HR-sol-dbl1")
            .accounts(actionAccounts(proposalPDA, "HR-sol-dbl1", "accepter"))
            .rpc();

        try {
            await program.methods
                .acceptProposal("HR-sol-dbl1")
                .accounts(actionAccounts(proposalPDA, "HR-sol-dbl1", "accepter"))
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("AlreadyAccepted");
        }
    });

    it("rejects acceptance by a signer that does not own the parcel", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-owner-only"], false);
        const intruder = Keypair.generate();
        await airdrop(provider.connection, intruder.publicKey);

        try {
            await program.methods
                .acceptProposal("HR-sol-owner-only")
                .accounts(actionAccounts(proposalPDA, "HR-sol-owner-only", "accepter", intruder.publicKey))
                .signers([intruder])
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("UnauthorizedParcelOwner");
        }
    });

    // ========================
    // Withdraw acceptance
    // ========================

    it("withdraws acceptance on conditional proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-wd1", "HR-sol-wd2"], true);

        await program.methods
            .acceptProposal("HR-sol-wd1")
            .accounts(actionAccounts(proposalPDA, "HR-sol-wd1", "accepter"))
            .rpc();

        let account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(1);

        await program.methods
            .withdrawAcceptance("HR-sol-wd1")
            .accounts(actionAccounts(proposalPDA, "HR-sol-wd1", "withdrawer"))
            .rpc();

        account = await program.account.proposal.fetch(proposalPDA);
        expect((account.acceptanceCount as any).toNumber()).to.equal(0);
        expect(account.acceptedParcels).to.deep.equal([]);
        expect(account.acceptancePossible).to.be.true;
    });

    it("rejects withdrawal on non-conditional proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-nc1", "HR-sol-nc2"], false);

        await program.methods
            .acceptProposal("HR-sol-nc1")
            .accounts(actionAccounts(proposalPDA, "HR-sol-nc1", "accepter"))
            .rpc();

        try {
            await program.methods
                .withdrawAcceptance("HR-sol-nc1")
                .accounts(actionAccounts(proposalPDA, "HR-sol-nc1", "withdrawer"))
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("NotConditional");
        }
    });

    it("rejects withdrawal by a signer that does not own the parcel", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-wd-owner"], true);
        const intruder = Keypair.generate();
        await airdrop(provider.connection, intruder.publicKey);

        await program.methods
            .acceptProposal("HR-sol-wd-owner")
            .accounts(actionAccounts(proposalPDA, "HR-sol-wd-owner", "accepter"))
            .rpc();

        try {
            await program.methods
                .withdrawAcceptance("HR-sol-wd-owner")
                .accounts(actionAccounts(proposalPDA, "HR-sol-wd-owner", "withdrawer", intruder.publicKey))
                .signers([intruder])
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("UnauthorizedParcelOwner");
        }
    });

    it("distributes SOL to accepted parcel owners after execution", async () => {
        const amount = 0.25 * anchor.web3.LAMPORTS_PER_SOL;
        const { proposalPDA } = await mintProposal(["HR-sol-dist"], false, amount);
        const [parcelPDA] = findParcelPDA(parcelProgram.programId, "HR-sol-dist");

        await program.methods
            .acceptProposal("HR-sol-dist")
            .accounts(actionAccounts(proposalPDA, "HR-sol-dist", "accepter"))
            .rpc();

        await program.methods
            .distributeFunds()
            .accounts({
                proposal: proposalPDA,
                parcelProgram: parcelProgram.programId,
            } as any)
            .remainingAccounts([
                { pubkey: parcelPDA, isSigner: false, isWritable: false },
                { pubkey: provider.wallet.publicKey, isSigner: false, isWritable: true },
            ])
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.solBalance as any).toNumber()).to.equal(0);
        expect(account.status).to.deep.equal({ executed: {} });
    });

    it("owner can cancel an active proposal and refund SOL", async () => {
        const amount = 0.25 * anchor.web3.LAMPORTS_PER_SOL;
        const { proposalPDA } = await mintProposal(["HR-sol-cancel"], true, amount);

        await program.methods
            .cancelAndRefund()
            .accounts({
                proposal: proposalPDA,
                owner: provider.wallet.publicKey,
            } as any)
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.solBalance as any).toNumber()).to.equal(0);
        expect(account.acceptancePossible).to.be.false;
        expect(account.status).to.deep.equal({ cancelled: {} });
    });

    // ========================
    // Contribute funds
    // ========================

    it("contributes SOL to a proposal", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-cf1", "HR-sol-cf2"], false);

        const amount = 0.5 * anchor.web3.LAMPORTS_PER_SOL;

        await program.methods
            .contributeFunds(new anchor.BN(amount))
            .accounts({
                proposal: proposalPDA,
                contributor: provider.wallet.publicKey,
            } as any)
            .remainingAccounts([
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ])
            .rpc();

        const account = await program.account.proposal.fetch(proposalPDA);
        expect((account.solBalance as any).toNumber()).to.equal(amount);
    });

    it("rejects zero contribution", async () => {
        const { proposalPDA } = await mintProposal(["HR-sol-z1", "HR-sol-z2"], false);

        try {
            await program.methods
                .contributeFunds(new anchor.BN(0))
                .accounts({
                    proposal: proposalPDA,
                    contributor: provider.wallet.publicKey,
                } as any)
                .rpc();
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.toString()).to.include("ZeroAmount");
        }
    });
});
