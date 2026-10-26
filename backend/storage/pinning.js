// Provider-neutral publication boundary. Storage and gateway selection are independent;
// published identities depend only on bytes and the application's fixed UnixFS profile.
import { cidOf } from '../cid.js';
import { createRequire } from 'node:module';
import { pinFileToPinata } from './providers/pinata.js';
import { pinFileToFilebase } from './providers/filebase.js';
import { pinningError } from './pinning-error.js';

const { MAX_PUBLISHED_OBJECT_BYTES } = createRequire(import.meta.url)('../../frontend/js/design-record.js');
export const MAX_PINNED_OBJECT_BYTES = MAX_PUBLISHED_OBJECT_BYTES;
const adapters = { pinata: pinFileToPinata, filebase: pinFileToFilebase };

export function ipfsGatewayUrl(cid, env = process.env) {
    const base = env.IPFS_READ_GATEWAY || 'https://ipfs.filebase.io/ipfs';
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw pinningError('pinning-unconfigured', 'IPFS_READ_GATEWAY must be an HTTP(S) gateway base URL.', 503);
    }
    return `${base.replace(/\/+$/, '')}/${encodeURIComponent(cid)}`;
}

export async function pinFile({ bytes, fileName, contentType = 'application/octet-stream', name = null, cid = null }) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw pinningError('invalid-pin', 'There are no bytes to pin.', 400);
    if (bytes.length > MAX_PINNED_OBJECT_BYTES) throw pinningError('too-large',
        `A pinned object is at most ${MAX_PINNED_OBJECT_BYTES} bytes; this one is ${bytes.length}.`, 413);
    const computedCid = cidOf(bytes);
    if (cid && computedCid !== cid) throw pinningError('cid-mismatch',
        `The bytes are ${computedCid}, not ${cid}.`, 400, { cid, computedCid });
    const provider = process.env.IPFS_PINNING_PROVIDER || 'filebase';
    const adapter = Object.hasOwn(adapters, provider) ? adapters[provider] : null;
    if (!adapter) throw pinningError('pinning-unconfigured', `Unknown IPFS_PINNING_PROVIDER: ${provider}.`, 503);
    const pinned = await adapter({ bytes, fileName, contentType, name });
    if (pinned.cid !== computedCid) throw pinningError('cid-mismatch',
        `${provider} pinned the bytes as ${pinned.cid}, not ${computedCid}.`, 409,
        { cid: computedCid, pinnedCid: pinned.cid });
    const timestamp = typeof pinned.pinnedAt === 'string' ? Date.parse(pinned.pinnedAt) : NaN;
    return { cid: computedCid, pinnedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString() };
}

export async function pinBytes({ bytes, name, cid }) {
    const pinned = await pinFile({ bytes, fileName: `${name}.json`, contentType: 'application/json', name, cid });
    console.log(`[pinning] pinned ${name} as ${pinned.cid} (${bytes.length} bytes)`);
    return pinned;
}
