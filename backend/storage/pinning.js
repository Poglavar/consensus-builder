// Pinata pinning (plan-design-agreement.md, M2 "Courier and index"). pinBytes pins the exact bytes of
// one published JSON object (a design, an agreement, a bundle of decisions) as a single file with
// CIDv1 and refuses Pinata's answer unless it is the CID the bytes were computed to have, so a wrong
// assumption about how Pinata builds the CID fails loudly at the first pin, never silently.
// pinFileToPinata is the one multipart pinFileToIPFS call; routes/ipfs.js pins NFT images through it.
import { cidOf } from '../cid.js';
import { createRequire } from 'node:module';

const { MAX_PUBLISHED_OBJECT_BYTES } = createRequire(import.meta.url)('../../frontend/js/design-record.js');

export const PINATA_FILE_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
// One published object is at most this many bytes (designs, agreements and decision bundles alike).
// Files larger than one 256 KiB chunk use a UnixFS dag-pb root with raw leaves;
// the browser and server compute that same file CID before uploading.
export const MAX_PINNED_OBJECT_BYTES = MAX_PUBLISHED_OBJECT_BYTES;

const log = message => console.log(`[${new Date().toISOString()}] [pinning] ${message}`);

function pinningError(code, message, status, extra = {}) {
    return Object.assign(new Error(message), { code, status, ...extra });
}

/** PINATA_API_KEY and PINATA_API_SECRET; without them pinning is unconfigured (503). */
export function pinataCredentials(env = process.env) {
    const apiKey = env.PINATA_API_KEY;
    const apiSecret = env.PINATA_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw pinningError('pinning-unconfigured',
            'Pinata API credentials are not configured. Set PINATA_API_KEY and PINATA_API_SECRET.', 503);
    }
    return { apiKey, apiSecret };
}

// Pinata's own record of when the pin was made, as ISO; null when it does not say.
function pinnedAtOf(timestamp) {
    const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Pins one file through Pinata's pinFileToIPFS (multipart: the file, then the optional metadata name
 * and pinataOptions). Throws `pinning-unconfigured` (503) or `pin-failed` (502).
 * @param {{ bytes: Uint8Array, fileName: string, contentType?: string, name?: string|null, pinataOptions?: object|null }} input
 * @returns {Promise<{ cid: string, pinnedAt: string|null }>} Pinata's IpfsHash and its Timestamp
 */
export async function pinFileToPinata({ bytes, fileName, contentType = 'application/octet-stream', name = null, pinataOptions = null }) {
    const { apiKey, apiSecret } = pinataCredentials();
    const formData = new FormData();
    formData.append('file', new Blob([bytes], { type: contentType }), fileName);
    if (name) formData.append('pinataMetadata', JSON.stringify({ name }));
    if (pinataOptions) formData.append('pinataOptions', JSON.stringify(pinataOptions));

    const response = await fetch(PINATA_FILE_ENDPOINT, {
        method: 'POST',
        headers: {
            'pinata_api_key': apiKey,
            'pinata_secret_api_key': apiSecret
        },
        body: formData
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw pinningError('pin-failed', `Pinata pinFileToIPFS failed: ${response.status} ${errorBody}`, 502,
            { upstreamStatus: response.status });
    }
    const result = await response.json();
    if (!result?.IpfsHash) throw pinningError('pin-failed', 'Pinata pinFileToIPFS answered without an IpfsHash.', 502);
    return { cid: result.IpfsHash, pinnedAt: pinnedAtOf(result.Timestamp) };
}

/**
 * Pins the exact bytes of one published JSON object under the CID they hash to.
 * Throws `cid-mismatch` with `cid` and `computedCid` (400) when the bytes are not `cid`, before any
 * request; `cid-mismatch` with `cid` and `pinnedCid` (409) when Pinata answers another CID (the bytes
 * then stay pinned under that one); and pinFileToPinata's errors.
 * @param {{ bytes: Uint8Array, name: string, cid: string }} input  name labels the pin on Pinata
 * @returns {Promise<{ cid: string, pinnedAt: string }>}
 */
export async function pinBytes({ bytes, name, cid }) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw pinningError('invalid-pin', 'There are no bytes to pin.', 400);
    if (bytes.length > MAX_PINNED_OBJECT_BYTES) {
        throw pinningError('too-large', `A pinned object is at most ${MAX_PINNED_OBJECT_BYTES} bytes; this one is ${bytes.length}.`, 413);
    }
    const computedCid = cidOf(bytes);
    if (computedCid !== cid) {
        throw pinningError('cid-mismatch', `The bytes are ${computedCid}, not ${cid}.`, 400, { cid, computedCid });
    }
    const pinned = await pinFileToPinata({
        bytes, fileName: `${name}.json`, contentType: 'application/json', name, pinataOptions: { cidVersion: 1 }
    });
    if (pinned.cid !== cid) {
        console.error(`[${new Date().toISOString()}] [pinning] CID MISMATCH for ${name}: computed ${cid}, Pinata pinned ${pinned.cid} (${bytes.length} bytes)`);
        throw pinningError('cid-mismatch', `Pinata pinned the bytes as ${pinned.cid}, not ${cid}.`, 409, { cid, pinnedCid: pinned.cid });
    }
    log(`pinned ${name} as ${cid} (${bytes.length} bytes)`);
    // The source's own time first; only when Pinata gives none is the time of its answer used.
    return { cid, pinnedAt: pinned.pinnedAt ?? new Date().toISOString() };
}
