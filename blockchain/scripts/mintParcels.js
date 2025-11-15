const { ethers } = require('ethers');
const http = require('http');
const https = require('https');
const { resolveContractAddress } = require('./deployment-utils');
const readline = require('readline');
// load .env file from parent directory
require('dotenv').config({ path: '../.env' });

// Updated ABI to include the mint function and custom errors
const PARCEL_NFT_ABI = [
    "function mint(address to, uint256 osmId) public returns (uint256)",
    "function mintBatch(address to, uint256[] calldata osmIds) public returns (uint256[] memory)",
    "function ownerOf(uint256 tokenId) public view returns (address)",
    // OpenZeppelin ERC721 custom errors
    "error ERC721NonexistentToken(uint256 tokenId)",
    "error ERC721InvalidTokenId(uint256 tokenId)",
    "error ERC721InvalidOwner(address owner)",
    // ParcelNFT custom errors
    "error ParcelNFT_TokenIdAlreadyMinted(uint256 tokenId)",
    "error ParcelNFT_ParcelDoesNotExist(uint256 tokenId)"
];

// Configuration
const CENTER_LAT = 45.760772;
const CENTER_LON = 15.962169;
const ZOOM = 17;
const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS;
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const BLOCK_EXPLORER_URL = process.env.BLOCK_EXPLORER_URL;

// Batch size for concurrent processing
const BATCH_SIZE = 20;
const RETRY_DELAY = 2000; // 2 seconds
const MAX_RETRIES = 3;

// Calculate bounding box for the given zoom level
function calculateBoundingBox(centerLat, centerLon, zoom) {
    const tiles = Math.pow(2, zoom);
    const degreesPerTile = 360 / tiles;

    // Approximate view range for zoom level 17
    const latRange = degreesPerTile * 2;
    const lonRange = degreesPerTile * 2;

    return {
        south: centerLat - latRange / 2,
        north: centerLat + latRange / 2,
        west: centerLon - lonRange / 2,
        east: centerLon + lonRange / 2
    };
}

async function getBuildings(bounds) {
    const query = `
    [out:json][timeout:25];
    (
      way["building"]
        (${bounds.south},${bounds.west},${bounds.north},${bounds.east});
    );
    out body;
  `;

    const { statusCode, body } = await httpRequest('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            Accept: 'application/json'
        },
        body: query
    });

    if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Failed to fetch buildings: status ${statusCode}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch (err) {
        throw new Error(`Failed to parse Overpass response: ${err.message}`);
    }
    return data.elements.filter(el => el.tags?.building && el.id);
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = null } = {}) {
    const url = new URL(urlString);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    let requestBody = null;

    if (Buffer.isBuffer(body)) {
        requestBody = body;
    } else if (typeof body === 'string') {
        requestBody = Buffer.from(body, 'utf8');
    } else if (body !== null && body !== undefined) {
        const json = JSON.stringify(body);
        requestBody = Buffer.from(json, 'utf8');
        if (!headers['Content-Type'] && !headers['content-type']) {
            headers = { ...headers, 'Content-Type': 'application/json' };
        }
    }

    const finalHeaders = { ...headers };
    if (requestBody && !finalHeaders['Content-Length'] && !finalHeaders['content-length']) {
        finalHeaders['Content-Length'] = Buffer.byteLength(requestBody);
    }

    const options = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: finalHeaders
    };

    return new Promise((resolve, reject) => {
        const req = client.request(options, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body: responseBody
                });
            });
        });

        req.on('error', reject);

        if (requestBody) {
            req.write(requestBody);
        }

        req.end();
    });
}

// function to generate a random address
function pickAnAddress() {
    const addressList = [
        process.env.ACCOUNT_0_ADDRESS,
        process.env.ACCOUNT_1_ADDRESS,
        process.env.ACCOUNT_2_ADDRESS,
        process.env.ACCOUNT_3_ADDRESS,
        process.env.ACCOUNT_4_ADDRESS,
        process.env.ACCOUNT_5_ADDRESS
    ]
    return addressList[Math.floor(Math.random() * addressList.length)];
}

function chunkArray(array, size) {
    // Create a copy of the array to shuffle
    const shuffled = [...array].sort(() => Math.random() - 0.5);

    // Initialize empty chunks
    const chunks = Array.from({ length: Math.ceil(array.length / size) }, () => []);

    // Distribute elements to chunks round-robin style
    shuffled.forEach((item, index) => {
        const chunkIndex = index % chunks.length;
        chunks[chunkIndex].push(item);
    });

    return chunks;
}

async function checkParcelOwnership(contract, osmId) {
    try {
        const owner = await contract.ownerOf(osmId);
        // console.log(`Owner found: ${owner}`);
        return true;
    } catch (error) {
        // if the error is ERC721NonexistentToken, return false
        if (error.message.includes("ERC721NonexistentToken")) {
            // console.log(`Parcel ${osmId} has not been minted yet`);
            return false;
        }
        console.log(`Error checking ownership for parcel ${osmId}:`, {
            errorCode: error.code,
            errorMessage: error.message,
            errorName: error.name,
            customError: error.data?.message
        });
        throw error; // Let's see the full error
    }
}

async function filterUnmintedParcels(contract, buildings) {
    const unminted = [];
    const minted = [];

    for (const building of buildings) {
        const osmId = BigInt(building.id);
        const isMinted = await checkParcelOwnership(contract, osmId);
        if (isMinted) {
            minted.push(building.id);
        } else {
            unminted.push(building);
        }
    }

    if (minted.length > 0) {
        // console.log(`\nSkipping ${minted.length} already minted parcels:`);
        // console.log(minted);
    }
    // console.log(`Found ${unminted.length} unminted parcels to process`);

    return unminted;
}

async function processBatch(contract, buildings, wallet, batchIndex) {
    const prefix = `\n[Batch ${batchIndex + 1}]`;
    console.log(prefix, 'Checking ownership status of parcels...');

    // First filter out already minted parcels
    const unmintedBuildings = [];
    for (const building of buildings) {
        try {
            const osmId = BigInt(building.id);
            // console.log(`\nChecking parcel: ${building.id}`);
            const isMinted = await checkParcelOwnership(contract, osmId);
            if (!isMinted) {
                unmintedBuildings.push(building);
            }
        } catch (error) {
            console.error(`Error processing building ${building.id}:`, error);
            // Continue with next building
        }
    }

    if (unmintedBuildings.length === 0) {
        console.log(prefix, 'Skipping batch - all parcels already minted or errored');
        return true;
    }

    const address = pickAnAddress();
    const osmIds = unmintedBuildings.map(b => BigInt(b.id));

    console.log(prefix, `Processing batch ${batchIndex + 1} with ${unmintedBuildings.length} unminted buildings`);
    console.log(prefix, `Minting to address: ${address}`);
    // console.log('OSM IDs to mint:', osmIds.map(id => id.toString()));

    let retries = 0;
    while (retries < MAX_RETRIES) {
        try {
            const nonce = await wallet.getNonce();
            const gasPrice = await wallet.provider.getFeeData();

            // console.log('Attempting mintBatch with params:', {
            //     to: address,
            //     osmIds: osmIds.map(id => id.toString()),
            //     nonce,
            //     maxFeePerGas: gasPrice.maxFeePerGas?.toString(),
            //     maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas?.toString()
            // });

            const tx = await contract.mintBatch(address, osmIds, {
                nonce,
                maxFeePerGas: gasPrice.maxFeePerGas,
                maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
            });

            console.log(prefix, `Transaction submitted: ${BLOCK_EXPLORER_URL}${tx.hash}`);

            const receipt = await tx.wait();
            console.log(prefix, `✅ Minted - Block: ${receipt.blockNumber}`);
            return true;
        } catch (error) {
            // Check for "not enough funds" error
            if ((error.error?.code == -32000) ||
                JSON.stringify(error).includes('Sender doesn\'t have enough funds to send tx')) {
                console.error('\n❌ ERROR: Not enough funds to process transaction');
                // console.error('Error details:', error.data?.message || error.message);
                process.exit(1);
            }

            retries++;
            if (retries < MAX_RETRIES) {
                console.log(`Retrying batch ${batchIndex + 1} (attempt ${retries + 1}/${MAX_RETRIES})...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                console.error(`❌ Failed to process batch ${batchIndex + 1} after ${MAX_RETRIES} attempts:`, error.message);
                if (error.data?.message) {
                    console.error('Detailed error:', error.data.message);
                }
                return false;
            }
        }
    }
}

async function checkBatchMintingSupport(contract) {
    try {
        if (!contract || !contract.runner?.provider) {
            console.log('\n⚠️  Invalid contract or missing provider');
            return false;
        }

        // Get the deployed bytecode using the contract's provider through the runner (wallet)
        console.log('\nChecking contract at address:', contract.target);
        const code = await contract.runner.provider.getCode(contract.target);

        // Check if the function signature exists in the deployed bytecode
        const mintBatchSignature = ethers.keccak256(ethers.toUtf8Bytes("mintBatch(address,uint256[])")).slice(0, 10);

        if (!code.includes(mintBatchSignature.slice(2))) {
            console.log('\n⚠️  Contract does not support batch minting. Falling back to single mints...');
            return false;
        }

        console.log('\n✅ Contract supports batch minting');
        return true;
    } catch (error) {
        console.log('\n⚠️  Contract does not support batch minting:', error.message);
        console.log('Error details:', error);
        return false;
    }
}

async function mintParcelNFTsSingle(contract, buildings, wallet) {
    console.log(`Processing ${buildings.length} buildings individually...`);

    for (let i = 0; i < buildings.length; i++) {
        const building = buildings[i];
        try {
            const to = pickAnAddress();
            const osmId = BigInt(building.id);

            console.log(`\nMinting NFT ${i + 1} of ${buildings.length}`);
            console.log(`Building ID: ${building.id}`);
            console.log(`Minting to: ${to}`);

            const nonce = await wallet.getNonce();
            const tx = await contract.mint(to, osmId, { nonce });
            console.log(`Transaction submitted: ${BLOCK_EXPLORER_URL}${tx.hash}`);

            const receipt = await tx.wait();
            console.log(`✅ Minted NFT ${i + 1} of ${buildings.length} - Block: ${receipt.blockNumber}`);
            console.log('----------------------------------------');

            if (!RPC_URL.includes('localhost')) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            if (error.message.includes("ParcelNFT: Token ID already minted")) {
                console.log(`✔ Error minting NFT ${i + 1} of ${buildings.length} for building ${building.id}:`, 'Parcel already minted');
            } else {
                console.error(`❌ Error minting NFT ${i + 1} of ${buildings.length} for building ${building.id}:`, error.message);
            }
            console.log('----------------------------------------');
        }
    }
}

async function promptUser(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.toLowerCase());
        });
    });
}

async function mintParcelNFTs(buildings, parcelNftAddress) {
    if (!parcelNftAddress || !PRIVATE_KEY) {
        throw new Error("Missing required environment variables");
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(parcelNftAddress, PARCEL_NFT_ABI, wallet);

    console.log(`Found ${buildings.length} buildings to mint`);
    console.log('----------------------------------------');

    // Check if contract supports batch minting
    const supportsBatchMinting = await checkBatchMintingSupport(contract);
    if (!supportsBatchMinting) {
        // Ask user whether to continue with single mints
        console.log('\n⚠️  This will process each mint individually, which will be slower and more expensive.');
        const answer = await promptUser('Do you want to continue with single minting? (Y/N): ');
        if (answer !== 'y') {
            console.log('\n❌ Minting process cancelled by user');
            process.exit(0);
        }
        // Fall back to single mints
        await mintParcelNFTsSingle(contract, buildings, wallet);
        return;
    }

    // Proceed with batch minting
    console.log('\n🚀 Contract supports batch minting. Proceeding with batched operations...');
    // Split buildings into batches
    const batches = chunkArray(buildings, BATCH_SIZE);
    console.log(`Split into ${batches.length} batches of up to ${BATCH_SIZE} buildings each`);

    // Process batches sequentially
    for (let i = 0; i < batches.length; i++) {
        await processBatch(contract, batches[i], wallet, i);

        // Add delay between batches if not on localhost
        if (!RPC_URL.includes('localhost') && i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }
}

async function main() {
    try {
        console.log("\n🏗️  Urban Game Theory - Parcel NFT Minter");
        console.log("----------------------------------------");

        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const network = await provider.getNetwork();

        const parcelAddressInfo = resolveContractAddress('ParcelNFT', network.chainId, {
            explicitAddress: process.env.PARCEL_NFT_ADDRESS || null
        });
        if (!parcelAddressInfo) {
            throw new Error('ParcelNFT address not provided and no matching deployment found. Run `yarn deploy` or set PARCEL_NFT_ADDRESS.');
        }

        const parcelNftAddress = parcelAddressInfo.address;
        console.log(`PARCEL_NFT_ADDRESS: ${parcelNftAddress} (${parcelAddressInfo.source})`);

        console.log("Calculating bounding box...");
        const bounds = calculateBoundingBox(CENTER_LAT, CENTER_LON, ZOOM);

        console.log("Fetching buildings from OpenStreetMap...");
        const buildings = await getBuildings(bounds);

        console.log("\n🚀 Starting minting process...");
        console.log("----------------------------------------");

        console.log('The deployer (minter) address is:', DEPLOYER_ADDRESS);

        await mintParcelNFTs(buildings, parcelNftAddress);

        console.log("\n✨ All done!");
    } catch (error) {
        console.error("\n❌ Minting error:", error.message);
        console.error('Error details:', error);
        process.exit(1);
    }
}

main(); 