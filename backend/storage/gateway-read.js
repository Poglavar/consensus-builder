// Reads published objects back from IPFS HTTP gateways by CID, for readers that must trust neither our
// index nor the gateway (agreement discovery, oracle/agreement-discovery.js). Gateways are tried in
// order, one request at a time and paced; bytes are accepted only when they hash to the CID asked for
// (cid.js, the index's own CID scheme), so a wrong or tampered answer is the same as no answer.

import { cidOf, isCid } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES, ipfsGatewayUrl } from './pinning.js';
import { createRequestPacer } from '../solana/rpc.js';

// Tried after the configured read gateway (our pinning provider's dedicated one, which serves a fresh pin
// within seconds; docs/ipfs-storage.md): Filebase's public gateway. Measured 2026-11-26, the free public
// gateways no longer serve programmatic reads: ipfs.io, dweb.link and nftstorage.link answer 429 ("switching
// to a service worker gateway only"), gateway.pinata.cloud timed out, lighthouse 402, storry.tv 403,
// trustless-gateway.link 5xx. Content pinned elsewhere is found only through IPFS_DISCOVERY_GATEWAYS.
export const PUBLIC_GATEWAY = 'https://ipfs.filebase.io/ipfs';
// A gateway that does not hold a CID can hang until the timeout (ipfs.filebase.io did, for 30 s).
export const DEFAULT_TIMEOUT_MS = 15_000;
// At least this long between the starts of two gateway requests of one process.
export const DEFAULT_MIN_INTERVAL_MS = 1_000;

const hostOf = base => new URL(base).host;

/**
 * The gateway bases to read from: IPFS_DISCOVERY_GATEWAYS (comma-separated) when set, else the
 * server's IPFS_READ_GATEWAY followed by PUBLIC_GATEWAY. Each must be a plain HTTP(S) base URL
 * (the rule ipfsGatewayUrl enforces); duplicates are dropped.
 */
export function readGateways(env = process.env) {
    const configured = typeof env.IPFS_DISCOVERY_GATEWAYS === 'string' && env.IPFS_DISCOVERY_GATEWAYS.trim()
        ? env.IPFS_DISCOVERY_GATEWAYS.split(',').map(base => base.trim()).filter(Boolean)
        : [env.IPFS_READ_GATEWAY || 'https://ipfs.filebase.io/ipfs', PUBLIC_GATEWAY];
    const bases = [];
    for (const base of configured) {
        // Throws for anything that is not an HTTP(S) base URL without credentials, query or fragment.
        ipfsGatewayUrl('probe', { IPFS_READ_GATEWAY: base });
        const clean = base.replace(/\/+$/, '');
        if (!bases.includes(clean)) bases.push(clean);
    }
    if (!bases.length) throw new Error('no IPFS gateway is configured');
    return bases;
}

// The response body, refused once it passes `maxBytes` (declared or streamed).
async function cappedBytes(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`answers ${declared} bytes, more than ${maxBytes}`);
    if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error(`answers more than ${maxBytes} bytes`);
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`answers more than ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
}

/**
 * @returns {{ gateways: string[], read(cid): Promise<{ bytes: Uint8Array, gateway: string }>,
 *   readJson(cid): Promise<{ content: any, gateway: string }>, requests: () => number }}
 *   read throws code 'content-unavailable' (with `attempts`, one line per gateway) when no gateway
 *   answers bytes that hash to the CID; readJson also throws code 'content-not-json'.
 */
export function createGatewayReader({
    gateways = readGateways(), fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS, maxBytes = MAX_PINNED_OBJECT_BYTES, pacer = null
} = {}) {
    const pace = pacer || (minIntervalMs > 0 ? createRequestPacer(minIntervalMs) : async () => {});
    let requests = 0;

    async function read(cid) {
        if (!isCid(cid)) throw Object.assign(new Error(`${JSON.stringify(cid)} is not a CID`), { code: 'invalid-cid' });
        const attempts = [];
        for (const base of gateways) {
            await pace();
            requests += 1;
            try {
                const response = await fetchImpl(`${base}/${encodeURIComponent(cid)}`, {
                    headers: { Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.1' },
                    redirect: 'follow',
                    signal: AbortSignal.timeout(timeoutMs)
                });
                if (!response.ok) {
                    attempts.push(`${hostOf(base)}: HTTP ${response.status}`);
                    continue;
                }
                const bytes = await cappedBytes(response, maxBytes);
                const computed = cidOf(bytes);
                if (computed !== cid) {
                    attempts.push(`${hostOf(base)}: its bytes are ${computed}`);
                    continue;
                }
                return { bytes, gateway: hostOf(base) };
            } catch (error) {
                attempts.push(`${hostOf(base)}: ${error.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : error.message}`);
            }
        }
        throw Object.assign(new Error(`${cid} is not retrievable (${attempts.join('; ')})`), { code: 'content-unavailable', attempts });
    }

    async function readJson(cid) {
        const { bytes, gateway } = await read(cid);
        try {
            return { content: JSON.parse(Buffer.from(bytes).toString('utf8')), gateway };
        } catch {
            throw Object.assign(new Error(`${cid} is not JSON`), { code: 'content-not-json' });
        }
    }

    return { gateways, read, readJson, requests: () => requests };
}
