// solana-adapter.js — the Solana side of the chain adapter (blockchain-flows.md, Flow 3): design and
// plan records and ownerless parcel anchors of the ugt program on one cluster, read through a
// web3.js Connection and written through an injected `send` (a wallet in the browser, the agent's
// keypair on the server). Same surface as chain/evm-adapter.js, so the mint checklist, Share's
// chain path, the chain watcher and the MCP tools run on either chain. The instruction bytes and
// account decoding are UgtClient's (solana/ugt-client.js). window.SolanaAdapter.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.SolanaAdapter = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const ugt = () => {
        const api = root.UgtClient || (typeof require === 'function' ? require('../solana/ugt-client.js') : null);
        if (!api) throw new Error('UgtClient (js/solana/ugt-client.js) is not loaded.');
        return api;
    };

    // The clusters the ugt program is deployed on, by the chain key addresses.json uses.
    const CLUSTERS = Object.freeze({ devnet: Object.freeze({ name: 'Solana devnet' }) });
    const DEFAULT_CLUSTER = 'devnet';
    // A legacy transaction is at most 1232 bytes; anchors are packed by size, and at most this many
    // per transaction so the compute budget holds (each creates one account).
    const MAX_TX_BYTES = 1232;
    const ANCHOR_BATCH = 8;

    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
    const chainKeyOf = cluster => `solana-${cluster}`;
    const clusterOf = chainKey => {
        const text = String(chainKey || '').trim();
        const cluster = text.startsWith('solana-') ? text.slice('solana-'.length) : text;
        return CLUSTERS[cluster] ? cluster : null;
    };
    const chainName = cluster => (CLUSTERS[clusterOf(cluster)] || {}).name || `Solana ${cluster}`;

    /** The Solana explorer page of an account or a transaction on a cluster. */
    function explorerUrl(cluster, { address = null, tx = null } = {}) {
        const path = tx ? `tx/${encodeURIComponent(tx)}` : address ? `address/${encodeURIComponent(address)}` : '';
        const name = clusterOf(cluster) || cluster;
        const suffix = name && name !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(name)}` : '';
        return `https://explorer.solana.com/${path}${suffix}`;
    }

    const utf8Length = text => new TextEncoder().encode(String(text)).length;
    const compactLength = n => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

    /**
     * The serialized size of a legacy transaction holding one anchor_parcels instruction for these
     * parcels, signed by its payer alone: signatures, header, account keys (payer, system program,
     * the ugt program, one anchor each), blockhash and the instruction with its borsh data.
     */
    function anchorTxSize(parcelIds, metadataUris) {
        const keys = 3 + parcelIds.length;
        const strings = values => 4 + values.reduce((sum, value) => sum + 4 + utf8Length(value), 0);
        const data = 8 + strings(parcelIds) + strings(metadataUris);
        const accounts = 2 + parcelIds.length;
        return 1 + 64 + 3 + compactLength(keys) + 32 * keys + 32 + 1
            + 1 + compactLength(accounts) + accounts + compactLength(data) + data;
    }

    /** `parcelIds` split into the batches anchor transactions carry: at most `max` each, each within the size limit. */
    function anchorBatches(parcelIds, metadataUriOf, { max = ANCHOR_BATCH, maxBytes = MAX_TX_BYTES } = {}) {
        const batches = [];
        let current = [];
        for (const parcelId of parcelIds) {
            const next = [...current, parcelId];
            const fits = next.length <= max && anchorTxSize(next, next.map(id => String(metadataUriOf(id) || ''))) <= maxBytes;
            if (fits) { current = next; continue; }
            if (!current.length) throw failure('anchor-too-large', `Parcel ${parcelId} and its metadata URI do not fit one transaction.`);
            batches.push(current);
            current = [parcelId];
        }
        if (current.length) batches.push(current);
        return batches;
    }

    /** The first `maxBytes` UTF-8 bytes of `text`, never splitting a character. */
    function truncateUtf8(text, maxBytes) {
        let out = '';
        for (const char of String(text)) {
            if (utf8Length(out + char) > maxBytes) break;
            out += char;
        }
        return out;
    }

    /** A decoded Record as a row, the EVM adapter's shape plus the record and asset addresses. */
    function recordRow(record, cluster) {
        return {
            cid: record.cid,
            kind: record.kind,
            minter: record.minter,
            createdAt: new Date(record.createdAt * 1000).toISOString(),
            tokenUri: null,
            chainId: chainKeyOf(cluster),
            address: record.address,
            asset: record.asset
        };
    }

    /**
     * The adapter for one cluster. `connection` reads; `send(instructions)` (optional) signs, sends
     * and confirms a transaction and resolves its signature; `wallet` is the signer's base58 key.
     */
    function createAdapter({ connection, cluster = DEFAULT_CLUSTER, programId = null, wallet = null, send = null, log: logLine = null }) {
        const name = clusterOf(cluster);
        if (!name) throw failure('invalid-chain', `The ugt program is not deployed on Solana ${cluster}.`);
        if (!connection) throw failure('no-connection', 'A Solana connection is required.');
        const client = ugt();
        const program = programId || client.constants.UGT_PROGRAM_ID;
        const log = message => (logLine || (line => console.info(line)))(`[${new Date().toISOString()}] [SolanaAdapter ${name}] ${message}`);
        const signing = () => {
            if (!send || !wallet) throw failure('no-signer', `No wallet is connected to ${chainName(name)} to sign with.`);
            return send;
        };

        // Every record of `kind` ('design' | 'plan', or null for both), newest first.
        async function listRecords(kind = null) {
            if (kind && !client.KIND_CODES[kind]) throw failure('invalid-kind', `No record kind ${kind}.`);
            const records = await client.listRecords(connection, { kind, programId: program });
            log(`${records.length} ${kind || 'record'}(s) in the program`);
            return records.map(record => recordRow(record, name));
        }

        // The record of `cid` (as `kind`, or as whichever kind holds it), or null.
        async function recordOf(cid, kind = null) {
            for (const each of kind ? [kind] : ['design', 'plan']) {
                const record = await client.fetchRecord(connection, { kind: each, cid, programId: program });
                if (record) return recordRow(record, name);
            }
            return null;
        }

        // The parcel ids among `parcelIds` that have no anchor, in the order given.
        async function anchorsMissing(parcelIds) {
            const ids = Array.from(new Set(parcelIds.map(String)));
            const anchors = await client.fetchParcelAnchors(connection, ids, { programId: program });
            return ids.filter((_, index) => !anchors[index]);
        }

        /**
         * Anchors `parcelIds` in transactions packed by size, one wallet approval each; the program
         * skips parcels anchored meanwhile, so a batch refused midway is simply run again.
         * `metadataUriOf` gives each parcel's fixed metadata URI; `onBatch({ done, total, txHash })`
         * reports progress. Resolves { txHashes, anchored }.
         */
        async function mintAnchors(parcelIds, { metadataUriOf, batchSize = ANCHOR_BATCH, onBatch = null } = {}) {
            const sign = signing();
            const ids = Array.from(new Set(parcelIds.map(String)));
            const uriOf = parcelId => String(metadataUriOf(parcelId) || '');
            const txHashes = [];
            let done = 0;
            for (const batch of anchorBatches(ids, uriOf, { max: batchSize })) {
                const { instruction } = client.buildAnchorParcelsIx({ parcelIds: batch, metadataUris: batch.map(uriOf), payer: wallet, programId: program });
                const signature = await sign([instruction]);
                txHashes.push(signature);
                done += batch.length;
                log(`anchored ${done}/${ids.length} parcel(s) in ${signature}`);
                if (onBatch) onBatch({ done, total: ids.length, txHash: signature });
            }
            return { txHashes, anchored: ids.length };
        }

        /**
         * Mints the record of `cid` and its Metaplex Core asset to the signer. The asset's name is
         * the token metadata's (truncated to the program's limit); its URI is `tokenUri`. Resolves
         * { txHash, record }; refuses a minted CID.
         */
        async function mintRecord(kind, cid, tokenUri) {
            const sign = signing();
            if (!client.KIND_CODES[kind]) throw failure('invalid-kind', `No record kind ${kind}.`);
            const existing = await recordOf(cid);
            if (existing) throw failure('record-exists', `${cid} already has a record on ${chainName(name)}, minted by ${existing.minter}.`, { record: existing });
            const metadata = tokenMetadataOf(tokenUri);
            const title = truncateUtf8((metadata && metadata.name) || cid, client.constants.MAX_NAME_BYTES) || cid;
            const uri = String(tokenUri || '');
            if (utf8Length(uri) > client.constants.MAX_URI_BYTES) throw failure('uri-too-long', `The token metadata of ${cid} is longer than ${client.constants.MAX_URI_BYTES} bytes.`);
            const { instruction } = client.buildCreateRecordIx({ kind, cid, name: title, uri, minter: wallet, programId: program });
            const signature = await sign([instruction]);
            log(`minted ${kind} ${cid} in ${signature}`);
            return { txHash: signature, record: await recordOf(cid, kind) };
        }

        return Object.freeze({
            family: 'solana', chainId: chainKeyOf(name), cluster: name, name: chainName(name), anchorBatch: ANCHOR_BATCH,
            addresses: Object.freeze({ RecordRegistry: program, ParcelAnchor: program }), canSign: !!(send && wallet),
            explorerUrl: target => explorerUrl(name, target),
            signerAddress: () => Promise.resolve(wallet || null),
            listRecords, recordOf, anchorsMissing, mintAnchors, mintRecord
        });
    }

    /** The token metadata of a data: URI (chain/evm-adapter.js's tokenUriOf), or null for any other URI. */
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

    /** The Anchor error a failed simulation logged ("Error Code: X. … Error Message: m."), or null. */
    function anchorError(logs) {
        const match = (Array.isArray(logs) ? logs.join('\n') : String(logs || '')).match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/m);
        return match ? { code: match[1], number: Number(match[2]), message: match[3] } : null;
    }

    function browser(win) {
        const cluster = () => (typeof win.solanaWalletManager?.getCluster === 'function' ? win.solanaWalletManager.getCluster() : DEFAULT_CLUSTER);

        async function connectionFor(name) {
            if (!win.solanaWeb3?.Transaction && typeof win.ensureWalletVendors === 'function') await win.ensureWalletVendors();
            if (!win.solanaWeb3?.Transaction || !win.SolanaChainDataLoader?.getConnection) throw failure('web3-unavailable', 'The Solana library could not be loaded.');
            return win.SolanaChainDataLoader.getConnection(name);
        }

        // The connected Solana wallet's address without asking it for anything, or null.
        function walletAddress() {
            const state = typeof win.solanaWalletManager?.getState === 'function' ? win.solanaWalletManager.getState() : null;
            return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length ? String(state.accounts[0]) : null;
        }

        // Simulate, sign with the wallet, send, confirm. A simulation failure names the program's error.
        function walletSend(connection, provider, wallet) {
            return async instructions => {
                const latest = await connection.getLatestBlockhash('confirmed');
                const transaction = new win.solanaWeb3.Transaction({ feePayer: wallet, recentBlockhash: latest.blockhash });
                instructions.forEach(instruction => transaction.add(instruction));
                // web3.js 1.x: a legacy Transaction without signers is an unsigned simulation.
                const simulation = await connection.simulateTransaction(transaction);
                if (simulation && simulation.value && simulation.value.err) {
                    const logs = simulation.value.logs || [];
                    const program = anchorError(logs);
                    console.warn(`[${new Date().toISOString()}] [SolanaAdapter] simulation failed`, simulation.value.err, logs);
                    throw failure('simulation-failed', `The transaction would fail: ${program ? program.message : JSON.stringify(simulation.value.err)}`, { logs, programError: program ? program.code : null });
                }
                const signed = await provider.signTransaction(transaction);
                const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
                const confirmation = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
                if (confirmation && confirmation.value && confirmation.value.err) throw failure('confirmation-failed', `Transaction ${signature} failed on chain.`, { signature });
                return signature;
            };
        }

        // A read-only adapter for `name` (the wallet's cluster, else devnet); null where the program is not deployed.
        async function forCluster(name = cluster()) {
            if (!clusterOf(name)) return null;
            return createAdapter({ connection: await connectionFor(clusterOf(name)), cluster: clusterOf(name) });
        }

        // The signing adapter of the connected Solana wallet; null without one or on a cluster without the program.
        async function connected() {
            const address = walletAddress();
            const name = clusterOf(cluster());
            if (!address || !name) return null;
            const provider = win.solanaWalletManager.getProvider();
            if (!provider || typeof provider.signTransaction !== 'function') return null;
            const connection = await connectionFor(name);
            const wallet = new win.solanaWeb3.PublicKey(address);
            return createAdapter({ connection, cluster: name, wallet: address, send: walletSend(connection, provider, wallet) });
        }

        return { cluster, walletAddress, forCluster, connected };
    }

    return { CLUSTERS, DEFAULT_CLUSTER, MAX_TX_BYTES, ANCHOR_BATCH, chainKeyOf, clusterOf, chainName, explorerUrl,
        anchorTxSize, anchorBatches, truncateUtf8, recordRow, tokenMetadataOf, anchorError, createAdapter, browser };
});
