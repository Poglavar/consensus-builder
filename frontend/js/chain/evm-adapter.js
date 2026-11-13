// evm-adapter.js — the EVM side of the chain adapter (blockchain-flows.md, Flow 3): design and plan
// records in RecordRegistry and ownerless parcel anchors in ParcelAnchor (blockchain/contracts/) on
// one chain, read through any ethers provider and written through a wallet's signer. The pure parts
// (ABIs, chain names, explorer links, row shaping, token metadata) run in node for the tests and the
// server's chain watcher; `browser` binds them to the page's wallet and contract addresses.
// window.EvmAdapter.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.EvmAdapter = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // The chains the contracts are deployed on (frontend/contracts/addresses.json), with the explorer
    // a record or transaction links to.
    const CHAINS = Object.freeze({
        '31337': Object.freeze({ name: 'Local Hardhat', explorer: null }),
        '84532': Object.freeze({ name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' }),
        '11155111': Object.freeze({ name: 'Sepolia', explorer: 'https://sepolia.etherscan.io' })
    });
    const DEFAULT_CHAIN_ID = '84532';
    const KIND_CODES = Object.freeze({ design: 1, plan: 2 });
    const KIND_NAMES = Object.freeze({ 1: 'design', 2: 'plan' });
    const RECORD_TUPLE = '(uint8 kind, string cid, address minter, uint64 createdAt, string tokenURI)';
    const ANCHOR_TUPLE = '(string parcelId, string metadataURI, uint64 anchoredAt, address anchoredBy)';
    const RECORD_REGISTRY_ABI = Object.freeze([
        'function mint(uint8 kind, string cid, string uri) returns (uint256)',
        'function exists(string cid) view returns (bool)',
        `function recordOf(string cid) view returns (${RECORD_TUPLE})`,
        'function count() view returns (uint256)',
        `function records(uint256 offset, uint256 limit, uint8 kind) view returns (${RECORD_TUPLE}[])`,
        'event RecordMinted(uint256 indexed tokenId, uint8 indexed kind, string cid, address indexed minter)'
    ]);
    const PARCEL_ANCHOR_ABI = Object.freeze([
        'function anchorBatch(string[] parcelIds, string[] metadataURIs) returns (uint256)',
        'function missing(string[] parcelIds) view returns (bool[])',
        `function anchorOf(string parcelId) view returns (${ANCHOR_TUPLE})`,
        'function count() view returns (uint256)'
    ]);
    // Records per read, and parcels per anchoring transaction (one wallet approval each).
    const PAGE = 200;
    const ANCHOR_BATCH = 25;

    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

    /** A chain id as addresses.json spells it (decimal string), from hex, a number or a bigint. */
    function normalizeChainId(value) {
        if (value == null || value === '') return null;
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null;
        const text = String(value).trim();
        if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text).toString();
        return /^\d+$/.test(text) ? text : null;
    }

    const chainName = chainId => (CHAINS[normalizeChainId(chainId)] || {}).name || `chain ${normalizeChainId(chainId)}`;

    /** The explorer page of an address or a transaction, or null where the chain has no explorer. */
    function explorerUrl(chainId, { address = null, tx = null } = {}) {
        const explorer = (CHAINS[normalizeChainId(chainId)] || {}).explorer;
        if (!explorer) return null;
        if (tx) return `${explorer}/tx/${tx}`;
        return address ? `${explorer}/address/${address}` : explorer;
    }

    /**
     * The wallet-facing token metadata of a record as a data: URI, so a mint needs no second upload.
     * Cosmetic: nothing verifies it and readers never take content from it.
     */
    function tokenUriOf({ name, description = '', externalUrl = null, image = null }) {
        const metadata = { name: String(name || ''), description: String(description || '') };
        if (externalUrl) metadata.external_url = String(externalUrl);
        if (image) metadata.image = String(image);
        const json = JSON.stringify(metadata);
        const base64 = typeof Buffer === 'function' ? Buffer.from(json, 'utf8').toString('base64')
            : btoa(String.fromCharCode(...new TextEncoder().encode(json)));
        return `data:application/json;base64,${base64}`;
    }

    /** The reverse of tokenUriOf, or null for any other URI. */
    function tokenMetadataOf(uri) {
        const match = /^data:application\/json;base64,(.+)$/.exec(String(uri || ''));
        if (!match) return null;
        try {
            const json = typeof Buffer === 'function' ? Buffer.from(match[1], 'base64').toString('utf8')
                : new TextDecoder().decode(Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)));
            return JSON.parse(json);
        } catch (_) {
            return null;
        }
    }

    /** A decoded `Record` tuple as a row: { cid, kind, minter, createdAt (ISO), tokenUri, chainId }. */
    function recordRow(tuple, chainId) {
        const kind = Number(tuple.kind ?? tuple[0]);
        const createdAt = Number(tuple.createdAt ?? tuple[3]);
        if (!createdAt) return null;
        return {
            cid: String(tuple.cid ?? tuple[1]),
            kind: KIND_NAMES[kind] || String(kind),
            minter: String(tuple.minter ?? tuple[2]),
            createdAt: new Date(createdAt * 1000).toISOString(),
            tokenUri: String(tuple.tokenURI ?? tuple[4]),
            chainId: normalizeChainId(chainId)
        };
    }

    /**
     * The adapter for one chain. `provider` reads; `signer` (a wallet's, optional) writes.
     * `addresses` is { ParcelAnchor, RecordRegistry }.
     */
    function createAdapter({ ethers, chainId, provider, signer = null, addresses, log: logLine = null }) {
        const id = normalizeChainId(chainId);
        if (!id) throw failure('invalid-chain', `Not a chain id: ${chainId}`);
        if (!ethers || !ethers.Contract) throw failure('ethers-unavailable', 'The ethers library is not loaded.');
        if (!addresses || !addresses.RecordRegistry || !addresses.ParcelAnchor) throw failure('no-contracts', `${chainName(id)} has no record registry or parcel anchor contract.`);
        const registry = new ethers.Contract(addresses.RecordRegistry, RECORD_REGISTRY_ABI, provider);
        const anchors = new ethers.Contract(addresses.ParcelAnchor, PARCEL_ANCHOR_ABI, provider);
        const writer = contract => {
            if (!signer) throw failure('no-signer', `No wallet is connected to ${chainName(id)} to sign with.`);
            return contract.connect(signer);
        };
        // The server injects its own line writer (stderr under the MCP stdio transport); the page logs to the console.
        const log = message => (logLine || (line => console.info(line)))(`[${new Date().toISOString()}] [EvmAdapter ${id}] ${message}`);

        // Every record of `kind` ('design' | 'plan', or null for both), newest first.
        async function listRecords(kind = null) {
            const code = kind ? KIND_CODES[kind] : 0;
            if (kind && !code) throw failure('invalid-kind', `No record kind ${kind}.`);
            const rows = [];
            for (let offset = 0; ; offset += PAGE) {
                const page = await registry.records(offset, PAGE, code);
                for (const tuple of page) { const row = recordRow(tuple, id); if (row) rows.push(row); }
                if (page.length < PAGE) break;
            }
            log(`${rows.length} ${kind || 'record'}(s) in the registry`);
            return rows.reverse();
        }

        async function recordOf(cid) {
            if (!(await registry.exists(cid))) return null;
            return recordRow(await registry.recordOf(cid), id);
        }

        // The parcel ids among `parcelIds` that have no anchor, in the order given.
        async function anchorsMissing(parcelIds) {
            const ids = Array.from(new Set(parcelIds.map(String)));
            const missing = [];
            for (let offset = 0; offset < ids.length; offset += PAGE) {
                const batch = ids.slice(offset, offset + PAGE);
                const flags = await anchors.missing(batch);
                batch.forEach((parcelId, index) => { if (flags[index]) missing.push(parcelId); });
            }
            return missing;
        }

        /**
         * Anchors `parcelIds` in batches of `batchSize`, one wallet approval each; the contract skips
         * parcels anchored meanwhile, so a batch refused midway is simply run again. `metadataUriOf`
         * gives each parcel's fixed metadata URI; `onBatch({ done, total, txHash })` reports progress.
         * Resolves { txHashes, anchored }.
         */
        async function mintAnchors(parcelIds, { metadataUriOf, batchSize = ANCHOR_BATCH, onBatch = null } = {}) {
            const ids = Array.from(new Set(parcelIds.map(String)));
            const txHashes = [];
            for (let offset = 0; offset < ids.length; offset += batchSize) {
                const batch = ids.slice(offset, offset + batchSize);
                const tx = await writer(anchors).anchorBatch(batch, batch.map(parcelId => String(metadataUriOf(parcelId) || '')));
                await tx.wait();
                txHashes.push(tx.hash);
                log(`anchored ${Math.min(offset + batch.length, ids.length)}/${ids.length} parcel(s) in ${tx.hash}`);
                if (onBatch) onBatch({ done: Math.min(offset + batch.length, ids.length), total: ids.length, txHash: tx.hash });
            }
            return { txHashes, anchored: ids.length };
        }

        // Mints the record of `cid` to the signer. Resolves { txHash, record }; refuses a minted CID.
        async function mintRecord(kind, cid, tokenUri) {
            const code = KIND_CODES[kind];
            if (!code) throw failure('invalid-kind', `No record kind ${kind}.`);
            const existing = await recordOf(cid);
            if (existing) throw failure('record-exists', `${cid} already has a record on ${chainName(id)}, minted by ${existing.minter}.`, { record: existing });
            const tx = await writer(registry).mint(code, cid, String(tokenUri || ''));
            await tx.wait();
            log(`minted ${kind} ${cid} in ${tx.hash}`);
            return { txHash: tx.hash, record: await recordOf(cid) };
        }

        return Object.freeze({
            family: 'evm', chainId: id, name: chainName(id), addresses, canSign: !!signer,
            explorerUrl: target => explorerUrl(id, target),
            signerAddress: () => (signer ? signer.getAddress() : Promise.resolve(null)),
            listRecords, recordOf, anchorsMissing, mintAnchors, mintRecord
        });
    }

    function browser(win) {
        let addressBook = null;
        // Every contract addresses.json lists for `chainId` (the agreement bridge reads `Agreement`), or null.
        async function contractAddresses(chainId) {
            if (!addressBook) {
                const response = await win.fetch('/contracts/addresses.json', { cache: 'no-store' });
                if (!response.ok) throw failure('no-contracts', `addresses.json: HTTP ${response.status}`);
                addressBook = await response.json();
            }
            const entry = addressBook[normalizeChainId(chainId)];
            return entry && typeof entry === 'object' ? { ...entry } : null;
        }
        async function addressesFor(chainId) {
            const entry = await contractAddresses(chainId);
            return entry && entry.ParcelAnchor && entry.RecordRegistry ? { ParcelAnchor: entry.ParcelAnchor, RecordRegistry: entry.RecordRegistry } : null;
        }

        async function ensureEthers() {
            if (!win.ethers && typeof win.ensureWalletVendors === 'function') await win.ensureWalletVendors();
            if (!win.ethers) throw failure('ethers-unavailable', 'The ethers library could not be loaded.');
            return win.ethers;
        }

        // The chain of the connected EVM wallet (decimal string), or null without one.
        function walletChainId() {
            const state = typeof win.walletManager?.getState === 'function' ? win.walletManager.getState() : null;
            if (!state || state.status !== 'connected' || !Array.isArray(state.accounts) || !state.accounts.length) return null;
            return normalizeChainId(state.chainId);
        }

        // A read-only adapter for `chainId` (the wallet's chain, else Base Sepolia); null when the
        // chain has no contracts.
        async function forChain(chainId = walletChainId() || DEFAULT_CHAIN_ID) {
            const addresses = await addressesFor(chainId);
            if (!addresses) return null;
            const ethers = await ensureEthers();
            return createAdapter({ ethers, chainId, provider: await win.ChainDataLoader.getProviderForChain(chainId), addresses });
        }

        // The signing adapter for the wallet's chain; null without an EVM wallet on a chain with contracts.
        async function connected() {
            const chainId = walletChainId();
            if (!chainId) return null;
            const addresses = await addressesFor(chainId);
            if (!addresses) return null;
            const ethers = await ensureEthers();
            const provider = new ethers.BrowserProvider(win.walletManager.getProvider());
            return createAdapter({ ethers, chainId, provider, signer: await provider.getSigner(), addresses });
        }

        return { walletChainId, forChain, connected, contractAddresses, ensureEthers };
    }

    return { CHAINS, DEFAULT_CHAIN_ID, KIND_CODES, RECORD_REGISTRY_ABI, PARCEL_ANCHOR_ABI, PAGE, ANCHOR_BATCH,
        normalizeChainId, chainName, explorerUrl, tokenUriOf, tokenMetadataOf, recordRow, createAdapter, browser };
});
