// ipfs-courier.js — gets an object's canonical bytes onto IPFS before anything references its CID
// on chain (blockchain-flows.md, Flow 2). Couriers in order, each only when the one before is
// unavailable: our server (POST /pins), the person's own Pinata key (kept in this browser only), and
// self-pinning (the bytes downloaded, pinned anywhere). Whatever the courier, the retrievability gate
// is the same: a public gateway that is not our backend serves bytes hashing to the CID.
// window.IpfsCourier; the pure parts run in node with fetch injected.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.IpfsCourier = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
    const PINATA_JWT_KEY = 'cb_pinata_jwt';
    // Propagation to a public gateway takes its time: the gate asks this often, this many times.
    const GATE_DELAYS_MS = Object.freeze([2000, 3000, 5000, 8000, 10000, 15000, 15000, 20000, 20000, 30000, 30000, 30000]);

    const ipfsRead = () => root.IpfsRead || (typeof require === 'function' ? require('./ipfs-read.js') : null);
    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function toBase64(bytes) {
        if (typeof Buffer === 'function') return Buffer.from(bytes).toString('base64');
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(binary);
    }

    /**
     * Whether a public gateway serves `cid` yet. One probe per attempt, `delays` apart, each attempt
     * reported through onAttempt({ attempt, total }). Resolves { retrievable, gateway, attempts }.
     */
    async function retrievable(cid, { delays = GATE_DELAYS_MS, onAttempt = null, fetchImpl = root.fetch, gateways, timeoutMs = 10000, wait = sleep } = {}) {
        const total = delays.length + 1;
        for (let attempt = 1; attempt <= total; attempt++) {
            if (onAttempt) onAttempt({ attempt, total });
            try {
                const { gateway } = await ipfsRead().fetchBytes(cid, { fetchImpl, gateways, timeoutMs });
                return { retrievable: true, gateway, attempts: attempt };
            } catch (error) {
                if (error && error.code === 'invalid-cid') throw error;
            }
            if (attempt <= delays.length) await wait(delays[attempt - 1]);
        }
        return { retrievable: false, gateway: null, attempts: total };
    }

    /** Pins through our server: POST /pins { kind, cid, bytes }. Throws the server's refusal with its code. */
    async function pinThroughServer(apiBase, { kind, cid, bytes, fetchImpl = root.fetch }) {
        const response = await fetchImpl(`${String(apiBase).replace(/\/+$/, '')}/pins`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
            body: JSON.stringify({ kind, cid, bytes: toBase64(bytes) })
        });
        let body = null;
        try { body = await response.json(); } catch (_) { body = null; }
        if (!response.ok) throw failure((body && body.code) || `http-${response.status}`, (body && body.error) || `POST /pins: HTTP ${response.status}`, { status: response.status });
        if (!body || body.cid !== cid) throw failure('cid-mismatch', `The server pinned ${body && body.cid}, not ${cid}.`);
        return { via: 'server', pinnedAt: body.pinnedAt || null };
    }

    /**
     * Pins through the person's own Pinata key (a JWT scoped to pinning). Pinata computes the CID of
     * what it stores; it must be ours (CIDv1, raw leaves, 256 KiB chunks), else the pin is useless.
     */
    async function pinThroughPinata(jwt, { cid, bytes, fetchImpl = root.fetch, FormDataImpl = root.FormData, BlobImpl = root.Blob }) {
        const form = new FormDataImpl();
        form.append('file', new BlobImpl([bytes], { type: 'application/json' }), `${cid}.json`);
        form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
        form.append('pinataMetadata', JSON.stringify({ name: cid }));
        const response = await fetchImpl(PINATA_PIN_URL, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form, signal: AbortSignal.timeout(60000) });
        let body = null;
        try { body = await response.json(); } catch (_) { body = null; }
        if (!response.ok) throw failure(`pinata-${response.status}`, (body && (body.error?.details || body.error?.reason || body.error)) || `Pinata: HTTP ${response.status}`, { status: response.status });
        if (!body || body.IpfsHash !== cid) throw failure('cid-mismatch', `Pinata stored ${body && body.IpfsHash}, not ${cid}.`);
        return { via: 'pinata', pinnedAt: body.Timestamp || null };
    }

    /**
     * Delivers one object: already retrievable, else pinned through the first courier that works,
     * then gated until a public gateway serves it. `onStatus({ phase, courier, attempt, total })`
     * narrates: 'checking', 'pinning', 'waiting'. Resolves { via, gateway }; throws code
     * 'no-courier' (with serverError / pinataError) when nothing could pin it, or 'not-retrievable'
     * when the gate never opened after a pin.
     */
    async function deliver({ kind, cid, bytes, apiBase = null, pinataJwt = null, onStatus = null, gate = {} }) {
        const status = update => { if (onStatus) onStatus(update); };
        status({ phase: 'checking' });
        const first = await retrievable(cid, { ...gate, delays: [] });
        if (first.retrievable) return { via: 'already', gateway: first.gateway };
        let pinned = null;
        const errors = {};
        if (apiBase) {
            status({ phase: 'pinning', courier: 'server' });
            try { pinned = await pinThroughServer(apiBase, { kind, cid, bytes, fetchImpl: gate.fetchImpl }); } catch (error) { errors.serverError = error; }
        }
        if (!pinned && pinataJwt) {
            status({ phase: 'pinning', courier: 'pinata' });
            try { pinned = await pinThroughPinata(pinataJwt, { cid, bytes, fetchImpl: gate.fetchImpl }); } catch (error) { errors.pinataError = error; }
        }
        if (!pinned) {
            console.warn(`[${new Date().toISOString()}] [IpfsCourier] no courier could pin ${cid}`, errors);
            throw failure('no-courier', 'Nothing could pin this object: the server did not take it and no pinning key is set.', errors);
        }
        const opened = await retrievable(cid, { ...gate, onAttempt: ({ attempt, total }) => status({ phase: 'waiting', courier: pinned.via, attempt, total }) });
        if (!opened.retrievable) throw failure('not-retrievable', `${cid} was pinned through ${pinned.via} but no public gateway serves it yet.`, { via: pinned.via });
        return { via: pinned.via, gateway: opened.gateway };
    }

    function browser(win) {
        function pinataJwt() {
            try { return win.localStorage.getItem(PINATA_JWT_KEY) || null; } catch (_) { return null; }
        }
        function savePinataJwt(jwt) {
            try { if (jwt) win.localStorage.setItem(PINATA_JWT_KEY, jwt); else win.localStorage.removeItem(PINATA_JWT_KEY); } catch (_) { /* private window: the key lives for this page only */ }
        }
        // The canonical bytes as a file, for pinning anywhere (the self-pinned courier).
        function download(cid, bytes) {
            const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
            const a = win.document.createElement('a');
            a.href = url; a.download = `${cid}.json`;
            win.document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        return { pinataJwt, savePinataJwt, download };
    }

    return { PINATA_JWT_KEY, GATE_DELAYS_MS, toBase64, retrievable, pinThroughServer, pinThroughPinata, deliver, browser };
});
