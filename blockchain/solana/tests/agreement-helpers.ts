// Localnet helpers for the agreement program (programs/agreement): test CIDs, the agreement PDA
// ["agreement", sponsor, sha256(cid)], one call per instruction, the lens's AgreementDecision-v1
// attestation through the mock SAS program, and an Agreement look-alike owned by another program.
// Shared by tests/agreement.ts and the market and pledge suites, whose subject is an agreement.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { LensMember, attestDecision, chainNow, writeSasAccount } from "./sas-mock.ts";

/** agreement::AgreementStatus codes, the byte at STATUS_OFFSET that markets and pledges read. */
export const STATUS = { active: 0, executed: 1, cancelled: 2, expired: 3 } as const;
/** Byte offsets of the Agreement account (programs/agreement/README.md, "Agreement account"). */
export const OFFSET = {
    authority: 8, lens: 40, payout: 72, deadline: 104, createdAt: 112, requiredLamports: 120, escrowLamports: 128,
    status: 136, openGround: 137, decision: 138, decisionAttestedAt: 139, decisionObservedAt: 147,
    decisionAttestation: 155, decisionHash: 187, executedAt: 219, bump: 227, cid: 228,
} as const;
/** 8-byte discriminator + 288 bytes. */
export const AGREEMENT_ACCOUNT_SIZE = 296;

export const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** CIDv1, raw codec (0x55), sha2-256, base32 lower case (`bafkrei…`, 59 characters) of `bytes`. */
export function cidOf(bytes: Buffer): string {
    const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), sha256(bytes)]);
    let out = "b";
    let buffer = 0;
    let bits = 0;
    for (const byte of raw) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += BASE32[(buffer >>> bits) & 31];
        }
        buffer &= (1 << bits) - 1;
    }
    if (bits) out += BASE32[(buffer << (5 - bits)) & 31];
    return out;
}

/** A fresh agreement CID: every call names another agreement/v1 object. */
export function testCid(label = "agreement"): string {
    return cidOf(Buffer.from(`${label}:${randomBytes(8).toString("hex")}`, "utf8"));
}

export function findAgreementPda(programId: PublicKey, sponsor: PublicKey, cid: string): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("agreement"), sponsor.toBuffer(), sha256(Buffer.from(cid, "utf8"))], programId)[0];
}

/** The provider's own keypair (the fee payer); never passed twice as a signer. */
function providerPayer(program: Program): Keypair {
    return ((program.provider as anchor.AnchorProvider).wallet as any).payer as Keypair;
}

function signersOf(program: Program, keypairs: Keypair[]): Keypair[] {
    const payer = providerPayer(program).publicKey;
    return keypairs.filter(keypair => !keypair.publicKey.equals(payer));
}

export type AgreementTerms = {
    /** The sponsor: signs create, pays the rent, funds, cancels, receives refunds. Default: the provider wallet. */
    sponsor?: Keypair;
    cid?: string;
    lens: PublicKey;
    /** Unix seconds (chain time); 0 for no deadline. */
    deadline?: number;
    openGround?: boolean;
    requiredLamports?: number | bigint;
    /** Default: the sponsor. */
    payout?: PublicKey;
    /** Lamports funded right after create (0: none). */
    fund?: number | bigint;
};

export type CreatedAgreement = { agreement: PublicKey; cid: string; sponsor: Keypair; signature: string };

/** create(cid, lens, deadline, open_ground, required_lamports, payout) from the sponsor, then an optional fund. */
export async function createAgreement(program: Program, terms: AgreementTerms): Promise<CreatedAgreement> {
    const sponsor = terms.sponsor ?? providerPayer(program);
    const cid = terms.cid ?? testCid();
    const agreement = findAgreementPda(program.programId, sponsor.publicKey, cid);
    const signature = await program.methods
        .create(
            cid,
            terms.lens,
            new anchor.BN(terms.deadline ?? 0),
            terms.openGround ?? false,
            new anchor.BN((terms.requiredLamports ?? 0).toString()),
            terms.payout ?? sponsor.publicKey
        )
        .accountsStrict({ agreement, authority: sponsor.publicKey, systemProgram: SystemProgram.programId })
        .signers(signersOf(program, [sponsor]))
        .rpc();
    if (terms.fund && BigInt(terms.fund) > 0n) await fundAgreement(program, agreement, sponsor, terms.fund);
    return { agreement, cid, sponsor, signature };
}

export function fundAgreement(program: Program, agreement: PublicKey, authority: Keypair, lamports: number | bigint): Promise<string> {
    return program.methods
        .fund(new anchor.BN(lamports.toString()))
        .accountsStrict({ agreement, authority: authority.publicKey, systemProgram: SystemProgram.programId })
        .signers(signersOf(program, [authority]))
        .rpc();
}

/** attest() with an attestation and the credential it names (permissionless: the provider sends it). */
export function recordDecision(program: Program, agreement: PublicKey, attestation: PublicKey, credential: PublicKey): Promise<string> {
    return program.methods.attest().accountsStrict({ agreement, attestation, credential }).rpc();
}

/** The lens issues a satisfied AgreementDecision-v1 for (cid, sponsor) and anyone records it. */
export async function attestSatisfied(
    program: Program,
    lens: LensMember,
    a: { agreement: PublicKey; cid: string; sponsor: PublicKey }
): Promise<PublicKey> {
    const provider = program.provider as anchor.AnchorProvider;
    const { address } = await attestDecision(provider, lens, { agreementCid: a.cid, sponsor: a.sponsor });
    await recordDecision(program, a.agreement, address, lens.credential);
    return address;
}

export function executeAgreement(program: Program, agreement: PublicKey, payout: PublicKey): Promise<string> {
    return program.methods.execute().accountsStrict({ agreement, payout }).rpc();
}

/** The lens's satisfied decision recorded, then execution (escrow to the payout): status Executed. */
export async function settleExecuted(program: Program, lens: LensMember, created: CreatedAgreement, payout?: PublicKey): Promise<void> {
    await attestSatisfied(program, lens, { agreement: created.agreement, cid: created.cid, sponsor: created.sponsor.publicKey });
    const account: any = await program.account.agreement.fetch(created.agreement);
    await executeAgreement(program, created.agreement, payout ?? account.payout);
}

export function cancelAgreement(program: Program, agreement: PublicKey, authority: Keypair): Promise<string> {
    return program.methods
        .cancel()
        .accountsStrict({ agreement, authority: authority.publicKey })
        .signers(signersOf(program, [authority]))
        .rpc();
}

/** expire(): anyone (the provider sends it); the escrow returns to `authority`, who need not sign. */
export function expireAgreement(program: Program, agreement: PublicKey, authority: PublicKey): Promise<string> {
    return program.methods.expire().accountsStrict({ agreement, authority }).rpc();
}

/** The status byte a market or pledge reads at offset 136. */
export async function statusByte(connection: anchor.web3.Connection, agreement: PublicKey): Promise<number> {
    const info = await connection.getAccountInfo(agreement);
    if (!info) throw new Error(`agreement ${agreement.toBase58()} does not exist`);
    return info.data[OFFSET.status];
}

/** Poll the validator's clock (never the host's) until it reaches `instant`. */
export async function waitForChainTime(connection: anchor.web3.Connection, instant: number): Promise<void> {
    while ((await chainNow(connection)) < instant) {
        await new Promise(resolve => setTimeout(resolve, 400));
    }
}

/**
 * Agreement account bytes in the program's own layout (discriminator, Active, no decision), written
 * into an account the mock SAS program owns: every byte a reader checks is right except the owner.
 */
export async function writeAgreementLookalike(
    provider: anchor.AnchorProvider,
    a: { authority: PublicKey; lens: PublicKey; cid?: string; status?: number }
): Promise<PublicKey> {
    const cid = a.cid ?? testCid("lookalike");
    const bytes = Buffer.alloc(AGREEMENT_ACCOUNT_SIZE);
    sha256("account:Agreement").copy(bytes, 0, 0, 8);
    a.authority.toBuffer().copy(bytes, OFFSET.authority);
    a.lens.toBuffer().copy(bytes, OFFSET.lens);
    a.authority.toBuffer().copy(bytes, OFFSET.payout);
    bytes[OFFSET.status] = a.status ?? STATUS.active;
    bytes.writeUInt32LE(cid.length, OFFSET.cid);
    Buffer.from(cid, "utf8").copy(bytes, OFFSET.cid + 4);
    return writeSasAccount(provider, bytes);
}

/** Lamports to fresh keypairs in one transaction from the provider wallet. */
export async function fundKeypairs(provider: anchor.AnchorProvider, keypairs: Keypair[], lamports = anchor.web3.LAMPORTS_PER_SOL): Promise<void> {
    const tx = new anchor.web3.Transaction();
    for (const keypair of keypairs) {
        tx.add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: keypair.publicKey, lamports }));
    }
    await provider.sendAndConfirm(tx);
}
