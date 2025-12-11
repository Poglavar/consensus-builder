#!/usr/bin/env node

/*
 * Parcel NFT batch minter service
 * -------------------------------
 * Provides the shared plumbing for parcel selection, metadata creation,
 * and minting. City-specific scripts supply the parcel selection query,
 * parcel-to-object mapping, and metadata builder.
 */

const path = require('path');
const fs = require('fs');

// Try to load .env from current directory first, then parent
const envPath = fs.existsSync(path.join(__dirname, '../.env'))
    ? path.join(__dirname, '../.env')
    : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

const { existsSync, mkdirSync, writeFileSync } = require('fs');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const { ethers } = require('ethers');
const { Client } = require('pg');
const { findDeploymentAddress } = require('./deploymentUtils');

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
    'ACCOUNT_1_ADDRESS',
    'ACCOUNT_2_ADDRESS',
    'ACCOUNT_3_ADDRESS',
    'ACCOUNT_4_ADDRESS',
    'ACCOUNT_5_ADDRESS',
    'ACCOUNT_6_ADDRESS'
];

const networkConfig = {
    rpcUrl: process.env.RPC_URL || process.env.ETHEREUM_RPC_URL,
    explorerUrl: process.env.BLOCK_EXPLORER_URL || process.env.ETHEREUM_BLOCK_EXPLORER_URL,
    deployerKey: process.env.DEPLOYER_PRIVATE_KEY,
    deployerAddress: process.env.DEPLOYER_ADDRESS,
    parcelNftAddress: null, // Will be resolved from deployments
};

const UPLOAD_SERVICE_BASE_URL =
    (process.env.UPLOAD_SERVICE_BASE_URL
        || process.env.LOCAL_UPLOAD_BASE_URL
        || process.env.PARCEL_METADATA_BASE_URL
        || ''
    ).trim().replace(/\/+$/, '');
const ASSETS_UPLOAD_URL = (process.env.ASSETS_UPLOAD_URL || 'http://127.0.0.1:3000/assets/upload').trim().replace(/\/+$/, '');
const LOCAL_UPLOAD_CHAIN_IDS = new Set(
    (process.env.LOCAL_UPLOAD_CHAIN_IDS || '31337,1337')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
);
let useLocalUploadService = false;
let skipIpfsUploads = false;

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

function sanitizeRing(ring) {
    if (!Array.isArray(ring)) return [];
    if (ring.length <= 2) return ring.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Array.isArray(first) && Array.isArray(last) && first.length >= 2 && last.length >= 2 && first[0] === last[0] && first[1] === last[1]) {
        return ring.slice(0, ring.length - 1);
    }
    return ring.slice();
}

function computeBoundingBox(polygons) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    polygons.forEach(polygon => {
        ensureArray(polygon).forEach(ring => {
            sanitizeRing(ring).forEach(coord => {
                if (!Array.isArray(coord) || coord.length < 2) return;
                const [lon, lat] = coord;
                if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
                if (lon < minX) minX = lon;
                if (lat < minY) minY = lat;
                if (lon > maxX) maxX = lon;
                if (lat > maxY) maxY = lat;
            });
        });
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }
    if (minX === maxX) {
        minX -= 0.0001;
        maxX += 0.0001;
    }
    if (minY === maxY) {
        minY -= 0.0001;
        maxY += 0.0001;
    }
    return { minX, minY, maxX, maxY };
}

function projectCoordinate(coord, bounds, width, height, padding) {
    const [lon, lat] = coord;
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const maxDrawableWidth = Math.max(width - padding * 2, 1);
    const maxDrawableHeight = Math.max(height - padding * 2, 1);
    const scaleX = spanX > 0 ? maxDrawableWidth / spanX : 1;
    const scaleY = spanY > 0 ? maxDrawableHeight / spanY : 1;
    const scale = Math.min(scaleX, scaleY);
    const usedWidth = spanX * scale;
    const usedHeight = spanY * scale;
    const offsetX = padding + (maxDrawableWidth - usedWidth) / 2;
    const offsetY = padding + (maxDrawableHeight - usedHeight) / 2;
    const x = offsetX + (lon - bounds.minX) * scale;
    const y = height - (offsetY + (lat - bounds.minY) * scale);
    return [
        Number.isFinite(x) ? x : width / 2,
        Number.isFinite(y) ? y : height / 2
    ];
}

/**
 * Build an SVG from actual parcel geometry (GeoJSON).
 * Uses the same algorithm as the frontend for attestify.network.
 *
 * @param {Object} parcel - Parcel object with geometry and labels
 * @param {string|Object} parcel.geometry - GeoJSON geometry (string or parsed object)
 * @param {string} parcel.parcelId - Primary label (parcel ID)
 * @param {string} [parcel.cadastralName] - Secondary label (municipality/city)
 * @param {string} [parcel.cityName] - City name for secondary label (fallback)
 * @param {Object} [options] - Rendering options
 * @param {number} [options.width=512] - SVG width
 * @param {number} [options.height=512] - SVG height
 * @param {number} [options.paddingRatio=0.08] - Padding ratio
 * @returns {string|null} SVG content or null if geometry is invalid
 */
function buildParcelGeometrySvg(parcel, { width = 512, height = 512, paddingRatio = 0.08 } = {}) {
    const geometrySource = parcel.geometry;
    if (!geometrySource) return null;

    const polygons = extractPolygonCoordinateSets(geometrySource);
    if (polygons.length === 0) {
        return null;
    }

    const bounds = computeBoundingBox(polygons);
    if (!bounds) {
        return null;
    }

    const padding = Math.min(width, height) * paddingRatio;
    const pathElements = [];

    polygons.forEach(polygon => {
        const commands = [];
        ensureArray(polygon).forEach(ring => {
            const sanitized = sanitizeRing(ring);
            sanitized.forEach((coord, index) => {
                const projected = projectCoordinate(coord, bounds, width, height, padding);
                commands.push(`${index === 0 ? 'M' : 'L'}${projected[0].toFixed(2)} ${projected[1].toFixed(2)}`);
            });
            if (sanitized.length > 0) {
                commands.push('Z');
            }
        });
        if (commands.length > 0) {
            pathElements.push(
                `<path d="${commands.join(' ')}" fill="#facd55" fill-opacity="0.85" stroke="#f97316" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" fill-rule="evenodd" />`
            );
        }
    });

    if (pathElements.length === 0) {
        return null;
    }

    // Build labels
    const primaryLabel = parcel.parcelId ? escapeXml(parcel.parcelId) : null;
    const secondaryRaw = parcel.cadastralName || parcel.cityName || null;
    const secondaryLabel = secondaryRaw ? escapeXml(secondaryRaw) : null;

    const labelElements = [];
    if (primaryLabel) {
        labelElements.push(
            `<text x="50%" y="88%" text-anchor="middle" fill="#e5e7eb" font-size="40" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${primaryLabel}</text>`
        );
    }
    if (secondaryLabel) {
        labelElements.push(
            `<text x="50%" y="95%" text-anchor="middle" fill="#94a3b8" font-size="28" font-family="'Inter','Helvetica Neue',Arial,sans-serif">${secondaryLabel}</text>`
        );
    }

    const svgParts = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `  <rect width="${width}" height="${height}" fill="#0b1120" rx="24" />`,
        `  <g>${pathElements.join('\n    ')}</g>`,
        labelElements.length > 0 ? `  <g>${labelElements.join('\n    ')}</g>` : '',
        `</svg>`
    ].filter(Boolean);

    return svgParts.join('\n');
}

/**
 * Build the best available SVG for a parcel.
 * Uses geometry-based SVG if geometry is available, otherwise falls back to placeholder.
 *
 * @param {Object} parcel - Parcel object
 * @returns {string} SVG content
 */
function buildParcelSvg(parcel) {
    // Try geometry-based SVG first
    if (parcel.geometry) {
        const geometrySvg = buildParcelGeometrySvg(parcel);
        if (geometrySvg) {
            return geometrySvg;
        }
    }
    // Fall back to placeholder SVG
    return buildParcelPlaceholderSvg(parcel);
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

function postJsonHttp(urlString, payload) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;
        const body = JSON.stringify(payload);
        const options = {
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Connection': 'close'
            },
            agent: false  // Don't reuse sockets
        };

        const req = transport.request(options, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(responseBody));
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${responseBody}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
                }
            });
        });

        req.on('error', err => {
            reject(new Error(`Request error: ${err.message}`));
        });

        req.write(body);
        req.end();
    });
}

// Direct filesystem write - bypasses HTTP entirely for reliability
const BACKEND_UPLOADS_DIR = path.resolve(__dirname, '../../backend/uploads');
const BACKEND_IMAGES_DIR = path.join(BACKEND_UPLOADS_DIR, 'images');
const BACKEND_METADATA_DIR = path.join(BACKEND_UPLOADS_DIR, 'metadata');

function ensureLocalUploadDirs() {
    [BACKEND_UPLOADS_DIR, BACKEND_IMAGES_DIR, BACKEND_METADATA_DIR].forEach(dir => {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    });
}

async function createLocalMetadataResource(parcel, { dryRun = false, buildMetadata, metadataHelpers } = {}) {
    if (typeof buildMetadata !== 'function') {
        throw new Error('buildMetadata function is required to create local metadata.');
    }
    const slug = slugifyParcelId(parcel.parcelId) || `parcel-${Date.now()}`;
    const metadata = buildMetadata(parcel, metadataHelpers);

    // Base URL for serving files (assumes backend serves /uploads)
    const baseUrl = ASSETS_UPLOAD_URL.replace(/\/assets\/upload$/, '').replace(/\/$/, '');
    const imageFilename = `${slug}.svg`;
    const metadataFilename = `${slug}.json`;
    const imageUrl = `${baseUrl}/uploads/images/${imageFilename}`;
    const metadataURI = `${baseUrl}/uploads/metadata/${metadataFilename}`;

    if (dryRun) {
        return {
            metadataURI,
            metadata,
            storage: 'filesystem-direct',
            imageUrl
        };
    }

    // Write directly to backend/uploads - no HTTP needed
    ensureLocalUploadDirs();

    const svgContent = buildParcelSvg(parcel);
    const imagePath = path.join(BACKEND_IMAGES_DIR, imageFilename);
    writeFileSync(imagePath, svgContent, 'utf8');

    const metadataToSave = {
        ...metadata,
        image: imageUrl,
        image_url: imageUrl
    };
    const metadataPath = path.join(BACKEND_METADATA_DIR, metadataFilename);
    writeFileSync(metadataPath, JSON.stringify(metadataToSave, null, 2), 'utf8');

    return {
        metadataURI,
        metadata,
        storage: 'filesystem-direct',
        imageUrl
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

const metadataHelpers = {
    slugifyParcelId,
    buildImageUrl,
    buildExternalUrl,
    cleanMetadataObject,
    applyTemplate
};

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

/**
 * Upload an SVG image to Pinata and return the public gateway URL.
 * Uses the same form-data approach as mint-proposals.js.
 */
async function uploadParcelImageToPinata(parcel) {
    if (!PINATA_API_KEY || !PINATA_API_SECRET) {
        throw new Error('Pinata credentials missing. Provide PINATA_API_KEY and PINATA_API_SECRET.');
    }

    const svgContent = buildParcelSvg(parcel);
    if (!svgContent) {
        throw new Error(`Unable to build SVG for parcel ${parcel.parcelId}`);
    }

    const form = new FormData();
    const safeName = slugifyParcelId(parcel.parcelId) || 'parcel';
    const fileName = `${safeName}.svg`;

    form.append('file', Buffer.from(svgContent, 'utf8'), {
        filename: fileName,
        contentType: 'image/svg+xml'
    });

    form.append('pinataOptions', JSON.stringify({ cidVersion: 0 }));
    form.append('pinataMetadata', JSON.stringify({ name: fileName }));

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

        const req = https.request(options, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
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
        form.pipe(req);
    });
}

async function createMetadataResource(parcel, { dryRun = false, buildMetadata, metadataHelpers } = {}) {
    if (typeof buildMetadata !== 'function') {
        throw new Error('buildMetadata function is required to create metadata.');
    }
    if (useLocalUploadService) {
        return createLocalMetadataResource(parcel, { dryRun, buildMetadata, metadataHelpers });
    }

    const metadata = buildMetadata(parcel, metadataHelpers);
    const hasPinata = (PINATA_API_KEY && PINATA_API_SECRET) && !skipIpfsUploads;

    if (hasPinata) {
        // Upload SVG image first, then set image fields before pinning metadata
        let imageUrl = buildImageUrl(parcel);
        try {
            const uploadedImageUrl = await uploadParcelImageToPinata(parcel);
            if (uploadedImageUrl) {
                imageUrl = uploadedImageUrl;
            }
        } catch (err) {
            if (dryRun) {
                imageUrl = '(pending-upload-to-pinata)';
            } else {
                throw err;
            }
        }

        metadata.image = imageUrl;
        metadata.image_url = imageUrl;

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
        verbose: true,
        batchSize: DEFAULT_BATCH_SIZE,
        network: 'hardhat', // Default to hardhat if not specified
        batch: null,
        skipMintStatusCheck: false,
        skipIpfsUploads: false
    };
    argv.forEach(arg => {
        if (arg.startsWith('--limit=')) {
            args.limit = Number(arg.split('=')[1]) || DEFAULT_LIMIT;
        } else if (arg.startsWith('--offset=')) {
            args.offset = Number(arg.split('=')[1]) || DEFAULT_OFFSET;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--no-check') {
            args.skipMintStatusCheck = true;
        } else if (arg === '--no-ipfs') {
            args.skipIpfsUploads = true;
        } else if (arg.startsWith('--bbox=')) {
            const raw = arg.substring('--bbox='.length);
            args.bbox = parseBoundingBoxArg(raw);
        } else if (arg.startsWith('--batch-size=')) {
            const size = Number(arg.split('=')[1]);
            if (!Number.isFinite(size) || size <= 0) {
                throw new Error('Invalid --batch-size value. Expected a positive integer.');
            }
            args.batchSize = Math.floor(size);
        } else if (arg.startsWith('--batch=')) {
            const raw = arg.substring('--batch='.length).trim();
            args.batch = raw || null;
        } else if (arg.startsWith('--network=')) {
            args.network = arg.split('=')[1]?.trim();
        } else if (arg.startsWith('--')) {
            // Check if it's a shorthand network argument (e.g., --hardhat, --sepolia)
            const networkName = arg.substring(2); // Remove '--' prefix
            if (SUPPORTED_NETWORKS[networkName]) {
                args.network = networkName;
            }
        }
    });
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

function getDemoOwnerPool() {
    const pool = RANDOM_ADDRESS_ENV_KEYS
        .map(key => process.env[key])
        .filter(Boolean);
    if (pool.length === 0) {
        throw new Error('No demo owner addresses defined. Populate ACCOUNT_1_ADDRESS...ACCOUNT_6_ADDRESS.');
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

async function fetchCandidateParcels(client, args, buildParcelSelectionQuery) {
    const { sql, params } = buildParcelSelectionQuery(args);
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
    const total = parcels.length;
    console.log(`Checking mint statuses for ${total} parcels...`);
    const results = [];
    let checked = 0;
    for (const parcel of parcels) {
        const owner = await getExistingParcelOwner(contract, parcel.parcelId);
        if (owner) {
            results.push({ ...parcel, status: 'already-minted', owner });
        } else {
            results.push({ ...parcel, status: 'available' });
        }
        checked += 1;
        if (checked % 100 === 0) {
            console.log(`[mint-check] Checked ${checked}/${total} parcels...`);
        }
    }
    console.log(`Mint status check complete: ${checked}/${total} parcels processed.`);
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
    let ownerIndex = 0;
    const ownerTotal = ownerBuckets.size;

    for (const [owner, ownerParcels] of ownerBuckets.entries()) {
        ownerIndex += 1;
        const ownerBatches = chunkArray(ownerParcels, batchSize);
        if (verbose) {
            console.log(`[mint-loop] Owner ${ownerIndex}/${ownerTotal} (${owner}) -> ${ownerParcels.length} parcel(s) in ${ownerBatches.length} batch(es)`);
        }
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
        let batchIndex = 0;
        for (const batchParcels of batches) {
            batchIndex += 1;
            if (batchParcels.length === 0) continue;

            const parcelIds = batchParcels.map(parcel => parcel.parcelId);
            const metadataURIs = batchParcels.map(parcel => {
                if (!parcel.metadataURI) {
                    throw new Error(`Missing metadata URI for parcel ${parcel.parcelId}`);
                }
                return parcel.metadataURI;
            });

            if (verbose) {
                console.log(`[mint-loop]   Batch ${batchIndex}/${batches.length} for owner ${owner} (${batchParcels.length} parcel(s))`);
            }

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
            if (verbose) {
                console.log(`[mint-loop]   Mined batch ${batchIndex}/${batches.length} tx ${receipt.hash}`);
            }
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

async function attachMetadataToParcels(parcels, { dryRun, verbose, buildMetadata, metadataHelpers }) {
    const enriched = [];
    for (const parcel of parcels) {
        if (parcel.status !== 'available') {
            enriched.push(parcel);
            continue;
        }

        const metadataResource = await createMetadataResource(parcel, { dryRun, buildMetadata, metadataHelpers });
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

function validateCityConfig(cityConfig) {
    if (!cityConfig || typeof cityConfig !== 'object') {
        throw new Error('City configuration object is required.');
    }
    const requiredFns = ['buildParcelSelectionQuery', 'mapDbRowToParcel', 'buildParcelMetadata'];
    requiredFns.forEach(name => {
        if (typeof cityConfig[name] !== 'function') {
            throw new Error(`City config is missing required function "${name}".`);
        }
    });
}

function createMintParcelsService(cityConfig) {
    validateCityConfig(cityConfig);
    const introText = cityConfig.introText || `Mint parcels for ${cityConfig.cityName || 'unknown city'}.`;
    return {
        run: async (argv = process.argv.slice(2)) =>
            runMintParcels({ ...cityConfig, introText }, argv)
    };
}

async function runMintParcels(cityConfig, argv = process.argv.slice(2)) {
    validateCityConfig(cityConfig);
    const cityName = cityConfig.cityName || 'unknown city';

    console.log(cityConfig.introText || `Mint parcels for ${cityName}.`);
    const args = parseArgs(argv);
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
    const signerAddress = signer.address;
    const deployerAddress = networkConfig.deployerAddress || signerAddress;
    const network = await provider.getNetwork();
    skipIpfsUploads = args.skipIpfsUploads;
    useLocalUploadService = shouldUseLocalUpload(network.chainId) || skipIpfsUploads;
    if (useLocalUploadService) {
        console.log(`Writing metadata directly to ${BACKEND_UPLOADS_DIR}${skipIpfsUploads ? ' (forced by --no-ipfs)' : ''}`);
    } else if (skipIpfsUploads) {
        console.log('IPFS uploads disabled via --no-ipfs; will use filesystem outputs.');
    }

    if (!networkConfig.parcelNftAddress) {
        const resolved = findDeploymentAddress('ParcelNFT', network.chainId);
        if (!resolved) {
            throw new Error('ParcelNFT address not found in deployments. Run `yarn deploy` first.');
        }
        networkConfig.parcelNftAddress = resolved.address;
        console.log(`Resolved ParcelNFT from deployments/${resolved.directory}: ${resolved.address}`);
    }

    let formattedBalance = 'unknown';
    let deployerBalanceWei = null;
    try {
        deployerBalanceWei = await provider.getBalance(signerAddress);
        formattedBalance = `${ethers.formatEther(deployerBalanceWei)} ETH`;
    } catch (err) {
        console.warn('Unable to fetch signer balance:', err.message);
    }

    if (networkConfig.deployerAddress && networkConfig.deployerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
        console.warn(`⚠️  Warning: DEPLOYER_ADDRESS (${deployerAddress}) does not match signer address (${signerAddress}).`);
        console.warn(`   Transactions will be sent from ${signerAddress}, not ${deployerAddress}.`);
        try {
            const deployerBalance = await provider.getBalance(deployerAddress);
            console.warn(`   DEPLOYER_ADDRESS balance: ${ethers.formatEther(deployerBalance)} ETH`);
        } catch (err) {
            // Ignore
        }
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
        console.log(`City: ${cityName}`);
        console.log(`Parcel contract: ${networkConfig.parcelNftAddress}`);
        console.log(`RPC URL: ${networkConfig.rpcUrl}`);
        console.log(`Network chain: ${network.chainId} (${network.name || 'unknown'})`);
        console.log(`Signer address: ${signerAddress} (sending transactions)`);
        if (deployerAddress !== signerAddress) {
            console.log(`Deployer address: ${deployerAddress} (from DEPLOYER_ADDRESS env var)`);
        }
        console.log(`Signer balance: ${formattedBalance}`);

        const ownerPool = getDemoOwnerPool();
        console.log(`\nOwner addresses (parcels will be minted to these):`);
        ownerPool.forEach((addr, idx) => {
            const envKey = RANDOM_ADDRESS_ENV_KEYS[idx];
            console.log(`  ${envKey}: ${addr}`);
        });
        if (args.bbox) {
            console.log('Bounding box filter (lat/lon):');
            console.log(`  South: ${args.bbox.south}, West: ${args.bbox.west}`);
            console.log(`  North: ${args.bbox.north}, East: ${args.bbox.east}`);
        } else {
            console.log('Bounding box filter: none (using full dataset)');
        }
        console.log(`Batch size: ${args.batchSize} parcel(s) per transaction.`);
        console.log('----------------------------------------');

        if (!args.dryRun) {
            if (deployerBalanceWei === null) {
                throw new Error('Unable to check signer balance. Cannot proceed without balance verification.');
            }
            if (deployerBalanceWei === 0n) {
                throw new Error(`Signer address ${signerAddress} has zero balance. Please fund this address before minting. Use the fund-account script or send ETH to this address.`);
            }
            const minRecommendedWei = ethers.parseEther('0.01');
            if (deployerBalanceWei < minRecommendedWei) {
                console.warn(`⚠️  Warning: Signer balance is very low (${formattedBalance}). You may run out of gas during minting.`);
            }
        }

        const contractCode = await provider.getCode(networkConfig.parcelNftAddress);
        if (!contractCode || contractCode === '0x') {
            throw new Error(`No contract deployed at ${networkConfig.parcelNftAddress} on chain ${network.chainId}.`);
        }

        console.log('Fetching candidate parcels from database...');
        const rows = await fetchCandidateParcels(dbClient, args, cityConfig.buildParcelSelectionQuery);
        if (rows.length === 0) {
            console.log('No parcels returned from database. Check filters or increase limit.');
            return;
        }

        const parcels = rows.map(row => cityConfig.mapDbRowToParcel(row, { metadataHelpers, ethers }));
        console.log(`Fetched ${parcels.length} parcels from database (before mint status check).`);

        const contract = new ethers.Contract(networkConfig.parcelNftAddress, parcelNftAbi, nonceManager);

        let parcelsWithStatus;
        let pending;
        if (args.skipMintStatusCheck) {
            console.log('Skipping mint status pre-check (per --no-check). Will attempt to mint all fetched parcels.');
            parcelsWithStatus = parcels.map(p => ({ ...p, status: 'available' }));
            pending = parcelsWithStatus;
        } else {
            parcelsWithStatus = await resolveAlreadyMinted(contract, parcels);
            pending = parcelsWithStatus.filter(p => p.status === 'available');
        }
        if (pending.length === 0) {
            console.log('All parcels in selection already minted.');
            console.log('Parcels already minted:');
            parcelsWithStatus.forEach(parcel => {
                const ownerHint = parcel.owner ? ` (owner ${parcel.owner})` : '';
                console.log(`  - ${parcel.parcelId}${ownerHint}`);
            });
            return;
        }

        if (args.verbose) {
            console.log('Generating metadata for pending parcels...');
        }
        const parcelsWithMetadata = await attachMetadataToParcels(parcelsWithStatus, {
            dryRun: args.dryRun,
            verbose: args.verbose,
            buildMetadata: parcel => cityConfig.buildParcelMetadata(parcel, metadataHelpers),
            metadataHelpers
        });
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
                    console.log(`[dry-run] Parcel: ${item.parcelId}`);
                    console.log(`          Owner: ${item.owner}`);
                    console.log(`          Metadata [${storageHint}]: ${item.metadataURI}${fileHint}`);
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
                console.log(`Parcel: ${item.parcelId}`);
                console.log(`  Token: ${tokenDescriptor}`);
                console.log(`  Owner: ${owner}`);
                if (nftUrl) {
                    console.log(`  Explorer NFT: ${nftUrl}`);
                    if (txUrl) {
                        console.log(`  Explorer TX: ${txUrl}`);
                    }
                } else {
                    console.log(`  Chain ${network.chainId} (${network.name || 'unknown'}) | Contract ${networkConfig.parcelNftAddress}`);
                    console.log(`  Transaction: ${txHash}`);
                }
                if (item.metadataURI) {
                    console.log(`  Metadata: ${item.metadataURI}`);
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

module.exports = {
    createMintParcelsService,
    metadataHelpers,
    // SVG generation utilities (for use in city-specific scripts if needed)
    buildParcelSvg,
    buildParcelGeometrySvg,
    buildParcelPlaceholderSvg
};

if (require.main === module) {
    console.error('This file now exposes a minting service. Use mint-parcels-zg.js or mint-parcels-ba.js instead.');
    process.exit(1);
}
