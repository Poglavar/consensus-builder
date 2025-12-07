#!/usr/bin/env node

/*
 * Check Minted Proposals
 * ----------------------
 * - Queries the ProposalNFT contract to get total number of proposals
 * - Loops through all proposal IDs (sequential)
 * - For each proposal, fetches the parcel IDs it contains
 * - Outputs the results to console
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
    "function ownerOf(uint256 tokenId) public view returns (address)",
    "function getProposalsForParcel(string memory parcelId) public view returns (uint256[] memory)",
    // Events used to infer acceptance state per parcel
    "event ProposalAccepted(uint256 indexed proposalId, string parcelId, address owner)",
    "event ProposalAcceptanceWithdrawn(uint256 indexed proposalId, string parcelId, address owner)"
];

const PARCEL_NFT_ABI = [
    "function totalSupply() public view returns (uint256)",
    "function tokenByIndex(uint256 index) public view returns (uint256)",
    "function parcelIdForTokenId(uint256 tokenId) public view returns (string memory)"
];

const RPC_URL = process.env.RPC_URL || process.env.ETHEREUM_RPC_URL;

// Helper function to format token ID for display (decimal and hex)
function formatTokenIdForDisplay(tokenId) {
    if (tokenId === null || tokenId === undefined) {
        return { decimal: 'unknown', hex: null };
    }
    const toPair = value => {
        try {
            const big = BigInt(value);
            return {
                decimal: big.toString(10),
                hex: `0x${big.toString(16)}`
            };
        } catch (_) {
            return { decimal: String(value), hex: null };
        }
    };
    if (typeof tokenId === 'bigint') {
        return {
            decimal: tokenId.toString(10),
            hex: `0x${tokenId.toString(16)}`
        };
    }
    if (typeof tokenId === 'string') {
        if (tokenId.startsWith('0x') || tokenId.startsWith('0X')) {
            return toPair(tokenId);
        }
        return toPair(tokenId);
    }
    if (typeof tokenId === 'number') {
        return {
            decimal: tokenId.toString(10),
            hex: `0x${tokenId.toString(16)}`
        };
    }
    return toPair(tokenId);
}

async function main() {
    try {
        console.log("\n🔍 Checking Minted Proposals");
        console.log("----------------------------------------");

        if (!RPC_URL) {
            throw new Error('RPC_URL or ETHEREUM_RPC_URL must be set in environment.');
        }

        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const network = await provider.getNetwork();

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
        console.log(`PROPOSAL_NFT_ADDRESS: ${proposalNftAddress} (${proposalAddressInfo.source})`);
        console.log(`PARCEL_NFT_ADDRESS: ${parcelNftAddress} (${parcelNftAddressInfo.source})`);
        console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
        console.log(`RPC URL: ${RPC_URL}`);

        const proposalContract = new ethers.Contract(proposalNftAddress, PROPOSAL_NFT_ABI, provider);
        const parcelContract = new ethers.Contract(parcelNftAddress, PARCEL_NFT_ABI, provider);
        const proposalIface = new ethers.Interface(PROPOSAL_NFT_ABI);

        // Build acceptance state from events so we can annotate parcels/proposals
        const { acceptedParcelsByProposal, acceptedProposalsByParcel } = await hydrateAcceptances({
            provider,
            proposalAddress: proposalNftAddress,
            iface: proposalIface
        });

        // Get total number of proposals
        console.log("\n📊 Fetching total supply...");
        const totalSupply = await proposalContract.totalSupply();
        console.log(`Total proposals minted: ${totalSupply.toString()}`);

        if (totalSupply === 0n) {
            console.log("\n✅ No proposals have been minted yet.");
            return;
        }

        console.log("\n📋 Proposal Details:");
        console.log("=" .repeat(80));

        // Loop through all proposal IDs (they are sequential: 0 to totalSupply-1)
        for (let i = 0; i < Number(totalSupply); i++) {
            const proposalId = BigInt(i);
            
            try {
                // Check if proposal exists (by checking owner)
                const owner = await proposalContract.ownerOf(proposalId);
                
                // Get proposal details
                const proposal = await proposalContract.getProposal(proposalId);
                const [parcelIds, isConditional, imageURI, acceptancePossible, status, ethBalance, tokenBalance, acceptanceCount, expiryTimestamp, expiringPercentage] = proposal;

                // Status: 0=Active, 1=Executed, 2=Cancelled, 3=Expired
                const statusNames = ['Active', 'Executed', 'Cancelled', 'Expired'];
                const statusName = statusNames[status] || 'Unknown';

                console.log(`\nProposal ID: ${proposalId.toString()}`);
                console.log(`  Owner: ${owner}`);
                console.log(`  Conditional: ${isConditional ? 'Yes' : 'No'}`);
                console.log(`  Status: ${statusName}`);
                console.log(`  Acceptance Possible: ${acceptancePossible ? 'Yes' : 'No'}`);
                console.log(`  ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);
                console.log(`  Token Balance: ${ethers.formatEther(tokenBalance)} CITY`);
                console.log(`  Acceptance Count: ${acceptanceCount.toString()}`);
                if (expiryTimestamp > 0n) {
                    const expiryDate = new Date(Number(expiryTimestamp) * 1000);
                    console.log(`  Expiry Timestamp: ${expiryTimestamp.toString()} (${expiryDate.toISOString()})`);
                } else {
                    console.log(`  Expiry Timestamp: None`);
                }
                console.log(`  Image URI: ${imageURI}`);
                console.log(`  Parcels (${parcelIds.length}):`);
                
                if (parcelIds.length === 0) {
                    console.log(`    (none)`);
                } else {
                    const acceptedSet = acceptedParcelsByProposal.get(proposalId.toString()) || new Set();
                    parcelIds.forEach((parcelId, idx) => {
                        const mark = acceptedSet.has(parcelId) ? " ✅" : "";
                        console.log(`    ${idx + 1}. ${parcelId}${mark}`);
                    });
                }
            } catch (error) {
                console.log(`\nProposal ID: ${proposalId.toString()}`);
                console.log(`  ❌ Error: ${error.message}`);
            }
        }

        console.log("\n" + "=".repeat(80));
        console.log(`\n✅ Proposal check complete. Found ${totalSupply.toString()} proposal(s).`);

        // Part 2: Check parcels and their proposals
        console.log("\n\n🔍 Checking Parcels and Their Proposals");
        console.log("=".repeat(80));

        // Get total number of parcels
        console.log("\n📊 Fetching parcel total supply...");
        const parcelTotalSupply = await parcelContract.totalSupply();
        console.log(`Total parcels minted: ${parcelTotalSupply.toString()}`);

        if (parcelTotalSupply === 0n) {
            console.log("\n✅ No parcels have been minted yet.");
            return;
        }

        console.log("\n📋 Parcels with Proposals:");
        console.log("=".repeat(80));

        let parcelsWithProposals = 0;
        let totalProposalReferences = 0;

        // Loop through all parcel token IDs (they are sequential via tokenByIndex)
        for (let i = 0; i < Number(parcelTotalSupply); i++) {
            const index = BigInt(i);
            
            try {
                // Get token ID at this index
                const tokenId = await parcelContract.tokenByIndex(index);
                
                // Get parcel ID from token ID
                const parcelId = await parcelContract.parcelIdForTokenId(tokenId);
                
                // Get all proposals for this parcel
                const proposalIds = await proposalContract.getProposalsForParcel(parcelId);
                
                // Only output parcels that belong to at least one proposal
                if (proposalIds.length > 0) {
                    parcelsWithProposals++;
                    totalProposalReferences += proposalIds.length;
                    
                    const { decimal, hex } = formatTokenIdForDisplay(tokenId);
                    const tokenDescriptor = hex ? `${decimal} (${hex})` : decimal;
                    
                    console.log(`\nParcel: ${parcelId}`);
                    console.log(`  Token ID: ${tokenDescriptor}`);
                    console.log(`  Belongs to ${proposalIds.length} proposal(s):`);
                    const acceptedSet = acceptedProposalsByParcel.get(parcelId) || new Set();
                    proposalIds.forEach((proposalId, idx) => {
                        const mark = acceptedSet.has(proposalId.toString()) ? " ✅" : "";
                        console.log(`    ${idx + 1}. Proposal ID: ${proposalId.toString()}${mark}`);
                    });
                }
            } catch (error) {
                // Silently skip parcels that don't exist or have errors
                // (this can happen if there are gaps in the token IDs)
                continue;
            }
        }

        console.log("\n" + "=".repeat(80));
        console.log(`\n✅ Parcel check complete.`);
        console.log(`   Total parcels: ${parcelTotalSupply.toString()}`);
        console.log(`   Parcels with proposals: ${parcelsWithProposals}`);
        console.log(`   Total proposal references: ${totalProposalReferences}`);
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

async function hydrateAcceptances({ provider, proposalAddress, iface }) {
    // Fetch acceptance and withdrawal logs, apply in block/log order to derive latest state.
    const topicAccepted = iface.getEvent("ProposalAccepted").topicHash;
    const topicWithdrawn = iface.getEvent("ProposalAcceptanceWithdrawn").topicHash;

    const [acceptedLogs, withdrawnLogs] = await Promise.all([
        provider.getLogs({ address: proposalAddress, topics: [topicAccepted], fromBlock: 0 }),
        provider.getLogs({ address: proposalAddress, topics: [topicWithdrawn], fromBlock: 0 })
    ]);

    const combined = [...acceptedLogs, ...withdrawnLogs].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        return a.logIndex - b.logIndex;
    });

    const acceptedParcelsByProposal = new Map(); // proposalId -> Set(parcelId)
    const acceptedProposalsByParcel = new Map(); // parcelId -> Set(proposalId)

    for (const log of combined) {
        const parsed = iface.parseLog(log);
        const proposalId = parsed.args.proposalId.toString();
        const parcelId = parsed.args.parcelId;
        const isAccept = parsed.name === "ProposalAccepted";

        if (isAccept) {
            if (!acceptedParcelsByProposal.has(proposalId)) {
                acceptedParcelsByProposal.set(proposalId, new Set());
            }
            acceptedParcelsByProposal.get(proposalId).add(parcelId);

            if (!acceptedProposalsByParcel.has(parcelId)) {
                acceptedProposalsByParcel.set(parcelId, new Set());
            }
            acceptedProposalsByParcel.get(parcelId).add(proposalId);
        } else {
            // Withdrawal removes acceptance
            acceptedParcelsByProposal.get(proposalId)?.delete(parcelId);
            acceptedProposalsByParcel.get(parcelId)?.delete(proposalId);
        }
    }

    return { acceptedParcelsByProposal, acceptedProposalsByParcel };
}

