const { ethers } = require('ethers');
const http = require('http');
const https = require('https');
const { resolveContractAddress } = require('./deployment-utils');
require('dotenv').config({ path: '../.env' });

// Contract ABIs
const PROPOSAL_NFT_ABI = [
    "function mintAndFund(address to, string[] memory parcelIds, bool isConditional, string memory imageURI, uint256 ethAmount, uint256 tokenAmount) public payable returns (uint256)",
    "function ownerOf(uint256 tokenId) public view returns (address)",
    "function totalSupply() public view returns (uint256)"
];

const CITY_TOKEN_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)"
];

// Configuration
const CENTER_LAT = 45.760772;
const CENTER_LON = 15.962169;
const ZOOM = 17;
const NUM_PROPOSALS = 5; // Configure how many proposals to mint

const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS;
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const BLOCK_EXPLORER_URL = process.env.BLOCK_EXPLORER_URL;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;

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

// Function to upload image to IPFS via Pinata
async function uploadImageToPinata(imageData, name) {
    if (!PINATA_API_KEY || !PINATA_API_SECRET) {
        throw new Error('Pinata API key or secret not found. Please check your .env file');
    }

    const { statusCode, body } = await httpRequest('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_API_SECRET
        },
        body: imageData
    });

    if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Failed to upload image to Pinata: status ${statusCode} - ${body}`);
    }

    let result;
    try {
        result = JSON.parse(body);
    } catch (err) {
        throw new Error(`Failed to parse Pinata image response: ${err.message}`);
    }
    return `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`;
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

// Function to mint a proposal
async function mintProposal(contract, cityTokenContract, buildings, proposalIndex, proposalNftAddress) {
    try {
        const parcels = await generateConnectedParcels(buildings);
        const parcelIds = parcels.map(p => p.id.toString());
        const isConditional = getRandomBoolean();
        const ethAmount = getRandomEthAmount();
        const tokenAmount = getRandomTokenAmount();

        // Generate random proposal type and details
        const proposalTypes = ['Road', 'Park', 'Square', 'Buildings', 'Mixed'];
        const proposalType = proposalTypes[getRandomInt(0, proposalTypes.length - 1)];
        const proposalName = generateRandomName(proposalType);
        const proposalDescription = generateDescription(proposalType);

        console.log(`\nMinting proposal ${proposalIndex + 1}/${NUM_PROPOSALS}`);
        console.log(`Name: ${proposalName}`);
        console.log(`Type: ${proposalType}`);
        console.log(`Description: ${proposalDescription}`);
        console.log(`Parcels: ${parcelIds.join(', ')}`);
        console.log(`Conditional: ${isConditional}`);
        console.log(`ETH Amount: ${ethers.formatEther(ethAmount)} ETH`);
        console.log(`Token Amount: ${ethers.formatEther(tokenAmount)} CITY`);

        // Generate a simple image for the proposal (in real app this would be a map screenshot)
        const imageData = Buffer.from('Sample image data');
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
        if (tokenAmount > 0n) {
            console.log('\nApproving tokens...');
            const approveTx = await cityTokenContract.approve(proposalNftAddress, tokenAmount);
            await approveTx.wait();
            console.log('Token approval confirmed');
        }

        // Mint the proposal
        console.log('\nMinting proposal...');
        const tx = await contract.mintAndFund(
            DEPLOYER_ADDRESS,
            parcelIds,
            isConditional,
            ipfsUrl,
            ethAmount,
            tokenAmount,
            { value: ethAmount }
        );

        console.log(`Transaction submitted: ${BLOCK_EXPLORER_URL}${tx.hash}`);
        const receipt = await tx.wait();
        console.log('Receipt:', receipt);
        console.log(`✅ Proposal ${proposalIndex + 1} minted - Block: ${receipt.blockNumber}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to mint proposal ${proposalIndex + 1}:`, error.message);
        if (error.data?.message) {
            console.error('Detailed error:', error.data.message);
        }
        console.error('Error details:', error);
        return false;
    }
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

async function main() {
    try {
        console.log("\n🏗️  Urban Game Theory - Proposal NFT Minter");
        console.log("----------------------------------------");
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const network = await provider.getNetwork();

        const proposalAddressInfo = resolveContractAddress('ProposalNFT', network.chainId, {
            explicitAddress: process.env.PROPOSAL_NFT_ADDRESS || null
        });
        if (!proposalAddressInfo) {
            throw new Error('ProposalNFT address not provided and no matching deployment found. Run `yarn deploy` or set PROPOSAL_NFT_ADDRESS.');
        }

        const cityTokenAddressInfo = resolveContractAddress('CityMemeToken', network.chainId, {
            explicitAddress: process.env.CITY_MEME_TOKEN_ADDRESS || process.env.CITY_TOKEN_ADDRESS || null
        });
        if (!cityTokenAddressInfo) {
            throw new Error('CityMemeToken address not provided and no matching deployment found. Run `yarn deploy` or set CITY_MEME_TOKEN_ADDRESS.');
        }

        if (!PRIVATE_KEY) {
            throw new Error('DEPLOYER_PRIVATE_KEY not set in environment.');
        }

        const proposalNftAddress = proposalAddressInfo.address;
        const cityTokenAddress = cityTokenAddressInfo.address;

        console.log(`PROPOSAL_NFT_ADDRESS: ${proposalNftAddress} (${proposalAddressInfo.source})`);
        console.log(`CITY_TOKEN_ADDRESS: ${cityTokenAddress} (${cityTokenAddressInfo.source})`);
        console.log(`DEPLOYER_ADDRESS: ${DEPLOYER_ADDRESS}`);

        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const proposalContract = new ethers.Contract(proposalNftAddress, PROPOSAL_NFT_ABI, wallet);
        const cityTokenContract = new ethers.Contract(cityTokenAddress, CITY_TOKEN_ABI, wallet);

        console.log("\nCalculating bounding box...");
        const bounds = calculateBoundingBox(CENTER_LAT, CENTER_LON, ZOOM);

        console.log("Fetching all buildings from OpenStreetMap in the bounding box...");
        const allBuildings = await getBuildings(bounds);
        console.log(`Found ${allBuildings.length} buildings`);

        const totalProposals = await getTotalProposals(proposalContract);
        console.log(`\nCurrent number of proposals minted: ${totalProposals}`);

        console.log("\n🚀 Starting proposal minting process...");
        console.log("----------------------------------------");

        const success = [];
        for (let i = 0; i < NUM_PROPOSALS; i++) {
            const buildings = await generateConnectedParcels(allBuildings);
            await mintProposal(proposalContract, cityTokenContract, buildings, i, proposalNftAddress);
        }

        console.log("\n✨ All done!");
    } catch (error) {
        console.error("\n❌ Error--->:", error.message);
        process.exit(1);
    }
}

main();