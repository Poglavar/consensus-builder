#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { resolveContractAddress } = require('./deploymentUtils');

// Load .env from repo root or blockchain folder
const envPath = fs.existsSync(path.join(__dirname, '../.env'))
    ? path.join(__dirname, '../.env')
    : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

const ABI = [
    'function ownerOfParcelId(string parcelId) view returns (address)',
    'function tokenIdForParcelId(string parcelId) view returns (uint256)',
    'function getParcelById(string parcelId) view returns (tuple(string parcelId, string metadataURI))'
];

function formatTokenId(value) {
    if (value === undefined || value === null) return null;
    try {
        const big = BigInt(value);
        return {
            decimal: big.toString(10),
            hex: `0x${big.toString(16)}`
        };
    } catch (_) {
        return { decimal: String(value), hex: null };
    }
}

async function main() {
    const parcelId = process.argv[2];
    if (!parcelId) {
        console.error('Usage: node check-parcel.js <PARCEL_ID>');
        process.exit(1);
    }

    const rpcUrl = process.env.RPC_URL || process.env.ETHEREUM_RPC_URL;
    if (!rpcUrl) {
        console.error('Missing RPC_URL or ETHEREUM_RPC_URL in environment.');
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();

    const resolved = resolveContractAddress('ParcelNFT', network.chainId, {
        explicitAddress: process.env.PARCEL_NFT_ADDRESS
    });
    if (!resolved) {
        console.error(`ParcelNFT address not found for chain ${network.chainId}. Set PARCEL_NFT_ADDRESS or add a deployment file.`);
        process.exit(1);
    }

    const contract = new ethers.Contract(resolved.address, ABI, provider);

    console.log('------------------------------');
    console.log(`Parcel ID: ${parcelId}`);
    console.log(`Network: ${network.chainId} (${network.name || 'unknown'})`);
    console.log(`ParcelNFT: ${resolved.address} (${resolved.source || 'resolved'})`);
    console.log('------------------------------');

    let tokenId = null;
    let owner = null;
    let metadataUri = null;

    try {
        tokenId = await contract.tokenIdForParcelId(parcelId);
    } catch (err) {
        // If this reverts, the parcel likely isn't minted
        console.log('tokenIdForParcelId: not found or reverted');
    }

    try {
        owner = await contract.ownerOfParcelId(parcelId);
    } catch (err) {
        // Not minted or function reverted
    }

    try {
        const parcelTuple = await contract.getParcelById(parcelId);
        metadataUri = parcelTuple?.metadataURI || null;
    } catch (_) {
        // Optional, some deployments may not support
    }

    const minted = Boolean(owner && owner !== ethers.ZeroAddress);
    const formattedId = formatTokenId(tokenId);

    if (minted) {
        console.log('Status: MINTED');
        if (formattedId?.decimal) {
            console.log(`Token ID: ${formattedId.decimal}${formattedId.hex && formattedId.hex !== formattedId.decimal ? ` (${formattedId.hex})` : ''}`);
        }
        console.log(`Owner: ${owner}`);
    } else {
        console.log('Status: NOT MINTED');
    }

    if (metadataUri) {
        console.log(`Metadata: ${metadataUri}`);
    }
}

main().catch(err => {
    console.error('check-parcel failed:', err.message || err);
    process.exit(1);
});

