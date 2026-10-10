#!/usr/bin/env node
// Open a proposal's (or named plan's) yes/no pool if it has none, then stake devnet USDC on one side,
// from a keypair on this machine. The same instructions the Bets sheet sends (agents/bettor.js →
// frontend/js/solana/market-client.js). Dry run by default; --run signs. With --target the amount is
// the position the wallet should END with on that side, so a rerun tops up instead of doubling.
//
//   node scripts/stake-pool.mjs --account <proposal or plan account> --keypair <wallet.json> --side yes|no --amount 0.25 [--target] [--run]

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import { Connection, Keypair } from '@solana/web3.js';
import { ensureMarketAndStake, usdcToAtomic } from '../agents/bettor.js';
import { sendAndConfirmPolling } from '../agents/solana-send.js';
import { DEVNET_USDC_MINT } from '../routes/markets.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const require = createRequire(import.meta.url);
const marketClient = require('../../frontend/js/solana/market-client.js');
marketClient.configure({ web3: require('@solana/web3.js') });
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const usdc = atomic => (Number(atomic) / 1e6).toFixed(2);

const { values } = parseArgs({ options: {
    account: { type: 'string' }, keypair: { type: 'string' }, side: { type: 'string' }, amount: { type: 'string' },
    target: { type: 'boolean', default: false }, run: { type: 'boolean', default: false }, rpc: { type: 'string' },
    help: { type: 'boolean', default: false }
} });
if (values.help || !values.account || !values.keypair || !['yes', 'no'].includes(values.side) || !values.amount) {
    console.log('Usage: node scripts/stake-pool.mjs --account <account> --keypair <wallet.json> --side yes|no --amount <usdc> [--target] [--run]');
    process.exit(values.help ? 0 : 1);
}

const connection = new Connection(values.rpc || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(values.keypair, 'utf8'))));
const side = values.side === 'yes' ? marketClient.constants.SIDE_YES : marketClient.constants.SIDE_NO;
const amountAtomic = usdcToAtomic(values.amount);
const before = await marketClient.readMarket(connection, values.account);
log(`${values.account}: pool ${before ? `yes ${usdc(before.yesPool)} / no ${usdc(before.noPool)} USDC` : 'not opened yet'}`);
log(`${wallet.publicKey.toBase58()} → ${values.amount} USDC on ${values.side.toUpperCase()}${values.target ? ' (target position)' : ''}`);
if (!values.run) { log('dry run: nothing signed (add --run)'); process.exit(0); }
const result = await ensureMarketAndStake({
    connection, ownerKeypair: wallet, proposalPda: values.account, stakeMint: DEVNET_USDC_MINT,
    side, amountAtomic, targetAmount: values.target, sendAndConfirm: sendAndConfirmPolling
});
const after = await marketClient.readMarket(connection, values.account);
log(`${result.created ? `opened pool ${result.marketPda} (${result.createSignature}); ` : ''}stake ${result.stakeSignature || 'not needed'}`);
log(`pool now yes ${usdc(after.yesPool)} / no ${usdc(after.noPool)} USDC`);
