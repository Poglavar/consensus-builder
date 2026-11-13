// The server's IPFS courier (docs/blockchain-flows.md, Flow 2) for agents minting on a chain: an
// object's canonical bytes must be served by a public gateway before a record references its CID.
// The same gate as the browser's (frontend/js/chain/ipfs-courier.js retrievable(): a public gateway,
// never our backend, returns bytes hashing to the CID); the courier is our pinning account
// (storage/pinning.js), used only when no public gateway serves the object yet.
import { createRequire } from 'node:module';
import { cidOf } from '../cid.js';
import { pinBytes } from '../storage/pinning.js';

const require = createRequire(import.meta.url);
const IpfsCourier = require('../../frontend/js/chain/ipfs-courier.js');
const IpfsRead = require('../../frontend/js/chain/ipfs-read.js');

export const COURIER_KINDS = Object.freeze(['design', 'plan', 'agreement']);
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const stderrLog = line => process.stderr.write(`${line}\n`);

/**
 * Makes `bytes` (the canonical bytes of `cid`) retrievable from a public gateway.
 * Resolves { cid, via: 'already' | 'pinned', gateway, attempts, pinnedAt }. Throws 'invalid-kind',
 * 'cid-mismatch' (the bytes are another CID), the pinning error's code ('pinning-unconfigured',
 * 'pinning-quota-exhausted', ...; 'pin-failed' without one), or 'not-retrievable' when the gate
 * did not open within `delays` (IpfsCourier.GATE_DELAYS_MS, about four minutes).
 * `fetchImpl`, `wait`, `pin` and `gateways` are injectable for tests.
 */
export async function ensureRetrievable({
    kind, cid, bytes, log = stderrLog, fetchImpl = globalThis.fetch, wait,
    delays = IpfsCourier.GATE_DELAYS_MS, pin = pinBytes, gateways = IpfsRead.gateways()
} = {}) {
    const say = message => log(`[${new Date().toISOString()}] [courier] ${message}`);
    if (!COURIER_KINDS.includes(kind)) throw failure('invalid-kind', `kind must be one of ${COURIER_KINDS.join(', ')}.`);
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw failure('invalid-bytes', `There are no bytes for ${kind} ${cid}.`);
    const computed = cidOf(bytes);
    if (computed !== cid) throw failure('cid-mismatch', `The bytes of ${kind} ${cid} are ${computed}.`, { cid, computedCid: computed });
    const gate = { fetchImpl, gateways, ...(wait ? { wait } : {}) };

    say(`${kind} ${cid}: asking ${gateways.length} public gateway(s)`);
    const first = await IpfsCourier.retrievable(cid, { ...gate, delays: [] });
    if (first.retrievable) {
        say(`${kind} ${cid}: already served by ${first.gateway}`);
        return { cid, via: 'already', gateway: first.gateway, attempts: first.attempts, pinnedAt: null };
    }

    say(`${kind} ${cid}: not on a public gateway; pinning ${bytes.length} bytes`);
    let pinned;
    try {
        pinned = await pin({ bytes, name: `${kind}-${cid}`, cid });
    } catch (error) {
        throw failure(error?.code || 'pin-failed', `${kind} ${cid} could not be pinned: ${error?.message || error}`, { cid });
    }
    const opened = await IpfsCourier.retrievable(cid, {
        ...gate, delays,
        onAttempt: ({ attempt, total }) => say(`${kind} ${cid}: waiting for a public gateway, attempt ${attempt}/${total}`)
    });
    if (!opened.retrievable) {
        throw failure('not-retrievable', `${kind} ${cid} was pinned but no public gateway served it after ${opened.attempts} attempts; run the mint again later.`, { cid });
    }
    say(`${kind} ${cid}: served by ${opened.gateway} after ${opened.attempts} attempt(s)`);
    return { cid, via: 'pinned', gateway: opened.gateway, attempts: opened.attempts, pinnedAt: pinned?.pinnedAt || null };
}
