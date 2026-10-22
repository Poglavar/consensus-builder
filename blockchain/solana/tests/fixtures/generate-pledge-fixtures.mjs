// Generates the genesis account the proposal_pledge localnet suite needs: the hard-coded devnet USDC
// mint address, with a local test-only mint authority, because the program accepts no other mint.
// Since M3 the suite's subject is an agreement, and its Expired agreements are made live by the
// agreement program's `expire` after their deadline, so no subject, escrow or book is a fixture.
//
// Usage: node tests/fixtures/generate-pledge-fixtures.mjs   (run from blockchain/solana)
// Idempotent: the mint authority keypair is reused, so the mint fixture and Anchor.toml stay valid.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

const { MintLayout, MINT_SIZE, TOKEN_PROGRAM_ID } = createRequire(import.meta.url)("@solana/spl-token");

const here = path.dirname(fileURLToPath(import.meta.url));
const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

function keypair(name) {
    const file = path.join(here, `${name}.keypair.json`);
    if (existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
    const kp = Keypair.generate();
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + "\n");
    return kp;
}

// Local validator default rent: (128-byte overhead + data) * 3480 lamports/byte-year * 2 years.
const rentExempt = (len) => (128 + len) * 3480 * 2;

function writeAccount(file, pubkey, owner, data) {
    const json = {
        pubkey: pubkey.toBase58(),
        account: {
            lamports: rentExempt(data.length),
            data: [data.toString("base64"), "base64"],
            owner: owner.toBase58(),
            executable: false,
            rentEpoch: 0,
            space: data.length,
        },
    };
    writeFileSync(path.join(here, file), JSON.stringify(json, null, 2) + "\n");
}

const mintAuthority = keypair("local-usdc-mint-authority");

// The devnet USDC address as a local mint with no supply: the suite mints what each party holds.
const mint = Buffer.alloc(MINT_SIZE);
MintLayout.encode({
    mintAuthorityOption: 1, mintAuthority: mintAuthority.publicKey, supply: 0n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
}, mint);
writeAccount("devnet-usdc-mint.json", DEVNET_USDC_MINT, TOKEN_PROGRAM_ID, mint);

writeFileSync(path.join(here, "pledge-fixtures.json"), JSON.stringify({ usdcMint: DEVNET_USDC_MINT.toBase58() }, null, 2) + "\n");

const toml = `[[test.validator.account]]\naddress = "${DEVNET_USDC_MINT.toBase58()}"\nfilename = "tests/fixtures/devnet-usdc-mint.json"\n`;
console.log(`[${new Date().toISOString()}] fixtures written to ${here}; Anchor.toml needs:\n\n${toml}`);
