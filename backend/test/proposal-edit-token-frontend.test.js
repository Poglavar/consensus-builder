// Frontend side of the proposal edit tokens: the upload stores the token POST /proposals returns,
// and the three writers (card epoch menu, bulk epoch distribution, legacy block rename) send it —
// or, holding none (someone else's proposal), leave the server copy alone without a failing request.
// The DOM-bound functions are lifted out of their files and run with stubbed collaborators.
// Also: plan replay orders server records by authoredAt, and the upload error path reaches its toast.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function sliceBetween(src, from, to) {
    const start = src.indexOf(from);
    expect(start, `missing "${from}"`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start);
    expect(end, `missing "${to}" after it`).toBeGreaterThan(start);
    return src.slice(start, end);
}

function fakeLocalStorage() {
    const data = new Map();
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: key => { data.delete(key); }
    };
}

describe('edit token storage (server-sync.js)', () => {
    beforeEach(() => { globalThis.localStorage = fakeLocalStorage(); });
    afterEach(() => { delete globalThis.localStorage; });

    it('keeps the token per server row id, outside the proposal record', () => {
        const { rememberProposalEditToken, getProposalEditToken } = require('../../frontend/js/proposals/server-sync.js');
        expect(rememberProposalEditToken('51', 'tok-51')).toBe(true);
        expect(getProposalEditToken('51')).toBe('tok-51');
        expect(getProposalEditToken(51)).toBe('tok-51');
        expect(getProposalEditToken('45')).toBeNull();
        // Only server row ids key a token; a local or fingerprint id never does.
        expect(rememberProposalEditToken('c2-abc', 'x')).toBe(false);
        expect(getProposalEditToken('c2-abc')).toBeNull();
    });

    it('the upload stores the token the server returned', () => {
        const upload = sliceBetween(read('../../frontend/js/proposals/server-sync.js'),
            'async function uploadProposalToServer(', 'async function headProposalExists(');
        expect(upload).toContain('rememberProposalEditToken(serverProposalId, result.editToken)');
    });
});

describe('epoch writes (epoch.js)', () => {
    const src = read('../../frontend/js/proposals/epoch.js');
    const helpers = sliceBetween(src, 'function serverIdOf(', '/* ------------------------- raspodjela');
    const writer = sliceBetween(src, 'async function writeEpochsToServer(', 'async function distributeEpochs(');
    const { parseEpochYear } = require('../../frontend/js/proposals/epoch.js');

    function load(tokens) {
        const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ missing: [], forbidden: [] }) }));
        const storage = { setProposalEpochYear: vi.fn() };
        const api = new Function('parseEpochYear', 'getProposalEditToken', 'resolveBackendBaseUrl', 'fetch',
            'proposalStorage', 'rememberEpoch', 'renderList',
            `${helpers}\n${writer}\nreturn { setEpoch, writeEpochsToServer };`)(
            parseEpochYear, id => tokens[String(id)] || null, () => 'https://api.test', fetch,
            storage, () => {}, () => {});
        return { ...api, fetch, storage };
    }

    it('someone else\'s server proposal: the epoch is set locally, no request is made', async () => {
        const { setEpoch, fetch, storage } = load({});
        const proposal = { proposalId: 'c2-theirs', serverProposalId: '45' };

        await expect(setEpoch(proposal, 2045)).resolves.toBe(2045);

        expect(fetch).not.toHaveBeenCalled();
        expect(proposal.epochYear).toBe(2045);
        expect(storage.setProposalEpochYear).toHaveBeenCalledWith('c2-theirs', 2045);
    });

    it('own upload: PATCHes with the edit token header', async () => {
        const { setEpoch, fetch } = load({ 51: 'tok-51' });

        await setEpoch({ proposalId: 'c2-mine', serverProposalId: '51' }, 2055);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('https://api.test/proposals/51/epoch');
        expect(init.headers['X-Proposal-Edit-Token']).toBe('tok-51');
    });

    it('the bulk write sends only own uploads, each with its token', async () => {
        const { writeEpochsToServer, fetch } = load({ 51: 'tok-51' });
        const failed = [];

        await writeEpochsToServer([
            { proposal: { serverProposalId: '51' }, year: 2035 },
            { proposal: { serverProposalId: '45' }, year: 2045 },
            { proposal: { proposalId: 'local-only' }, year: 2055 }
        ], failed);

        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body).toEqual({ epochs: [{ id: '51', epochYear: 2035, editToken: 'tok-51' }] });
        expect(failed).toEqual([]);
    });

    it('the bulk write makes no request when it holds no tokens at all', async () => {
        const { writeEpochsToServer, fetch } = load({});

        expect(await writeEpochsToServer([{ proposal: { serverProposalId: '45' }, year: 2045 }], [])).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('legacy block rename (block-batch.js)', () => {
    const src = read('../../frontend/js/block-batch.js');
    const body = sliceBetween(src, 'async function renameProposalRecord(', '    /**\n     * Rename every leftover');

    function load(tokens) {
        const fetch = vi.fn(async () => ({ ok: true }));
        const global = {
            resolveBackendBaseUrl: () => 'https://api.test',
            getProposalEditToken: id => tokens[String(id)] || null,
            proposalStorage: { setProposalName: vi.fn(() => true) }
        };
        const rename = new Function('global', 'fetch', `${body}\nreturn renameProposalRecord;`)(global, fetch);
        return { rename, fetch, global };
    }

    it('renames an own upload on the server with the token', async () => {
        const { rename, fetch } = load({ 51: 'tok-51' });

        await expect(rename({ proposalId: 'c2-a', serverId: '51', to: 'Block 1-AAAA' })).resolves.toEqual({ server: 'renamed' });
        expect(fetch.mock.calls[0][1].headers['X-Proposal-Edit-Token']).toBe('tok-51');
    });

    it('renames only locally when no token is held, and says so', async () => {
        const { rename, fetch, global } = load({});

        await expect(rename({ proposalId: 'c2-a', serverId: '45', to: 'Block 1-AAAA' })).resolves.toEqual({ server: 'no-edit-token' });
        expect(fetch).not.toHaveBeenCalled();
        expect(global.proposalStorage.setProposalName).toHaveBeenCalledWith('c2-a', 'Block 1-AAAA');
    });
});

describe('plan replay order uses the authored time of server records', () => {
    const { compareFormationOrder, orderFormations } = require('../../frontend/js/proposals/plan-order.js');

    it('a record uploaded late still replays in authoring order', () => {
        const road = { proposalId: 'road', serverProposalId: '90', authoredAt: '2026-09-01T10:00:00Z', createdAt: '2026-09-20T10:00:00Z' };
        const building = { proposalId: 'building', serverProposalId: '80', authoredAt: '2026-09-02T10:00:00Z', createdAt: '2026-09-10T10:00:00Z' };

        expect(orderFormations([building, road]).map(r => r.proposalId)).toEqual(['road', 'building']);
    });

    it('a local record (createdAt only) and its server copy order the same way', () => {
        const local = { proposalId: 'a', createdAt: '2026-09-01T10:00:00Z' };
        const serverCopy = { proposalId: 'a', serverProposalId: '5', authoredAt: '2026-09-01T10:00:00Z', createdAt: '2026-09-22T10:00:00Z' };
        const other = { proposalId: 'b', createdAt: '2026-09-05T10:00:00Z' };

        expect(compareFormationOrder(local, other)).toBeLessThan(0);
        expect(compareFormationOrder(serverCopy, other)).toBeLessThan(0);
    });
});

describe('upload error path (dialog-upload.js)', () => {
    it('does not call the ancestry gate deleted in 23cf806 — it threw before the error toast', () => {
        const src = read('../../frontend/js/proposals/dialog-upload.js');
        const catchBlock = sliceBetween(src, "console.error('Upload failed:', error);", '// Download JSON handler');
        expect(catchBlock).toContain('showEphemeralMessage(');
        expect(src).not.toMatch(/enforceUploadAncestryGate\s*\(/);
    });
});
