// Generates the genesis accounts the proposal_pledge localnet suite needs: the hard-coded devnet
// USDC mint address (with a local test-only mint authority) and an already-Expired proposal with
// its donation escrow and pledge book, because no proposal_nft instruction ever sets Expired.
//
// Usage: node tests/fixtures/generate-pledge-fixtures.mjs   (run from blockchain/solana)
// Idempotent: existing keypairs and the manifest are reused, so Anchor.toml addresses stay valid.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

const { MintLayout, AccountLayout, MINT_SIZE, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = createRequire(import.meta.url)("@solana/spl-token");

const here = path.dirname(fileURLToPath(import.meta.url));
const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROPOSAL_NFT_PROGRAM_ID = new PublicKey("3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg");
const PLEDGE_PROGRAM_ID = new PublicKey("1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g");
const STATUS_EXPIRED = 3;
const EXPIRED_DONATION = 4_000_000n;
const EXPIRED_PLEDGE = 6_000_000n;

function keypair(name) {
    const file = path.join(here, `${name}.keypair.json`);
    if (existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
    const kp = Keypair.generate();
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + "\n");
    return kp;
}

// Local validator default rent: (128-byte overhead + data) * 3480 lamports/byte-year * 2 years.
const rentExempt = (len) => (128 + len) * 3480 * 2;
const discriminator = (name) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u8 = (v) => Buffer.from([v]);
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

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
const expiredProposal = keypair("expired-proposal-address").publicKey;
const expiredBeneficiary = keypair("expired-beneficiary").publicKey;
const expiredDonor = keypair("expired-donor");
const expiredPledger = keypair("expired-pledger");

// 1. The devnet USDC address as a local mint; supply is only what the fixture vault holds.
const mint = Buffer.alloc(MINT_SIZE);
MintLayout.encode({
    mintAuthorityOption: 1, mintAuthority: mintAuthority.publicKey, supply: EXPIRED_DONATION,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
}, mint);
writeAccount("devnet-usdc-mint.json", DEVNET_USDC_MINT, TOKEN_PROGRAM_ID, mint);

// 2. A proposal_nft Proposal already in Expired; field order mirrors proposal_nft::Proposal.
const proposal = Buffer.concat([
    discriminator("Proposal"), u64(9_000_000), expiredBeneficiary.toBuffer(),
    u32(1), str("HR-plg-expired-fixture"), u8(0), str("ipfs://expired-fixture"), u8(0), u8(STATUS_EXPIRED),
    u64(0), u64(0), u64(0), u32(0), u32(1), expiredBeneficiary.toBuffer(), u8(255),
]);
writeAccount("expired-proposal.json", expiredProposal, PROPOSAL_NFT_PROGRAM_ID, proposal);

// 3. Its donation escrow, holding one funded donation from expiredDonor.
const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("donation_escrow"), expiredProposal.toBuffer()], PLEDGE_PROGRAM_ID);
const vault = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, escrow, true);
const donationId = createHash("sha256").update("expired-fixture-donation").digest();
const [position, positionBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("donation"), escrow.toBuffer(), expiredDonor.publicKey.toBuffer(), donationId], PLEDGE_PROGRAM_ID);
writeAccount("expired-escrow.json", escrow, PLEDGE_PROGRAM_ID, Buffer.concat([
    discriminator("DonationEscrow"), expiredProposal.toBuffer(), expiredBeneficiary.toBuffer(),
    DEVNET_USDC_MINT.toBuffer(), vault.toBuffer(),
    u64(EXPIRED_DONATION), u64(0), u64(0), u64(1), u64(1), u8(0), u8(escrowBump),
]));
const vaultData = Buffer.alloc(ACCOUNT_SIZE);
AccountLayout.encode({
    mint: DEVNET_USDC_MINT, owner: escrow, amount: EXPIRED_DONATION, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
}, vaultData);
writeAccount("expired-vault.json", vault, TOKEN_PROGRAM_ID, vaultData);
writeAccount("expired-position.json", position, PLEDGE_PROGRAM_ID, Buffer.concat([
    discriminator("DonationPosition"), escrow.toBuffer(), expiredDonor.publicKey.toBuffer(), donationId,
    u64(EXPIRED_DONATION), u8(0), u8(positionBump),
]));

// 4. Its pledge book, holding one active commitment from expiredPledger.
const [book, bookBump] = PublicKey.findProgramAddressSync([Buffer.from("pledge_book"), expiredProposal.toBuffer()], PLEDGE_PROGRAM_ID);
const [commitment, commitmentBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pledge"), book.toBuffer(), expiredPledger.publicKey.toBuffer()], PLEDGE_PROGRAM_ID);
writeAccount("expired-book.json", book, PLEDGE_PROGRAM_ID, Buffer.concat([
    discriminator("PledgeBook"), expiredProposal.toBuffer(), expiredBeneficiary.toBuffer(), DEVNET_USDC_MINT.toBuffer(),
    u64(EXPIRED_PLEDGE), u64(0), u64(0), u64(1), u64(1), u64(0), u8(bookBump),
]));
writeAccount("expired-commitment.json", commitment, PLEDGE_PROGRAM_ID, Buffer.concat([
    discriminator("PledgeCommitment"), book.toBuffer(), expiredProposal.toBuffer(), expiredPledger.publicKey.toBuffer(),
    u64(EXPIRED_PLEDGE), u8(0), u8(1), u8(commitmentBump),
]));

const manifest = {
    usdcMint: DEVNET_USDC_MINT.toBase58(),
    expiredProposal: expiredProposal.toBase58(), expiredBeneficiary: expiredBeneficiary.toBase58(),
    expiredEscrow: escrow.toBase58(), expiredVault: vault.toBase58(), expiredPosition: position.toBase58(),
    expiredDonationId: donationId.toString("hex"), expiredDonation: EXPIRED_DONATION.toString(),
    expiredBook: book.toBase58(), expiredCommitment: commitment.toBase58(), expiredPledge: EXPIRED_PLEDGE.toString(),
};
writeFileSync(path.join(here, "pledge-fixtures.json"), JSON.stringify(manifest, null, 2) + "\n");

const toml = [
    ["devnet-usdc-mint.json", DEVNET_USDC_MINT], ["expired-proposal.json", expiredProposal],
    ["expired-escrow.json", escrow], ["expired-vault.json", vault], ["expired-position.json", position],
    ["expired-book.json", book], ["expired-commitment.json", commitment],
].map(([file, key]) => `[[test.validator.account]]\naddress = "${key.toBase58()}"\nfilename = "tests/fixtures/${file}"\n`);
console.log(`[${new Date().toISOString()}] fixtures written to ${here}; Anchor.toml needs:\n\n${toml.join("\n")}`);
