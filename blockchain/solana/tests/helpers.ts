import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

export function findProposalCounterPDA(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_counter")],
        programId
    );
}

export function findProposalPDA(programId: PublicKey, count: number): [PublicKey, number] {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(count));
    return PublicKey.findProgramAddressSync(
        [Buffer.from("proposal"), buf],
        programId
    );
}

export function findParcelPDA(programId: PublicKey, parcelId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("parcel"), Buffer.from(parcelId)],
        programId
    );
}

export async function airdrop(
    connection: anchor.web3.Connection,
    pubkey: PublicKey,
    lamports: number = 10 * anchor.web3.LAMPORTS_PER_SOL
) {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latestBlockhash });
}

export async function initializeProposalCounter(
    program: anchor.Program,
    authority: anchor.web3.Keypair
): Promise<PublicKey> {
    const [counterPDA] = findProposalCounterPDA(program.programId);

    await program.methods
        .initialize()
        .accounts({
            proposalCounter: counterPDA,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
        } as any)
        .signers([authority])
        .rpc();

    return counterPDA;
}
