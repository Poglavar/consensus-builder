// Headless contract tests for DID Web parsing, wallet authorization, and bounded resolution.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const didWeb = require('../../frontend/js/community/did-web.js');

const did = 'did:web:ngo.example:consultation';
const sol = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';
const response = text => ({
    ok: true,
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
    headers: { get: () => String(new TextEncoder().encode(text).byteLength) }
});

test('normalizes DID Web domain and path forms and maps document URLs', () => {
    assert.equal(didWeb.normalizeDid('ngo.example/consultation'), did);
    assert.equal(didWeb.normalizeDid('https://ngo.example'), 'did:web:ngo.example');
    assert.equal(didWeb.normalizeDid('https://ngo.example/consultation'), did);
    assert.equal(didWeb.normalizeDid('https://ngo.example:8443/consultation'), 'did:web:ngo.example%3A8443:consultation');
    assert.equal(didWeb.normalizeDid('did:web:ngo.example%3a8443:consultation'), 'did:web:ngo.example%3A8443:consultation');
    assert.equal(didWeb.documentUrl('did:web:ngo.example'), 'https://ngo.example/.well-known/did.json');
    assert.equal(didWeb.documentUrl(did), 'https://ngo.example/consultation/did.json');
    assert.equal(didWeb.documentUrl('did:web:ngo.example%3A8443:consultation'), 'https://ngo.example:8443/consultation/did.json');
});

test('rejects URL ambiguity and path traversal', () => {
    for (const value of ['https://user:pass@ngo.example', 'https://ngo.example?q=1', 'did:web:ngo.example#x',
        'https://ngo.example/a/../b', 'did:web:ngo.example:a%2Fb', 'did:web:ngo.example:..', 'did:web:127.0.0.1',
        'did:web:localhost', 'did:web:service.local', 'did:web:ngo.example%3A-1', 'did:web:ngo.example%3A70000']) {
        assert.throws(() => didWeb.normalizeDid(value), undefined, value);
    }
});

test('authorizes only an assertion method controlled by the exact DID and wallet', () => {
    const document = {
        id: did,
        verificationMethod: [
            { id: did + '#signer', controller: did, blockchainAccountId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:' + sol },
            { id: did + '#other', controller: 'did:web:other.example', blockchainAccountId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:' + sol }
        ],
        authentication: [did + '#signer'],
        assertionMethod: [did + '#signer']
    };
    const account = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:' + sol;
    assert.equal(didWeb.authorizedWallet(document, did, account), true);
    assert.equal(didWeb.authorizedWallet({ ...document, assertionMethod: [] }, did, account), false);
    assert.equal(didWeb.authorizedWallet({ ...document, assertionMethod: [did + '#other'] }, did, account), false);
    assert.equal(didWeb.authorizedWallet({ ...document, id: 'did:web:tampered.example' }, did, account), false);
    assert.equal(didWeb.authorizedWallet({ ...document, verificationMethod: [] }, did, account), false);
    assert.equal(didWeb.authorizedWallet({ ...document, verificationMethod: [
        { ...document.verificationMethod[0], id: 'did:web:other.example#signer' }
    ] }, did, account), false);
    assert.equal(didWeb.authorizedWallet(document, did, account.replace(sol, sol.slice(0, -1) + '1')), false);
});

test('matches EVM CAIP-10 addresses case-insensitively and preserves exact Solana casing', () => {
    const evm = '0x1234567890abcdef1234567890abcdef12345678';
    assert.equal(didWeb.walletMatches('eip155:1:' + evm, 'eip155:1:' + evm.toUpperCase().replace('0X', '0x')), true);
    assert.equal(didWeb.walletMatches('solana:devnet:' + sol, 'solana:devnet:' + sol.toLowerCase()), false);
});

test('resolve fetches HTTPS with bounded, non-credentialed CORS and hashes canonical document', async () => {
    const document = { assertionMethod: [], id: did, verificationMethod: [] };
    let request;
    const result = await didWeb.resolve(did, { fetch: async (url, init) => {
        request = { url, init };
        return response(JSON.stringify(document));
    } });
    assert.equal(request.url, 'https://ngo.example/consultation/did.json');
    assert.equal(request.init.mode, 'cors');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.cache, 'no-store');
    assert.equal(result.did, did);
    assert.equal(result.hash, await didWeb.documentHash({ verificationMethod: [], id: did, assertionMethod: [] }));
    await assert.rejects(didWeb.resolve(did, { fetch: async () => response('{"id":"did:web:wrong.example"}') }), /does not match/);
    const chunks = [];
    const tooLarge = { ok: true, headers: { get: () => null }, body: new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(didWeb.MAX_DOCUMENT_BYTES));
            controller.enqueue(new Uint8Array([1]));
        },
        cancel(reason) { chunks.push(reason); }
    }) };
    await assert.rejects(didWeb.resolve(did, { fetch: async () => tooLarge }), /size limit/);
    assert.equal(chunks.length, 1);
    await assert.rejects(didWeb.resolve(did, { fetch: async () => ({ ok: true, text: async () => '{}' }) }), /bounded streaming/);
    await assert.rejects(didWeb.resolve(did, {
        timeoutMs: 5,
        fetch: async (_url, init) => {
            assert.ok(init.signal);
            return { ok: true, headers: { get: () => null }, body: new ReadableStream({ pull() { return new Promise(() => {}); } }) };
        }
    }), /timed out/);
});
