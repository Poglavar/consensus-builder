// Every browser wallet bridge preflights with connection.simulateTransaction before asking the
// wallet to sign. web3.js 1.x has two overloads: (VersionedTransaction, config) and
// (legacy Transaction, signers?). The bridges build legacy Transactions, so a config object as the
// second argument throws "Invalid arguments" before anything is signed — which is exactly what a
// permissive stub cannot see. Here simulateTransaction is the REAL web3 method on a real
// Connection (only its JSON-RPC transport and the surrounding reads are stubbed), so the argument
// validation the browser hits is exercised; a source ratchet covers the bridges not driven here.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const AgreementClient = require('../../frontend/js/solana/agreement-client.js');
const AgreementBridge = require('../../frontend/js/solana/agreement-bridge.js');
const ParcelClient = require('../../frontend/js/solana/parcel-client.js');
const ParcelAnchors = require('../../frontend/js/solana/parcel-mint.js');
ParcelClient.configure({ web3 });

const WALLET = new web3.PublicKey('Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W');
const PROGRAM = new web3.PublicKey('9S7jXSkWyDYF1W95E8JYDwjpqR9tfXZiMKc6L3NGgJ71');
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ';
const BRIDGES = ['market-bridge.js', 'agreement-bridge.js', 'parcel-mint.js'];
const LENS = new web3.PublicKey(Uint8Array.from({ length: 32 }, () => 11)).toBase58();
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';

function source(name) {
    return fs.readFileSync(new URL(`../../frontend/js/solana/${name}`, import.meta.url), 'utf8');
}

// A real Connection: simulateTransaction is web3's own (its RPC call answered from a table), the
// reads and the send/confirm tail are stubbed on the instance so no socket is ever opened.
function realConnection(calls) {
    const connection = new web3.Connection('http://localhost:1', 'confirmed');
    connection._rpcRequest = async (method) => {
        calls.push(method);
        if (method === 'simulateTransaction') {
            return { jsonrpc: '2.0', id: '1', result: { context: { slot: 1 }, value: { err: null, logs: [], accounts: null, unitsConsumed: 0, returnData: null } } };
        }
        throw new Error(`unexpected rpc ${method}`);
    };
    connection.getLatestBlockhash = vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 99 }));
    connection.getBalance = vi.fn(async () => 1_000_000_000);
    connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '5000000', decimals: 6 } }));
    connection.sendRawTransaction = vi.fn(async () => { calls.push('sendRawTransaction'); return 'signature-1'; });
    connection.confirmTransaction = vi.fn(async () => { calls.push('confirmTransaction'); return { value: { err: null } }; });
    return connection;
}

function provider() {
    return { publicKey: WALLET, signTransaction: vi.fn(async transaction => ({ serialize: () => transaction.serializeMessage() })) };
}

function instruction() {
    return new web3.TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
}

describe('wallet bridges preflight through real web3 simulateTransaction', () => {
    it('documents the trap: a legacy Transaction plus a config object is rejected by web3 itself', async () => {
        const connection = realConnection([]);
        const transaction = new web3.Transaction({ feePayer: WALLET, recentBlockhash: BLOCKHASH }).add(instruction());
        await expect(connection.simulateTransaction(transaction, { sigVerify: false })).rejects.toThrow('Invalid arguments');
        await expect(connection.simulateTransaction(transaction)).resolves.toMatchObject({ value: { err: null } });
    });

    // The parimutuel stake() was replaced by LMSR buy() in c2cf630e1 ("Move agreement betting to LMSR").
    it('market bridge buys: simulate → sign → send → confirm', async () => {
        const calls = [];
        const connection = realConnection(calls);
        connection.getSlot = vi.fn(async () => 1);
        connection.getBlockTime = vi.fn(async () => 1_800_000_000);
        connection.getAccountInfo = vi.fn(async () => ({ data: Buffer.alloc(0) }));
        const signer = provider();
        const proposal = PROGRAM.toBase58();
        const sponsor = new web3.PublicKey(Uint8Array.from({ length: 32 }, () => 22)).toBase58();
        const deadline = 1_800_001_000;
        const SEED = 69_314_718n;
        const market = { kind: 0, proposal, creator: sponsor, stakeMint: USDC, b: 100_000_000n, closesAt: BigInt(deadline),
            graceSeconds: 0, maxPosition: 0n, seed: SEED, resolved: false };
        const lmsr = {
            constants: { SIDE_YES: 1, SIDE_NO: 0, KIND_PROPOSAL: 0 },
            getMarketPda: vi.fn(() => [PROGRAM]),
            readMarket: vi.fn(async () => market),
            getAssociatedTokenAddress: vi.fn(() => WALLET),
            buildBuyIx: vi.fn(() => instruction())
        };
        const window = {
            solanaWeb3: web3,
            SolanaLmsrClient: lmsr,
            AgreementClient: { fetchAgreement: vi.fn(async () => ({ authority: sponsor, lenses: [LENS], deadline, status: 'Active' })) },
            Lmsr: { maxLoss: () => SEED },
            SolanaChainDataLoader: { getVerifiedConnection: async () => connection },
            solanaWalletManager: { getCluster: () => 'devnet', getProvider: () => signer }
        };
        vm.runInNewContext(source('market-bridge.js'), { window });
        const statuses = [];
        const result = await window.SolanaMarketBridge.buy({ proposal, marketAddress: PROGRAM.toBase58(), side: 0, shares: 50_000n, maxCost: 60_000n, onStatus: s => statuses.push(s.state) });
        expect(calls).toEqual(['simulateTransaction', 'sendRawTransaction', 'confirmTransaction']);
        expect(lmsr.buildBuyIx).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ proposal, side: 0, shares: 50_000n, maxCost: 60_000n, stakeMint: USDC }));
        expect(signer.signTransaction).toHaveBeenCalledTimes(1);
        expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
        expect(result.transactionHash).toBe('signature-1');
    });

    it('agreement bridge mints: simulate → sign → send → confirm', async () => {
        const calls = [];
        const connection = realConnection(calls);
        // The program is deployed and the agreement's account does not exist yet.
        connection.getAccountInfo = vi.fn(async key => (key.toBase58() === AgreementClient.constants.AGREEMENT_PROGRAM_ID
            ? { executable: true, owner: web3.SystemProgram.programId, lamports: 1, data: Buffer.alloc(0) }
            : null));
        const signer = provider();
        AgreementClient.configure({ web3 });
        try {
            const bridge = AgreementBridge.browser({
                solanaWeb3: web3,
                SolanaChainDataLoader: { getConnection: () => connection },
                solanaWalletManager: { getCluster: () => 'devnet', getProvider: () => signer }
            });
            const agreement = {
                deadline: null, inputs: { openGroundM2: 0 }, onchain: null,
                published: { cid: CID, publishedAt: '2026-10-22T08:00:00.000Z', apiBase: 'https://api.example.test', sponsor: WALLET.toBase58() }
            };
            const statuses = [];
            const result = await bridge.mint({ agreement, lenses: [LENS], payout: WALLET.toBase58(), onStatus: s => statuses.push(s.state) });
            expect(calls).toEqual(['simulateTransaction', 'sendRawTransaction', 'confirmTransaction']);
            expect(signer.signTransaction).toHaveBeenCalledTimes(1);
            expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
            expect(result).toMatchObject({ signature: 'signature-1', account: AgreementClient.getAgreementPda(CID, WALLET)[0].toBase58() });
        } finally {
            AgreementClient.configure({ web3: null });
        }
    });

    // docs/blockchain-flows.md Flow 3: every input parcel is anchored before the agreement exists, and a
    // wallet that signs several transactions at once approves the anchors and the create together.
    it('agreement bridge anchors the input parcels first, with one wallet approval for all transactions', async () => {
        const calls = [];
        const connection = realConnection(calls);
        connection.getAccountInfo = vi.fn(async key => (key.toBase58() === AgreementClient.constants.AGREEMENT_PROGRAM_ID
            ? { executable: true, owner: web3.SystemProgram.programId, lamports: 1, data: Buffer.alloc(0) }
            : null));
        const [anchored] = ParcelClient.getParcelPda('HR-335754-1/1');
        connection.getMultipleAccountsInfo = vi.fn(async keys => keys.map(key => (key.equals(anchored) ? { data: Buffer.alloc(8) } : null)));
        const signer = { ...provider(), signAllTransactions: vi.fn(async transactions => transactions.map(tx => ({ serialize: () => tx.serializeMessage() }))) };
        AgreementClient.configure({ web3 });
        try {
            const bridge = AgreementBridge.browser({
                solanaWeb3: web3, SolanaParcelAnchors: ParcelAnchors,
                SolanaChainDataLoader: { getConnection: () => connection },
                solanaWalletManager: { getCluster: () => 'devnet', getProvider: () => signer }
            });
            const long = 'GB-HMLR-LONDON-0123456789-ABCDEFGH';
            const parcelIds = ['HR-335754-1/1', ...Array.from({ length: 10 }, (_, i) => `HR-335754-${100 + i}/2`), long];
            const agreement = {
                deadline: null, inputs: { openGroundM2: 0, parcels: parcelIds.map(parcelId => ({ parcelId })) }, onchain: null,
                published: { cid: CID, publishedAt: '2026-10-22T08:00:00.000Z', apiBase: 'https://api.example.test', sponsor: WALLET.toBase58() }
            };
            const statuses = [];
            const result = await bridge.mint({ agreement, lenses: [LENS], payout: WALLET.toBase58(), onStatus: s => statuses.push(s) });
            // Ten new anchors in two transactions, then the create: three simulated, one approval, sent in order.
            expect(signer.signAllTransactions).toHaveBeenCalledTimes(1);
            expect(signer.signTransaction).not.toHaveBeenCalled();
            const [transactions] = signer.signAllTransactions.mock.calls[0];
            expect(transactions).toHaveLength(3);
            const programs = transactions.map(tx => [...new Set(tx.instructions.map(ix => ix.programId.toBase58()))]);
            expect(programs).toEqual([[ParcelClient.constants.PARCEL_NFT_PROGRAM_ID], [ParcelClient.constants.PARCEL_NFT_PROGRAM_ID], [AgreementClient.constants.AGREEMENT_PROGRAM_ID]]);
            const anchoredIds = transactions.slice(0, 2).flatMap(tx => tx.instructions.map(ix => ix.keys[0].pubkey.toBase58()));
            expect(anchoredIds).toEqual(parcelIds.slice(1, 11).map(id => ParcelClient.getParcelPda(id)[0].toBase58()));
            expect(Buffer.from(transactions[0].instructions[0].data).equals(Buffer.from(ParcelClient.encodeMintParcelData(parcelIds[1], `https://urbangametheory.xyz/parcel/${parcelIds[1]}`)))).toBe(true);
            expect(calls).toEqual(['simulateTransaction', 'simulateTransaction', 'simulateTransaction',
                'sendRawTransaction', 'confirmTransaction', 'sendRawTransaction', 'confirmTransaction', 'sendRawTransaction', 'confirmTransaction']);
            expect(statuses.map(s => s.state)).toEqual(['preparing', 'awaiting_signature', 'anchoring', 'anchoring', 'submitted', 'confirmed']);
            expect(statuses[3].detail).toEqual({ done: 10, total: 10 });
            expect(result.inputAnchors).toMatchObject({ alreadyAnchored: ['HR-335754-1/1'], skipped: [{ parcelId: long, reason: 'id-too-long' }] });
            expect(result.inputAnchors.anchored.map(row => row.parcelId)).toEqual(parcelIds.slice(1, 11));
        } finally {
            AgreementClient.configure({ web3: null });
        }
    });

    it('the parcel panel anchors several parcels per transaction, skipping anchored ones, with one approval', async () => {
        const calls = [];
        const connection = realConnection(calls);
        const [anchored] = ParcelClient.getParcelPda('HR-1-1');
        connection.getMultipleAccountsInfo = vi.fn(async keys => keys.map(key => (key.equals(anchored) ? { data: Buffer.alloc(8) } : null)));
        const signer = { ...provider(), signAllTransactions: vi.fn(async transactions => transactions.map(tx => ({ serialize: () => tx.serializeMessage() }))) };
        const cached = [];
        const saved = { solanaWeb3: globalThis.solanaWeb3, solanaWalletManager: globalThis.solanaWalletManager, SolanaChainDataLoader: globalThis.SolanaChainDataLoader };
        Object.assign(globalThis, { solanaWeb3: web3, solanaWalletManager: { getProvider: () => signer },
            SolanaChainDataLoader: { getConnection: () => connection, setParcelMintStatusCache: (...args) => cached.push(args) } });
        try {
            const ids = ['HR-1-1', ...Array.from({ length: 12 }, (_, i) => `HR-335754-${200 + i}/2`)];
            const progress = [];
            const result = await ParcelAnchors.anchorParcels(ids, { programId: ParcelClient.constants.PARCEL_NFT_PROGRAM_ID, cluster: 'devnet', onProgress: p => progress.push(p) });
            expect(signer.signAllTransactions).toHaveBeenCalledTimes(1);
            expect(signer.signAllTransactions.mock.calls[0][0]).toHaveLength(2);
            expect(result.transactions.map(row => row.parcelIds.length).reduce((a, b) => a + b)).toBe(12);
            expect(result.alreadyAnchored).toEqual(['HR-1-1']);
            expect(result.anchoredParcelIds).toEqual(ids);
            expect(progress.at(-1)).toEqual({ done: 12, total: 12 });
            expect(cached).toHaveLength(13);
            expect(cached[1][3]).toMatchObject({ minted: true, metadataURI: `https://urbangametheory.xyz/parcel/${ids[1]}` });
        } finally {
            Object.assign(globalThis, saved);
        }
    });

    it('no bridge passes a config object to simulateTransaction (source ratchet)', () => {
        for (const name of BRIDGES) {
            const text = source(name);
            expect(text, `${name} must call simulateTransaction somewhere`).toMatch(/simulateTransaction\(/);
            // Matches `simulateTransaction(tx, {` across line breaks — the exact shape web3 rejects.
            expect(text, `${name} passes a config object to simulateTransaction`).not.toMatch(/simulateTransaction\(\s*\w+\s*,\s*\{/);
        }
    });
});
