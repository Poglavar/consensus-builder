// Localnet suite for the proposal_pledge program: funded USDC donations (donate → release on
// Executed / refund on Cancelled or Expired) and soft pledges (set → revoke / fulfil / void), plus
// the signer, mint, re-init and account-substitution attacks each instruction must reject.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotent,
    createMint,
    getAccount,
    getAssociatedTokenAddressSync,
    mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { expect } from "chai";
import {
    findProposalCounterPDA,
    findProposalPDA,
    findParcelPDA,
    initializeProposalCounter,
} from "./helpers.ts";

const COMMITMENT_ACTIVE = 0;
const COMMITMENT_FULFILLED = 1;
const COMMITMENT_REVOKED = 2;
const COMMITMENT_VOIDED = 3;

/** Every funded party starts with 20 USDC (6 decimals); amounts below are in base units. */
const USDC_FUNDING = 20_000_000;

const fixtureDir = path.join(__dirname, "fixtures");
const fixtures = JSON.parse(readFileSync(path.join(fixtureDir, "pledge-fixtures.json"), "utf8"));
const loadKeypair = (name: string) =>
    Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(fixtureDir, `${name}.keypair.json`), "utf8"))));

describe("proposal_pledge", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ProposalPledge as Program;
    const proposalProgram = anchor.workspace.ProposalNft as Program;
    const parcelProgram = anchor.workspace.ParcelNft as Program;
    const connection = provider.connection;
    const payer = (provider.wallet as any).payer as Keypair;

    // The program pins the devnet USDC address; the localnet copy comes from tests/fixtures with a
    // test-only mint authority (Anchor.toml [[test.validator.account]]).
    const USDC = new PublicKey(fixtures.usdcMint);
    const usdcAuthority = loadKeypair("local-usdc-mint-authority");

    type Party = { kp: Keypair; pk: PublicKey; usdc: PublicKey; fake: PublicKey };
    type Prop = { proposal: PublicKey; parcelId: string };

    let counterPDA: PublicKey;
    let fakeMint: PublicKey;
    const creator = Keypair.generate(); // owns every proposal below, so it is the captured beneficiary
    let beneficiaryUsdc: PublicKey;
    let donorA: Party, donorB: Party, pledgerA: Party, pledgerB: Party, pledgerC: Party, attacker: Party;

    before(async () => {
        // Earlier files may already have initialized the shared proposal counter on this validator.
        const [counter] = findProposalCounterPDA(proposalProgram.programId);
        const existing = await proposalProgram.account.proposalCounter.fetchNullable(counter);
        counterPDA = existing ? counter : await initializeProposalCounter(proposalProgram, payer);

        const mintInfo = await connection.getParsedAccountInfo(USDC);
        expect((mintInfo.value?.data as any)?.parsed?.info?.mintAuthority,
            "devnet USDC fixture missing: run `anchor test` so Anchor.toml loads tests/fixtures").to.equal(usdcAuthority.publicKey.toBase58());

        fakeMint = await createMint(connection, payer, payer.publicKey, null, 6);
        const keypairs = Array.from({ length: 6 }, () => Keypair.generate());
        // One transfer tx instead of six airdrops: rent for init accounts is paid by these wallets.
        const fund = new Transaction();
        for (const kp of [creator, ...keypairs]) {
            fund.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: anchor.web3.LAMPORTS_PER_SOL }));
        }
        await provider.sendAndConfirm(fund);

        const party = async (kp: Keypair, funded = true): Promise<Party> => {
            const usdc = await createAssociatedTokenAccountIdempotent(connection, payer, USDC, kp.publicKey);
            const fake = await createAssociatedTokenAccountIdempotent(connection, payer, fakeMint, kp.publicKey);
            if (funded) {
                await mintTo(connection, payer, USDC, usdc, usdcAuthority, USDC_FUNDING);
                await mintTo(connection, payer, fakeMint, fake, payer, USDC_FUNDING);
            }
            return { kp, pk: kp.publicKey, usdc, fake };
        };
        [donorA, donorB, pledgerA, pledgerB, attacker] = await Promise.all(keypairs.slice(0, 5).map(kp => party(kp)));
        pledgerC = await party(keypairs[5], false); // pledges but never holds USDC
        beneficiaryUsdc = getAssociatedTokenAddressSync(USDC, creator.publicKey);
    });

    // ========================
    // PDAs and proposal lifecycle helpers
    // ========================

    const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
    const escrowOf = (proposal: PublicKey) => pda([Buffer.from("donation_escrow"), proposal.toBuffer()]);
    const vaultOf = (escrow: PublicKey) => getAssociatedTokenAddressSync(USDC, escrow, true);
    const positionOf = (escrow: PublicKey, donor: PublicKey, id: Buffer) =>
        pda([Buffer.from("donation"), escrow.toBuffer(), donor.toBuffer(), id]);
    const donorRecordOf = (escrow: PublicKey, donor: PublicKey) => pda([Buffer.from("donor"), escrow.toBuffer(), donor.toBuffer()]);
    const bookOf = (proposal: PublicKey) => pda([Buffer.from("pledge_book"), proposal.toBuffer()]);
    const commitmentOf = (book: PublicKey, owner: PublicKey) => pda([Buffer.from("pledge"), book.toBuffer(), owner.toBuffer()]);
    const donationId = (label: string) => createHash("sha256").update(`plg-${label}`).digest();

    async function newProposal(tag: string): Promise<Prop> {
        const parcelId = `HR-plg-${tag}`;
        await parcelProgram.methods
            .mintParcel(parcelId, `ipfs://${parcelId}`)
            .accounts({ parcel: findParcelPDA(parcelProgram.programId, parcelId)[0], owner: provider.wallet.publicKey, systemProgram: SystemProgram.programId } as any)
            .rpc();
        const count = (await proposalProgram.account.proposalCounter.fetch(counterPDA)).count as any;
        const [proposal] = findProposalPDA(proposalProgram.programId, count.toNumber());
        await proposalProgram.methods
            .mintAndFund([parcelId], false, "ipfs://pledge-test", new anchor.BN(0), [creator.publicKey])
            .accounts({ proposal, proposalCounter: counterPDA, owner: creator.publicKey, systemProgram: SystemProgram.programId } as any)
            .signers([creator])
            .rpc();
        return { proposal, parcelId };
    }

    /** The provider wallet owns the single parcel, so its acceptance executes the proposal. */
    async function execute(p: Prop) {
        await proposalProgram.methods
            .acceptProposal(p.parcelId)
            .accounts({
                proposal: p.proposal,
                parcel: findParcelPDA(parcelProgram.programId, p.parcelId)[0],
                parcelProgram: parcelProgram.programId,
                accepter: provider.wallet.publicKey,
            } as any)
            .rpc();
        expect((await proposalProgram.account.proposal.fetch(p.proposal)).status).to.deep.equal({ executed: {} });
    }

    async function cancel(p: Prop) {
        await proposalProgram.methods.cancelAndRefund()
            .accounts({ proposal: p.proposal, owner: creator.publicKey } as any)
            .signers([creator]).rpc();
        expect((await proposalProgram.account.proposal.fetch(p.proposal)).status).to.deep.equal({ cancelled: {} });
    }

    // ========================
    // Instruction builders (accountsStrict, so a substituted account is really what gets sent)
    // ========================

    function createEscrow(proposal: PublicKey, over: any = {}) {
        const escrow = escrowOf(proposal);
        return program.methods.createDonationEscrow().accountsStrict({
            escrow, proposal, mint: USDC, vault: vaultOf(escrow), creator: payer.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, ...over,
        } as any).rpc();
    }

    function donate(donor: Party, proposal: PublicKey, label: string, amount: number, over: any = {}) {
        const escrow = over.escrow ?? escrowOf(proposal);
        const id = donationId(label);
        return program.methods.donate(Array.from(id), new anchor.BN(amount)).accountsStrict({
            escrow, proposal, position: positionOf(escrow, donor.pk, id), donorRecord: donorRecordOf(escrow, donor.pk),
            vault: vaultOf(escrow), donorTokenAccount: donor.usdc, donor: donor.pk,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, ...over,
        } as any).signers([donor.kp]).rpc();
    }

    function release(proposal: PublicKey, releaser: Party, over: any = {}) {
        const escrow = over.escrow ?? escrowOf(proposal);
        const beneficiary: PublicKey = over.beneficiary ?? creator.publicKey;
        const mint: PublicKey = over.mint ?? USDC;
        return program.methods.releaseDonations().accountsStrict({
            escrow, proposal, mint, vault: vaultOf(escrow), beneficiary,
            beneficiaryTokenAccount: getAssociatedTokenAddressSync(mint, beneficiary),
            releaser: releaser.pk, tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, ...over,
        } as any).signers([releaser.kp]).rpc();
    }

    function refund(donor: Party, proposal: PublicKey, label: string, over: any = {}) {
        const escrow = over.escrow ?? escrowOf(proposal);
        return program.methods.refundDonation().accountsStrict({
            escrow, proposal, position: positionOf(escrow, donor.pk, donationId(label)), vault: vaultOf(escrow),
            donorTokenAccount: donor.usdc, donor: donor.pk, tokenProgram: TOKEN_PROGRAM_ID, ...over,
        } as any).signers([donor.kp]).rpc();
    }

    function createBook(proposal: PublicKey, over: any = {}) {
        return program.methods.createPledgeBook().accountsStrict({
            book: bookOf(proposal), proposal, mint: USDC, creator: payer.publicKey,
            systemProgram: SystemProgram.programId, ...over,
        } as any).rpc();
    }

    function setPledge(pledger: Party, proposal: PublicKey, amount: number, over: any = {}) {
        const book = over.book ?? bookOf(proposal);
        return program.methods.setPledge(new anchor.BN(amount)).accountsStrict({
            book, proposal, commitment: commitmentOf(book, pledger.pk), pledger: pledger.pk,
            systemProgram: SystemProgram.programId, ...over,
        } as any).signers([pledger.kp]).rpc();
    }

    function revoke(pledger: Party, proposal: PublicKey, over: any = {}) {
        const book = over.book ?? bookOf(proposal);
        return program.methods.revokePledge().accountsStrict({
            book, proposal, commitment: commitmentOf(book, pledger.pk), pledger: pledger.pk, ...over,
        } as any).signers([pledger.kp]).rpc();
    }

    function fulfill(pledger: Party, proposal: PublicKey, over: any = {}) {
        const book = over.book ?? bookOf(proposal);
        const beneficiary: PublicKey = over.beneficiary ?? creator.publicKey;
        const mint: PublicKey = over.mint ?? USDC;
        return program.methods.fulfillPledge().accountsStrict({
            book, proposal, commitment: commitmentOf(book, pledger.pk), mint,
            pledgerTokenAccount: pledger.usdc, beneficiary,
            beneficiaryTokenAccount: getAssociatedTokenAddressSync(mint, beneficiary),
            pledger: pledger.pk, tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, ...over,
        } as any).signers([pledger.kp]).rpc();
    }

    /** Permissionless: no signer beyond the fee payer. */
    function voidPledge(owner: PublicKey, proposal: PublicKey, over: any = {}) {
        const book = over.book ?? bookOf(proposal);
        return program.methods.voidPledge().accountsStrict({
            book, proposal, commitment: commitmentOf(book, owner), ...over,
        } as any).rpc();
    }

    // ========================
    // Assertion helpers
    // ========================

    async function balance(address: PublicKey): Promise<number> {
        return Number((await getAccount(connection, address)).amount);
    }
    const n = (bn: any) => (bn as anchor.BN).toNumber();

    /** Anchor puts the code on err.error.errorCode.code; a raw runtime failure only has logs. */
    function errorText(err: any): string {
        const logs = err?.logs ?? err?.transactionLogs ?? err?.error?.logs ?? [];
        return [err?.error?.errorCode?.code, err?.message, String(err), Array.isArray(logs) ? logs.join("\n") : ""]
            .filter(Boolean).join("\n");
    }

    /** Run `fn`, require it to fail, and assert the exact Anchor error code (string) or log text (RegExp). */
    async function expectFailure(fn: () => Promise<any>, expected: string | RegExp) {
        let thrown: any;
        try {
            await fn();
        } catch (err: any) {
            thrown = err;
        }
        expect(thrown, `expected a failure matching ${expected}`).to.exist;
        if (typeof expected === "string") {
            expect(thrown?.error?.errorCode?.code, errorText(thrown)).to.equal(expected);
        } else {
            expect(errorText(thrown)).to.match(expected);
        }
    }
    const ALREADY_IN_USE = /already in use/;

    // ========================
    // Funded donations
    // ========================

    describe("donations", () => {
        let executed: Prop, cancelled: Prop, other: Prop, dead: Prop;
        let executedEscrow: PublicKey, otherEscrow: PublicKey;

        before(async () => {
            executed = await newProposal("don-exec");
            cancelled = await newProposal("don-cancel");
            other = await newProposal("don-other");
            dead = await newProposal("don-dead");
            await cancel(dead);
            executedEscrow = escrowOf(executed.proposal);
            otherEscrow = escrowOf(other.proposal);
        });

        describe("create_donation_escrow", () => {
            it("captures the proposal owner as beneficiary and opens an escrow-owned USDC vault", async () => {
                await createEscrow(executed.proposal);
                const escrow = await program.account.donationEscrow.fetch(executedEscrow);
                expect(escrow.proposal.toBase58()).to.equal(executed.proposal.toBase58());
                expect(escrow.beneficiary.toBase58()).to.equal(creator.publicKey.toBase58());
                expect(escrow.mint.toBase58()).to.equal(USDC.toBase58());
                expect(escrow.vault.toBase58()).to.equal(vaultOf(executedEscrow).toBase58());
                expect([escrow.totalDonated, escrow.totalReleased, escrow.totalRefunded, escrow.donationCount, escrow.donorCount].map(n))
                    .to.deep.equal([0, 0, 0, 0, 0]);
                expect(escrow.released).to.be.false;
                const vault = await getAccount(connection, vaultOf(executedEscrow));
                expect(vault.owner.toBase58()).to.equal(executedEscrow.toBase58());
                expect(Number(vault.amount)).to.equal(0);
            });

            it("rejects a second escrow for the same proposal (re-init)", async () => {
                await expectFailure(() => createEscrow(executed.proposal), ALREADY_IN_USE);
            });

            it("rejects any mint other than devnet USDC", async () => {
                const escrow = escrowOf(other.proposal);
                await expectFailure(() => createEscrow(other.proposal, {
                    mint: fakeMint, vault: getAssociatedTokenAddressSync(fakeMint, escrow, true),
                }), "InvalidMint");
            });

            it("rejects a proposal account not owned by proposal_nft (parcel, wallet)", async () => {
                const parcel = findParcelPDA(parcelProgram.programId, executed.parcelId)[0];
                await expectFailure(() => createEscrow(parcel), "InvalidProposalAccount");
                await expectFailure(() => createEscrow(creator.publicKey), "InvalidProposalAccount");
            });

            it("rejects a proposal_nft account that is not a Proposal (the counter)", async () => {
                await expectFailure(() => createEscrow(counterPDA), "InvalidProposalAccount");
            });

            it("rejects a proposal that is no longer Active", async () => {
                await expectFailure(() => createEscrow(dead.proposal), "ProposalNotActive");
            });

            it("opens the remaining escrows", async () => {
                await createEscrow(other.proposal);
                await createEscrow(cancelled.proposal);
                expect(n((await program.account.donationEscrow.fetch(otherEscrow)).totalDonated)).to.equal(0);
            });
        });

        describe("donate", () => {
            it("records immutable positions, per-donor totals and escrow aggregates", async () => {
                await donate(donorA, executed.proposal, "a1", 3_000_000);
                await donate(donorA, executed.proposal, "a2", 2_000_000);
                await donate(donorB, executed.proposal, "b1", 5_000_000);

                const escrow = await program.account.donationEscrow.fetch(executedEscrow);
                expect(n(escrow.totalDonated)).to.equal(10_000_000);
                expect(n(escrow.donationCount)).to.equal(3);
                expect(n(escrow.donorCount)).to.equal(2);

                const record = await program.account.donor.fetch(donorRecordOf(executedEscrow, donorA.pk));
                expect(record.owner.toBase58()).to.equal(donorA.pk.toBase58());
                expect(n(record.totalDonated)).to.equal(5_000_000);
                expect(n(record.donationCount)).to.equal(2);

                const position = await program.account.donationPosition.fetch(positionOf(executedEscrow, donorA.pk, donationId("a1")));
                expect(position.escrow.toBase58()).to.equal(executedEscrow.toBase58());
                expect(position.owner.toBase58()).to.equal(donorA.pk.toBase58());
                expect(Buffer.from(position.donationId as number[]).equals(donationId("a1"))).to.be.true;
                expect(n(position.amount)).to.equal(3_000_000);
                expect(position.refunded).to.be.false;

                expect(await balance(vaultOf(executedEscrow))).to.equal(10_000_000);
                expect(await balance(donorA.usdc)).to.equal(USDC_FUNDING - 5_000_000);
            });

            it("rejects a duplicate donation_id (retry is idempotent, no double charge)", async () => {
                await expectFailure(() => donate(donorA, executed.proposal, "a1", 3_000_000), ALREADY_IN_USE);
                expect(await balance(donorA.usdc)).to.equal(USDC_FUNDING - 5_000_000);
                expect(n((await program.account.donationEscrow.fetch(executedEscrow)).donationCount)).to.equal(3);
            });

            it("rejects a zero amount", async () => {
                await expectFailure(() => donate(donorA, executed.proposal, "zero", 0), "ZeroAmount");
            });

            it("rejects spending another wallet's token account", async () => {
                await expectFailure(() => donate(donorB, executed.proposal, "steal", 1_000_000, { donorTokenAccount: donorA.usdc }),
                    "ConstraintTokenOwner");
            });

            it("rejects a token account of the wrong mint", async () => {
                await expectFailure(() => donate(donorA, executed.proposal, "fake", 1_000_000, { donorTokenAccount: donorA.fake }),
                    "ConstraintTokenMint");
            });

            it("rejects another proposal passed alongside the escrow", async () => {
                await expectFailure(() => donate(donorA, other.proposal, "swap-prop", 1_000_000, { escrow: executedEscrow }),
                    "InvalidProposalAccount");
            });

            it("rejects another escrow's vault", async () => {
                await expectFailure(() => donate(donorA, executed.proposal, "swap-vault", 1_000_000, { vault: vaultOf(otherEscrow) }),
                    "ConstraintAddress");
            });

            it("rejects a non-escrow program account passed as the escrow", async () => {
                const donorRecord = donorRecordOf(executedEscrow, donorA.pk);
                await expectFailure(() => donate(donorA, executed.proposal, "swap-escrow", 1_000_000, {
                    escrow: donorRecord, vault: vaultOf(executedEscrow),
                }), "AccountDiscriminatorMismatch");
            });

            it("rejects release and refund while the proposal is Active", async () => {
                await expectFailure(() => release(executed.proposal, attacker), "ProposalNotExecuted");
                await expectFailure(() => refund(donorA, executed.proposal, "a1"), "ProposalNotRefundable");
            });
        });

        describe("release_donations (Executed)", () => {
            before(async () => {
                await execute(executed);
            });

            it("rejects new donations and refunds once Executed", async () => {
                await expectFailure(() => donate(donorA, executed.proposal, "late", 1_000_000), "ProposalNotActive");
                await expectFailure(() => refund(donorA, executed.proposal, "a1"), "ProposalNotRefundable");
            });

            it("rejects a redirected beneficiary", async () => {
                await expectFailure(() => release(executed.proposal, attacker, { beneficiary: attacker.pk }), "ConstraintAddress");
            });

            it("rejects a mint other than the escrow's", async () => {
                await expectFailure(() => release(executed.proposal, attacker, { mint: fakeMint }), "ConstraintAddress");
            });

            it("rejects another escrow's vault", async () => {
                await expectFailure(() => release(executed.proposal, attacker, { vault: vaultOf(otherEscrow) }), "ConstraintAddress");
            });

            it("rejects another proposal passed alongside the escrow", async () => {
                await expectFailure(() => release(other.proposal, attacker, { escrow: executedEscrow }), "InvalidProposalAccount");
            });

            it("lets anyone release the whole vault to the captured beneficiary", async () => {
                await release(executed.proposal, attacker);
                expect(await balance(beneficiaryUsdc)).to.equal(10_000_000);
                expect(await balance(vaultOf(executedEscrow))).to.equal(0);
                expect(await balance(attacker.usdc)).to.equal(USDC_FUNDING);
                const escrow = await program.account.donationEscrow.fetch(executedEscrow);
                expect(escrow.released).to.be.true;
                expect(n(escrow.totalReleased)).to.equal(10_000_000);
            });

            it("rejects a second release, and any donation or refund afterwards", async () => {
                await expectFailure(() => release(executed.proposal, attacker), "DonationsReleased");
                await expectFailure(() => refund(donorA, executed.proposal, "a1"), "DonationsReleased");
                await expectFailure(() => donate(donorA, executed.proposal, "after", 1_000_000), "DonationsReleased");
            });

            it("rejects releasing an empty vault", async () => {
                const empty = await newProposal("don-empty");
                await createEscrow(empty.proposal);
                await execute(empty);
                await expectFailure(() => release(empty.proposal, attacker), "NothingToRelease");
            });
        });

        describe("refund_donation (Cancelled)", () => {
            let cancelledEscrow: PublicKey;

            before(async () => {
                cancelledEscrow = escrowOf(cancelled.proposal);
                await donate(donorA, cancelled.proposal, "c1", 4_000_000);
                await donate(donorB, cancelled.proposal, "c2", 1_000_000);
                await cancel(cancelled);
            });

            it("rejects donations and release once Cancelled", async () => {
                await expectFailure(() => donate(donorA, cancelled.proposal, "late", 1_000_000), "ProposalNotActive");
                await expectFailure(() => release(cancelled.proposal, attacker), "ProposalNotExecuted");
            });

            it("rejects refunding someone else's position", async () => {
                await expectFailure(() => refund(donorB, cancelled.proposal, "c1", {
                    position: positionOf(cancelledEscrow, donorA.pk, donationId("c1")),
                }), "ConstraintSeeds");
            });

            it("rejects paying the refund into another wallet's token account", async () => {
                await expectFailure(() => refund(donorA, cancelled.proposal, "c1", { donorTokenAccount: donorB.usdc }), "ConstraintTokenOwner");
            });

            it("rejects a refund token account of the wrong mint", async () => {
                await expectFailure(() => refund(donorA, cancelled.proposal, "c1", { donorTokenAccount: donorA.fake }), "ConstraintTokenMint");
            });

            it("rejects a position that belongs to another escrow", async () => {
                await expectFailure(() => refund(donorA, cancelled.proposal, "a1", {
                    position: positionOf(executedEscrow, donorA.pk, donationId("a1")),
                }), "ConstraintSeeds");
            });

            it("rejects another escrow's vault", async () => {
                await expectFailure(() => refund(donorA, cancelled.proposal, "c1", { vault: vaultOf(otherEscrow) }), "ConstraintAddress");
            });

            it("refunds the position's amount to its owner exactly once", async () => {
                const before = await balance(donorA.usdc);
                await refund(donorA, cancelled.proposal, "c1");
                expect(await balance(donorA.usdc)).to.equal(before + 4_000_000);
                const position = await program.account.donationPosition.fetch(positionOf(cancelledEscrow, donorA.pk, donationId("c1")));
                expect(position.refunded).to.be.true;
                expect(n((await program.account.donationEscrow.fetch(cancelledEscrow)).totalRefunded)).to.equal(4_000_000);

                await expectFailure(() => refund(donorA, cancelled.proposal, "c1"), "AlreadyRefunded");
                expect(await balance(donorA.usdc)).to.equal(before + 4_000_000);
            });

            it("refunds the remaining donor and empties the vault", async () => {
                await refund(donorB, cancelled.proposal, "c2");
                expect(await balance(vaultOf(cancelledEscrow))).to.equal(0);
                const escrow = await program.account.donationEscrow.fetch(cancelledEscrow);
                expect(n(escrow.totalRefunded)).to.equal(n(escrow.totalDonated));
                expect(escrow.released).to.be.false;
            });
        });

        describe("refund_donation (Expired fixture)", () => {
            const expiredProposal = new PublicKey(fixtures.expiredProposal);
            const expiredDonorKp = loadKeypair("expired-donor");
            let expiredDonor: Party;
            const fixtureId = Buffer.from(fixtures.expiredDonationId, "hex");
            const expiredRefund = () => program.methods.refundDonation().accountsStrict({
                escrow: new PublicKey(fixtures.expiredEscrow), proposal: expiredProposal,
                position: new PublicKey(fixtures.expiredPosition), vault: new PublicKey(fixtures.expiredVault),
                donorTokenAccount: expiredDonor.usdc, donor: expiredDonor.pk, tokenProgram: TOKEN_PROGRAM_ID,
            } as any).signers([expiredDonor.kp]).rpc();

            before(async () => {
                const usdc = await createAssociatedTokenAccountIdempotent(connection, payer, USDC, expiredDonorKp.publicKey);
                expiredDonor = { kp: expiredDonorKp, pk: expiredDonorKp.publicKey, usdc, fake: usdc };
                // Guard against a stale fixture: the program must derive the same position address.
                expect(positionOf(new PublicKey(fixtures.expiredEscrow), expiredDonor.pk, fixtureId).toBase58()).to.equal(fixtures.expiredPosition);
            });

            it("rejects donations and release on an Expired proposal", async () => {
                await expectFailure(() => donate(donorA, expiredProposal, "expired", 1_000_000), "ProposalNotActive");
                await expectFailure(() => release(expiredProposal, attacker, { beneficiary: new PublicKey(fixtures.expiredBeneficiary) }),
                    "ProposalNotExecuted");
            });

            it("refunds the funded donation once after expiry", async () => {
                await expiredRefund();
                expect(await balance(expiredDonor.usdc)).to.equal(Number(fixtures.expiredDonation));
                expect(await balance(new PublicKey(fixtures.expiredVault))).to.equal(0);
                await expectFailure(expiredRefund, "AlreadyRefunded");
            });
        });

        // The vault ATA's address is predictable and the Associated Token program lets anyone create
        // an ATA for any owner, PDAs included. With `init` that pre-creation made create_donation_escrow
        // fail forever ("Provided owner is not allowed"), blocking donations; `init_if_needed` fixes it.
        it("still opens the escrow when someone pre-created its vault ATA", async () => {
            const griefed = await newProposal("don-grief");
            await createAssociatedTokenAccountIdempotent(connection, attacker.kp, USDC, escrowOf(griefed.proposal), {}, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, true);
            await createEscrow(griefed.proposal);
            expect((await program.account.donationEscrow.fetch(escrowOf(griefed.proposal))).beneficiary.toBase58())
                .to.equal(creator.publicKey.toBase58());
        });
    });

    // ========================
    // Soft pledges
    // ========================

    describe("pledges", () => {
        let executed: Prop, cancelled: Prop, other: Prop;
        let book: PublicKey, otherBook: PublicKey;

        const commitment = (proposal: PublicKey, owner: Party) =>
            program.account.pledgeCommitment.fetch(commitmentOf(bookOf(proposal), owner.pk));
        const bookState = async (proposal: PublicKey) => {
            const b = await program.account.pledgeBook.fetch(bookOf(proposal));
            return {
                activePledged: n(b.activePledged), totalFulfilled: n(b.totalFulfilled), totalRevoked: n(b.totalRevoked),
                pledgeCount: n(b.pledgeCount), activeCount: n(b.activeCount), fulfilledCount: n(b.fulfilledCount),
            };
        };

        before(async () => {
            executed = await newProposal("plg-exec");
            cancelled = await newProposal("plg-cancel");
            other = await newProposal("plg-other");
            book = bookOf(executed.proposal);
            otherBook = bookOf(other.proposal);
        });

        describe("create_pledge_book", () => {
            it("captures the proposal owner as beneficiary with empty aggregates", async () => {
                await createBook(executed.proposal);
                const b = await program.account.pledgeBook.fetch(book);
                expect(b.proposal.toBase58()).to.equal(executed.proposal.toBase58());
                expect(b.beneficiary.toBase58()).to.equal(creator.publicKey.toBase58());
                expect(b.mint.toBase58()).to.equal(USDC.toBase58());
                expect(await bookState(executed.proposal)).to.deep.equal({
                    activePledged: 0, totalFulfilled: 0, totalRevoked: 0, pledgeCount: 0, activeCount: 0, fulfilledCount: 0,
                });
            });

            it("rejects a second book for the same proposal (re-init)", async () => {
                await expectFailure(() => createBook(executed.proposal), ALREADY_IN_USE);
            });

            it("rejects any mint other than devnet USDC", async () => {
                await expectFailure(() => createBook(other.proposal, { mint: fakeMint }), "InvalidMint");
            });

            it("rejects a non-Proposal account", async () => {
                await expectFailure(() => createBook(counterPDA), "InvalidProposalAccount");
                await expectFailure(() => createBook(creator.publicKey), "InvalidProposalAccount");
            });

            it("rejects a proposal that is no longer Active", async () => {
                const dead = await newProposal("plg-dead");
                await cancel(dead);
                await expectFailure(() => createBook(dead.proposal), "ProposalNotActive");
            });

            it("opens the remaining books", async () => {
                await createBook(other.proposal);
                await createBook(cancelled.proposal);
                expect((await bookState(other.proposal)).pledgeCount).to.equal(0);
            });
        });

        describe("set_pledge / revoke_pledge (Active)", () => {
            it("creates a commitment without moving any USDC", async () => {
                await setPledge(pledgerA, executed.proposal, 5_000_000);
                const c = await commitment(executed.proposal, pledgerA);
                expect(c.book.toBase58()).to.equal(book.toBase58());
                expect(c.proposal.toBase58()).to.equal(executed.proposal.toBase58());
                expect(c.owner.toBase58()).to.equal(pledgerA.pk.toBase58());
                expect(n(c.amount)).to.equal(5_000_000);
                expect(c.status).to.equal(COMMITMENT_ACTIVE);
                expect(c.initialized).to.be.true;
                expect(await balance(pledgerA.usdc)).to.equal(USDC_FUNDING);
                expect(await bookState(executed.proposal)).to.include({ activePledged: 5_000_000, pledgeCount: 1, activeCount: 1 });
            });

            it("updates the same commitment in place instead of adding a second one", async () => {
                await setPledge(pledgerA, executed.proposal, 7_000_000);
                expect(n((await commitment(executed.proposal, pledgerA)).amount)).to.equal(7_000_000);
                expect(await bookState(executed.proposal)).to.include({ activePledged: 7_000_000, pledgeCount: 1, activeCount: 1 });
            });

            it("aggregates several pledgers", async () => {
                await setPledge(pledgerB, executed.proposal, 3_000_000);
                await setPledge(pledgerC, executed.proposal, 1_000_000);
                expect(await bookState(executed.proposal)).to.include({ activePledged: 11_000_000, pledgeCount: 3, activeCount: 3 });
            });

            it("rejects a zero amount", async () => {
                await expectFailure(() => setPledge(pledgerA, executed.proposal, 0), "ZeroAmount");
            });

            it("rejects another proposal passed alongside the book", async () => {
                await expectFailure(() => setPledge(pledgerA, other.proposal, 1_000_000, { book }), "InvalidProposalAccount");
            });

            it("rejects a non-book program account passed as the book", async () => {
                await expectFailure(() => setPledge(pledgerA, executed.proposal, 1_000_000, {
                    book: commitmentOf(book, pledgerA.pk), commitment: commitmentOf(book, pledgerA.pk),
                }), "AccountDiscriminatorMismatch");
            });

            it("rejects revoking another wallet's commitment", async () => {
                await expectFailure(() => revoke(pledgerB, executed.proposal, { commitment: commitmentOf(book, pledgerA.pk) }), "ConstraintSeeds");
            });

            it("rejects a commitment that belongs to another book", async () => {
                await setPledge(pledgerA, other.proposal, 2_000_000);
                await expectFailure(() => revoke(pledgerA, executed.proposal, { commitment: commitmentOf(otherBook, pledgerA.pk) }), "ConstraintSeeds");
            });

            it("revokes an active commitment once", async () => {
                await revoke(pledgerA, executed.proposal);
                expect((await commitment(executed.proposal, pledgerA)).status).to.equal(COMMITMENT_REVOKED);
                expect(await bookState(executed.proposal)).to.include({ activePledged: 4_000_000, activeCount: 2, totalRevoked: 7_000_000 });
                await expectFailure(() => revoke(pledgerA, executed.proposal), "PledgeNotActive");
            });

            it("re-activates a revoked commitment without double counting it", async () => {
                await setPledge(pledgerA, executed.proposal, 2_000_000);
                expect((await commitment(executed.proposal, pledgerA)).status).to.equal(COMMITMENT_ACTIVE);
                expect(await bookState(executed.proposal)).to.include({ activePledged: 6_000_000, pledgeCount: 3, activeCount: 3 });
            });

            it("rejects fulfil and void while the proposal is Active", async () => {
                await expectFailure(() => fulfill(pledgerA, executed.proposal), "ProposalNotExecuted");
                await expectFailure(() => voidPledge(pledgerA.pk, executed.proposal), "ProposalNotRefundable");
            });
        });

        describe("fulfill_pledge (Executed)", () => {
            before(async () => {
                await execute(executed);
            });

            it("rejects set and revoke once Executed", async () => {
                await expectFailure(() => setPledge(pledgerA, executed.proposal, 9_000_000), "ProposalNotActive");
                await expectFailure(() => revoke(pledgerA, executed.proposal), "ProposalNotActive");
            });

            it("rejects fulfilling another wallet's commitment", async () => {
                await expectFailure(() => fulfill(pledgerB, executed.proposal, { commitment: commitmentOf(book, pledgerA.pk) }), "ConstraintSeeds");
            });

            it("rejects paying from another wallet's token account", async () => {
                await expectFailure(() => fulfill(pledgerB, executed.proposal, { pledgerTokenAccount: pledgerA.usdc }), "ConstraintTokenOwner");
            });

            it("rejects a redirected beneficiary", async () => {
                await expectFailure(() => fulfill(pledgerB, executed.proposal, { beneficiary: attacker.pk }), "ConstraintAddress");
            });

            it("rejects a pledger token account of the wrong mint", async () => {
                await expectFailure(() => fulfill(pledgerB, executed.proposal, { pledgerTokenAccount: pledgerB.fake }), "ConstraintTokenMint");
            });

            it("rejects a mint other than the book's", async () => {
                await expectFailure(() => fulfill(pledgerB, executed.proposal, { mint: fakeMint, pledgerTokenAccount: pledgerB.fake }),
                    "ConstraintAddress");
            });

            it("rejects another proposal passed alongside the book", async () => {
                await expectFailure(() => fulfill(pledgerB, other.proposal, { book }), "InvalidProposalAccount");
            });

            it("moves exactly the pledged amount from pledger to beneficiary once", async () => {
                const beneficiaryBefore = await balance(beneficiaryUsdc);
                await fulfill(pledgerB, executed.proposal);
                expect(await balance(pledgerB.usdc)).to.equal(USDC_FUNDING - 3_000_000);
                expect(await balance(beneficiaryUsdc)).to.equal(beneficiaryBefore + 3_000_000);
                expect((await commitment(executed.proposal, pledgerB)).status).to.equal(COMMITMENT_FULFILLED);
                expect(await bookState(executed.proposal)).to.include({
                    activePledged: 3_000_000, activeCount: 2, totalFulfilled: 3_000_000, fulfilledCount: 1,
                });
                await expectFailure(() => fulfill(pledgerB, executed.proposal), "PledgeNotActive");
                expect(await balance(pledgerB.usdc)).to.equal(USDC_FUNDING - 3_000_000);
            });

            it("fails an unfunded pledger in the token program and leaves the commitment active", async () => {
                await expectFailure(() => fulfill(pledgerC, executed.proposal), /insufficient funds/);
                expect((await commitment(executed.proposal, pledgerC)).status).to.equal(COMMITMENT_ACTIVE);
            });

            it("rejects voiding on an Executed proposal", async () => {
                await expectFailure(() => voidPledge(pledgerA.pk, executed.proposal), "ProposalNotRefundable");
            });
        });

        describe("void_pledge (Cancelled)", () => {
            before(async () => {
                await setPledge(pledgerA, cancelled.proposal, 4_000_000);
                await setPledge(pledgerB, cancelled.proposal, 2_000_000);
                await cancel(cancelled);
            });

            it("rejects set, revoke and fulfil once Cancelled", async () => {
                await expectFailure(() => setPledge(pledgerA, cancelled.proposal, 1_000_000), "ProposalNotActive");
                await expectFailure(() => revoke(pledgerA, cancelled.proposal), "ProposalNotActive");
                await expectFailure(() => fulfill(pledgerA, cancelled.proposal), "ProposalNotExecuted");
            });

            it("rejects a commitment that belongs to another book", async () => {
                await expectFailure(() => voidPledge(pledgerC.pk, cancelled.proposal, { commitment: commitmentOf(book, pledgerC.pk) }),
                    "ConstraintSeeds");
            });

            it("lets anyone void an active commitment once", async () => {
                await voidPledge(pledgerA.pk, cancelled.proposal);
                expect((await commitment(cancelled.proposal, pledgerA)).status).to.equal(COMMITMENT_VOIDED);
                expect(await bookState(cancelled.proposal)).to.include({ activePledged: 2_000_000, activeCount: 1, totalRevoked: 0 });
                await expectFailure(() => voidPledge(pledgerA.pk, cancelled.proposal), "PledgeNotActive");
                expect(await balance(pledgerA.usdc)).to.equal(USDC_FUNDING);
            });
        });

        describe("void_pledge (Expired fixture)", () => {
            const expiredProposal = new PublicKey(fixtures.expiredProposal);
            const expiredPledgerKp = loadKeypair("expired-pledger");
            const expiredPledger = expiredPledgerKp.publicKey;
            const expiredBeneficiary = new PublicKey(fixtures.expiredBeneficiary);
            let fixturePledger: Party;

            before(async () => {
                // Pre-create both ATAs so the unfunded fixture wallet only has to sign.
                const usdc = await createAssociatedTokenAccountIdempotent(connection, payer, USDC, expiredPledger);
                await createAssociatedTokenAccountIdempotent(connection, payer, USDC, expiredBeneficiary);
                fixturePledger = { kp: expiredPledgerKp, pk: expiredPledger, usdc, fake: usdc };
            });

            it("derives the fixture commitment the program expects", () => {
                expect(bookOf(expiredProposal).toBase58()).to.equal(fixtures.expiredBook);
                expect(commitmentOf(bookOf(expiredProposal), expiredPledger).toBase58()).to.equal(fixtures.expiredCommitment);
            });

            it("rejects new pledges and fulfilment on an Expired proposal", async () => {
                await expectFailure(() => setPledge(pledgerA, expiredProposal, 1_000_000), "ProposalNotActive");
                await expectFailure(() => fulfill(fixturePledger, expiredProposal, { beneficiary: expiredBeneficiary }), "ProposalNotExecuted");
            });

            it("voids the active commitment once after expiry", async () => {
                await voidPledge(expiredPledger, expiredProposal);
                const c = await program.account.pledgeCommitment.fetch(new PublicKey(fixtures.expiredCommitment));
                expect(c.status).to.equal(COMMITMENT_VOIDED);
                expect(await bookState(expiredProposal)).to.include({ activePledged: 0, activeCount: 0 });
                await expectFailure(() => voidPledge(expiredPledger, expiredProposal), "PledgeNotActive");
            });
        });
    });
});
