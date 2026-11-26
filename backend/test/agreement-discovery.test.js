// Agreement discovery (oracle/agreement-discovery.js, agreements/onchain.js listAccounts,
// storage/gateway-read.js): the program's accounts are listed and PDA-checked, an agreement the index
// lacks is fetched from gateways by its CID (bytes checked), indexed through POST /agreements's checks at
// the account's creation time and recorded from the account; known, elsewhere-recorded and forged
// accounts are left alone; failures are retried after a growing wait and poison the verdict; a dry
// run writes nothing. Also the run-stats shape and the CLI's usage and refusals.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createMockPool } from './helpers/mock-pool.js';
import { agreementContent, cidOf, designContent } from './helpers/content-fixtures.js';
import { agreementAccountBytes, AGREEMENT_ACCOUNT_SPACE } from './fixtures/agreement-account.js';
import {
    AGREEMENT_PROGRAM_ID, AgreementClient, DEVNET_GENESIS_HASH, OLD_AGREEMENT_PROGRAM_ID, agreementAccountOf, createAgreementChain
} from '../agreements/onchain.js';
import {
    RETRY_WAIT_MS, discoverChainAgreements, discoveryProblem, nextAttemptAt, retriesFromState, runAgreementDiscoveryJob, stateFromRetries
} from '../oracle/agreement-discovery.js';
import { buildAgreementDiscoveryRunStats } from '../operations/run-stats.js';
import { createGatewayReader, readGateways } from '../storage/gateway-read.js';
import { canonicalBytes } from '../cid.js';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const keyFrom = seed => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + seed) % 256)).publicKey.toBase58();
const SPONSOR = keyFrom(1);
const STRANGER = keyFrom(2);
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const CREATED_AT = Math.floor(Date.parse('2026-11-25T10:00:00.000Z') / 1000);
const SLOT = 526_000_000;

const park = designContent();
const contentOf = title => agreementContent([park], { sponsor: SPONSOR, title });
const NEW = contentOf('Found on chain');
const KNOWN = contentOf('Recorded already');
const UNRECORDED = contentOf('Indexed, never recorded');
const ELSEWHERE = contentOf('Recorded on the retired program');
const [NEW_CID, KNOWN_CID, UNRECORDED_CID, ELSEWHERE_CID] = [NEW, KNOWN, UNRECORDED, ELSEWHERE].map(cidOf);

// An account as the program writes it, at its PDA unless `address` says otherwise.
function listed(cid, { authority = SPONSOR, address = agreementAccountOf(cid, authority), createdAt = CREATED_AT, status = 0, data = null } = {}) {
    return {
        pubkey: new PublicKey(address),
        account: { owner: new PublicKey(AGREEMENT_PROGRAM_ID), lamports: 3_000_000, executable: false,
            data: data ?? agreementAccountBytes({ cid, authority, createdAt, status, deadline: Math.floor(Date.parse('2099-01-01T00:00:00Z') / 1000) }) }
    };
}

// A connection answering getProgramAccounts with `accounts`; records the request.
function fakeConnection(accounts) {
    const calls = { programAccounts: [] };
    return {
        calls,
        async getGenesisHash() { return DEVNET_GENESIS_HASH; },
        async getProgramAccounts(programId, config) {
            calls.programAccounts.push({ programId: programId.toBase58(), config });
            return { context: { slot: SLOT }, value: accounts };
        }
    };
}

// The index: agreement rows by CID (with or without `onchain`), recording every write.
function indexPool(rows = []) {
    const pool = createMockPool();
    const byCid = new Map(rows.map(row => [row.cid, row]));
    pool.answer(/FROM consensus\.agreement WHERE cid = ANY/, (sql, params) => ({ rows: params[0].filter(cid => byCid.has(cid)).map(cid => byCid.get(cid)) }));
    pool.answer(/UPDATE consensus\.agreement\s+SET onchain/, (sql, params) => {
        byCid.set(params[0], { ...byCid.get(params[0]), onchain: JSON.parse(params[1]) });
        return { rowCount: 1, rows: [] };
    });
    pool.byCid = byCid;
    return pool;
}
const writesOf = pool => pool.getCalls().filter(call => /^\s*(INSERT|UPDATE)/.test(call.sql));

// POST /agreements's answer, stubbed: 201 for content it is given, unless `answers` scripts otherwise.
function fakeIndex(pool, answers = []) {
    const calls = [];
    const index = vi.fn(async (body, options) => {
        calls.push({ body, now: options.now(), dryRun: options.dryRun });
        const scripted = answers.shift();
        if (scripted) return typeof scripted === 'function' ? scripted(body) : scripted;
        if (options.dryRun) return { status: 200, body: { dryRun: true, cid: body.cid } };
        pool.byCid.set(body.cid, { cid: body.cid, content: body.content, onchain: null });
        return { status: 201, body: { cid: body.cid, content: body.content, onchain: null } };
    });
    index.calls = calls;
    return index;
}

// Gateways holding `objects` (cid → content); a CID it lacks is unavailable.
function fakeGateway(objects) {
    const reads = [];
    const readJson = vi.fn(async cid => {
        reads.push(cid);
        if (!objects.has(cid)) throw Object.assign(new Error(`${cid} is not retrievable (gw: HTTP 504)`), { code: 'content-unavailable' });
        return { content: objects.get(cid), gateway: 'gw.example' };
    });
    readJson.reads = reads;
    return readJson;
}

const chainOver = accounts => createAgreementChain({ connection: fakeConnection(accounts) });
const pass = (options) => discoverChainAgreements({ now: () => NOW, ...options });

describe('listAccounts', () => {
    it('asks for the program\'s agreement accounts by size and discriminator and keeps each one only at its own PDA', async () => {
        const forgedAddress = keyFrom(9);
        const connection = fakeConnection([
            listed(NEW_CID),
            listed(KNOWN_CID, { address: forgedAddress }),
            listed(KNOWN_CID, { address: keyFrom(10), data: Buffer.alloc(AGREEMENT_ACCOUNT_SPACE, 7) })
        ]);
        const { slot, rows } = await createAgreementChain({ connection }).listAccounts();
        expect(slot).toBe(SLOT);
        expect(rows.map(row => [row.address, row.problem, row.account?.cid ?? null])).toEqual([
            [agreementAccountOf(NEW_CID, SPONSOR), null, NEW_CID],
            [forgedAddress, 'not-pda', null],
            [keyFrom(10), 'undecodable', null]
        ]);
        const [request] = connection.calls.programAccounts;
        expect(request.programId).toBe(AGREEMENT_PROGRAM_ID);
        expect(request.config).toMatchObject({ commitment: 'confirmed', withContext: true });
        expect(request.config.filters).toEqual([
            { dataSize: AgreementClient.constants.AGREEMENT_ACCOUNT_SPACE },
            { memcmp: { offset: 0, bytes: Buffer.from(AgreementClient.ACCOUNT_DISCRIMINATORS.Agreement).toString('base64'), encoding: 'base64' } }
        ]);
    });
});

describe('discoverChainAgreements', () => {
    it('indexes and records an agreement the index never heard of, judged at the account\'s creation time, from its account alone', async () => {
        const pool = indexPool();
        const index = fakeIndex(pool);
        const readJson = fakeGateway(new Map([[NEW_CID, NEW]]));
        const result = await pass({ pool, chain: chainOver([listed(NEW_CID)]), index, readJson, apply: true });

        expect(readJson.reads).toEqual([NEW_CID]);
        expect(index.calls).toEqual([{ body: { cid: NEW_CID, content: NEW }, now: CREATED_AT * 1000, dryRun: false }]);
        expect(result.imported).toEqual([{ cid: NEW_CID, account: agreementAccountOf(NEW_CID, SPONSOR), indexed: true, recorded: true, status: 'active' }]);
        const onchain = pool.byCid.get(NEW_CID).onchain;
        expect(onchain).toMatchObject({
            chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account: agreementAccountOf(NEW_CID, SPONSOR),
            sponsor: SPONSOR, status: 'active', observedAt: new Date(NOW).toISOString(), observedSlot: SLOT
        });
        // No signature is claimed: the account and the content are the proof.
        expect(onchain).not.toHaveProperty('signature');
        expect(discoveryProblem(result)).toBeNull();
    });

    it('leaves recorded accounts alone, records an indexed row that lacks onchain without fetching it, and never moves a retired-program record', async () => {
        const pool = indexPool([
            { cid: KNOWN_CID, content: KNOWN, onchain: { programId: AGREEMENT_PROGRAM_ID, account: agreementAccountOf(KNOWN_CID, SPONSOR) } },
            { cid: UNRECORDED_CID, content: UNRECORDED, onchain: null },
            { cid: ELSEWHERE_CID, content: ELSEWHERE, onchain: { programId: OLD_AGREEMENT_PROGRAM_ID, account: keyFrom(20), status: 'executed' } }
        ]);
        const index = fakeIndex(pool);
        const readJson = fakeGateway(new Map());
        const result = await pass({
            pool, chain: chainOver([listed(KNOWN_CID), listed(UNRECORDED_CID), listed(ELSEWHERE_CID)]), index, readJson, apply: true
        });
        expect(result).toMatchObject({ listed: 3, known: 1 });
        expect(result.recordedElsewhere).toEqual([{ cid: ELSEWHERE_CID, account: agreementAccountOf(ELSEWHERE_CID, SPONSOR), recordedAs: `${OLD_AGREEMENT_PROGRAM_ID}/${keyFrom(20)}` }]);
        expect(result.imported).toEqual([{ cid: UNRECORDED_CID, account: agreementAccountOf(UNRECORDED_CID, SPONSOR), indexed: false, recorded: true, status: 'active' }]);
        expect(readJson).not.toHaveBeenCalled();
        expect(index).not.toHaveBeenCalled();
        expect(writesOf(pool).map(call => call.params[0])).toEqual([UNRECORDED_CID]);
        expect(pool.byCid.get(ELSEWHERE_CID).onchain.programId).toBe(OLD_AGREEMENT_PROGRAM_ID);
    });

    it('is idempotent: a second applied pass finds everything recorded and writes nothing', async () => {
        const pool = indexPool();
        const chain = chainOver([listed(NEW_CID)]);
        const readJson = fakeGateway(new Map([[NEW_CID, NEW]]));
        await pass({ pool, chain, index: fakeIndex(pool), readJson, apply: true });
        const writes = writesOf(pool).length;
        const second = await pass({ pool, chain, index: fakeIndex(pool), readJson, apply: true });
        expect(second).toMatchObject({ known: 1, imported: [] });
        expect(writesOf(pool)).toHaveLength(writes);
        expect(readJson.reads).toEqual([NEW_CID]);
    });

    it('carries the plan and then the designs the index asks for, each read from a gateway', async () => {
        const pool = indexPool();
        const plan = { schema: 'plan/v1', title: 'p', designCids: [cidOf(park)] };
        const index = fakeIndex(pool, [
            { status: 422, body: { code: 'plan-not-indexed', error: 'send the plan' } },
            { status: 422, body: { code: 'design-not-indexed', error: 'send the designs', missing: [cidOf(park)] } }
        ]);
        const readJson = fakeGateway(new Map([[NEW_CID, NEW], [NEW.planCid, plan], [cidOf(park), park]]));
        const result = await pass({ pool, chain: chainOver([listed(NEW_CID)]), index, readJson, apply: true });
        expect(readJson.reads).toEqual([NEW_CID, NEW.planCid, cidOf(park)]);
        expect(index.calls.map(call => Object.keys(call.body))).toEqual([['cid', 'content'], ['cid', 'content', 'plan'], ['cid', 'content', 'plan', 'designs']]);
        expect(index.calls[2].body.designs).toEqual([{ cid: cidOf(park), content: park }]);
        expect(result.imported).toHaveLength(1);
    });

    it('refuses an account another wallet created for a published CID: its content names a different sponsor', async () => {
        const pool = indexPool();
        const readJson = fakeGateway(new Map([[NEW_CID, NEW]]));
        const result = await pass({ pool, chain: chainOver([listed(NEW_CID, { authority: STRANGER })]), index: fakeIndex(pool), readJson, apply: true });
        expect(result.imported).toEqual([]);
        expect(result.refused).toEqual([expect.objectContaining({ cid: NEW_CID, account: agreementAccountOf(NEW_CID, STRANGER), code: 'onchain-account-mismatch' })]);
        expect(pool.byCid.get(NEW_CID).onchain).toBeNull();
        expect(discoveryProblem(result)).toMatch(/1 refused/);
    });

    it('refuses an account whose stored CID is not one of the index\'s scheme, without a gateway read', async () => {
        const junk = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaatay7sucv'; // listed on devnet, 2026-11-26
        const pool = indexPool();
        const readJson = createGatewayReader({ gateways: ['https://a.example/ipfs'], fetchImpl: vi.fn(), minIntervalMs: 0 }).readJson;
        const result = await pass({ pool, chain: chainOver([listed(junk)]), index: fakeIndex(pool), readJson, apply: true });
        expect(result.refused).toEqual([expect.objectContaining({ cid: junk, code: 'invalid-cid' })]);
        expect(result.unavailable).toEqual([]);
    });

    it('records what the index refuses, and imports nothing from a forged or undecodable account', async () => {
        const pool = indexPool();
        const index = fakeIndex(pool, [{ status: 422, body: { code: 'deadline-past', error: 'The deadline has already passed.' } }]);
        const readJson = fakeGateway(new Map([[NEW_CID, NEW]]));
        const result = await pass({ pool, chain: chainOver([listed(NEW_CID), listed(KNOWN_CID, { address: keyFrom(9) })]), index, readJson, apply: true });
        expect(result.refused).toEqual([expect.objectContaining({ cid: NEW_CID, code: 'deadline-past' })]);
        expect(result.invalidAccounts).toEqual([{ account: keyFrom(9), problem: 'not-pda' }]);
        expect(readJson.reads).toEqual([NEW_CID]);
        expect(writesOf(pool)).toEqual([]);
    });

    it('retries content no gateway serves after a growing wait; the pass that tries it fails, the passes in between count it as waiting', async () => {
        const pool = indexPool();
        const chain = chainOver([listed(NEW_CID)]);
        const retries = new Map();
        const empty = fakeGateway(new Map());
        const first = await pass({ pool, chain, index: fakeIndex(pool), readJson: empty, apply: true, retries });
        expect(first.unavailable).toEqual([expect.objectContaining({ cid: NEW_CID, object: NEW_CID })]);
        const entry = retries.get(agreementAccountOf(NEW_CID, SPONSOR));
        expect(entry).toMatchObject({ cid: NEW_CID, misses: 1, lastAt: new Date(NOW).toISOString() });
        expect(nextAttemptAt(entry)).toBe(NOW + RETRY_WAIT_MS);
        expect(discoveryProblem(first)).toMatch(/1 with content no gateway serves/);

        const waiting = await pass({ pool, chain, index: fakeIndex(pool), readJson: empty, apply: true, retries, now: () => NOW + 60_000 });
        expect(waiting.waiting).toEqual([expect.objectContaining({ cid: NEW_CID, misses: 1, nextAt: new Date(NOW + RETRY_WAIT_MS).toISOString() })]);
        expect(empty.reads).toHaveLength(1);
        expect(discoveryProblem(waiting)).toBeNull();
        // The wait doubles with each miss, up to a day.
        expect(nextAttemptAt({ misses: 3, lastAt: new Date(NOW).toISOString() })).toBe(NOW + 4 * RETRY_WAIT_MS);
        expect(nextAttemptAt({ misses: 30, lastAt: new Date(NOW).toISOString() })).toBe(NOW + 24 * 60 * 60 * 1000);

        // Due again, and this time a gateway has it: imported, and the retry entry is gone.
        const found = await pass({ pool, chain, index: fakeIndex(pool), readJson: fakeGateway(new Map([[NEW_CID, NEW]])), apply: true, retries, now: () => NOW + RETRY_WAIT_MS });
        expect(found.imported).toHaveLength(1);
        expect(retries.size).toBe(0);
        // The state file round-trips.
        expect(retriesFromState(stateFromRetries(new Map([['a', entry]])))).toEqual(new Map([['a', entry]]));
    });

    it('a dry run runs the checks with dryRun and writes nothing', async () => {
        const pool = indexPool([{ cid: UNRECORDED_CID, content: UNRECORDED, onchain: null }]);
        const index = fakeIndex(pool);
        const retries = new Map();
        const result = await pass({
            // Oldest account first.
            pool, chain: chainOver([listed(UNRECORDED_CID, { createdAt: CREATED_AT + 60 }), listed(NEW_CID)]), index, readJson: fakeGateway(new Map([[NEW_CID, NEW]])), retries
        });
        expect(result.dryRun).toBe(true);
        expect(index.calls.map(call => call.dryRun)).toEqual([true]);
        expect(result.imported.map(item => [item.cid, item.indexed, item.recorded])).toEqual([[NEW_CID, true, false], [UNRECORDED_CID, false, false]]);
        expect(writesOf(pool)).toEqual([]);
    });

    it('imports at most maxImports accounts a pass and defers the rest', async () => {
        const pool = indexPool();
        const readJson = fakeGateway(new Map([[NEW_CID, NEW], [KNOWN_CID, KNOWN]]));
        const result = await pass({ pool, chain: chainOver([listed(NEW_CID), listed(KNOWN_CID)]), index: fakeIndex(pool), readJson, apply: true, maxImports: 1 });
        expect(result.imported).toHaveLength(1);
        expect(result.deferred).toBe(1);
        expect(discoveryProblem(result)).toBeNull();
    });
});

describe('runAgreementDiscoveryJob', () => {
    it('fails the run before listing when the RPC is another cluster, and passes the verdict through', async () => {
        const wrong = { connection: async () => { throw new Error('the RPC for devnet answers genesis x'); } };
        const discover = vi.fn();
        expect(await runAgreementDiscoveryJob({ chain: wrong, discover })).toMatchObject({ result: null, exitCode: 1 });
        expect(discover).not.toHaveBeenCalled();
        const ok = { connection: async () => ({}) };
        const clean = { listed: 1, known: 1, recordedElsewhere: [], invalidAccounts: [], waiting: [], deferred: 0, imported: [], refused: [], unavailable: [], failed: [], fetches: 0, dryRun: false };
        expect(await runAgreementDiscoveryJob({ chain: ok, discover: async () => clean })).toMatchObject({ error: null, exitCode: 0 });
        const bad = await runAgreementDiscoveryJob({ chain: ok, discover: async () => ({ ...clean, failed: [{ cid: 'c', error: 'db down' }] }) });
        expect(bad.exitCode).toBe(1);
        const stats = buildAgreementDiscoveryRunStats({ startedAt: 'a', endedAt: 'b', result: bad.result, error: bad.error });
        expect(stats).toMatchObject({ job: 'consensus-builder-agreement-discovery', verdict: 'failure', counters: { listed: 1, known: 1, failed: 1 } });
    });
});

describe('gateway reads', () => {
    const bytes = canonicalBytes(NEW);
    const answer = (body, status = 200) => ({ ok: status === 200, status, headers: new Headers(), arrayBuffer: async () => body, body: null });

    it('accepts only bytes that hash to the CID, trying the next gateway after a wrong or failed answer', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(answer(canonicalBytes(KNOWN)))
            .mockResolvedValueOnce(answer(new Uint8Array(), 504))
            .mockResolvedValueOnce(answer(bytes));
        const reader = createGatewayReader({ gateways: ['https://a.example/ipfs', 'https://b.example/ipfs', 'https://c.example/ipfs'], fetchImpl, minIntervalMs: 0 });
        const read = await reader.readJson(NEW_CID);
        expect(read).toEqual({ content: NEW, gateway: 'c.example' });
        expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c'].map(host => `https://${host}.example/ipfs/${NEW_CID}`));
    });

    it('says why no gateway served the CID, and refuses an answer over the size cap', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(answer(canonicalBytes(KNOWN)));
        const reader = createGatewayReader({ gateways: ['https://a.example/ipfs'], fetchImpl, minIntervalMs: 0 });
        await expect(reader.read(NEW_CID)).rejects.toMatchObject({ code: 'content-unavailable', attempts: [`a.example: its bytes are ${KNOWN_CID}`] });
        const small = createGatewayReader({ gateways: ['https://a.example/ipfs'], fetchImpl: vi.fn().mockResolvedValue(answer(bytes)), minIntervalMs: 0, maxBytes: 10 });
        await expect(small.read(NEW_CID)).rejects.toMatchObject({ code: 'content-unavailable' });
    });

    it('reads the configured gateway first, then a public one, and refuses a base with credentials', () => {
        expect(readGateways({ IPFS_READ_GATEWAY: 'https://pins.example/ipfs/' })).toEqual(['https://pins.example/ipfs', 'https://ipfs.filebase.io/ipfs']);
        expect(readGateways({})).toEqual(['https://ipfs.filebase.io/ipfs']);
        expect(readGateways({ IPFS_DISCOVERY_GATEWAYS: 'https://x.example/ipfs, https://x.example/ipfs' })).toEqual(['https://x.example/ipfs']);
        expect(() => readGateways({ IPFS_DISCOVERY_GATEWAYS: 'https://user:pw@x.example/ipfs' })).toThrow();
    });
});

// ---- the CLI: every case exits while parsing its options, before dotenv or a database pool ----------

function job(args) {
    return spawnSync(process.execPath, [path.join(BACKEND, 'oracle', 'agreement-discovery-job.mjs'), ...args], {
        cwd: BACKEND, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000
    });
}

describe('agreement-discovery-job.mjs', () => {
    it('prints its usage for --help and for no arguments, and refuses neither or both of --dry-run and --apply', () => {
        for (const args of [['--help'], []]) {
            const run = job(args);
            expect(run.status, args.join(' ')).toBe(0);
            expect(run.stdout).toMatch(/^Usage: node oracle\/agreement-discovery-job\.mjs \(--dry-run \| --apply\)/);
        }
        for (const args of [['--max', '3'], ['--dry-run', '--apply']]) {
            expect(job(args).status, args.join(' ')).toBe(2);
        }
    });
});
