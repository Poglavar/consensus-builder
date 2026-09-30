// Localnet helpers for the lens model: lay out Solana Attestation Service credential, schema and
// attestation accounts byte-identical to sas-lib 1.0.10's codecs, write them through the mock SAS
// program (tests/mock_sas, loaded at the real SAS id by Anchor.toml), and drive proposal_nft's
// accept_with_attestations / settle_with_verdict with them.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "crypto";

export const SAS_PROGRAM_ID = new PublicKey("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
export const PARCEL_NFT_PROGRAM_ID = new PublicKey("4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1");

export const OWNERSHIP_SCHEMA = "ParcelOwnership";
export const VERDICT_SCHEMA = "ProposalVerdict";

/** Far enough ahead that no test run reaches it. */
export const FAR_EXPIRY = 4_000_000_000;

/** The validator's Clock.unix_timestamp, which the programs compare against (it drifts from the
 * host clock on a long local run, so tests must never use Date.now() for on-chain times). */
export async function chainNow(connection: Connection): Promise<number> {
    const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    return Number(clock!.data.readBigInt64LE(32));
}

/** Genesis programs are invisible in the slot they were deployed in; wait until slot 2. */
export async function waitForProgramsVisible(connection: Connection): Promise<void> {
    while ((await connection.getSlot()) < 2) {
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

export function sha256(bytes: Buffer): Buffer {
    return createHash("sha256").update(bytes).digest();
}

export function borshBytes(value: Buffer | string): Buffer {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
}

function i64(value: number | bigint): Buffer {
    const out = Buffer.alloc(8);
    out.writeBigInt64LE(BigInt(value));
    return out;
}

/** Credential: discriminator 0 | authority | name (u32 + bytes) | authorized_signers (u32 + 32 each). */
export function credentialBytes(authority: PublicKey, name = "lens-member", signers: PublicKey[] = [authority]): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(signers.length);
    return Buffer.concat([Buffer.from([0]), authority.toBuffer(), borshBytes(name), count, ...signers.map(s => s.toBuffer())]);
}

/** Schema: discriminator 1 | credential | name | description | layout | field names | is_paused | version. */
export function schemaBytes(credential: PublicKey, name: string, { paused = false, version = 1 } = {}): Buffer {
    return Buffer.concat([
        Buffer.from([1]), credential.toBuffer(),
        borshBytes(name), borshBytes(`${name} test schema`), borshBytes(Buffer.from([12, 12])), borshBytes("a,b"),
        Buffer.from([paused ? 1 : 0, version]),
    ]);
}

/** sas-lib deriveSchemaPda: ["schema", credential, name, [version]]. */
export function schemaPda(credential: PublicKey, name: string, version = 1): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("schema"), credential.toBuffer(), Buffer.from(name), Buffer.from([version])],
        SAS_PROGRAM_ID
    )[0];
}

/** Attestation: discriminator 2 | nonce | credential | schema | data (u32 + bytes) | signer | expiry | token account. */
export function attestationBytes(a: {
    credential: PublicKey; schema: PublicKey; payload: Buffer; authority: PublicKey;
    expiry?: number; nonce?: PublicKey;
}): Buffer {
    return Buffer.concat([
        Buffer.from([2]), (a.nonce ?? Keypair.generate().publicKey).toBuffer(), a.credential.toBuffer(), a.schema.toBuffer(),
        borshBytes(a.payload), a.authority.toBuffer(), i64(a.expiry ?? FAR_EXPIRY), PublicKey.default.toBuffer(),
    ]);
}

/** ParcelOwnership-v1: string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt. */
export function ownershipPayload(p: { parcelUid: string; owner: PublicKey | string; ownerCount?: number; evidenceRef?: string; sourceObservedAt: number }): Buffer {
    return Buffer.concat([
        borshBytes(p.parcelUid), borshBytes(p.owner.toString()), Buffer.from([p.ownerCount ?? 1]),
        borshBytes(p.evidenceRef ?? "case-ref"), i64(p.sourceObservedAt),
    ]);
}

/** ProposalVerdict-v1: string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt. */
export function verdictPayload(p: { proposalAccount: PublicKey | string; verdict: string; evidenceRef?: string; sourceObservedAt: number }): Buffer {
    return Buffer.concat([
        borshBytes(p.proposalAccount.toString()), borshBytes(p.verdict),
        borshBytes(p.evidenceRef ?? "case-ref"), i64(p.sourceObservedAt),
    ]);
}

/** Create an account owned by the (mock) SAS program holding exactly `bytes`. */
export async function writeSasAccount(provider: anchor.AnchorProvider, bytes: Buffer): Promise<PublicKey> {
    const account = Keypair.generate();
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(bytes.length);
    const chunk = 700;
    for (let offset = 0; offset < bytes.length || offset === 0; offset += chunk) {
        const tx = new Transaction();
        if (offset === 0) {
            tx.add(SystemProgram.createAccount({
                fromPubkey: provider.wallet.publicKey, newAccountPubkey: account.publicKey,
                lamports, space: bytes.length, programId: SAS_PROGRAM_ID,
            }));
        }
        const header = Buffer.alloc(4);
        header.writeUInt32LE(offset);
        tx.add(new TransactionInstruction({
            programId: SAS_PROGRAM_ID,
            keys: [{ pubkey: account.publicKey, isSigner: false, isWritable: true }],
            data: Buffer.concat([header, bytes.subarray(offset, offset + chunk)]),
        }));
        await provider.sendAndConfirm(tx, offset === 0 ? [account] : []);
        if (bytes.length === 0) break;
    }
    return account.publicKey;
}

export type LensMember = { keypair: Keypair; publicKey: PublicKey; credential: PublicKey };

/** A lens member: a key plus a SAS credential whose authority is that key. */
export async function createLensMember(provider: anchor.AnchorProvider, keypair: Keypair = Keypair.generate()): Promise<LensMember> {
    const credential = await writeSasAccount(provider, credentialBytes(keypair.publicKey));
    return { keypair, publicKey: keypair.publicKey, credential };
}

export async function attestOwnership(
    provider: anchor.AnchorProvider,
    member: LensMember,
    p: Omit<Parameters<typeof ownershipPayload>[0], "sourceObservedAt"> & {
        sourceObservedAt?: number; expiry?: number; schema?: PublicKey; authority?: PublicKey; credential?: PublicKey;
    }
): Promise<{ address: PublicKey; bytes: Buffer }> {
    const credential = p.credential ?? member.credential;
    const sourceObservedAt = p.sourceObservedAt ?? (await chainNow(provider.connection)) - 60;
    const bytes = attestationBytes({
        credential,
        schema: p.schema ?? schemaPda(credential, OWNERSHIP_SCHEMA),
        payload: ownershipPayload({ ...p, sourceObservedAt }),
        authority: p.authority ?? member.publicKey,
        expiry: p.expiry,
    });
    return { address: await writeSasAccount(provider, bytes), bytes };
}

export async function attestVerdict(
    provider: anchor.AnchorProvider,
    member: LensMember,
    p: Omit<Parameters<typeof verdictPayload>[0], "sourceObservedAt"> & { sourceObservedAt?: number; expiry?: number }
): Promise<PublicKey> {
    const sourceObservedAt = p.sourceObservedAt ?? (await chainNow(provider.connection)) - 60;
    return writeSasAccount(provider, attestationBytes({
        credential: member.credential,
        schema: schemaPda(member.credential, VERDICT_SCHEMA),
        payload: verdictPayload({ ...p, sourceObservedAt }),
        authority: member.publicKey,
        expiry: p.expiry,
    }));
}

export function findParcelAnchor(parcelId: string): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("parcel"), Buffer.from(parcelId)], PARCEL_NFT_PROGRAM_ID)[0];
}

export function findTally(programId: PublicKey, proposal: PublicKey, parcelId: string): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("consent"), proposal.toBuffer(), Buffer.from(parcelId)], programId)[0];
}

export function findRecord(programId: PublicKey, proposal: PublicKey, parcelId: string, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("acceptance"), proposal.toBuffer(), Buffer.from(parcelId), owner.toBuffer()],
        programId
    )[0];
}

/** Submit accept_with_attestations; the owner signs, the provider wallet pays unless `payer` is given. */
export async function acceptWithAttestation(
    proposalProgram: anchor.Program,
    a: { proposal: PublicKey; parcelId: string; owner: Keypair; ownership: PublicKey; credential: PublicKey; payout?: PublicKey | null; payer?: Keypair; recordOwner?: PublicKey }
): Promise<string> {
    const provider = proposalProgram.provider as anchor.AnchorProvider;
    const payer = a.payer?.publicKey ?? provider.wallet.publicKey;
    const signers = [a.owner, ...(a.payer ? [a.payer] : [])].filter(k => !k.publicKey.equals(provider.wallet.publicKey));
    return proposalProgram.methods
        .acceptWithAttestations(a.parcelId, a.payout ?? null)
        .accountsStrict({
            proposal: a.proposal,
            parcel: findParcelAnchor(a.parcelId),
            ownership: a.ownership,
            ownershipCredential: a.credential,
            tally: findTally(proposalProgram.programId, a.proposal, a.parcelId),
            record: findRecord(proposalProgram.programId, a.proposal, a.parcelId, a.recordOwner ?? a.owner.publicKey),
            owner: a.owner.publicKey,
            payer,
            systemProgram: SystemProgram.programId,
        })
        .signers(signers)
        .rpc();
}

/** A lens member attests `owner` for a single-owner parcel and the owner accepts. */
export async function attestAndAccept(
    proposalProgram: anchor.Program,
    member: LensMember,
    a: { proposal: PublicKey; parcelId: string; owner: Keypair; ownerCount?: number; payout?: PublicKey | null }
): Promise<{ ownership: PublicKey; bytes: Buffer }> {
    const provider = proposalProgram.provider as anchor.AnchorProvider;
    const { address, bytes } = await attestOwnership(provider, member, {
        parcelUid: a.parcelId, owner: a.owner.publicKey, ownerCount: a.ownerCount ?? 1,
    });
    await acceptWithAttestation(proposalProgram, {
        proposal: a.proposal, parcelId: a.parcelId, owner: a.owner, ownership: address,
        credential: member.credential, payout: a.payout,
    });
    return { ownership: address, bytes };
}

export async function settleWithVerdict(
    proposalProgram: anchor.Program,
    a: { proposal: PublicKey; verdict: PublicKey; credential: PublicKey }
): Promise<string> {
    const provider = proposalProgram.provider as anchor.AnchorProvider;
    const verdictRecord = PublicKey.findProgramAddressSync(
        [Buffer.from("verdict"), a.proposal.toBuffer(), a.verdict.toBuffer()],
        proposalProgram.programId
    )[0];
    return proposalProgram.methods
        .settleWithVerdict()
        .accountsStrict({
            proposal: a.proposal,
            verdict: a.verdict,
            verdictCredential: a.credential,
            verdictRecord,
            submitter: provider.wallet.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
}

/** Mint the parcel anchor if nobody has yet (anchors are ownerless and shared across suites). */
export async function ensureParcelAnchor(parcelProgram: anchor.Program, parcelId: string): Promise<PublicKey> {
    const provider = parcelProgram.provider as anchor.AnchorProvider;
    const anchorAddress = findParcelAnchor(parcelId);
    if (await provider.connection.getAccountInfo(anchorAddress)) return anchorAddress;
    await parcelProgram.methods
        .mintParcel(parcelId, `https://api.urbangametheory.xyz/parcels/parcelIds?ids=${parcelId}`)
        .accountsStrict({ parcel: anchorAddress, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    return anchorAddress;
}
