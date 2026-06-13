// Walrus (Sui) decentralized blob storage client. Uploads raw bytes to a Walrus publisher and
// builds walrus://<blobId> canonical URIs plus aggregator gateway URLs for reading blobs back.
// Defaults target the public Walrus testnet endpoints; override via env for mainnet/self-hosted.

const DEFAULT_PUBLISHER_URL = 'https://publisher.walrus-testnet.walrus.space';
const DEFAULT_AGGREGATOR_URL = 'https://aggregator.walrus-testnet.walrus.space';
const DEFAULT_EPOCHS = 5;

function trimTrailingSlash(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function getWalrusConfig(env = process.env) {
    const publisherUrl = trimTrailingSlash(env.WALRUS_PUBLISHER_URL || DEFAULT_PUBLISHER_URL);
    const aggregatorUrl = trimTrailingSlash(env.WALRUS_AGGREGATOR_URL || DEFAULT_AGGREGATOR_URL);
    const parsedEpochs = Number(env.WALRUS_EPOCHS);
    const epochs = Number.isFinite(parsedEpochs) && parsedEpochs > 0 ? Math.trunc(parsedEpochs) : DEFAULT_EPOCHS;
    const permanent = String(env.WALRUS_PERMANENT || '').toLowerCase() === 'true';
    const sendObjectTo = env.WALRUS_SEND_OBJECT_TO ? String(env.WALRUS_SEND_OBJECT_TO).trim() : null;
    return { publisherUrl, aggregatorUrl, epochs, permanent, sendObjectTo };
}

export function buildWalrusUri(blobId) {
    return `walrus://${blobId}`;
}

export function buildWalrusGatewayUrl(blobId, aggregatorUrl = DEFAULT_AGGREGATOR_URL) {
    return `${trimTrailingSlash(aggregatorUrl)}/v1/blobs/${blobId}`;
}

// Walrus dedups by content: a first upload returns `newlyCreated`, a repeat returns
// `alreadyCertified` with the same blobId. We handle both and surface Sui object id + cost.
function parsePutResponse(result, aggregatorUrl) {
    const newlyCreated = result?.newlyCreated?.blobObject;
    const alreadyCertified = result?.alreadyCertified;

    let blobId = null;
    let suiObjectId = null;
    let endEpoch = null;
    let cost = null;

    if (newlyCreated?.blobId) {
        blobId = newlyCreated.blobId;
        suiObjectId = newlyCreated.id || null;
        endEpoch = newlyCreated.storage?.endEpoch ?? null;
        cost = result.newlyCreated.cost ?? null;
    } else if (alreadyCertified?.blobId) {
        blobId = alreadyCertified.blobId;
        endEpoch = alreadyCertified.endEpoch ?? null;
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

// Store raw bytes on Walrus via the publisher's PUT /v1/blobs endpoint.
export async function putBlob(bytes, { env = process.env } = {}) {
    const config = getWalrusConfig(env);

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
    const response = await fetch(url, { method: 'PUT', body: bytes });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Walrus publisher returned ${response.status}: ${errorBody}`);
    }

    const result = await response.json();
    return parsePutResponse(result, config.aggregatorUrl);
}
