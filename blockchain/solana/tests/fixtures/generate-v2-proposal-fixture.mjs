// Generates a proposal_nft Proposal account in the v2 layout (lens model, before the v3 site_hash /
// open_ground fields), 4096 bytes and zero-padded like every real account, so the localnet suite can
// prove that v3 still reads and drives accounts minted by v2.
//
// Usage: node tests/fixtures/generate-v2-proposal-fixture.mjs   (run from blockchain/solana)
// Idempotent: existing keypairs are reused, so the Anchor.toml address stays valid.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROPOSAL_NFT_PROGRAM_ID = new PublicKey("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");
const ACCOUNT_SPACE = 4096;
const V2_PARCEL_ID = "HR-v2-fixture";
const V2_SOL_BALANCE = 100_000_000n;

function keypair(name) {
    const file = path.join(here, `${name}.keypair.json`);
    if (existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
    const kp = Keypair.generate();
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + "\n");
    return kp;
}

const rentExempt = (len) => (128 + len) * 3480 * 2;
const discriminator = (name) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u8 = (v) => Buffer.from([v]);
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

const address = keypair("v2-proposal-address").publicKey;
const owner = keypair("v2-proposal-owner").publicKey;
const member = keypair("v2-lens-member").publicKey;

// v2 field order: proposal_id, owner, parcel_ids, is_conditional, image_uri, acceptance_possible,
// status, sol_balance, token_balance, acceptance_count, accepted_parcels, lens, bump,
// verdict_may_execute. Active, one parcel, nothing accepted, 0.1 SOL escrowed.
const content = Buffer.concat([
    discriminator("Proposal"), u64(8_000_000), owner.toBuffer(),
    u32(1), str(V2_PARCEL_ID), u8(0), str("ipfs://v2-fixture"), u8(1), u8(0),
    u64(V2_SOL_BALANCE), u64(0), u64(0), u32(0), u32(1), member.toBuffer(), u8(255), u8(0),
]);
const data = Buffer.concat([content, Buffer.alloc(ACCOUNT_SPACE - content.length)]);

writeFileSync(path.join(here, "v2-proposal.json"), JSON.stringify({
    pubkey: address.toBase58(),
    account: {
        lamports: rentExempt(data.length) + Number(V2_SOL_BALANCE),
        data: [data.toString("base64"), "base64"],
        owner: PROPOSAL_NFT_PROGRAM_ID.toBase58(),
        executable: false,
        rentEpoch: 0,
        space: data.length,
    },
}, null, 2) + "\n");

console.log(`[${new Date().toISOString()}] v2 proposal fixture written; Anchor.toml needs:

[[test.validator.account]]
address = "${address.toBase58()}"
filename = "tests/fixtures/v2-proposal.json"`);
