#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

const envPath = fs.existsSync(path.join(__dirname, '../.env'))
  ? path.join(__dirname, '../.env')
  : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

const RPC_URL = process.env.ETHEREUM_RPC_URL || process.env.RPC_URL;
const FUND_AMOUNT_ETH = process.env.LENS_FUND_AMOUNT_ETH || '0.5';
const FUND_AMOUNT_WEI = ethers.parseEther(FUND_AMOUNT_ETH);
const FUNDING_PRIVATE_KEY = process.env.ACCOUNT_1_PRIVATE_KEY || process.env.ACCOUNT_1_PK;

if (!RPC_URL) {
  throw new Error('ETHEREUM_RPC_URL or RPC_URL must be set (Sepolia RPC endpoint)');
}

if (!FUNDING_PRIVATE_KEY) {
  throw new Error('ACCOUNT_1_PRIVATE_KEY must be set to fund lens accounts');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const funder = new ethers.Wallet(FUNDING_PRIVATE_KEY, provider);

function resolveLensAccounts() {
  const accounts = [];
  for (let i = 1; i <= 3; i++) {
    const envAddress =
      process.env[`LENS_ACCOUNT_${i}`] ||
      process.env[`LENS_ACCOUNT_${i}_ADDRESS`] ||
      process.env[`LENS_${i}`] ||
      process.env[`LENS_${i}_ADDRESS`];
    const envPrivateKey =
      process.env[`LENS_ACCOUNT_${i}_PRIVATE_KEY`] ||
      process.env[`LENS_${i}_PK`] ||
      process.env[`LENS_${i}_PRIVATE_KEY`];

    if (envAddress) {
      accounts.push({ label: `lens ${i}`, address: envAddress });
      continue;
    }

    if (envPrivateKey) {
      try {
        const wallet = new ethers.Wallet(envPrivateKey);
        accounts.push({ label: `lens ${i}`, address: wallet.address });
      } catch (err) {
        throw new Error(`Invalid lens ${i} private key: ${err.message || err}`);
      }
    }
  }

  if (accounts.length === 0) {
    throw new Error('Set LENS_ACCOUNT_1..3 or LENS_1..3 (or their private keys) in .env');
  }

  const unique = [];
  const seen = new Set();
  for (const account of accounts) {
    const key = account.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(account);
  }

  return unique;
}

async function main() {
  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n) {
    throw new Error(
      `RPC network mismatch: expected Sepolia (11155111) but got chainId ${network.chainId}`
    );
  }

  const lensAccounts = resolveLensAccounts();
  const funderAddress = await funder.getAddress();

  console.log(`Funding lens accounts on ${network.name} with ${FUND_AMOUNT_ETH} ETH each`);
  console.log(`Funder: ${funderAddress}`);
  console.log('='.repeat(80));

  const funderBalance = await provider.getBalance(funderAddress);
  const totalNeededWei = FUND_AMOUNT_WEI * BigInt(lensAccounts.length);
  if (funderBalance < totalNeededWei) {
    const neededEth = ethers.formatEther(totalNeededWei);
    const currentEth = ethers.formatEther(funderBalance);
    throw new Error(`Insufficient balance. Need ${neededEth} ETH, have ${currentEth} ETH.`);
  }

  let nonce = await provider.getTransactionCount(funderAddress, 'pending');
  let successCount = 0;

  for (const account of lensAccounts) {
    console.log(`\nSending to ${account.label} (${account.address})`);
    const before = await provider.getBalance(account.address);
    console.log(`Before: ${ethers.formatEther(before)} ETH`);

    try {
      const tx = await funder.sendTransaction({
        to: account.address,
        value: FUND_AMOUNT_WEI,
        nonce: nonce++,
      });
      console.log(`Tx: ${tx.hash}`);
      await tx.wait();
      const after = await provider.getBalance(account.address);
      console.log(`After: ${ethers.formatEther(after)} ETH`);
      console.log('Status: success');
      successCount += 1;
    } catch (err) {
      console.error(`Status: failed (${err.message || err})`);
    }
  }

  console.log('\n'.concat('='.repeat(80)));
  console.log(`Finished: ${successCount}/${lensAccounts.length} funded`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

