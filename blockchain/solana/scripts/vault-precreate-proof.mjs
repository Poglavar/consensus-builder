#!/usr/bin/env node
// Devnet proof that a pre-created vault can no longer block a proposal: a throwaway second wallet
// creates the donation-escrow and market vault token accounts first (anyone can, the addresses are
// predictable), then the proposal owner still opens both. With the pre-2026-09-23 `init` vaults both
// opens failed permanently. Refuses to write without --live; prints one JSON proof object.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mintProposal } from '../../../backend/agents/minter.js';
import { sendAndConfirmPolling } from '../../../backend/agents/solana-send.js';

const solanaRequire = createRequire(new URL('../package.json', import.meta.url));
const localRequire = createRequire(import.meta.url);
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = solanaRequire('@solana/web3.js');
const { createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } = solanaRequire('@solana/spl-token');
const web3 = { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction };
const support = localRequire('../../../frontend/js/solana/pledge-client.js');
const market = localRequire('../../../frontend/js/solana/market-client.js');
support.configure({ web3 });
market.configure({ web3 });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROPOSAL_PROGRAM = new PublicKey('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg');
const SUPPORT_PROGRAM = new PublicKey(support.constants.PROGRAM_ID);
const MARKET_PROGRAM = new PublicKey(market.constants.PROGRAM_ID);
const USDC_MINT = new PublicKey(support.constants.USDC_DEVNET_MINT);

const log = message => console.error(`[${new Date().toISOString()}] ${message}`);
const explorer = kind => value => `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
const tx = explorer('tx');
const address = explorer('address');

function loadKeypair(file) {
    const resolved = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, 'utf8'))));
}

async function main() {
    if (process.argv.includes('--help') || !process.argv.includes('--live')) {
        console.error('Usage: node scripts/vault-precreate-proof.mjs --live\n'
            + 'Mints one throwaway devnet proposal, pre-creates its escrow and market vaults from a second\n'
            + 'wallet, then opens both. Costs ~0.06 SOL of fees and rent. Refuses to write without --live.');
        process.exit(process.argv.includes('--help') ? 0 : 1);
    }
    const connection = new Connection(RPC_URL, 'confirmed');
    const owner = loadKeypair(process.env.SOLANA_KEYPAIR || '~/.config/solana/id.json');
    const other = Keypair.generate();
    const send = (transaction, signers) => sendAndConfirmPolling(connection, transaction, signers, { commitment: 'confirmed' });

    log('1/5 minting a throwaway proposal');
    const minted = await mintProposal({
        connection, programId: PROPOSAL_PROGRAM, ownerKeypair: owner,
        parcelIds: [`VAULT-PRECREATE-${Date.now()}`], imageUri: 'https://urbangametheory.xyz/#vault-precreate-proof',
        lens: [owner.publicKey], sendAndConfirm: sendAndConfirmPolling
    });
    const proposal = new PublicKey(minted.proposalPda);

    const [escrow] = support.getDonationEscrowPda(proposal, SUPPORT_PROGRAM);
    const escrowVault = getAssociatedTokenAddressSync(USDC_MINT, escrow, true);
    const [marketPda] = market.getMarketPda(proposal, MARKET_PROGRAM);
    const marketVault = market.getVaultAddress(marketPda, USDC_MINT);

    log('2/5 funding a second wallet for rent');
    const fundSignature = await send(new Transaction().add(SystemProgram.transfer({
        fromPubkey: owner.publicKey, toPubkey: other.publicKey, lamports: 20_000_000
    })), [owner]);

    log('3/5 second wallet pre-creates both vault token accounts');
    const precreateSignature = await send(new Transaction()
        .add(createAssociatedTokenAccountIdempotentInstruction(other.publicKey, escrowVault, escrow, USDC_MINT))
        .add(createAssociatedTokenAccountIdempotentInstruction(other.publicKey, marketVault, marketPda, USDC_MINT)), [other]);

    log('4/5 owner opens the donation escrow over the pre-created vault');
    const escrowSignature = await send(new Transaction().add(support.buildCreateDonationEscrowIx({
        proposal, owner: owner.publicKey, programId: SUPPORT_PROGRAM
    })), [owner]);

    log('5/5 owner opens the market over the pre-created vault');
    const marketSignature = await send(new Transaction().add(market.buildCreateMarketIx({
        proposal, stakeMint: USDC_MINT, creator: owner.publicKey, programId: MARKET_PROGRAM
    })), [owner]);

    // Read the artifacts back: the accounts must exist and the vaults must be owned by their PDAs.
    const escrowState = await support.readDonationEscrow(connection, proposal, SUPPORT_PROGRAM);
    const escrowVaultState = await getAccount(connection, escrowVault);
    const marketVaultState = await getAccount(connection, marketVault);
    const ok = Boolean(escrowState)
        && escrowVaultState.owner.equals(escrow)
        && marketVaultState.owner.equals(marketPda)
        && Boolean(await connection.getAccountInfo(marketPda));
    console.log(JSON.stringify({
        ok,
        proposal: address(proposal.toBase58()),
        precreatedBy: other.publicKey.toBase58(),
        transactions: {
            mint: tx(minted.signature), fund: tx(fundSignature), precreateVaults: tx(precreateSignature),
            createDonationEscrow: tx(escrowSignature), createMarket: tx(marketSignature)
        },
        accounts: {
            escrow: address(escrow.toBase58()), escrowVault: address(escrowVault.toBase58()),
            market: address(marketPda.toBase58()), marketVault: address(marketVault.toBase58())
        }
    }, null, 2));
    if (!ok) process.exit(1);
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] FAILED: ${error.message}`);
    process.exit(1);
});
