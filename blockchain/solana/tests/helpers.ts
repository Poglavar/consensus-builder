// Localnet helpers shared by the program suites.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export async function airdrop(
    connection: anchor.web3.Connection,
    pubkey: PublicKey,
    lamports: number = 10 * anchor.web3.LAMPORTS_PER_SOL
) {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latestBlockhash });
}
