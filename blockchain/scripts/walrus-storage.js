// CJS Walrus (Sui) blob storage helper for the mint scripts. Mirrors backend/storage/walrus.js:
// uploads raw bytes to a Walrus publisher and builds walrus://<blobId> URIs + aggregator gateway
// URLs. Defaults target the public Walrus testnet; override via env for mainnet/self-hosted.

const DEFAULT_PUBLISHER_URL = 'https://publisher.walrus-testnet.walrus.space';
const DEFAULT_AGGREGATOR_URL = 'https://aggregator.walrus-testnet.walrus.space';
const DEFAULT_EPOCHS = 5;

function trimTrailingSlash(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function getWalrusConfig(env = process.env) {
    const publisherUrl = trimTrailingSlash(env.WALRUS_PUBLISHER_URL || DEFAULT_PUBLISHER_URL);
    const aggregatorUrl = trimTrailingSlash(env.WALRUS_AGGREGATOR_URL || DEFAULT_AGGREGATOR_URL);
    const parsedEpochs = Number(env.WALRUS_EPOCHS);
    const epochs = Number.isFinite(parsedEpochs) && parsedEpochs > 0 ? Math.trunc(parsedEpochs) : DEFAULT_EPOCHS;
    const permanent = String(env.WALRUS_PERMANENT || '').toLowerCase() === 'true';
    const sendObjectTo = env.WALRUS_SEND_OBJECT_TO ? String(env.WALRUS_SEND_OBJECT_TO).trim() : null;
    return { publisherUrl, aggregatorUrl, epochs, permanent, sendObjectTo };
}

function buildWalrusUri(blobId) {
    return `walrus://${blobId}`;
}

function buildWalrusGatewayUrl(blobId, aggregatorUrl = DEFAULT_AGGREGATOR_URL) {
    return `${trimTrailingSlash(aggregatorUrl)}/v1/blobs/${blobId}`;
}

// Walrus dedups by content: first upload returns `newlyCreated`, a repeat returns `alreadyCertified`
// with the same blobId. Handle both and surface Sui object id + cost.
function parsePutResponse(result, aggregatorUrl) {
    const newlyCreated = result && result.newlyCreated && result.newlyCreated.blobObject;
    const alreadyCertified = result && result.alreadyCertified;

    let blobId = null;
    let suiObjectId = null;
    let endEpoch = null;
    let cost = null;

    if (newlyCreated && newlyCreated.blobId) {
        blobId = newlyCreated.blobId;
        suiObjectId = newlyCreated.id || null;
        endEpoch = newlyCreated.storage ? newlyCreated.storage.endEpoch : null;
        cost = result.newlyCreated.cost != null ? result.newlyCreated.cost : null;
    } else if (alreadyCertified && alreadyCertified.blobId) {
        blobId = alreadyCertified.blobId;
        endEpoch = alreadyCertified.endEpoch != null ? alreadyCertified.endEpoch : null;
    }

    if (!blobId) {
        throw new Error('Walrus publisher response did not include a blobId.');
    }

    return {
        blobId,
        suiObjectId,
        endEpoch,
        cost,
        walrusUri: buildWalrusUri(blobId),
        gatewayUrl: buildWalrusGatewayUrl(blobId, aggregatorUrl)
    };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Store raw bytes on Walrus via the publisher's PUT /v1/blobs endpoint. Retries on network
// errors and 429/5xx (the public publisher is rate-limited under concurrency) with backoff.
async function putBlob(bytes, { env = process.env } = {}) {
    const config = getWalrusConfig(env);
    const maxRetries = Number(env.WALRUS_MAX_RETRIES) > 0 ? Math.trunc(Number(env.WALRUS_MAX_RETRIES)) : 4;

    const params = new URLSearchParams();
    if (config.permanent) {
        params.set('permanent', 'true');
    } else {
        params.set('epochs', String(config.epochs));
    }
    if (config.sendObjectTo) {
        params.set('send_object_to', config.sendObjectTo);
    }
    const url = `${config.publisherUrl}/v1/blobs?${params.toString()}`;

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            await sleep(Math.min(500 * 2 ** (attempt - 1), 8000)); // 0.5s,1s,2s,4s,8s
        }
        try {
            const response = await fetch(url, { method: 'PUT', body: bytes });
            if (response.ok) {
                return parsePutResponse(await response.json(), config.aggregatorUrl);
            }
            const errorBody = await response.text();
            // Retry transient publisher errors; fail fast on other 4xx.
            if (response.status === 429 || response.status >= 500) {
                lastError = new Error(`Walrus publisher returned ${response.status}: ${errorBody}`);
                continue;
            }
            throw new Error(`Walrus publisher returned ${response.status}: ${errorBody}`);
        } catch (error) {
            lastError = error;
            // Network/transient errors are retried; the loop exits when retries are exhausted.
        }
    }
    throw lastError || new Error('Walrus upload failed after retries.');
}

module.exports = {
    getWalrusConfig,
    buildWalrusUri,
    buildWalrusGatewayUrl,
    putBlob
};
