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

const WALLET = new web3.PublicKey('Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W');
const PROGRAM = new web3.PublicKey('GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB');
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ';
const BRIDGES = ['market-bridge.js', 'pledge-bridge.js', 'acceptance-bridge.js', 'parcel-mint.js', 'proposal-bridge.js'];

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

    it('market bridge stakes: simulate → sign → send → confirm', async () => {
        const calls = [];
        const connection = realConnection(calls);
        const signer = provider();
        const window = {
            solanaWeb3: web3,
            SolanaMarketClient: {
                constants: { SIDE_YES: 1, SIDE_NO: 0 },
                readMarket: vi.fn(async () => ({ stakeMint: USDC, resolved: false })),
                getAssociatedTokenAddress: vi.fn(() => WALLET),
                buildStakeIx: vi.fn(() => instruction())
            },
            SolanaChainDataLoader: { getConnection: () => connection },
            solanaWalletManager: { getCluster: () => 'devnet', getProvider: () => signer }
        };
        vm.runInNewContext(source('market-bridge.js'), { window });
        const statuses = [];
        const result = await window.SolanaMarketBridge.stake({ proposal: PROGRAM.toBase58(), side: 0, amount: 50_000n, onStatus: s => statuses.push(s.state) });
        expect(calls).toEqual(['simulateTransaction', 'sendRawTransaction', 'confirmTransaction']);
        expect(signer.signTransaction).toHaveBeenCalledTimes(1);
        expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);
        expect(result.transactionHash).toBe('signature-1');
    });

    it('pledge bridge pledges: simulate → sign → send → confirm', async () => {
        const calls = [];
        const connection = realConnection(calls);
        const signer = provider();
        const window = {
            solanaWeb3: web3,
            SolanaPledgeClient: {
                constants: { USDC_DEVNET_MINT: USDC, PLEDGE_ACTIVE: 1, PLEDGE_FULFILLED: 2 },
                parseUsdc: vi.fn(() => 50_000n),
                formatUsdc: vi.fn(() => '5'),
                getAssociatedTokenAddress: vi.fn(() => WALLET),
                readPledgeCommitment: vi.fn(async () => null),
                readPledgeBook: vi.fn(async () => ({ exists: true })),
                buildSetPledgeIx: vi.fn(() => instruction())
            },
            SolanaChainDataLoader: { getConnection: () => connection },
            solanaWalletManager: { getCluster: () => 'devnet', getProvider: () => signer }
        };
        vm.runInNewContext(source('pledge-bridge.js'), { window });
        const result = await window.SolanaPledgeBridge.pledge({ proposal: PROGRAM.toBase58(), amount: '0.05' });
        expect(calls).toEqual(['simulateTransaction', 'sendRawTransaction', 'confirmTransaction']);
        expect(signer.signTransaction).toHaveBeenCalledTimes(1);
        expect(result.transactionHash).toBe('signature-1');
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
