// Chain anchor for the owner decisions on an agreement minted on Solana, with no program change. A
// canonical bundle of signed decisions is pinned to IPFS, and a Memo v1 transaction records
// `ugt-owner-decisions/1 <subject> <ipfs uri> sha256:<hash>` with a lookup address derived from the
// agreement's chain account; the subject is the agreement's CID, which every decision signs. A
// reader that knows only the account lists those memos, fetches each bundle, checks its hash and
// verifies every decision itself, so chain + IPFS reproduce the tally without our server. The chain
// records decisions here; it does not count or pay them. Every function takes the agreement-like
// object of ProposalApproval's decision functions, with `onchain` once the agreement is minted.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalAnchor = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    // Memo v1 logs its data and ignores accounts, so the lookup address can ride along unsigned
    // (Memo v2 demands every account sign). Checked on devnet 2026-10-12.
    const MEMO_V1_PROGRAM_ID = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
    const INBOX_SEED = 'ugt-owner-decisions';
    const MEMO_PREFIX = 'ugt-owner-decisions/1';
    const BUNDLE_SCHEMA = 'owner-decision-bundle/v1';
    // A reader fetches at most this many bundles; anyone can post memos, so the rest is noise.
    const MAX_BUNDLES = 50;
    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const relay = () => root.ProposalApprovalRelay || (typeof require === 'function' ? require('./approval-relay.js') : null);
    const sha256 = () => root.__consentSha256 || (typeof require === 'function' ? require('../../vendor/noble-hashes-1.8.0/sha256.js') : null);

    function failure(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    // The agreement's Solana account, or null when it is not minted there: the index's `onchain`
    // ({ chain: 'solana', cluster, account, … }, backend/agreements/onchain.js) on the agreement-like object.
    function chainRef(agreement) {
        const onchain = agreement?.onchain || {};
        const cluster = String(onchain.cluster || '');
        if (onchain.chain !== 'solana' || !/^[a-z-]+$/.test(cluster) || typeof onchain.account !== 'string' || !onchain.account) return null;
        return { cluster, account: onchain.account };
    }

    // The decisions that apply, in signing order, under this agreement's CID and context.
    function bundleOf(agreement, decisions, verify) {
        const A = approval();
        return { schema: BUNDLE_SCHEMA, subject: A.subjectOf(agreement), contextHash: A.contextHash(agreement),
            decisions: relay().fold(agreement, decisions, verify).applied };
    }
    const hashOf = bundle => `sha256:${sha256().sha256Hex(approval().stableStringify(bundle))}`;
    const memoText = ({ subject, uri, hash }) => `${MEMO_PREFIX} ${subject} ${uri} ${hash}`;

    // getSignaturesForAddress returns a transaction's memos as "[length] text", joined by "; ".
    function memoTexts(memo) {
        const texts = [];
        let index = 0;
        while (typeof memo === 'string' && index < memo.length) {
            const head = /^\[(\d+)\] /.exec(memo.slice(index));
            if (!head) break;
            const start = index + head[0].length;
            texts.push(memo.slice(start, start + Number(head[1])));
            index = start + Number(head[1]);
            if (memo.startsWith('; ', index)) index += 2;
        }
        return texts;
    }

    // The bundle pointers a memo names for this subject; anything else is ignored.
    function pointersIn(memo, subject) {
        return memoTexts(memo).map(text => text.split(' ')).filter(parts => parts.length === 4
            && parts[0] === MEMO_PREFIX && parts[1] === subject
            && /^ipfs:\/\/[A-Za-z0-9]{20,100}$/.test(parts[2]) && /^sha256:[0-9a-f]{64}$/.test(parts[3]))
            .map(parts => ({ uri: parts[2], hash: parts[3] }));
    }

    function inboxAddress(web3, account) {
        return web3.PublicKey.findProgramAddressSync([new TextEncoder().encode(INBOX_SEED), new web3.PublicKey(account).toBytes()],
            new web3.PublicKey(MEMO_V1_PROGRAM_ID))[0];
    }

    function memoInstruction(web3, account, text) {
        return new web3.TransactionInstruction({
            programId: new web3.PublicKey(MEMO_V1_PROGRAM_ID),
            keys: [{ pubkey: inboxAddress(web3, account), isSigner: false, isWritable: false }],
            data: new TextEncoder().encode(text)
        });
    }

    /**
     * Every decision anchored for a minted agreement, from chain + IPFS alone. Bundles whose content
     * does not hash to their memo, or that name another subject, are rejected; the decisions in
     * the rest still have to verify when folded (merge/fold does that).
     * @param {{ connection: object, web3: object, fetchJson: (uri: string) => Promise<object> }} io
     */
    async function readAnchors(agreement, { connection, web3, fetchJson }) {
        const ref = chainRef(agreement);
        if (!ref) return null;
        const subject = approval().subjectOf(agreement);
        const rows = await connection.getSignaturesForAddress(inboxAddress(web3, ref.account), { limit: 1000 }, 'confirmed');
        // Keyed by URI and hash: anyone can post a memo, so a bogus URI under a genuine hash must
        // not shadow the genuine pointer. A hash is accepted once, from the first URI that matches it.
        const pointers = new Map();
        for (const row of rows || []) {
            if (row.err) continue;
            for (const pointer of pointersIn(row.memo, subject)) {
                const key = `${pointer.hash} ${pointer.uri}`;
                if (!pointers.has(key)) pointers.set(key, { ...pointer, signature: row.signature });
            }
        }
        const decisions = [];
        const transactions = [];
        const accepted = new Set();
        let rejected = 0;
        for (const pointer of [...pointers.values()].slice(0, MAX_BUNDLES)) {
            if (accepted.has(pointer.hash)) continue;
            let bundle = null;
            try { bundle = await fetchJson(pointer.uri); } catch (_) { bundle = null; }
            if (!bundle || bundle.schema !== BUNDLE_SCHEMA || bundle.subject !== subject || !Array.isArray(bundle.decisions)
                || hashOf(bundle) !== pointer.hash) {
                rejected += 1;
                continue;
            }
            accepted.add(pointer.hash);
            decisions.push(...bundle.decisions);
            transactions.push(pointer.signature);
        }
        return { decisions, transactions, bundles: transactions.length, rejected };
    }

    // Public gateways for an ipfs:// URI, tried in order; content is checked against the memo hash.
    const IPFS_GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/'];
    const gatewayUrls = uri => (/^ipfs:\/\//.test(uri) ? IPFS_GATEWAYS.map(base => base + uri.slice('ipfs://'.length)) : []);

    // Signatures of decisions anchored by these reads, for "N of M anchored".
    const anchoredSignatures = read => new Set((read?.decisions || []).map(relay().signatureOf).filter(Boolean));

    /**
     * Pins this agreement's current decisions and records the pointer with one wallet transaction.
     * @param {{ publishBundle: () => Promise<{ uri: string, hash: string, subject: string }>, connection: object,
     *   web3: object, provider: { publicKey: object, signTransaction(tx: object): Promise<object> } }} io
     */
    async function anchor(agreement, { publishBundle, connection, web3, provider }) {
        const ref = chainRef(agreement);
        if (!ref) throw failure('not-minted', 'This agreement is not minted on Solana.');
        if (!provider?.publicKey || typeof provider.signTransaction !== 'function') throw failure('wallet-required', 'Connect a Solana wallet first.');
        const published = await publishBundle();
        const subject = approval().subjectOf(agreement);
        if (published?.subject !== subject || !/^ipfs:\/\//.test(published.uri || '') || !/^sha256:[0-9a-f]{64}$/.test(published.hash || '')) {
            throw failure('bad-bundle', 'The pinned bundle does not belong to this agreement.');
        }
        // A wallet's PublicKey may come from its own web3.js copy; rebuild it in ours.
        const payer = new web3.PublicKey(typeof provider.publicKey.toBase58 === 'function' ? provider.publicKey.toBase58() : String(provider.publicKey));
        const latest = await connection.getLatestBlockhash('confirmed');
        const transaction = new web3.Transaction({ feePayer: payer, recentBlockhash: latest.blockhash })
            .add(memoInstruction(web3, ref.account, memoText({ subject, uri: published.uri, hash: published.hash })));
        const simulation = await connection.simulateTransaction(transaction);
        if (simulation?.value?.err) throw failure('simulation-failed', `The anchor transaction would fail: ${JSON.stringify(simulation.value.err)}`);
        const signed = await provider.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize());
        const confirmation = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
        if (confirmation?.value?.err) throw failure('confirmation-failed', 'The anchor transaction failed.');
        return { signature, cluster: ref.cluster, ...published };
    }

    return { MEMO_V1_PROGRAM_ID, INBOX_SEED, MEMO_PREFIX, BUNDLE_SCHEMA, MAX_BUNDLES,
        IPFS_GATEWAYS, gatewayUrls, chainRef, bundleOf, hashOf, memoText, memoTexts, pointersIn, inboxAddress, memoInstruction,
        readAnchors, anchoredSignatures, anchor };
});
