// Unit tests for frontend/js/chain/mint-checklist.js (docs/blockchain-flows.md, Flow 3): the steps a
// mint runs through, in order, over a chain adapter and the IPFS courier; a failed step stops the run
// and a rerun resumes there without repeating what is done. i18n is absent here, so notes are keys.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MintChecklist = require('../../frontend/js/chain/mint-checklist.js');

function fakes({ existing = null, anchored = [] } = {}) {
    const calls = [];
    const courier = { deliver: vi.fn(async ({ cid }) => { calls.push(['deliver', cid]); return { via: 'server', gateway: 'https://gw.example/ipfs/' }; }) };
    const adapter = {
        name: 'Base Sepolia', addresses: { RecordRegistry: '0xreg' }, anchorBatch: 2,
        explorerUrl: ({ tx, address }) => (tx ? `https://x/tx/${tx}` : `https://x/address/${address}`),
        recordOf: vi.fn(async cid => (existing && existing.cid === cid ? existing : null)),
        mintRecord: vi.fn(async (kind, cid, uri) => { calls.push(['mint', kind, cid, uri]); return { txHash: '0xtx', record: { cid, kind, minter: '0xminterminterminter' } }; }),
        anchorsMissing: vi.fn(async ids => ids.filter(id => !anchored.includes(id))),
        mintAnchors: vi.fn(async (ids, { onBatch }) => { calls.push(['anchor', ids]); onBatch({ done: ids.length, total: ids.length, txHash: '0xa' }); return { txHashes: ['0xa'], anchored: ids.length }; })
    };
    return { calls, courier, adapter };
}
const spec = (over, extra = {}) => ({ kind: 'plan', objects: [{ cid: 'bafymember', bytes: new Uint8Array([1]), label: 'Member' }, { cid: 'bafyplan', bytes: new Uint8Array([2]), label: 'Plan' }],
    subject: 'bafyplan', apiBase: 'https://api.example', tokenUri: 'data:meta', pinataJwt: () => null, ...over, ...extra });

describe('MintChecklist', () => {
    it('runs content, anchors and the record in order and reports each', async () => {
        const { calls, courier, adapter } = fakes({ anchored: ['HR-1'] });
        const list = MintChecklist.steps(spec({ courier, adapter, parcelIds: ['HR-1', 'HR-2', 'HR-3'] }));
        expect(list.map(step => step.id)).toEqual(['content:bafymember', 'content:bafyplan', 'anchors', 'record']);
        const state = new Map();
        const changes = [];
        expect(await MintChecklist.run(list, state, step => changes.push([step.id, state.get(step.id).status]))).toBe(true);
        expect(calls).toEqual([['deliver', 'bafymember'], ['deliver', 'bafyplan'], ['anchor', ['HR-2', 'HR-3']], ['mint', 'plan', 'bafyplan', 'data:meta']]);
        expect(courier.deliver.mock.calls[0][0]).toMatchObject({ kind: 'plan', cid: 'bafymember', apiBase: 'https://api.example' });
        expect([...state.values()].map(entry => entry.status)).toEqual(['done', 'done', 'done', 'done']);
        expect(state.get('content:bafyplan').note).toBe('mint.status.retrievable');
        expect(state.get('anchors').extra).toEqual({ tx: '0xa' });
        expect(state.get('record').extra).toEqual({ tx: '0xtx' });
        expect(changes[0]).toEqual(['content:bafymember', 'running']);
    });

    it('stops at a failed step and resumes there, never repeating a done one; a minted CID is not minted again', async () => {
        const { calls, courier, adapter } = fakes();
        adapter.mintRecord.mockRejectedValueOnce(Object.assign(new Error('user rejected'), { code: 'ACTION_REJECTED' }));
        const list = MintChecklist.steps(spec({ courier, adapter }));
        const state = new Map();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await MintChecklist.run(list, state, () => {})).toBe(false);
        expect(state.get('record')).toMatchObject({ status: 'failed', note: 'user rejected' });
        expect(await MintChecklist.run(list, state, () => {})).toBe(true);
        warn.mockRestore();
        expect(calls.filter(call => call[0] === 'deliver').length).toBe(2);
        expect(adapter.mintRecord).toHaveBeenCalledTimes(2);

        const already = fakes({ existing: { cid: 'bafyplan', minter: '0xotherminterminter' } });
        const state2 = new Map();
        expect(await MintChecklist.run(MintChecklist.steps(spec({ courier: already.courier, adapter: already.adapter })), state2, () => {})).toBe(true);
        expect(already.adapter.mintRecord).not.toHaveBeenCalled();
        expect(state2.get('record')).toMatchObject({ status: 'done', note: 'mint.status.alreadyMinted', extra: { address: '0xreg' } });
        expect(state2.get('record').result.record.minter).toBe('0xotherminterminter');
    });

    it('names the courier failure a person can act on', async () => {
        const { courier, adapter } = fakes();
        courier.deliver.mockRejectedValueOnce(Object.assign(new Error('nothing'), { code: 'no-courier' }));
        const state = new Map();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await MintChecklist.run(MintChecklist.steps(spec({ courier, adapter })), state, () => {})).toBe(false);
        warn.mockRestore();
        expect(state.get('content:bafymember')).toMatchObject({ status: 'failed', note: 'mint.status.noCourier' });
        expect(state.get('content:bafymember').extra.error.code).toBe('no-courier');
        expect(state.has('content:bafyplan')).toBe(false);
    });
});
