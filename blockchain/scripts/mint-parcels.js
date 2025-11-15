#!/usr/bin/env node

/*
 * Parcel NFT batch minter
 * -----------------------
 * - Reads Postgres parcels (filtered to Zagreb) using pg
 * - Builds canonical parcel IDs HR-<maticni_broj_ko>-<broj_cestice>
 * - Mints missing ParcelNFT tokens as ERC721 NFTs, with ownership assigned to random addresses from a set
 * - Respects --limit and --offset, defaults to first 10
 */

require('dotenv').config();

const { existsSync, mkdirSync, writeFileSync } = require('fs');
const path = require('path');
const https = require('https');
const { ethers } = require('ethers');
const { Client } = require('pg');
const { findDeploymentAddress } = require('./deployment-utils');

const DEFAULT_LIMIT = 10;
const DEFAULT_OFFSET = 0;
const SUPPORTED_NETWORKS = {
    hardhat: { chainId: 31337, rpcEnv: 'RPC_URL' },
    anvil: { chainId: 31337, rpcEnv: 'RPC_URL' },
    'sepolia': { chainId: 11155111, rpcEnv: 'ETHEREUM_RPC_URL' },
    'ethereum-mainnet': { chainId: 1, rpcEnv: 'ETHEREUM_RPC_URL' },
    'mainnet': { chainId: 1, rpcEnv: 'ETHEREUM_RPC_URL' },
    'base': { chainId: 8453, rpcEnv: 'ETHEREUM_RPC_URL' },
    'base-sepolia': { chainId: 84532, rpcEnv: 'ETHEREUM_RPC_URL' }
};
const DEFAULT_BATCH_SIZE = 20;
const RANDOM_ADDRESS_ENV_KEYS = [
    'ACCOUNT_0_ADDRESS',
    'ACCOUNT_1_ADDRESS',
    'ACCOUNT_2_ADDRESS',
    'ACCOUNT_3_ADDRESS',
    'ACCOUNT_4_ADDRESS',
    'ACCOUNT_5_ADDRESS'
];

const networkConfig = {
    rpcUrl: process.env.RPC_URL || process.env.ETHEREUM_RPC_URL,
    explorerUrl: process.env.BLOCK_EXPLORER_URL || process.env.ETHEREUM_BLOCK_EXPLORER_URL,
    deployerKey: process.env.DEPLOYER_PRIVATE_KEY,
    deployerAddress: process.env.DEPLOYER_ADDRESS,
    parcelNftAddress: process.env.PARCEL_NFT_ADDRESS,
};

const UPLOAD_SERVICE_BASE_URL =
    (process.env.UPLOAD_SERVICE_BASE_URL || process.env.LOCAL_UPLOAD_BASE_URL || '').trim().replace(/\/+$/, '');
const LOCAL_UPLOAD_CHAIN_IDS = new Set(
    (process.env.LOCAL_UPLOAD_CHAIN_IDS || '31337,1337')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
);
let useLocalUploadService = false;

const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;
const METADATA_BASE_URL = process.env.PARCEL_METADATA_BASE_URL || null;
const METADATA_OUTPUT_DIR = process.env.PARCEL_METADATA_OUTPUT_DIR
    ? path.resolve(process.env.PARCEL_METADATA_OUTPUT_DIR)
    : path.resolve(__dirname, '../uploads/metadata/parcels');
const IMAGE_URL_TEMPLATE = process.env.PARCEL_IMAGE_URL_TEMPLATE || null;
const IMAGE_BASE_URL = process.env.PARCEL_IMAGE_BASE_URL || null;
const IMAGE_PLACEHOLDER_URL = process.env.PARCEL_IMAGE_PLACEHOLDER_URL
    || 'https://dummyimage.com/512x512/0d3b66/f4d35e.png&text=Parcel';
const EXTERNAL_URL_TEMPLATE = process.env.PARCEL_EXTERNAL_URL_TEMPLATE || null;

const parcelNftAbi = [
    'function mintParcel(address to, string parcelId, string metadataURI) public returns (uint256)',
    'function mintBatch(address to, string[] parcelIds, string[] metadataURIs) public returns (uint256[] memory)',
    'function ownerOf(uint256 tokenId) public view returns (address)',
    'function ownerOfParcelId(string parcelId) public view returns (address)',
    'function tokenIdForParcelId(string parcelId) public view returns (uint256)',
    'function getParcelById(string parcelId) public view returns (tuple(string parcelId, string metadataURI))'
];

async function postJson(urlString, payload, extraHeaders = {}) {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders
    };

    const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                resolve({ statusCode: res.statusCode || 0, body: responseBody });
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function ensureDirExists(dirPath) {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

function slugifyParcelId(parcelId) {
    return parcelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function applyTemplate(template, parcel) {
    if (!template) return null;
    const safeId = encodeURIComponent(parcel.parcelId);
    const slug = slugifyParcelId(parcel.parcelId);
    const municipality = parcel.cadastralName ? encodeURIComponent(parcel.cadastralName) : '';
    return template
        .replace(/{parcelId}/g, safeId)
        .replace(/{parcel_id}/g, safeId)
        .replace(/{parcelSlug}/g, slug)
        .replace(/{parcel_slug}/g, slug)
        .replace(/{municipality}/g, municipality)
        .replace('%s', safeId);
}

function combineUrl(base, fileName) {
    if (!base) return null;
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    try {
        return new URL(fileName, normalizedBase).toString();
    } catch (_) {
        return `${normalizedBase}${fileName}`;
    }
}

function normalizeExplorerBaseUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch (_) {
        return url.replace(/\/+$/, '');
    }
}

function buildNftExplorerUrl(explorerBaseUrl, contractAddress, tokenIdDecimal) {
    if (!explorerBaseUrl || !contractAddress || !tokenIdDecimal) return null;
    const base = normalizeExplorerBaseUrl(explorerBaseUrl);
    if (!base) return null;
    return `${base}/nft/${contractAddress}/${tokenIdDecimal}`;
}

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

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return 'unknown';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function shouldUseLocalUpload(chainIdBigInt) {
    if (!UPLOAD_SERVICE_BASE_URL) {
        return false;
    }
    if (process.env.FORCE_LOCAL_UPLOADS === 'true') {
        return true;
    }
    if (chainIdBigInt === undefined || chainIdBigInt === null) {
        return false;
    }
    const chainIdStr = chainIdBigInt.toString();
    return LOCAL_UPLOAD_CHAIN_IDS.has(chainIdStr);
}

function ensureUploadServiceConfigured() {
    if (!UPLOAD_SERVICE_BASE_URL) {
        throw new Error('UPLOAD_SERVICE_BASE_URL must be set to use the local upload service.');
    }
}

async function postJsonToUploadService(pathname, payload) {
    ensureUploadServiceConfigured();
    const target = `${UPLOAD_SERVICE_BASE_URL}${pathname}`;
    const response = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Upload service request to ${pathname} failed (${response.status}): ${body}`);
    }
    return response.json();
}

function buildParcelPlaceholderSvg(parcel) {
    const width = 512;
    const height = 512;
    const primaryLabel = escapeXml(parcel.parcelId);
    const secondaryRaw = parcel.cadastralName || parcel.maticniBrojKo || '';
    const secondaryLabel = secondaryRaw ? escapeXml(secondaryRaw) : '';
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        '  <defs>',
        '    <linearGradient id="parcelBg" x1="0%" y1="0%" x2="100%" y2="100%">',
        '      <stop offset="0%" stop-color="#0d3b66" />',
        '      <stop offset="100%" stop-color="#142c44" />',
        '    </linearGradient>',
        '  </defs>',
        '  <rect width="100%" height="100%" fill="url(#parcelBg)" rx="32" />',
        '  <g fill="none" stroke="#facd55" stroke-width="6" opacity="0.6">',
        '    <rect x="40" y="40" width="432" height="432" rx="30" />',
        '    <path d="M92 226 L188 138 L328 168 L420 276 L302 388 Z" />',
        '  </g>',
        `  <text x="50%" y="80%" text-anchor="middle" fill="#ffffff" font-size="42" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${primaryLabel}</text>`,
        secondaryLabel
            ? `  <text x="50%" y="91%" text-anchor="middle" fill="#cbd5f5" font-size="20" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${secondaryLabel}</text>`
            : '',
        '</svg>'
    ].join('\n');
}

async function uploadParcelImageLocally(parcel, fileLabel) {
    const svgContent = buildParcelPlaceholderSvg(parcel);
    const base64 = Buffer.from(svgContent, 'utf8').toString('base64');
    return postJsonToUploadService('/images', {
        imageData: `data:image/svg+xml;base64,${base64}`,
        fileName: `${fileLabel}-image`
    });
}

async function uploadParcelMetadataLocally(metadata, fileLabel) {
    return postJsonToUploadService('/metadata', {
        metadata,
        fileName: `${fileLabel}-metadata`
    });
}

async function createLocalMetadataResource(parcel, { dryRun = false } = {}) {
    ensureUploadServiceConfigured();
    const slug = slugifyParcelId(parcel.parcelId) || `parcel-${Date.now()}`;
    const metadata = buildParcelMetadata(parcel);
    if (dryRun) {
        return {
            metadataURI: `${UPLOAD_SERVICE_BASE_URL}/metadata/${slug}-metadata.json`,
            metadata,
            storage: 'local-service',
            imageUrl: `${UPLOAD_SERVICE_BASE_URL}/images/${slug}-image.svg`
        };
    }

    const imageResponse = await uploadParcelImageLocally(parcel, slug);
    metadata.image = imageResponse.imageUrl;
    metadata.image_url = imageResponse.imageUrl;
    metadata.external_url = metadata.external_url || imageResponse.imageUrl;
    metadata.properties = {
        ...(metadata.properties || {}),
        uploadSource: 'local-service'
    };

    const metadataResponse = await uploadParcelMetadataLocally(metadata, slug);

    return {
        metadataURI: metadataResponse.metadataUrl,
        metadata,
        storage: 'local-service',
        imageUrl: imageResponse.imageUrl
    };
}

function parseBoundingBoxArg(value) {
    if (!value) return null;
    const parts = value.split(',').map(part => Number(part.trim()));
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
        throw new Error('Invalid --bbox value. Expected format: lat1,lon1,lat2,lon2');
    }
    const [lat1, lon1, lat2, lon2] = parts;
    const south = Math.min(lat1, lat2);
    const north = Math.max(lat1, lat2);
    const west = Math.min(lon1, lon2);
    const east = Math.max(lon1, lon2);
    if (south === north || west === east) {
        throw new Error('Invalid --bbox value. Bounding box must have area.');
    }
    return { south, west, north, east };
}

function buildErrorFingerprint(error) {
    const pieces = [];
    const maybeAdd = value => {
        if (typeof value !== 'string') return;
        const trimmed = value.trim();
        if (!trimmed) return;
        pieces.push(trimmed);
    };
    maybeAdd(error?.reason);
    maybeAdd(error?.shortMessage);
    maybeAdd(error?.message);
    maybeAdd(error?.error?.message);
    return pieces.join(' ').toLowerCase();
}

function isParcelAlreadyMintedError(error) {
    const fingerprint = buildErrorFingerprint(error);
    return fingerprint.includes('parcel already minted') || fingerprint.includes('token id already minted');
}

function isParcelMissingError(error) {
    const fingerprint = buildErrorFingerprint(error);
    const code = error?.code || error?.error?.code;
    if (fingerprint.includes('parcel does not exist') || fingerprint.includes('nonexistent token')) {
        return true;
    }
    if (fingerprint.includes('does not exist') && fingerprint.includes('parcelnft')) {
        return true;
    }
    const zeroData =
        error?.value === '0x' ||
        error?.data === '0x' ||
        error?.error?.data === '0x' ||
        error?.info?.error?.data === '0x';
    if (code === 'CALL_EXCEPTION' && (zeroData || fingerprint.includes('require(false)'))) {
        return true;
    }
    return false;
}

function extractErrorDetails(error) {
    const fingerprint = buildErrorFingerprint(error);
    return fingerprint || (error ? String(error) : 'Unknown error');
}

function buildImageUrl(parcel) {
    if (IMAGE_URL_TEMPLATE) {
        return applyTemplate(IMAGE_URL_TEMPLATE, parcel);
    }
    if (IMAGE_BASE_URL) {
        const fileName = `${slugifyParcelId(parcel.parcelId) || parcel.parcelId}.png`;
        return combineUrl(IMAGE_BASE_URL, fileName);
    }
    return IMAGE_PLACEHOLDER_URL;
}

function buildExternalUrl(parcel) {
    if (!EXTERNAL_URL_TEMPLATE) return null;
    const result = applyTemplate(EXTERNAL_URL_TEMPLATE, parcel);
    if (result && result !== EXTERNAL_URL_TEMPLATE) {
        return result;
    }
    try {
        const url = new URL(EXTERNAL_URL_TEMPLATE);
        url.searchParams.set('parcelId', parcel.parcelId);
        return url.toString();
    } catch (_) {
        return EXTERNAL_URL_TEMPLATE;
    }
}

function cleanMetadataObject(obj) {
    const result = {};
    Object.entries(obj).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') {
            return;
        }
        result[key] = value;
    });
    return result;
}

function buildParcelMetadata(parcel) {
    const attributes = [
        { trait_type: 'Parcel ID', value: parcel.parcelId },
        { trait_type: 'Municipality', value: parcel.cadastralName || 'Unknown' },
        { trait_type: 'Cadastral Number', value: parcel.maticniBrojKo }
    ];

    let roundedArea = null;
    if (typeof parcel.areaSqM === 'number' && Number.isFinite(parcel.areaSqM)) {
        roundedArea = Math.round(parcel.areaSqM * 100) / 100;
        attributes.push({ trait_type: 'Area (m²)', value: roundedArea, display_type: 'number' });
    }

    if (parcel.geometryHash) {
        attributes.push({ trait_type: 'Geometry Hash', value: parcel.geometryHash });
    }

    const metadata = {
        name: `Parcel ${parcel.parcelId}`,
        description: `Digitized cadastral parcel ${parcel.parcelId}${parcel.cadastralName ? ` in ${parcel.cadastralName}` : ''}.`,
        image: buildImageUrl(parcel),
        external_url: buildExternalUrl(parcel),
        attributes,
        background_color: '0d3b66',
        parcelId: parcel.parcelId,
        cadastralMunicipality: parcel.cadastralName,
        cadastralNumber: parcel.maticniBrojKo,
        areaSquareMeters: roundedArea,
        geometryHash: parcel.geometryHash || null
    };

    return cleanMetadataObject(metadata);
}

async function uploadMetadataToPinata(metadata, parcelId) {
    if (!PINATA_API_KEY || !PINATA_API_SECRET) {
        throw new Error('Pinata credentials missing. Provide PINATA_API_KEY and PINATA_API_SECRET.');
    }

    let response;
    try {
        response = await postJson(
            'https://api.pinata.cloud/pinning/pinJSONToIPFS',
            {
                pinataContent: metadata,
                pinataMetadata: {
                    name: `${slugifyParcelId(parcelId)}-metadata.json`
                }
            },
            {
                pinata_api_key: PINATA_API_KEY,
                pinata_secret_api_key: PINATA_API_SECRET
            }
        );
    } catch (err) {
        throw new Error(`Failed to upload metadata to Pinata: ${err.message}`);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Failed to upload metadata to Pinata: status ${response.statusCode} - ${response.body}`);
    }

    let result;
    try {
        result = JSON.parse(response.body);
    } catch (err) {
        throw new Error(`Failed to parse Pinata response JSON: ${err.message}`);
    }

    if (!result.IpfsHash) {
        throw new Error('Pinata response missing IpfsHash.');
    }
    return `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`;
}

async function createMetadataResource(parcel, { dryRun = false } = {}) {
    if (useLocalUploadService) {
        return createLocalMetadataResource(parcel, { dryRun });
    }

    const metadata = buildParcelMetadata(parcel);
    const hasPinata = PINATA_API_KEY && PINATA_API_SECRET;

    if (hasPinata) {
        if (dryRun) {
            return { metadataURI: '(pending-upload-to-pinata)', metadata, storage: 'pinata' };
        }
        const uri = await uploadMetadataToPinata(metadata, parcel.parcelId);
        return { metadataURI: uri, metadata, storage: 'pinata' };
    }

    if (!METADATA_BASE_URL && !dryRun) {
        throw new Error('PARCEL_METADATA_BASE_URL must be set when not using Pinata.');
    }

    const fileName = `${slugifyParcelId(parcel.parcelId) || parcel.parcelId}.json`;
    const filePath = path.join(METADATA_OUTPUT_DIR, fileName);

    if (dryRun) {
        const uri = METADATA_BASE_URL ? combineUrl(METADATA_BASE_URL, fileName) : `file://${filePath}`;
        return { metadataURI: uri, metadata, storage: 'filesystem', filePath };
    }

    ensureDirExists(METADATA_OUTPUT_DIR);
    writeFileSync(filePath, JSON.stringify(metadata, null, 2));
    const uri = combineUrl(METADATA_BASE_URL, fileName);
    return { metadataURI: uri, metadata, storage: 'filesystem', filePath };
}

function parseArgs(argv) {
    const args = {
        limit: DEFAULT_LIMIT,
        offset: DEFAULT_OFFSET,
        dryRun: false,
        bbox: null,
        verbose: false,
        batchSize: DEFAULT_BATCH_SIZE,
        network: null
    };
    argv.forEach(arg => {
        if (arg.startsWith('--limit=')) {
            args.limit = Number(arg.split('=')[1]) || DEFAULT_LIMIT;
        } else if (arg.startsWith('--offset=')) {
            args.offset = Number(arg.split('=')[1]) || DEFAULT_OFFSET;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg.startsWith('--bbox=')) {
            const raw = arg.substring('--bbox='.length);
            args.bbox = parseBoundingBoxArg(raw);
        } else if (arg === '--verbose') {
            args.verbose = true;
        } else if (arg.startsWith('--batch-size=')) {
            const size = Number(arg.split('=')[1]);
            if (!Number.isFinite(size) || size <= 0) {
                throw new Error('Invalid --batch-size value. Expected a positive integer.');
            }
            args.batchSize = Math.floor(size);
        } else if (arg.startsWith('--network=')) {
            args.network = arg.split('=')[1]?.trim();
        }
    });
    if (!args.network || !SUPPORTED_NETWORKS[args.network]) {
        console.error('Please provide a valid --network argument.');
        console.error('Supported networks:');
        Object.keys(SUPPORTED_NETWORKS).forEach(name => console.error(`  - ${name}`));
        process.exit(1);
    }
    return args;
}

function formatParcelId(maticniBrojKo, brojCestice) {
    const idPart = String(maticniBrojKo).trim();
    const numberPart = String(brojCestice).trim();
    if (!idPart || !numberPart) {
        throw new Error('Invalid parcel row: missing cadastral or parcel number.');
    }
    return `HR-${idPart}-${numberPart}`;
}

function getDemoOwnerPool() {
    const pool = RANDOM_ADDRESS_ENV_KEYS
        .map(key => process.env[key])
        .filter(Boolean);
    if (pool.length === 0) {
        throw new Error('No demo owner addresses defined. Populate ACCOUNT_0_ADDRESS…ACCOUNT_5_ADDRESS.');
    }
    return pool;
}

function assignOwnersToParcels(parcels) {
    const pool = getDemoOwnerPool();
    return parcels.map(parcel => {
        if (parcel.status !== 'available') {
            return parcel;
        }
        const owner = pool[Math.floor(Math.random() * pool.length)];
        return { ...parcel, assignedOwner: owner };
    });
}

function buildOwnerBuckets(parcels) {
    const buckets = new Map();
    parcels.forEach(parcel => {
        if (parcel.status !== 'available') return;
        if (!parcel.assignedOwner) {
            throw new Error(`Parcel ${parcel.parcelId} is missing an assigned owner.`);
        }
        if (!buckets.has(parcel.assignedOwner)) {
            buckets.set(parcel.assignedOwner, []);
        }
        buckets.get(parcel.assignedOwner).push(parcel);
    });
    return buckets;
}

function chunkArray(items, size) {
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error('Batch size must be a positive integer.');
    }
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

function buildParcelSelectionQuery({ limit, offset, bbox }) {
    const conditions = [
        `p.current = true`,
        `cm.grad_opcina = 'ZAGREB'`
    ];

    const params = [];
    let paramIndex = 1;

    if (bbox) {
        conditions.push(`
            ST_Intersects(
                p.geom,
                ST_Transform(
                    ST_SetSRID(ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}), 4326),
                    ST_SRID(p.geom)
                )
            )
        `);
        params.push(bbox.west, bbox.south, bbox.east, bbox.north);
        paramIndex += 4;
    }

    const limitPlaceholder = `$${paramIndex++}`;
    params.push(limit);
    const offsetPlaceholder = `$${paramIndex++}`;
    params.push(offset);

    const sql = `
        SELECT
            p.cestica_id,
            p.broj_cestice,
            p.maticni_broj_ko,
            cm.naziv AS cadastral_name,
            ST_Area(p.geom) AS area_sqm,
            MD5(ST_AsBinary(p.geom)) AS geometry_hash
        FROM parcel p
        JOIN cadastral_municipality cm ON cm.maticni_broj = p.maticni_broj_ko
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY p.cestica_id
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;
    return { sql, params };
}

async function fetchCandidateParcels(client, { limit, offset, bbox }) {
    const { sql, params } = buildParcelSelectionQuery({ limit, offset, bbox });
    const { rows } = await client.query(sql, params);
    return rows;
}

async function getExistingParcelOwner(contract, parcelId) {
    try {
        return await contract.ownerOfParcelId(parcelId);
    } catch (error) {
        if (isParcelMissingError(error)) {
            return null;
        }
        throw error;
    }
}

// Check which parcels are already minted and return them with status
async function resolveAlreadyMinted(contract, parcels) {
    const results = [];
    for (const parcel of parcels) {
        const owner = await getExistingParcelOwner(contract, parcel.parcelId);
        if (owner) {
            results.push({ ...parcel, status: 'already-minted', owner });
        } else {
            results.push({ ...parcel, status: 'available' });
        }
    }
    return results;
}

async function mintParcels(contract, parcels, dryRun, { verbose, batchSize }) {
    const minted = [];
    const skipped = [];
    const totalAvailable = parcels.reduce(
        (acc, parcel) => (parcel.status === 'available' ? acc + 1 : acc),
        0
    );
    const startedAt = Date.now();
    let processedCount = 0;
    let totalGasSpentWei = 0n;

    const logEtaIfNeeded = () => {
        if (totalAvailable === 0) return;
        if (processedCount === 0 || processedCount % 100 !== 0) return;
        const elapsedMs = Date.now() - startedAt;
        const remaining = totalAvailable - processedCount;
        const etaMs =
            remaining > 0 ? Math.round((elapsedMs / processedCount) * remaining) : 0;
        console.log(
            `[eta] Processed ${processedCount}/${totalAvailable} parcels. Elapsed ${formatDuration(elapsedMs)}. ETA ${formatDuration(etaMs)}.`
        );
    };

    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error('Batch size must be a positive integer.');
    }

    const ownerBuckets = buildOwnerBuckets(parcels);

    for (const [owner, ownerParcels] of ownerBuckets.entries()) {
        const stillAvailable = [];
        for (const parcel of ownerParcels) {
            const existingOwner = await getExistingParcelOwner(contract, parcel.parcelId);
            if (existingOwner) {
                skipped.push({ ...parcel, owner: existingOwner, reason: 'already-minted' });
                processedCount += 1;
                logEtaIfNeeded();
                continue;
            }
            stillAvailable.push(parcel);
        }

        const batches = chunkArray(stillAvailable, batchSize);
        for (const batchParcels of batches) {
            if (batchParcels.length === 0) continue;

            const parcelIds = batchParcels.map(parcel => parcel.parcelId);
            const metadataURIs = batchParcels.map(parcel => {
                if (!parcel.metadataURI) {
                    throw new Error(`Missing metadata URI for parcel ${parcel.parcelId}`);
                }
                return parcel.metadataURI;
            });

            if (dryRun) {
                batchParcels.forEach(parcel => {
                    minted.push({ ...parcel, owner, txHash: 'dry-run' });
                });
                processedCount += batchParcels.length;
                logEtaIfNeeded();
                if (verbose) {
                    console.log(`[dry-run] Would mint batch of ${batchParcels.length} parcels to ${owner}`);
                }
                continue;
            }

            try {
                const mintFunction =
                    typeof contract.getFunction === 'function'
                        ? contract.getFunction('mintBatch')
                        : null;
                if (mintFunction && typeof mintFunction.staticCall === 'function') {
                    await mintFunction.staticCall(owner, parcelIds, metadataURIs);
                } else if (typeof contract.callStatic?.mintBatch === 'function') {
                    await contract.callStatic.mintBatch(owner, parcelIds, metadataURIs);
                } else {
                    throw new Error('Unable to perform static call for mintBatch.');
                }
            } catch (error) {
                const details = extractErrorDetails(error);
                if (verbose) {
                    console.warn(`[warn] Preflight batch mint (${batchParcels.length} parcels) reverted: ${details}`);
                }
                batchParcels.forEach(parcel => {
                    skipped.push({ ...parcel, owner: null, reason: 'preflight-revert', detail: details });
                    processedCount += 1;
                });
                logEtaIfNeeded();
                continue;
            }

            const tx = await contract.mintBatch(owner, parcelIds, metadataURIs);
            const receipt = await tx.wait();
            let feeWei = null;
            if (typeof receipt.fee === 'bigint') {
                feeWei = receipt.fee;
            } else if (typeof receipt.gasUsed === 'bigint' && typeof receipt.effectiveGasPrice === 'bigint') {
                feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
            } else if (typeof receipt.gasUsed === 'bigint' && typeof tx.gasPrice === 'bigint') {
                feeWei = receipt.gasUsed * tx.gasPrice;
            }
            if (typeof feeWei === 'bigint') {
                totalGasSpentWei += feeWei;
            }

            batchParcels.forEach(parcel => {
                minted.push({ ...parcel, owner, txHash: receipt.hash, tokenId: parcel.tokenId });
            });
            processedCount += batchParcels.length;
            logEtaIfNeeded();
            if (verbose) {
                console.log(`Minted batch of ${batchParcels.length} parcels to ${owner} - tx ${receipt.hash}`);
                batchParcels.forEach(parcel => {
                    console.log(`  ↳ ${parcel.parcelId} metadata: ${parcel.metadataURI}`);
                    if (parcel.storage === 'filesystem' && parcel.filePath) {
                        console.log(`      file: ${parcel.filePath}`);
                    } else if (parcel.storage === 'pinata') {
                        console.log('      storage: pinata');
                    }
                });
            }
        }
    }

    const durationMs = Date.now() - startedAt;
    return {
        minted,
        skipped,
        durationMs,
        processedCount,
        totalAvailable,
        totalGasSpentWei
    };
}

async function attachMetadataToParcels(parcels, { dryRun, verbose }) {
    const enriched = [];
    for (const parcel of parcels) {
        if (parcel.status !== 'available') {
            enriched.push(parcel);
            continue;
        }

        const metadataResource = await createMetadataResource(parcel, { dryRun });
        if (verbose) {
            if (dryRun) {
                const storageHint = metadataResource.storage || 'unknown';
                const fileHint = metadataResource.filePath ? ` (${metadataResource.filePath})` : '';
                console.log(`[metadata][dry-run] ${parcel.parcelId} -> ${metadataResource.metadataURI} [${storageHint}]${fileHint}`);
            } else if (metadataResource.storage === 'filesystem') {
                console.log(`[metadata] wrote ${parcel.parcelId} metadata to ${metadataResource.filePath}`);
            } else if (metadataResource.storage === 'pinata') {
                console.log(`[metadata] uploaded ${parcel.parcelId} metadata to ${metadataResource.metadataURI}`);
            }
        }
        enriched.push({ ...parcel, ...metadataResource });
    }
    return enriched;
}

async function main() {
    console.log('This script will mint some or all parcels from the "parcel" table where grad_opcina = ZAGREB.');
    const args = parseArgs(process.argv.slice(2));
    console.log('Mint parcels script starting with args:', args);

    const RPC_ENV_OVERRIDE = SUPPORTED_NETWORKS[args.network]?.rpcEnv;
    const rpcCandidate =
        (RPC_ENV_OVERRIDE && process.env[RPC_ENV_OVERRIDE]) ||
        process.env.RPC_URL ||
        process.env.ETHEREUM_RPC_URL ||
        networkConfig.rpcUrl;
    if (!rpcCandidate) {
        throw new Error(`Missing RPC URL. Set ${RPC_ENV_OVERRIDE || 'RPC_URL or ETHEREUM_RPC_URL'}.`);
    }
    networkConfig.rpcUrl = rpcCandidate;

    if (!networkConfig.deployerKey) {
        throw new Error('Missing DEPLOYER_PRIVATE_KEY in environment.');
    }

    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
    const signer = new ethers.Wallet(networkConfig.deployerKey, provider);
    const nonceManager = new ethers.NonceManager(signer);
    const deployerAddress = networkConfig.deployerAddress || signer.address;
    const network = await provider.getNetwork();
    useLocalUploadService = shouldUseLocalUpload(network.chainId);
    if (useLocalUploadService) {
        if (!UPLOAD_SERVICE_BASE_URL) {
            throw new Error('UPLOAD_SERVICE_BASE_URL is required when using the local upload service.');
        }
        console.log(`Using local upload service at ${UPLOAD_SERVICE_BASE_URL}`);
    }

    if (!networkConfig.parcelNftAddress) {
        const resolved = findDeploymentAddress('ParcelNFT', network.chainId);
        if (!resolved) {
            throw new Error('ParcelNFT address not provided and no matching deployment found. Run `yarn deploy` or set PARCEL_NFT_ADDRESS.');
        }
        networkConfig.parcelNftAddress = resolved.address;
        console.log(`Resolved ParcelNFT from deployments/${resolved.directory}: ${resolved.address}`);
    }

    let formattedBalance = 'unknown';
    let deployerBalanceWei = null;
    try {
        deployerBalanceWei = await provider.getBalance(deployerAddress);
        formattedBalance = `${ethers.formatEther(deployerBalanceWei)} ETH`;
    } catch (err) {
        console.warn('Unable to fetch deployer balance:', err.message);
    }

    const dbClient = new Client({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
    });

    await dbClient.connect();

    try {
        console.log('----------------------------------------');
        console.log(`Parcel contract: ${networkConfig.parcelNftAddress}`);
        console.log(`RPC URL: ${networkConfig.rpcUrl}`);
        console.log(`Network chain: ${network.chainId} (${network.name || 'unknown'})`);
        console.log(`Deployer address: ${deployerAddress}`);
        console.log(`Deployer balance: ${formattedBalance}`);
        if (args.bbox) {
            console.log('Bounding box filter (lat/lon):');
            console.log(`  South: ${args.bbox.south}, West: ${args.bbox.west}`);
            console.log(`  North: ${args.bbox.north}, East: ${args.bbox.east}`);
        } else {
            console.log('Bounding box filter: none (using full dataset)');
        }
        console.log(`Batch size: ${args.batchSize} parcel(s) per transaction.`);
        console.log('----------------------------------------');

        if (!args.dryRun && deployerBalanceWei !== null && deployerBalanceWei === 0n) {
            console.warn('⚠️  Deployer account has zero balance. Transactions will run out of gas unless funded.');
        }

        const contractCode = await provider.getCode(networkConfig.parcelNftAddress);
        if (!contractCode || contractCode === '0x') {
            throw new Error(`No contract deployed at ${networkConfig.parcelNftAddress} on chain ${network.chainId}.`);
        }

        console.log('Fetching candidate parcels from database...');
        const rows = await fetchCandidateParcels(dbClient, args);
        if (rows.length === 0) {
            console.log('No parcels returned from database. Check filters or increase limit.');
            return;
        }

        const parcels = rows.map(row => {
            const parcelId = formatParcelId(row.maticni_broj_ko, row.broj_cestice);
            const tokenId = ethers.id(parcelId);
            return {
                parcelId,
                tokenId,
                brojCestice: row.broj_cestice,
                maticniBrojKo: row.maticni_broj_ko,
                cadastralName: row.cadastral_name,
                areaSqM: (() => {
                    if (row.area_sqm === null || row.area_sqm === undefined) return null;
                    const areaValue = Number(row.area_sqm);
                    return Number.isFinite(areaValue) ? areaValue : null;
                })(),
                geometryHash: row.geometry_hash || null
            };
        });

        console.log(`Fetched ${parcels.length} parcels from database (before mint status check).`);

        const contract = new ethers.Contract(networkConfig.parcelNftAddress, parcelNftAbi, nonceManager);

        const parcelsWithStatus = await resolveAlreadyMinted(contract, parcels);
        const pending = parcelsWithStatus.filter(p => p.status === 'available');
        if (pending.length === 0) {
            console.log('All parcels in selection already minted.');
            return;
        }

        if (args.verbose) {
            console.log('Generating metadata for pending parcels...');
        }
        const parcelsWithMetadata = await attachMetadataToParcels(parcelsWithStatus, { dryRun: args.dryRun, verbose: args.verbose });
        const parcelsWithOwners = assignOwnersToParcels(parcelsWithMetadata);
        if (args.verbose) {
            console.log('Distributed parcels into owner buckets for batch minting.');
        }

        console.log(`Found ${pending.length} parcels available for minting out of ${parcels.length} fetched.`);
        console.log(args.dryRun ? 'Performing dry run (no transactions will be sent)...' : 'Minting parcels...');
        const {
            minted,
            skipped,
            durationMs: mintDurationMs,
            processedCount,
            totalAvailable,
            totalGasSpentWei
        } = await mintParcels(contract, parcelsWithOwners, args.dryRun, { verbose: args.verbose, batchSize: args.batchSize });
        const explorerBase = normalizeExplorerBaseUrl(networkConfig.explorerUrl);
        if (skipped.length > 0) {
            skipped.forEach(item => {
                const reason = item.reason === 'already-minted'
                    ? `already minted${item.owner ? ` (owner ${item.owner})` : ''}`
                    : 'previous preflight revert';
                console.log(`Skipped parcel ${item.parcelId}: ${reason}.`);
                if (args.verbose && item.detail) {
                    console.log(`  ↳ detail: ${item.detail}`);
                }
            });
            console.log(`Total skipped parcels: ${skipped.length}.`);
        }
        if (args.dryRun) {
            if (args.verbose) {
                minted.forEach(item => {
                    const storageHint = item.storage || 'unknown';
                    const fileHint = item.filePath ? ` (${item.filePath})` : '';
                    console.log(`[dry-run] Would mint ${item.parcelId} -> ${item.owner}`);
                    console.log(`          metadata [${storageHint}]: ${item.metadataURI}${fileHint}`);
                });
            }
            console.log(`Dry run complete. ${minted.length} parcels would be minted.`);
        } else if (minted.length > 0) {
            console.log(`Minted ${minted.length} parcel NFTs.`);
            minted.forEach(item => {
                const { decimal, hex } = formatTokenIdForDisplay(item.tokenId);
                const tokenDescriptor = hex && hex !== decimal ? `${decimal} (${hex})` : decimal;
                const owner = item.owner || 'unknown';
                const txHash = item.txHash || 'unknown';
                const nftUrl = explorerBase ? buildNftExplorerUrl(explorerBase, networkConfig.parcelNftAddress, decimal) : null;
                const txUrl = explorerBase && txHash !== 'unknown' ? `${explorerBase}/tx/${txHash}` : null;
                console.log(`  ↳ Parcel ${item.parcelId} → token ${tokenDescriptor} | owner ${owner}`);
                if (nftUrl) {
                    console.log(`      Explorer NFT: ${nftUrl}`);
                    if (txUrl) {
                        console.log(`      Explorer TX: ${txUrl}`);
                    }
                } else {
                    console.log(`      Chain ${network.chainId} (${network.name || 'unknown'}) | Contract ${networkConfig.parcelNftAddress}`);
                    console.log(`      Transaction: ${txHash}`);
                }
                if (item.metadataURI) {
                    console.log(`      Metadata: ${item.metadataURI}`);
                }
            });
        } else {
            console.log('No new parcels were minted.');
        }
        if (totalAvailable > 0) {
            console.log(`Processed ${processedCount}/${totalAvailable} parcels during mint phase.`);
        } else {
            console.log('No eligible parcels were processed during mint phase.');
        }
        console.log(`Mint duration: ${formatDuration(mintDurationMs)}`);
        const totalSpentEth = ethers.formatEther(totalGasSpentWei);
        console.log(`Total gas spent: ${totalSpentEth} ETH${args.dryRun ? ' (dry run)' : ''}`);
    } finally {
        await dbClient.end();
    }
}

main().catch(err => {
    console.error('Minting script failed:', err.message);
    console.error(err);
    process.exit(1);
});
