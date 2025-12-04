#!/usr/bin/env node

/*
 * Accept Proposals Randomly
 * -------------------------
 * - Fetches all proposals from ProposalNFT contract
 * - For each proposal, gets the parcels that are part of it
 * - For each parcel, flips a coin (50% chance)
 * - If coin says yes, finds the parcel owner and calls acceptProposal()
 * - Uses ACCOUNT_0_PRIVATE_KEY through ACCOUNT_5_PRIVATE_KEY from .env
 */

const path = require('path');
const fs = require('fs');

// Try to load .env from current directory first, then parent
const envPath = fs.existsSync(path.join(__dirname, '../.env'))
    ? path.join(__dirname, '../.env')
    : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

const { ethers } = require('ethers');
const { resolveContractAddress } = require('./deploymentUtils');

// Contract ABIs
const PROPOSAL_NFT_ABI = [
    "function totalSupply() public view returns (uint256)",
    "function getProposal(uint256 proposalId) public view returns (string[] memory parcelIds, bool isConditional, string memory imageURI, bool acceptancePossible, uint8 status, uint256 ethBalance, uint256 tokenBalance, uint256 acceptanceCount, uint256 expiryTimestamp, uint256 expiringPercentage)",
    "function acceptProposal(uint256 proposalId, string memory parcelId) public",
    "function hasAccepted(uint256 proposalId, string memory parcelId) public view returns (bool)"
];

const PARCEL_NFT_ABI = [
    "function ownerOfParcelId(string calldata parcelId) external view returns (address)",
    "function tokenIdForParcelId(string calldata parcelId) public view returns (uint256)"
];

const RPC_URL = process.env.RPC_URL || process.env.ETHEREUM_RPC_URL;

// Account configuration
const ACCOUNT_KEYS = [
    { addressKey: 'ACCOUNT_0_ADDRESS', privateKeyKey: 'ACCOUNT_0_PRIVATE_KEY' },
    { addressKey: 'ACCOUNT_1_ADDRESS', privateKeyKey: 'ACCOUNT_1_PRIVATE_KEY' },
    { addressKey: 'ACCOUNT_2_ADDRESS', privateKeyKey: 'ACCOUNT_2_PRIVATE_KEY' },
    { addressKey: 'ACCOUNT_3_ADDRESS', privateKeyKey: 'ACCOUNT_3_PRIVATE_KEY' },
    { addressKey: 'ACCOUNT_4_ADDRESS', privateKeyKey: 'ACCOUNT_4_PRIVATE_KEY' },
    { addressKey: 'ACCOUNT_5_ADDRESS', privateKeyKey: 'ACCOUNT_5_PRIVATE_KEY' }
];

// Load all accounts from environment
function loadAccounts() {
    const accounts = [];
    for (const { addressKey, privateKeyKey } of ACCOUNT_KEYS) {
        const address = process.env[addressKey];
        const privateKey = process.env[privateKeyKey];
        
        if (address && privateKey) {
            accounts.push({ address, privateKey });
        }
    }
    
    if (accounts.length === 0) {
        throw new Error('No accounts found. Please set ACCOUNT_0_ADDRESS/ACCOUNT_0_PRIVATE_KEY through ACCOUNT_5_ADDRESS/ACCOUNT_5_PRIVATE_KEY in .env');
    }
    
    return accounts;
}

// Helper function to flip a coin (50% chance)
function shouldAccept() {
    return Math.random() < 0.5;
}

// Find which account owns a parcel
async function findParcelOwner(parcelContract, parcelId, accounts) {
    try {
        const ownerAddress = await parcelContract.ownerOfParcelId(parcelId);
        const owner = accounts.find(acc => acc.address.toLowerCase() === ownerAddress.toLowerCase());
        return owner || null;
    } catch (error) {
        // Parcel might not exist or not be minted
        return null;
    }
}

// Accept a proposal for a parcel
async function acceptProposalForParcel(proposalContract, proposalId, parcelId, wallet, previousTx = null) {
    try {
        // Check if already accepted
        const alreadyAccepted = await proposalContract.hasAccepted(proposalId, parcelId);
        if (alreadyAccepted) {
            return { success: false, reason: 'already-accepted' };
        }

        // Get nonce if we have a previous transaction
        let nonce;
        if (previousTx) {
            // Ensure both are BigInt before adding
            const prevNonce = typeof previousTx.nonce === 'bigint' ? previousTx.nonce : BigInt(previousTx.nonce);
            nonce = prevNonce + 1n;
        } else {
            const txCount = await wallet.provider.getTransactionCount(wallet.address, 'pending');
            nonce = BigInt(txCount);
        }

        console.log(`    Using nonce: ${nonce.toString()}`);
        
        // Call acceptProposal
        const tx = await proposalContract.acceptProposal(proposalId, parcelId, { nonce });
        console.log(`    Transaction hash: ${tx.hash}`);
        console.log(`    Waiting for confirmation...`);
        
        const receipt = await tx.wait();
        console.log(`    ✅ Accepted - Block: ${receipt.blockNumber}`);
        
        return { success: true, tx, receipt };
    } catch (error) {
        return { success: false, reason: error.message, error };
    }
}

async function main() {
    try {
        console.log("\n🎲 Accepting Proposals Randomly");
        console.log("----------------------------------------");

        if (!RPC_URL) {
            throw new Error('RPC_URL or ETHEREUM_RPC_URL must be set in environment.');
        }

        // Load accounts
        const accounts = loadAccounts();
        console.log(`\n📋 Loaded ${accounts.length} account(s) from .env:`);
        accounts.forEach((acc, idx) => {
            console.log(`  ${ACCOUNT_KEYS[idx].addressKey}: ${acc.address}`);
        });

        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const network = await provider.getNetwork();

        // Resolve contract addresses from deployments
        const proposalAddressInfo = resolveContractAddress('ProposalNFT', network.chainId);
        if (!proposalAddressInfo) {
            throw new Error('ProposalNFT address not found in deployments. Run `yarn deploy` first.');
        }

        const parcelNftAddressInfo = resolveContractAddress('ParcelNFT', network.chainId);
        if (!parcelNftAddressInfo) {
            throw new Error('ParcelNFT address not found in deployments. Run `yarn deploy` first.');
        }

        const proposalNftAddress = proposalAddressInfo.address;
        const parcelNftAddress = parcelNftAddressInfo.address;
        
        console.log(`\nPROPOSAL_NFT_ADDRESS: ${proposalNftAddress} (${proposalAddressInfo.source})`);
        console.log(`PARCEL_NFT_ADDRESS: ${parcelNftAddress} (${parcelNftAddressInfo.source})`);
        console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);

        const proposalContract = new ethers.Contract(proposalNftAddress, PROPOSAL_NFT_ABI, provider);
        const parcelContract = new ethers.Contract(parcelNftAddress, PARCEL_NFT_ABI, provider);

        // Get total number of proposals
        console.log("\n📊 Fetching proposals...");
        const totalSupply = await proposalContract.totalSupply();
        console.log(`Total proposals: ${totalSupply.toString()}`);

        if (totalSupply === 0n) {
            console.log("\n✅ No proposals found.");
            return;
        }

        console.log("\n🎲 Processing proposals (50% chance to accept each parcel)...");
        console.log("=".repeat(80));

        let totalProcessed = 0;
        let totalAccepted = 0;
        let totalSkipped = 0;
        let totalErrors = 0;

        // Track transactions per account for nonce management
        const accountTransactions = new Map();

        // Loop through all proposals
        for (let i = 0; i < Number(totalSupply); i++) {
            const proposalId = BigInt(i);
            
            try {
                // Get proposal details
                const proposal = await proposalContract.getProposal(proposalId);
                const [parcelIds, isConditional, imageURI, acceptancePossible, status, ethBalance, tokenBalance, acceptanceCount, expiryTimestamp, expiringPercentage] = proposal;

                // Status: 0=Active, 1=Executed, 2=Cancelled, 3=Expired
                // Convert status to number for comparison (it comes as BigInt from contract)
                const statusNum = Number(status);
                const statusNames = ['Active', 'Executed', 'Cancelled', 'Expired'];
                
                if (!acceptancePossible || statusNum !== 0) {
                    console.log(`\nProposal ${proposalId.toString()}: SKIPPED (status: ${statusNames[statusNum] || 'Unknown'}, acceptancePossible: ${acceptancePossible})`);
                    continue;
                }

                console.log(`\nProposal ${proposalId.toString()}:`);
                console.log(`  Parcels: ${parcelIds.length}`);
                console.log(`  Conditional: ${isConditional ? 'Yes' : 'No'}`);
                console.log(`  Current acceptances: ${acceptanceCount.toString()}`);

                // Process each parcel in the proposal
                for (const parcelId of parcelIds) {
                    totalProcessed++;
                    
                    // Flip coin
                    const shouldAcceptParcel = shouldAccept();
                    
                    if (!shouldAcceptParcel) {
                        console.log(`  Parcel ${parcelId}: SKIPPED (coin flip: no)`);
                        totalSkipped++;
                        continue;
                    }

                    console.log(`  Parcel ${parcelId}: ACCEPTING (coin flip: yes)`);
                    
                    // Find parcel owner
                    const owner = await findParcelOwner(parcelContract, parcelId, accounts);
                    
                    if (!owner) {
                        console.log(`    ❌ Could not find owner for parcel ${parcelId}`);
                        totalErrors++;
                        continue;
                    }

                    // Create wallet for this owner
                    const wallet = new ethers.Wallet(owner.privateKey, provider);
                    const ownerProposalContract = new ethers.Contract(proposalNftAddress, PROPOSAL_NFT_ABI, wallet);

                    // Get previous transaction for nonce tracking
                    const previousTx = accountTransactions.get(owner.address) || null;

                    // Accept the proposal
                    const result = await acceptProposalForParcel(ownerProposalContract, proposalId, parcelId, wallet, previousTx);
                    
                    if (result.success) {
                        totalAccepted++;
                        // Store transaction for nonce tracking
                        accountTransactions.set(owner.address, result.tx);
                    } else {
                        if (result.reason === 'already-accepted') {
                            console.log(`    ⚠️  Already accepted`);
                            totalSkipped++;
                        } else {
                            console.log(`    ❌ Error: ${result.reason}`);
                            totalErrors++;
                        }
                    }
                }
            } catch (error) {
                console.log(`\nProposal ${proposalId.toString()}: ❌ Error - ${error.message}`);
                totalErrors++;
            }
        }

        console.log("\n" + "=".repeat(80));
        console.log("\n✅ Processing complete!");
        console.log(`   Total parcels processed: ${totalProcessed}`);
        console.log(`   Accepted: ${totalAccepted}`);
        console.log(`   Skipped (coin flip or already accepted): ${totalSkipped}`);
        console.log(`   Errors: ${totalErrors}`);
    } catch (error) {
        console.error("\n❌ Error:", error.message);
        if (error.reason) {
            console.error("Reason:", error.reason);
        }
        console.error(error);
        process.exit(1);
    }
}

main();

