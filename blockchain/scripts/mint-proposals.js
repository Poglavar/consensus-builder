const { ethers } = require('ethers');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const { resolveContractAddress } = require('./deploymentUtils');
const { Client } = require('pg');
const { buildParcelGeometrySvg } = require('./mint-parcels');
const path = require('path');
const fs = require('fs');

// Try to load .env from current directory first, then parent
const envPath = fs.existsSync(path.join(__dirname, '../.env'))
    ? path.join(__dirname, '../.env')
    : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

// Contract ABIs
const PROPOSAL_NFT_ABI = [
    "function mintAndFund(address to, string[] memory parcelIds, bool isConditional, string memory imageURI, uint256 ethAmount, uint256 tokenAmount, address[] memory lens) public payable returns (uint256)",
    "function ownerOf(uint256 tokenId) public view returns (address)",
    "function totalSupply() public view returns (uint256)"
];

const CITY_TOKEN_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)"
];

const PARCEL_NFT_ABI = [
    "function totalSupply() public view returns (uint256)",
    "function tokenByIndex(uint256 index) public view returns (uint256)",
    "function parcelIdForTokenId(uint256 tokenId) public view returns (string memory)"
];

// Configuration
const CENTER_LAT = 45.760772;
const CENTER_LON = 15.962169;
const ZOOM = 17;
const NUM_PROPOSALS = 3; // Configure how many proposals to mint
const SMP_REGEX = /^[0-9]{3}-[0-9]{3}[A-Za-z]?-[0-9]{3}[A-Za-z]?$/;
const REQUIRED_DB_ENV_VARS = ['PGHOST', 'PGUSER', 'PGDATABASE'];

const SUPPORTED_NETWORKS = {
    hardhat: { chainId: 31337, rpcEnv: 'RPC_URL' },
    anvil: { chainId: 31337, rpcEnv: 'RPC_URL' },
    'sepolia': { chainId: 11155111, rpcEnv: 'ETHEREUM_RPC_URL' },
    'ethereum-mainnet': { chainId: 1, rpcEnv: 'ETHEREUM_RPC_URL' },
    'mainnet': { chainId: 1, rpcEnv: 'ETHEREUM_RPC_URL' },
    'base': { chainId: 8453, rpcEnv: 'ETHEREUM_RPC_URL' },
    'base-sepolia': { chainId: 84532, rpcEnv: 'ETHEREUM_RPC_URL' }
};

const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS;
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const BLOCK_EXPLORER_URL = process.env.BLOCK_EXPLORER_URL;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;

function normalizeAddressOrThrow(address, label) {
    try {
        return ethers.getAddress(address);
    } catch (err) {
        throw new Error(`Invalid ${label} address "${address}": ${err.message || err}`);
    }
}

function resolveLensAddresses() {
    const addresses = [];

    if (process.env.LENS_ADDRESSES) {
        const parts = process.env.LENS_ADDRESSES.split(',')
            .map(part => part.trim())
            .filter(Boolean);
        addresses.push(...parts);
    }

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
            addresses.push(envAddress);
            continue;
        }

        if (envPrivateKey) {
            try {
                const wallet = new ethers.Wallet(envPrivateKey);
                addresses.push(wallet.address);
            } catch (err) {
                throw new Error(`Invalid lens ${i} private key: ${err.message || err}`);
            }
        }
    }

    const unique = [];
    const seen = new Set();
    addresses.forEach(addr => {
        const normalized = normalizeAddressOrThrow(addr, 'lens');
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(normalized);
    });

    if (unique.length === 0) {
        throw new Error('No lens addresses found. Set LENS_ADDRESSES or LENS_ACCOUNT_1..3 / LENS_1..3 (address or *_PRIVATE_KEY) in .env');
    }

    return unique;
}

function httpRequest(urlString, options = {}) {
    const { method = 'GET', headers = {}, body = null } = options;
    const url = new URL(urlString);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    let requestBody = null;
    let needsJsonContentType = false;

    if (Buffer.isBuffer(body)) {
        requestBody = body;
    } else if (typeof body === 'string') {
        requestBody = Buffer.from(body, 'utf8');
    } else if (body !== null && body !== undefined) {
        requestBody = Buffer.from(JSON.stringify(body), 'utf8');
        needsJsonContentType = true;
    }

    const finalHeaders = { ...headers };
    const headerNames = Object.keys(finalHeaders).map(name => name.toLowerCase());

    if (needsJsonContentType && !headerNames.includes('content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
        headerNames.push('content-type');
    }

    if (requestBody && !headerNames.includes('content-length')) {
        finalHeaders['Content-Length'] = Buffer.byteLength(requestBody);
    }

    const requestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: finalHeaders
    };

    return new Promise((resolve, reject) => {
        const req = client.request(requestOptions, res => {
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

function postJson(urlString, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    return httpRequest(urlString, {
        method: 'POST',
        headers,
        body
    });
}

// Helper function to get random number in range (inclusive)
function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to get random float in range
function getRandomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

// Helper function to get random boolean
function getRandomBoolean() {
    return Math.random() < 0.5;
}


// Helper function to get random ETH amount (between 0.001 and 0.005 ETH)
function getRandomEthAmount() {
    return ethers.parseEther(getRandomFloat(0.001, 0.005).toFixed(6));
}

// Helper function to get random token amount (between 1 and 10 tokens)
function getRandomTokenAmount() {
    return ethers.parseUnits(getRandomInt(1, 10).toString(), 18);
}

// Helper function to generate random proposal name
function generateRandomName(type) {
    const adjectives = ['New', 'Modern', 'Green', 'Urban', 'Smart', 'Sustainable'];
    const nouns = ['Development', 'Project', 'Initiative', 'Plan', 'Proposal'];
    return `${adjectives[getRandomInt(0, adjectives.length - 1)]} ${type} ${nouns[getRandomInt(0, nouns.length - 1)]}`;
}

// Helper function to generate description
function generateDescription(type) {
    const descriptions = {
        'Road': 'A new road development project to improve connectivity and traffic flow.',
        'Park': 'A green space development project to enhance community well-being.',
        'Square': 'A public square development to create a vibrant community space.',
        'Buildings': 'A modern building development project for mixed-use purposes.',
        'Mixed': 'A comprehensive development project combining multiple urban elements.'
    };
    return descriptions[type] || 'A new urban development proposal.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Parcel geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
function ensureArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function parseGeoJsonGeometry(input) {
    if (!input) return null;
    let source = input;
    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch (error) {
            return null;
        }
    }
    if (!source) return null;
    if (source.type === 'Feature') {
        return parseGeoJsonGeometry(source.geometry);
    }
    if (source.type && source.coordinates) {
        return source;
    }
    if (source.geometry) {
        return parseGeoJsonGeometry(source.geometry);
    }
    return null;
}

function extractPolygonCoordinateSets(geometryLike) {
    const geometry = parseGeoJsonGeometry(geometryLike);
    if (!geometry) return [];
    switch (geometry.type) {
        case 'Polygon':
            return geometry.coordinates ? [geometry.coordinates] : [];
        case 'MultiPolygon':
            return geometry.coordinates ? geometry.coordinates.map(coords => coords || []) : [];
        case 'GeometryCollection': {
            const polygons = [];
            ensureArray(geometry.geometries).forEach(inner => {
                extractPolygonCoordinateSets(inner).forEach(coords => polygons.push(coords));
            });
            return polygons;
        }
        default:
            return [];
    }
}

function combineParcelsIntoGeometry(parcels) {
    const polygons = [];
    parcels.forEach(parcel => {
        extractPolygonCoordinateSets(parcel.geometry).forEach(coords => polygons.push(coords));
    });
    if (polygons.length === 0) {
        return null;
    }
    return { type: 'MultiPolygon', coordinates: polygons };
}

function buildProposalSvgFromParcels(parcelsWithGeometry, { label }) {
    const combinedGeometry = combineParcelsIntoGeometry(parcelsWithGeometry);
    if (!combinedGeometry) {
        return null;
    }
    return buildParcelGeometrySvg(
        { parcelId: label, geometry: combinedGeometry },
        { width: 256, height: 256, paddingRatio: 0.08 }
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Database helpers for parcel geometry lookup
// ─────────────────────────────────────────────────────────────────────────────
function validateDbConfig() {
    const missing = REQUIRED_DB_ENV_VARS.filter(key => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing database configuration for parcel geometry lookup. Set ${missing.join(', ')} in your environment.`);
    }
}

async function connectToDatabase() {
    validateDbConfig();
    const client = new Client({
        host: process.env.PGHOST,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });
    await client.connect();
    return client;
}

async function fetchParcelGeometries(parcelIds, dbClient) {
    if (!dbClient) {
        throw new Error('Database client is not available for parcel geometry lookup.');
    }
    const uniqueIds = Array.from(new Set(parcelIds.filter(Boolean).map(id => id.trim())));
    if (uniqueIds.length === 0) {
        return [];
    }

    const results = [];
    const remaining = new Set(uniqueIds);

    const runQuery = async (sql, params, idExtractor) => {
        if (params.length === 0) return;
        const { rows } = await dbClient.query(sql, params);
        rows.forEach(row => {
            const parcelId = idExtractor(row);
            if (!parcelId) return;
            const geometry = parseGeoJsonGeometry(row.geometry);
            if (!geometry) return;
            results.push({ parcelId, geometry });
            remaining.delete(parcelId);
        });
    };

    const baIds = uniqueIds.filter(id => SMP_REGEX.test(id));
    if (baIds.length > 0) {
        const placeholders = baIds.map((_, idx) => `$${idx + 1}`).join(', ');
        await runQuery(
            `
            SELECT smp AS parcel_id, ST_AsGeoJSON(ST_Transform(geometry, 4326)) AS geometry
            FROM parcel_ba
            WHERE smp IN (${placeholders})
            `,
            baIds,
            row => row.parcel_id
        );
    }

    const remainingIds = Array.from(remaining);
    if (remainingIds.length > 0) {
        const placeholders = remainingIds.map((_, idx) => `$${idx + 1}`).join(', ');
        await runQuery(
            `
            SELECT CESTICA_ID AS parcel_id, ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geometry
            FROM parcel
            WHERE current = true
              AND CESTICA_ID IN (${placeholders})
            `,
            remainingIds,
            row => row.parcel_id
        );
    }

    if (remaining.size > 0) {
        console.warn(`⚠️  Missing geometry for parcels: ${Array.from(remaining).join(', ')}`);
    }

    return results;
}

function inferCityFromParcelIds(parcelIds) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
        return 'CITY';
    }
    const hasBa = parcelIds.some(id => SMP_REGEX.test(String(id || '')));
    return hasBa ? 'BA' : 'ZG';
}

// Function to upload image to IPFS via Pinata
async function uploadImageToPinata(imageData, name) {
    if (!PINATA_API_KEY || !PINATA_API_SECRET) {
        throw new Error('Pinata API key or secret not found. Please check your .env file');
    }

    // Pinata requires multipart/form-data for file uploads
    const form = new FormData();
    const fileName = `${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-image.svg`;

    // Add the file (SVG format)
    form.append('file', imageData, {
        filename: fileName,
        contentType: 'image/svg+xml'
    });

    // Add pinataOptions (optional)
    form.append('pinataOptions', JSON.stringify({
        cidVersion: 0
    }));

    // Add pinataMetadata (optional)
    form.append('pinataMetadata', JSON.stringify({
        name: fileName
    }));

    // Use native https module directly with form-data for proper stream handling
    return new Promise((resolve, reject) => {
        const url = new URL('https://api.pinata.cloud/pinning/pinFileToIPFS');
        const options = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname,
            headers: {
                ...form.getHeaders(),
                pinata_api_key: PINATA_API_KEY,
                pinata_secret_api_key: PINATA_API_SECRET
            }
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Failed to upload image to Pinata: status ${res.statusCode} - ${body}`));
                    return;
                }

                let result;
                try {
                    result = JSON.parse(body);
                } catch (err) {
                    reject(new Error(`Failed to parse Pinata image response: ${err.message}`));
                    return;
                }

                if (!result.IpfsHash) {
                    reject(new Error(`Pinata response missing IpfsHash: ${body}`));
                    return;
                }

                resolve(`https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`);
            });
        });

        req.on('error', reject);

        // Pipe the form data directly to the request
        form.pipe(req);
    });
}

// Function to upload metadata to IPFS via Pinata
async function uploadMetadataToPinata(metadata, name) {
    if (!PINATA_API_KEY || !PINATA_API_SECRET) {
        throw new Error('Pinata API key or secret not found. Please check your .env file');
    }

    const response = await postJson(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        {
            pinataContent: metadata,
            pinataMetadata: {
                name: `${name}-metadata.json`
            }
        },
        {
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_API_SECRET
        }
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Failed to upload metadata to Pinata: status ${response.statusCode} - ${response.body}`);
    }

    let result;
    try {
        result = JSON.parse(response.body);
    } catch (err) {
        throw new Error(`Failed to parse Pinata metadata response: ${err.message}`);
    }
    return `ipfs://${result.IpfsHash}`;
}

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

// Function to fetch all buildings from OpenStreetMap within the bounding box
async function getBuildings(bounds) {
    const query = `
    [out:json][timeout:25];
    (
      way["building"]
        (${bounds.south},${bounds.west},${bounds.north},${bounds.east});
    );
    out body;
    >;
    out skel qt;
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

// Helper function to find neighboring parcels
function findNeighbors(building, allBuildings) {
    // Convert building nodes to a set of coordinates
    const buildingNodes = new Set(building.nodes);

    // Find buildings that share at least one node (they are neighbors)
    return allBuildings.filter(other => {
        if (other.id === building.id) return false;
        return other.nodes.some(node => buildingNodes.has(node));
    });
}

// Generate a random chain of connected parcels
async function generateConnectedParcels(buildings) {
    if (buildings.length === 0) {
        throw new Error('No buildings found');
    }
    const numParcels = getRandomInt(1, 10);
    console.log('Number of parcels:', numParcels);
    const parcels = [];

    // Start with a random building
    const startIndex = getRandomInt(0, buildings.length - 1);
    console.log('Start index:', startIndex);
    let currentBuilding = buildings[startIndex];
    console.log('Starting with building:', currentBuilding.id);
    parcels.push(currentBuilding);

    // Add neighboring parcels
    while (parcels.length < numParcels) {
        const neighbors = findNeighbors(currentBuilding, buildings);
        if (neighbors.length === 0) {
            console.log('No neighbors found for building:', currentBuilding);
            break;
        }

        // Pick a random neighbor that hasn't been used yet
        const availableNeighbors = neighbors.filter(n => !parcels.includes(n.id.toString()));
        if (availableNeighbors.length === 0) break;

        const nextBuilding = availableNeighbors[getRandomInt(0, availableNeighbors.length - 1)];
        parcels.push(nextBuilding);
        currentBuilding = nextBuilding;
    }

    console.log('Generated:', parcels);

    return parcels;
}

// Function to get random minted parcels from ParcelNFT contract
async function getRandomMintedParcels(parcelNftContract, count = 3) {
    try {
        const totalSupply = await parcelNftContract.totalSupply();
        if (totalSupply === 0n) {
            throw new Error('No parcels have been minted yet. Please mint some parcels first.');
        }

        if (BigInt(count) > totalSupply) {
            console.log(`⚠️  Requested ${count} parcels but only ${totalSupply} available. Using all available parcels.`);
            count = Number(totalSupply);
        }

        // Get random indices
        const indices = [];
        const usedIndices = new Set();
        while (indices.length < count) {
            const randomIndex = getRandomInt(0, Number(totalSupply) - 1);
            if (!usedIndices.has(randomIndex)) {
                usedIndices.add(randomIndex);
                indices.push(BigInt(randomIndex));
            }
        }

        // Fetch token IDs and parcel IDs
        const parcels = [];
        for (const index of indices) {
            const tokenId = await parcelNftContract.tokenByIndex(index);
            const parcelId = await parcelNftContract.parcelIdForTokenId(tokenId);
            parcels.push({ tokenId, parcelId });
        }

        return parcels;
    } catch (error) {
        console.error("Error getting random minted parcels:", error.message);
        throw error;
    }
}

// Function to mint a proposal
async function mintProposal(contract, cityTokenContract, parcelIds, proposalIndex, proposalNftAddress, dbClient, { proposalIdLabel, cityLabel, lensAddresses }) {
    try {
        const isConditional = getRandomBoolean();
        const ethAmount = getRandomEthAmount();
        const tokenAmount = getRandomTokenAmount();
        if (!Array.isArray(lensAddresses) || lensAddresses.length === 0) {
            throw new Error('Lens addresses are required to mint proposals.');
        }

        // Generate random proposal type and details
        const proposalTypes = ['Road', 'Park', 'Square', 'Buildings', 'Mixed'];
        const proposalType = proposalTypes[getRandomInt(0, proposalTypes.length - 1)];
        const proposalName = generateRandomName(proposalType);
        const proposalDescription = generateDescription(proposalType);

        console.log(`\nMinting proposal ${proposalIndex + 1}/${NUM_PROPOSALS}`);
        console.log(`Name: ${proposalName}`);
        console.log(`Type: ${proposalType}`);
        console.log(`Description: ${proposalDescription}`);
        console.log(`Parcels (${parcelIds.length}): ${parcelIds.join(', ')}`);
        console.log(`Conditional: ${isConditional}`);
        console.log(`ETH Amount: ${ethers.formatEther(ethAmount)} ETH`);
        console.log(`Token Amount: ${ethers.formatEther(tokenAmount)} CITY`);

        // Build an SVG from the actual parcel geometries
        console.log('\nBuilding proposal SVG from parcel geometries...');
        const parcelsWithGeometry = await fetchParcelGeometries(parcelIds, dbClient);
        if (parcelsWithGeometry.length === 0) {
            throw new Error('No parcel geometries found. Cannot build proposal image.');
        }
        const svgContent = buildProposalSvgFromParcels(parcelsWithGeometry, { label: `${cityLabel}#${proposalIdLabel}` });
        if (!svgContent) {
            throw new Error('Failed to build proposal SVG from parcel geometries.');
        }
        const imageData = Buffer.from(svgContent, 'utf8');
        console.log('SVG image generated');
        console.log('\nUploading image to IPFS...');
        const imageUrl = await uploadImageToPinata(imageData, proposalName);
        console.log('Image uploaded:', imageUrl);

        // Create and upload metadata
        const metadata = {
            name: proposalName,
            description: proposalDescription,
            type: proposalType,
            image: imageUrl,
            image_url: imageUrl,
            external_url: imageUrl,
            attributes: [
                {
                    trait_type: "Proposal Type",
                    value: proposalType
                },
                {
                    trait_type: "Conditional",
                    value: isConditional ? "Yes" : "No"
                },
                {
                    trait_type: "Parcels",
                    value: parcelIds.length.toString()
                }
            ]
        };

        console.log('\nUploading metadata to IPFS...');
        const ipfsUrl = await uploadMetadataToPinata(metadata, proposalName);
        console.log('Metadata uploaded:', ipfsUrl);

        // First approve tokens if needed
        const wallet = contract.runner;
        let previousTx = null;

        if (tokenAmount > 0n) {
            console.log('\nApproving tokens...');
            const result = await sendTransactionWithNonce(
                wallet,
                (overrides) => cityTokenContract.approve(proposalNftAddress, tokenAmount, overrides),
                previousTx
            );
            previousTx = result.tx; // Store the transaction, not the receipt
            console.log('Token approval confirmed');
        }

        // Mint the proposal
        console.log('\nMinting proposal...');
        const { receipt } = await sendTransactionWithNonce(
            wallet,
            (overrides) => contract.mintAndFund(
                DEPLOYER_ADDRESS,
                parcelIds,
                isConditional,
                ipfsUrl,
                ethAmount,
                tokenAmount,
                lensAddresses,
                { value: ethAmount, ...overrides }
            ),
            previousTx
        );

        if (BLOCK_EXPLORER_URL) {
            console.log(`Transaction: ${BLOCK_EXPLORER_URL}${receipt.hash}`);
        }
        console.log(`✅ Proposal ${proposalIndex + 1} minted - Block: ${receipt.blockNumber}`);
        return true;
    } catch (error) {
        console.error(`\n❌ Failed to mint proposal ${proposalIndex + 1}:`, error.message);
        if (error.data?.message) {
            console.error('Detailed error:', error.data.message);
        }
        if (error.reason) {
            console.error('Error reason:', error.reason);
        }
        console.error('Full error:', error);
        // Stop on first failure - throw the error instead of returning false
        throw error;
    }
}

// Helper function to get and log nonce information
async function getAndLogNonce(wallet, action) {
    const currentNonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
    const lastConfirmedNonce = await wallet.provider.getTransactionCount(wallet.address, 'latest');
    console.log(`\n📊 Nonce info for ${action}:`);
    console.log(`   Last confirmed nonce: ${lastConfirmedNonce}`);
    console.log(`   Current nonce (pending): ${currentNonce}`);
    console.log(`   Will use nonce: ${currentNonce}`);
    return currentNonce;
}

// Helper function to send transaction with nonce tracking and confirmation
async function sendTransactionWithNonce(wallet, txFunction, previousTx = null) {
    // If we have a previous transaction, the next nonce should be that nonce + 1
    // Otherwise, get fresh nonce from provider
    let nonce;
    if (previousTx) {
        // Get nonce from previous transaction
        const prevNonce = previousTx.nonce;
        if (prevNonce === undefined || prevNonce === null) {
            // Fallback: get from provider
            console.log('⚠️  Previous transaction nonce not available, querying provider...');
            nonce = await getAndLogNonce(wallet, 'transaction');
        } else {
            // Use the previous transaction's nonce + 1
            nonce = BigInt(prevNonce) + 1n;
            const lastConfirmedNonce = await wallet.provider.getTransactionCount(wallet.address, 'latest');
            const pendingNonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
            console.log(`\n📊 Nonce info for transaction:`);
            console.log(`   Previous transaction nonce: ${prevNonce}`);
            console.log(`   Last confirmed nonce: ${lastConfirmedNonce}`);
            console.log(`   Current nonce (pending): ${pendingNonce}`);
            console.log(`   Will use nonce: ${nonce} (previous + 1)`);
        }
    } else {
        // First transaction - get fresh nonce
        nonce = await getAndLogNonce(wallet, 'transaction');
    }

    // Call the transaction function with explicit nonce
    const tx = await txFunction({ nonce });

    console.log(`   Transaction hash: ${tx.hash}`);
    console.log(`   Transaction nonce: ${tx.nonce}`);
    if (BigInt(tx.nonce) !== BigInt(nonce)) {
        console.log(`   ⚠️  Warning: Transaction nonce (${tx.nonce}) differs from requested (${nonce})`);
    }
    console.log(`   Waiting for confirmation...`);

    // Wait for confirmation - this ensures the transaction is mined before proceeding
    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block: ${receipt.blockNumber}`);

    return { tx, receipt };
}

// Add this function to check total proposals
async function getTotalProposals(contract) {
    try {
        const total = await contract.totalSupply();
        return total;
    } catch (error) {
        console.error("Error getting total proposals:", error.message);
        throw error;
    }
}

// Function to get the last minted token ID from ParcelNFT
async function getLastMintedParcelTokenId(parcelNftContract) {
    try {
        const totalSupply = await parcelNftContract.totalSupply();
        if (totalSupply === 0n) {
            return null;
        }
        // Get the token ID at the last index (totalSupply - 1)
        const lastIndex = totalSupply - 1n;
        const lastTokenId = await parcelNftContract.tokenByIndex(lastIndex);
        return { tokenId: lastTokenId, totalSupply };
    } catch (error) {
        console.error("Error getting last minted parcel token ID:", error.message);
        throw error;
    }
}

// Parse command line arguments
function parseArgs(argv) {
    const args = {
        network: 'hardhat', // Default to hardhat if not specified
        parcelId: null
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--network=')) {
            args.network = arg.split('=')[1]?.trim();
            continue;
        }
        if (arg === '--network' && argv[i + 1]) {
            args.network = argv[i + 1].trim();
            i += 1;
            continue;
        }
        if (arg.startsWith('--parcel-id=')) {
            args.parcelId = arg.split('=')[1]?.trim();
            continue;
        }
        if (arg === '--parcel-id' && argv[i + 1]) {
            args.parcelId = argv[i + 1].trim();
            i += 1;
            continue;
        }
        if (arg.startsWith('--')) {
            // Check if it's a shorthand network argument (e.g., --hardhat, --sepolia)
            const networkName = arg.substring(2); // Remove '--' prefix
            if (SUPPORTED_NETWORKS[networkName]) {
                args.network = networkName;
            }
        }
    }
    if (!SUPPORTED_NETWORKS[args.network]) {
        console.error(`Invalid network: ${args.network}`);
        console.error('Supported networks:');
        Object.keys(SUPPORTED_NETWORKS).forEach(name => console.error(`  - ${name}`));
        console.error('\nYou can use either:');
        console.error('  --network=hardhat  (or --network hardhat)');
        console.error('  --hardhat          (shorthand)');
        console.error('  (no network arg defaults to hardhat)');
        process.exit(1);
    }
    return args;
}

async function findParcelById(parcelNftContract, targetParcelId) {
    const totalSupply = await parcelNftContract.totalSupply();
    if (totalSupply === 0n) {
        throw new Error('No parcels have been minted yet.');
    }
    for (let idx = 0n; idx < totalSupply; idx++) {
        const tokenId = await parcelNftContract.tokenByIndex(idx);
        const parcelId = await parcelNftContract.parcelIdForTokenId(tokenId);
        if (parcelId === targetParcelId) {
            return { parcelId, tokenId };
        }
    }
    return null;
}

async function buildParcelSetIncludingTarget(parcelNftContract, targetParcelId, desiredCount) {
    const parcels = [{ parcelId: targetParcelId }];
    const seen = new Set([targetParcelId]);
    while (parcels.length < desiredCount) {
        const needed = desiredCount - parcels.length;
        const randoms = await getRandomMintedParcels(parcelNftContract, needed);
        randoms.forEach(p => {
            if (!seen.has(p.parcelId)) {
                parcels.push({ parcelId: p.parcelId, tokenId: p.tokenId });
                seen.add(p.parcelId);
            }
        });
        // Break if we can't add more unique parcels (rare unless supply is tiny)
        if (randoms.length === 0) break;
    }
    return parcels.map(p => p.parcelId);
}

async function main() {
    let dbClient = null;
    try {
        console.log("\n🏗️  Urban Game Theory - Proposal NFT Minter");
        console.log("----------------------------------------");

        // Parse command line arguments
        const args = parseArgs(process.argv.slice(2));
        console.log(`Using network: ${args.network}`);
        if (args.parcelId) {
            console.log(`Filtering proposals to include parcel: ${args.parcelId}`);
        }

        // Resolve RPC URL based on network
        const RPC_ENV_OVERRIDE = SUPPORTED_NETWORKS[args.network]?.rpcEnv;
        const rpcUrl =
            (RPC_ENV_OVERRIDE && process.env[RPC_ENV_OVERRIDE]) ||
            process.env.RPC_URL ||
            process.env.ETHEREUM_RPC_URL;

        if (!rpcUrl) {
            throw new Error(`Missing RPC URL. Set ${RPC_ENV_OVERRIDE || 'RPC_URL or ETHEREUM_RPC_URL'}.`);
        }

        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const network = await provider.getNetwork();

        const proposalAddressInfo = resolveContractAddress('ProposalNFT', network.chainId);
        if (!proposalAddressInfo) {
            throw new Error('ProposalNFT address not found in deployments. Run `yarn deploy` first.');
        }

        const cityTokenAddressInfo = resolveContractAddress('CityMemeToken', network.chainId);
        if (!cityTokenAddressInfo) {
            throw new Error('CityMemeToken address not found in deployments. Run `yarn deploy` first.');
        }

        const parcelNftAddressInfo = resolveContractAddress('ParcelNFT', network.chainId);
        if (!parcelNftAddressInfo) {
            throw new Error('ParcelNFT address not found in deployments. Run `yarn deploy` first.');
        }

        if (!PRIVATE_KEY) {
            throw new Error('DEPLOYER_PRIVATE_KEY not set in environment.');
        }

        const proposalNftAddress = proposalAddressInfo.address;
        const cityTokenAddress = cityTokenAddressInfo.address;
        const parcelNftAddress = parcelNftAddressInfo.address;
        const lensAddresses = resolveLensAddresses();

        console.log(`PROPOSAL_NFT_ADDRESS: ${proposalNftAddress} (${proposalAddressInfo.source})`);
        console.log(`CITY_TOKEN_ADDRESS: ${cityTokenAddress} (${cityTokenAddressInfo.source})`);
        console.log(`PARCEL_NFT_ADDRESS: ${parcelNftAddress} (${parcelNftAddressInfo.source})`);
        console.log(`DEPLOYER_ADDRESS: ${DEPLOYER_ADDRESS}`);
        console.log(`LENS_ADDRESSES: ${lensAddresses.join(', ')}`);

        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const proposalContract = new ethers.Contract(proposalNftAddress, PROPOSAL_NFT_ABI, wallet);
        const cityTokenContract = new ethers.Contract(cityTokenAddress, CITY_TOKEN_ABI, wallet);
        const parcelNftContract = new ethers.Contract(parcelNftAddress, PARCEL_NFT_ABI, wallet);

        // Store wallet reference in contracts for nonce tracking
        proposalContract.runner = wallet;
        cityTokenContract.runner = wallet;

        // Check and print the last minted ParcelNFT token ID
        console.log("\n📦 Checking ParcelNFT contract...");
        const lastParcelInfo = await getLastMintedParcelTokenId(parcelNftContract);
        if (lastParcelInfo) {
            console.log(`Last minted ParcelNFT token ID: ${lastParcelInfo.tokenId.toString()}`);
            console.log(`Total ParcelNFT tokens minted: ${lastParcelInfo.totalSupply.toString()}`);
        } else {
            console.log("No ParcelNFT tokens have been minted yet.");
        }
        if (args.parcelId) {
            const found = await findParcelById(parcelNftContract, args.parcelId);
            if (!found) {
                throw new Error(`Parcel ${args.parcelId} not found among minted parcels.`);
            }
            console.log(`Parcel ${args.parcelId} is minted (tokenId ${found.tokenId.toString()}).`);
        }

        // Connect to the database for parcel geometry lookup
        dbClient = await connectToDatabase();
        console.log("Connected to database for parcel geometry lookup.");

        const totalProposals = await getTotalProposals(proposalContract);
        console.log(`\nCurrent number of proposals minted: ${totalProposals}`);

        console.log("\n🚀 Starting proposal minting process...");
        console.log("----------------------------------------");

        // Stop on first failure - if mintProposal throws, the error will propagate
        for (let i = 0; i < NUM_PROPOSALS; i++) {
            let parcelIds;
            if (args.parcelId) {
                if (i === 0) {
                    parcelIds = [args.parcelId];
                    console.log(`\n📦 Using single target parcel for proposal ${i + 1}: ${args.parcelId}`);
                } else {
                    const desiredCount = Math.max(2, getRandomInt(2, 6));
                    console.log(`\n📦 Building parcel set (size ${desiredCount}) including target ${args.parcelId} for proposal ${i + 1}...`);
                    parcelIds = await buildParcelSetIncludingTarget(parcelNftContract, args.parcelId, desiredCount);
                }
            } else {
                // Get random minted parcels from ParcelNFT contract
                const parcelCount = getRandomInt(1, 10);
                console.log(`\n📦 Fetching ${parcelCount} random minted parcels for proposal ${i + 1}...`);
                const randomParcels = await getRandomMintedParcels(parcelNftContract, parcelCount);
                parcelIds = randomParcels.map(p => p.parcelId);
                console.log(`\n✅ Selected ${parcelIds.length} parcels:`);
                randomParcels.forEach((p, idx) => {
                    console.log(`   ${idx + 1}. Parcel ID: ${p.parcelId} (Token ID: ${p.tokenId.toString()})`);
                });
            }

            const baseProposalId = BigInt(totalProposals || 0n);
            const proposalId = (baseProposalId + BigInt(i + 1)).toString();
            const cityLabel = inferCityFromParcelIds(parcelIds);

            await mintProposal(
                proposalContract,
                cityTokenContract,
                parcelIds,
                i,
                proposalNftAddress,
                dbClient,
                { proposalIdLabel: proposalId, cityLabel, lensAddresses }
            );
        }

        console.log("\n✨ All done!");
    } catch (error) {
        console.error("\n❌ Error--->:", error.message);
        process.exitCode = 1;
    } finally {
        if (dbClient) {
            try {
                await dbClient.end();
            } catch (err) {
                console.warn('Warning: failed to close database connection:', err.message);
            }
        }
    }
}

main();