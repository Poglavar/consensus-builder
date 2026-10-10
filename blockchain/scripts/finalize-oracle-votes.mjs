#!/usr/bin/env node
// One-shot, restart-safe keeper. Run from a scheduler after deployment; on-chain state is
// the checkpoint, so rerunning skips already-finalized and already-released proposals.
import { ethers } from 'ethers';

const usage = 'Usage: node scripts/finalize-oracle-votes.mjs --rpc <url> --contract <address> [--apply]\n' +
    'Dry-run is the default. --apply requires ORACLE_KEEPER_PRIVATE_KEY in the environment.';
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
    console.log(usage);
    process.exit(0);
}
const valueAfter = flag => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
};
const rpc = valueAfter('--rpc');
const contractAddress = valueAfter('--contract');
const apply = args.includes('--apply');
if (!rpc || !contractAddress || (apply && !process.env.ORACLE_KEEPER_PRIVATE_KEY)) {
    console.error(usage);
    process.exit(2);
}

const abi = [
    'function totalSupply() view returns (uint256)',
    'function tokenByIndex(uint256) view returns (uint256)',
    'function getVoteInfo(uint256) view returns (bool,uint256,uint256,bool)',
    'function getOracleVoteInfo(uint256) view returns (bool,address,address,uint256,uint256,uint256,uint256,address,bool)',
    'function getProposal(uint256) view returns (string[],bool,string,bool,uint8,uint256,uint256,uint256,uint256,uint256)',
    'function finalizeOracleVote(uint256)',
    'function withdrawOracleFunds(uint256)'
];
const provider = new ethers.JsonRpcProvider(rpc);
const signer = apply ? new ethers.Wallet(process.env.ORACLE_KEEPER_PRIVATE_KEY, provider) : provider;
const contract = new ethers.Contract(contractAddress, abi, signer);
const total = Number(await contract.totalSupply());
if (!Number.isSafeInteger(total)) throw new Error('Proposal count exceeds safe integer range.');
let due = 0;
let finalized = 0;
let released = 0;
let failed = 0;
const reportProgress = scanned => {
    if (scanned % 100 === 0 || scanned === total) {
        console.log(`[${new Date().toISOString()}] ${scanned}/${total} scanned · ${due} due · ${finalized} finalized · ${released} released · ${failed} failed`);
    }
};
for (let i = 0; i < total; i++) {
    const id = await contract.tokenByIndex(i);
    let oracle;
    try {
        oracle = await contract.getOracleVoteInfo(id);
    } catch (error) {
        throw new Error('Configured proposal contract does not support oracle votes.', { cause: error });
    }
    if (!oracle[0]) {
        reportProgress(i + 1);
        continue;
    }
    const vote = await contract.getVoteInfo(id);
    if (!vote[3]) {
        reportProgress(i + 1);
        continue;
    }
    due++;
    try {
        if (!oracle[8]) {
            if (apply) {
                const tx = await contract.finalizeOracleVote(id);
                await tx.wait();
                finalized++;
                console.log(`[${new Date().toISOString()}] proposal ${id}: finalized ${tx.hash}`);
            } else {
                console.log(`[${new Date().toISOString()}] proposal ${id}: would finalize`);
            }
        }
        const proposal = await contract.getProposal(id);
        if (proposal[5] > 0n || proposal[6] > 0n) {
            if (apply) {
                const tx = await contract.withdrawOracleFunds(id);
                await tx.wait();
                released++;
                console.log(`[${new Date().toISOString()}] proposal ${id}: released escrow ${tx.hash}`);
            } else {
                console.log(`[${new Date().toISOString()}] proposal ${id}: would release escrow`);
            }
        }
    } catch (error) {
        failed++;
        console.error(`[${new Date().toISOString()}] proposal ${id}: ${error.shortMessage || error.message}`);
    }
    reportProgress(i + 1);
}
console.log(`[${new Date().toISOString()}] complete: ${total} scanned · ${due} due · ${finalized} finalized · ${released} released · ${failed} failed`);
if (failed) process.exitCode = 1;
