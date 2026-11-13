// Localnet suite for the ugt program's parcel anchors and design/plan records (programs/ugt/README.md):
// anchor_parcels creates ownerless anchors, skips the ones that exist and refuses malformed batches;
// create_record writes the record at ["record", kind, sha256(cid)] and mints a permanently frozen
// Metaplex Core asset (loaded at genesis from tests/fixtures/mpl_core.so) to the publisher, refuses a
// second create of the same CID and every malformed argument; the asset cannot be transferred.
// The browser codec (frontend/js/solana/ugt-client.js) builds the instructions, so its bytes are
// exercised against the program here too.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";
import { testCid } from "./agreement-helpers.ts";
import { waitForProgramsVisible } from "./sas-mock.ts";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const UgtClient = require("../../../frontend/js/solana/ugt-client.js");
const SolanaAdapter = require("../../../frontend/js/chain/solana-adapter.js");
UgtClient.configure({ web3: anchor.web3 });

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const SOL = anchor.web3.LAMPORTS_PER_SOL;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

describe("ugt: parcel anchors and records", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Ugt as Program;
    const connection = provider.connection;
    const payer = (provider.wallet as any).payer as Keypair;
    const publisher = Keypair.generate();

    before(async () => {
        await waitForProgramsVisible(connection);
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: publisher.publicKey, lamports: 10 * SOL }));
        await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    });

    /** Anchor puts the code on err.error.errorCode.code; a raw runtime failure only has logs. */
    function errorText(err: any): string {
        const logs = err?.logs ?? err?.transactionLogs ?? err?.error?.logs ?? [];
        return [err?.error?.errorCode?.code, err?.message, String(err), Array.isArray(logs) ? logs.join("\n") : ""].filter(Boolean).join("\n");
    }

    async function expectFailure(fn: () => Promise<any>, expected: RegExp) {
        let thrown: any;
        try { await fn(); } catch (err: any) { thrown = err; }
        expect(thrown, `expected a failure matching ${expected}`).to.exist;
        expect(errorText(thrown)).to.match(expected);
    }

    async function sendIx(instruction: TransactionInstruction, signers: Keypair[] = [], computeUnits?: number): Promise<string> {
        const tx = new Transaction();
        if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
        tx.add(instruction);
        // Confirmed, as every read below is: a processed transaction may not be visible to them yet.
        return provider.sendAndConfirm(tx, signers, { commitment: "confirmed" });
    }

    const pageOf = (parcelId: string) => `https://urbangametheory.xyz/parcel/${encodeURIComponent(parcelId)}`;

    function anchorIx(parcelIds: string[], uris = parcelIds.map(pageOf), signer: PublicKey = payer.publicKey) {
        return UgtClient.buildAnchorParcelsIx({ parcelIds, metadataUris: uris, payer: signer, programId: program.programId }).instruction as TransactionInstruction;
    }

    async function unitsOf(signature: string): Promise<number> {
        for (let attempt = 0; attempt < 50; attempt++) {
            const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            if (tx?.meta) return tx.meta.computeUnitsConsumed ?? 0;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error(`transaction ${signature} was never confirmed`);
    }

    describe("anchor_parcels", () => {
        it("creates ownerless anchors with the payer, the chain time and the fixed metadata URI", async () => {
            const ids = ["HR-ugt-1", "HR-ugt-2"];
            const signature = await sendIx(anchorIx(ids, ids.map(pageOf), publisher.publicKey), [publisher]);
            const anchors = await UgtClient.fetchParcelAnchors(connection, ids, { programId: program.programId });
            anchors.forEach((anchor: any, index: number) => {
                expect(anchor.parcelId).to.equal(ids[index]);
                expect(anchor.metadataUri).to.equal(pageOf(ids[index]));
                expect(anchor.anchoredBy).to.equal(publisher.publicKey.toBase58());
                expect(anchor.anchoredAt).to.be.greaterThan(0);
                expect(anchor.address).to.equal(PublicKey.findProgramAddressSync([Buffer.from("parcel"), Buffer.from(ids[index])], program.programId)[0].toBase58());
            });
            const info = await connection.getAccountInfo(new PublicKey(anchors[0].address));
            expect(info!.owner.toBase58()).to.equal(program.programId.toBase58());
            expect(await unitsOf(signature)).to.be.below(200_000);
        });

        it("skips anchors that exist, so a resumed batch never fails on its own earlier work", async () => {
            const before = await UgtClient.fetchParcelAnchors(connection, ["HR-ugt-1"], { programId: program.programId });
            await sendIx(anchorIx(["HR-ugt-1", "HR-ugt-3"], ["https://example.org/other", pageOf("HR-ugt-3")]));
            const [first, third] = await UgtClient.fetchParcelAnchors(connection, ["HR-ugt-1", "HR-ugt-3"], { programId: program.programId });
            expect(first).to.deep.equal(before[0]);
            expect(third.anchoredBy).to.equal(payer.publicKey.toBase58());
        });

        it("anchors a full batch the browser packs within the compute budget and the size limit", async () => {
            const ids = Array.from({ length: SolanaAdapter.ANCHOR_BATCH }, (_, i) => `HR-335754-${1000 + i}`);
            const batches = SolanaAdapter.anchorBatches(ids, pageOf);
            expect(batches).to.have.length(1);
            const tx = new Transaction().add(anchorIx(ids));
            tx.feePayer = payer.publicKey;
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            tx.sign(payer);
            expect(tx.serialize().length).to.equal(SolanaAdapter.anchorTxSize(ids, ids.map(pageOf)));
            const signature = await sendIx(anchorIx(ids));
            const units = await unitsOf(signature);
            expect(units, `${ids.length} anchors used ${units} compute units`).to.be.below(200_000);
            expect((await UgtClient.fetchParcelAnchors(connection, ids, { programId: program.programId })).every(Boolean)).to.be.true;
        });

        it("refuses malformed batches: no ids, unequal URIs, a missing or wrong account, a long id or URI", async () => {
            const page = pageOf("x");
            const raw = (ids: string[], uris: string[], accounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => program.methods
                .anchorParcels(ids, uris)
                .accountsStrict({ payer: payer.publicKey, systemProgram: SystemProgram.programId })
                .remainingAccounts(accounts)
                .rpc({ commitment: "confirmed" });
            const pda = (id: string) => PublicKey.findProgramAddressSync([Buffer.from("parcel"), Buffer.from(id)], program.programId)[0];
            const writable = (key: PublicKey) => ({ pubkey: key, isSigner: false, isWritable: true });
            await expectFailure(() => raw([], [], []), /InvalidAnchorBatch/);
            await expectFailure(() => raw(["HR-bad-1"], [], [writable(pda("HR-bad-1"))]), /InvalidAnchorBatch/);
            await expectFailure(() => raw(["HR-bad-1"], [page], []), /InvalidAnchorBatch/);
            await expectFailure(() => raw(["HR-bad-1"], [page], [writable(pda("HR-bad-2"))]), /WrongParcelAccount/);
            await expectFailure(() => raw(["HR-bad-1"], [page], [{ pubkey: pda("HR-bad-1"), isSigner: false, isWritable: false }]), /WrongParcelAccount/);
            await expectFailure(() => raw(["HR-bad-1"], [""], [writable(pda("HR-bad-1"))]), /InvalidMetadataUri/);
            await expectFailure(() => raw(["HR-bad-1"], ["u".repeat(201)], [writable(pda("HR-bad-1"))]), /InvalidMetadataUri/);
            // Short ids and URIs, so seventeen fit one transaction and the program's own limit answers.
            const seventeen = Array.from({ length: 17 }, (_, i) => `p${i}`);
            await expectFailure(() => raw(seventeen, seventeen.map(() => "u"), seventeen.map(id => writable(pda(id)))), /InvalidAnchorBatch/);
            expect(await connection.getAccountInfo(pda("HR-bad-1"))).to.be.null;
        });
    });

    describe("create_record", () => {
        const uri = "data:application/json;base64," + Buffer.from(JSON.stringify({ name: "Riverside park" })).toString("base64");

        function recordIx(kind: string, cid: string, minter: PublicKey = publisher.publicKey, name = "Riverside park", tokenUri = uri) {
            return UgtClient.buildCreateRecordIx({ kind, cid, name, uri: tokenUri, minter, programId: program.programId });
        }

        it("writes the record and mints a frozen Metaplex Core asset to the publisher", async () => {
            const cid = testCid("design");
            const { record, asset, instruction } = recordIx("design", cid);
            const signature = await sendIx(instruction, [publisher]);

            const [expectedRecord] = PublicKey.findProgramAddressSync([Buffer.from("record"), Buffer.from([1]), sha256(cid)], program.programId);
            const [expectedAsset] = PublicKey.findProgramAddressSync([Buffer.from("asset"), Buffer.from([1]), sha256(cid)], program.programId);
            expect(record.toBase58()).to.equal(expectedRecord.toBase58());
            expect(asset.toBase58()).to.equal(expectedAsset.toBase58());

            const value = await UgtClient.fetchRecord(connection, { kind: "design", cid, programId: program.programId });
            expect(value).to.include({ kind: "design", kindCode: 1, cid, minter: publisher.publicKey.toBase58(), asset: asset.toBase58() });
            expect(value.createdAt).to.be.greaterThan(0);
            const recordInfo = await connection.getAccountInfo(record);
            expect(recordInfo!.data.length).to.equal(UgtClient.constants.RECORD_ACCOUNT_SPACE);
            expect(recordInfo!.data[UgtClient.RECORD_OFFSETS.kind]).to.equal(1);

            // AssetV1: key 1 | owner | update authority Address(record) | name | uri | …
            const assetInfo = await connection.getAccountInfo(asset);
            expect(assetInfo!.owner.toBase58()).to.equal(MPL_CORE.toBase58());
            const data = assetInfo!.data;
            expect(data[0]).to.equal(1);
            expect(new PublicKey(data.subarray(1, 33)).toBase58()).to.equal(publisher.publicKey.toBase58());
            expect(data[33]).to.equal(1);
            expect(new PublicKey(data.subarray(34, 66)).toBase58()).to.equal(record.toBase58());
            const nameLength = data.readUInt32LE(66);
            expect(data.subarray(70, 70 + nameLength).toString("utf8")).to.equal("Riverside park");
            const uriLength = data.readUInt32LE(70 + nameLength);
            expect(data.subarray(74 + nameLength, 74 + nameLength + uriLength).toString("utf8")).to.equal(uri);
            expect(await unitsOf(signature)).to.be.below(200_000);
        });

        it("refuses a second create of the same CID, by anyone", async () => {
            const cid = testCid("design");
            await sendIx(recordIx("design", cid).instruction, [publisher]);
            await expectFailure(() => sendIx(recordIx("design", cid).instruction, [publisher]), /already in use/);
            await expectFailure(() => sendIx(recordIx("design", cid, payer.publicKey).instruction), /already in use/);
            expect((await UgtClient.fetchRecord(connection, { kind: "design", cid, programId: program.programId })).minter).to.equal(publisher.publicKey.toBase58());
        });

        it("keeps designs and plans apart and lists each kind by a memcmp", async () => {
            const plan = testCid("plan");
            await sendIx(recordIx("plan", plan).instruction, [publisher]);
            const plans = await UgtClient.listRecords(connection, { kind: "plan", programId: program.programId });
            const designs = await UgtClient.listRecords(connection, { kind: "design", programId: program.programId });
            expect(plans.map((row: any) => row.cid)).to.include(plan);
            expect(designs.map((row: any) => row.cid)).to.not.include(plan);
            expect(plans.every((row: any) => row.kind === "plan")).to.be.true;
            expect(designs.every((row: any) => row.kind === "design")).to.be.true;
        });

        it("refuses a kind other than design or plan, a malformed CID, an empty or long name or URI", async () => {
            const cid = testCid("bad");
            const raw = (kind: number, recordCid: string, name: string, tokenUri: string) => {
                const [record] = PublicKey.findProgramAddressSync([Buffer.from("record"), Buffer.from([kind]), sha256(recordCid)], program.programId);
                const [asset] = PublicKey.findProgramAddressSync([Buffer.from("asset"), Buffer.from([kind]), sha256(recordCid)], program.programId);
                return program.methods.createRecord(kind, recordCid, name, tokenUri)
                    .accountsStrict({ record, asset, minter: publisher.publicKey, mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId })
                    .signers([publisher])
                    .rpc({ commitment: "confirmed" });
            };
            await expectFailure(() => raw(0, cid, "n", uri), /InvalidKind/);
            await expectFailure(() => raw(3, cid, "n", uri), /InvalidKind/);
            await expectFailure(() => raw(1, "bafk-rei", "n", uri), /InvalidCid/);
            await expectFailure(() => raw(1, cid, "", uri), /InvalidName/);
            await expectFailure(() => raw(1, cid, "n".repeat(101), uri), /InvalidName/);
            await expectFailure(() => raw(1, cid, "n", ""), /InvalidUri/);
            expect(await UgtClient.fetchRecord(connection, { kind: "design", cid, programId: program.programId })).to.be.null;
        });

        it("refuses another program in Metaplex Core's place", async () => {
            const cid = testCid("design");
            const { instruction } = recordIx("design", cid);
            instruction.keys[3] = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };
            await expectFailure(() => sendIx(instruction, [publisher]), /WrongProgram/);
        });

        it("mints a soulbound asset: Metaplex Core refuses its transfer", async () => {
            const cid = testCid("design");
            const { asset, instruction } = recordIx("design", cid);
            await sendIx(instruction, [publisher]);
            const transfer = new TransactionInstruction({
                programId: MPL_CORE,
                keys: [
                    { pubkey: asset, isSigner: false, isWritable: true },
                    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
                    { pubkey: publisher.publicKey, isSigner: true, isWritable: true },
                    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
                    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
                    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
                    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
                ],
                data: Buffer.from([14, 0]),
            });
            await expectFailure(() => sendIx(transfer, [publisher]), /frozen|Frozen|custom program error/);
            const data = (await connection.getAccountInfo(asset))!.data;
            expect(new PublicKey(data.subarray(1, 33)).toBase58()).to.equal(publisher.publicKey.toBase58());
        });
    });
});
